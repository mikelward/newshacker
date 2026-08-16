#!/usr/bin/env bash
# The docs lane: lets housekeeping-only pull requests merge without the
# build job, while one required check — the `gate` job — still reports on
# every PR.
#
# Why this exists: a ruleset can only require named checks, and a required
# check that never reports blocks the PR forever. A `paths:` filter on
# `pull_request` skips the whole workflow for housekeeping diffs, which is
# exactly that trap. So the workflow runs on every PR; `classify` decides
# whether the build may skip, and `gate` — the only job a ruleset should
# require — independently re-derives that decision before blessing a skip,
# so a classification bug turns into a red check instead of a silent merge.
#
# One source of truth: both jobs run THIS file, so the housekeeping rule
# cannot drift between them. What the gate adds is re-execution plus a
# cross-check against what actually ran. scripts/docs-lane.test.sh exercises
# every branch below against a stubbed `gh`, and the classify job runs it
# before classifying — a broken rule fails closed, never green.
#
# This file is shared across the sibling repos. Everything below the config
# section is the ENGINE and stays identical everywhere; when you change it,
# change it in every repo that carries it.
set -euo pipefail

# --- Repo policy: the only section that differs between repos. -------------

# The lane's test is "can this change what CI validates?". Markdown is docs
# wherever it lives OUTSIDE the shipped trees — prose cannot change a build
# — while anything under src/, api/, or public/ is a build input whatever
# its extension (Vite can import any file, api/ deploys as functions, and
# public/ ships verbatim). Everything else is code — including .gitignore:
# ignore rules can hide files from CI's own staging steps, and the sibling
# repos' lanes treat it as code for exactly that reason.
is_housekeeping() {
  case "$1" in
    src/*) return 1 ;;
    api/*) return 1 ;;
    public/*) return 1 ;;
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}

# The subject prefixes this repo's commit conventions give housekeeping
# commits (see AGENTS.md "Commit messages"). On the docs lane every commit
# must carry one, so nothing on this lane can ever read like a bare
# behavior-change subject.
LANE_PREFIXES="deps docs todo test build refactor"

# This repo's workflow_dispatch has one caller — the weekly dependency
# job's publish step, which opens the PR first precisely so its dispatch
# can name it — so a PR-less dispatch is never legitimate, on any ref.
dispatch_without_pr_ok() {
  return 1
}

# --- Engine: identical across repos below this line. -----------------------

# The snapshot this run's verdict is about, recorded by docs_only and
# re-verified by still_pinned after every later API read — the diff, the
# commit subjects — so nothing read after the pin can be substituted by a
# force-push or a retarget mid-run. Empty until docs_only pins them.
PINNED_HEAD=""
PINNED_BASE=""
PINNED_BASE_SHA=""

# The live tip of branch $1 — read from the ref itself, not from the PR
# object, so the answer does not depend on how fresh the PR's cached base
# happens to be. The ref rides in the URL path, so URI-significant
# characters in a branch name (#, ?, spaces) are escaped — a raw `#` would
# silently truncate the request to a different ref. Slashes stay: they are
# real separators in a ref name, and escaping them would break the common
# case to accommodate the exotic one.
base_tip() {
  local enc
  enc=$(printf '%s' "$1" | jq -sRr '@uri' | sed 's,%2F,/,g') || return 1
  gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/${enc}" --jq '.object.sha'
}

# 0 = the PR still points where this run pinned it; 1 = it moved (refuse
# the housekeeping verdict); 2 = the question could not be answered.
still_pinned() {
  local now
  now=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.head.sha') || return 2
  if [ -n "$PINNED_HEAD" ] && [ "$now" != "$PINNED_HEAD" ]; then return 1; fi
  now=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.base.ref') || return 2
  if [ -n "$PINNED_BASE" ] && [ "$now" != "$PINNED_BASE" ]; then return 1; fi
  if [ -n "$PINNED_BASE_SHA" ]; then
    now=$(base_tip "$PINNED_BASE") || return 2
    if [ "$now" != "$PINNED_BASE_SHA" ]; then return 1; fi
  fi
  # The association is as movable as the head: a twin PR opened on the same
  # commit after the earlier sole-open-PR check would inherit this
  # per-commit gate, so that condition is re-verified at settlement too.
  local prs
  prs=$(open_prs_heading "$PINNED_HEAD") || return 2
  if [ "$(printf '%s' "$prs" | grep -c .)" -ne 1 ] || [ "$(printf '%s' "$prs" | head -n1)" != "$PR" ]; then return 1; fi
}

# A pull_request-event gate must prove its event still describes the PR
# before ANY verdict — the all-green path included. The verdict lands on
# the head commit and is read by whatever the PR looks like NOW, so a run
# outlived by a force-push, a retarget, a moved stacked base, or a twin PR
# must not report even when its heavy jobs passed: they validated a merge
# snapshot the PR no longer shows, and the newer event's own run owns the
# verdict. (Classify stays permissive on purpose — a stale or shared-head
# run still builds usefully; it just cannot mint the required check.)
verify_event_binding() {
  test "${GITHUB_EVENT_NAME:-}" = "pull_request" || return 0
  if [ -z "${PR:-}" ]; then
    echo "::error::A pull_request gate cannot verify its event without the PR number."
    return 1
  fi
  local head now
  head=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.head.sha') || {
    echo "::error::Could not read the pull request's head — refusing to report."
    return 1
  }
  if [ -n "${EVENT_HEAD:-}" ] && [ "$head" != "$EVENT_HEAD" ]; then
    echo "::error::The pull request's head moved after this run's event — the replacement head's own run owns the verdict."
    return 1
  fi
  now=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.base.ref') || {
    echo "::error::Could not read the pull request's base — refusing to report."
    return 1
  }
  if [ -n "${EVENT_BASE_REF:-}" ] && [ "$now" != "$EVENT_BASE_REF" ]; then
    echo "::error::The pull request was retargeted after this run's event — the new diff's own run owns the verdict."
    return 1
  fi
  # A base on the default branch is bound by its name — it is never
  # force-pushed, and its ordinary advance does not move this PR's
  # merge-base diff. Any other base is a stacked PR's feature branch,
  # where a force-push moves the diff while head and ref stand still, so
  # there the base COMMIT is verified too.
  if [ -n "${EVENT_BASE_REF:-}" ] && [ "$EVENT_BASE_REF" != "${DEFAULT_BRANCH:-main}" ] && [ -n "${EVENT_BASE_SHA:-}" ]; then
    now=$(base_tip "$EVENT_BASE_REF") || {
      echo "::error::Could not read the base branch's tip — refusing to report."
      return 1
    }
    if [ "$now" != "$EVENT_BASE_SHA" ]; then
      echo "::error::The pull request's base branch moved after this run's event — the new diff's own run owns the verdict."
      return 1
    fi
  fi
  # A green build proves this PR's merge snapshot, but the check run lands
  # on the commit — which any twin PR sharing the head would read too, its
  # own base unvalidated. Same sole-open-PR condition as the dispatch path.
  local heads
  heads=$(open_prs_heading "$head") || {
    echo "::error::Could not list the pull requests this commit heads — refusing to report."
    return 1
  }
  if [ "$(printf '%s' "$heads" | grep -c .)" -ne 1 ] || [ "$(printf '%s' "$heads" | head -n1)" != "$PR" ]; then
    echo "::error::Commit ${head} heads these open pull requests: $(printf '%s' "$heads" | tr '\n' ' ')— a per-commit gate cannot vouch for exactly one, so this run refuses to report."
    return 1
  fi
}

has_lane_prefix() {
  local subject=$1 p
  for p in $LANE_PREFIXES; do
    case "$subject" in "$p: "*) return 0 ;; esac
  done
  return 1
}

# The complete file list, or a hard failure — never a silent prefix of it.
# Two ways a naive listing lies: the endpoint caps at 3,000 files, returning
# a clean-looking truncation; and a pagination failure after the first page
# exits non-zero into a process substitution, where bash discards the status.
# So the output is captured with its status checked, and the count is
# reconciled against the PR's own changed_files figure before anything is
# classified.
pr_files() {
  local declared files listed
  declared=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.changed_files') || {
    echo "::error::Could not read the pull request's changed_files count." >&2
    return 1
  }
  # Both sides of every entry: a rename carries its new path in `filename`
  # and its old one in `previous_filename`, and classifying only the new
  # side would let a source file renamed into docs ride the docs lane while
  # deleting code. One TSV line per entry keeps the count reconcilable
  # against changed_files.
  files=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}/files" --paginate \
            --jq '.[] | [.filename, .previous_filename // ""] | @tsv') || {
    echo "::error::Could not list the pull request's files." >&2
    return 1
  }
  listed=$(printf '%s' "$files" | grep -c . || true)
  if [ "$listed" -ne "$declared" ]; then
    echo "::error::File list incomplete: listed ${listed} of ${declared} changed files (the API caps at 3,000) — refusing to classify." >&2
    return 1
  fi
  printf '%s\n' "$files"
}

# Every open pull request the given commit currently heads, one number per
# line — or a hard failure when the listing cannot be completed, because a
# per-commit check must not be minted on an association nobody verified.
open_prs_heading() {
  HEAD_Q="$1" gh api "repos/${GITHUB_REPOSITORY}/commits/$1/pulls" --paginate \
    --jq '.[] | select(.state == "open" and .head.sha == env.HEAD_Q) | .number'
}

# 0 = every changed file is housekeeping; 1 = code, or an empty diff;
# 2 = the file list could not be trusted (API failure or truncation).
docs_only() {
  # The files endpoint always answers with the PR's CURRENT diff, so the
  # snapshot is pinned first and re-verified after the listing; any movement
  # refuses the housekeeping verdict. Only that verdict needs the recheck —
  # a stale read that classifies as code merely runs the heavy jobs against
  # the event's own snapshot.
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request)
      # A commit can head more than one open PR (stacked PRs: same branch,
      # different bases), and a check run is per-commit — a gate minted for
      # this PR's justified skip would satisfy the other PR's required
      # check too, even where that PR's diff is code. So a shared head
      # never rides the docs lane: classified as code, the heavy jobs run,
      # and the gate on this SHA is backed by real validation whichever PR
      # reads it. (On pull_request events GITHUB_SHA is the merge commit,
      # not the head, so the PR's own head is looked up first.)
      test -n "${PR:-}" || return 1
      local prhead prs
      prhead=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.head.sha') || return 2
      # A queued run can outlive a force-push: the API answers with the
      # PR's CURRENT head while this run's checks land on the EVENT's
      # snapshot, so classifying the current diff would let a code head be
      # judged by a replacement docs-only head — and the stale gate be
      # reused if the old head is restored. The workflow pins the event's
      # own head SHA into EVENT_HEAD; a mismatch classifies as code, so
      # the stale run's gate is backed by its own heavy jobs or nothing.
      if [ -n "${EVENT_HEAD:-}" ] && [ "$prhead" != "$EVENT_HEAD" ]; then return 1; fi
      PINNED_HEAD="${EVENT_HEAD:-$prhead}"
      # A retarget moves what the diff is measured against while the head —
      # and any check runs already minted on it — stays put. The workflow
      # pins the event's own base ref (and subscribes to base-change
      # `edited` events, so a retarget always gets a fresh run); a mismatch
      # here means this run's event no longer describes the PR. The REF is
      # pinned rather than the base commit's sha because the base branch
      # advancing moves its sha without moving this PR's merge-base diff,
      # and the default branch is never force-pushed.
      local prbase
      prbase=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.base.ref') || return 2
      if [ -n "${EVENT_BASE_REF:-}" ] && [ "$prbase" != "$EVENT_BASE_REF" ]; then return 1; fi
      PINNED_BASE="${EVENT_BASE_REF:-$prbase}"
      # See verify_event_binding: a non-default base is a stacked feature
      # branch whose force-push moves this PR's diff while head and ref
      # stand still, so its commit is pinned too (from the event when it
      # carries one) and rechecked by still_pinned with everything else.
      if [ "$PINNED_BASE" != "${DEFAULT_BRANCH:-main}" ]; then
        if [ -n "${EVENT_BASE_SHA:-}" ]; then
          PINNED_BASE_SHA="$EVENT_BASE_SHA"
        else
          PINNED_BASE_SHA=$(base_tip "$PINNED_BASE") || return 2
        fi
      fi
      prs=$(open_prs_heading "$prhead") || return 2
      # The sole open PR must be THIS one, not merely a count of one: the
      # originating PR can close while its run is in flight, leaving a
      # stacked twin as the single open PR the gate would then vouch for.
      if [ "$(printf '%s' "$prs" | grep -c .)" -ne 1 ] || [ "$(printf '%s' "$prs" | head -n1)" != "$PR" ]; then return 1; fi
      ;;
    # A dispatched run may stand in for a PR run, but only by naming the PR,
    # so classification still judges the PR's real diff rather than waving
    # the branch through. verify_dispatch_binding (below) has already bound
    # the named PR to the checked-out commit before this runs.
    workflow_dispatch)
      test -n "${PR:-}" || return 1
      PINNED_HEAD="${GITHUB_SHA:-}"
      # No event snapshot carries a base here, so the base is pinned from
      # the first read and rechecked with everything else after the diff.
      PINNED_BASE=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.base.ref') || return 2
      if [ "$PINNED_BASE" != "${DEFAULT_BRANCH:-main}" ]; then
        PINNED_BASE_SHA=$(base_tip "$PINNED_BASE") || return 2
      fi
      ;;
    *) return 1 ;;
  esac
  local files any=false new old
  files=$(pr_files) || return 2
  while IFS=$'\t' read -r new old; do
    test -n "$new" || continue
    any=true
    is_housekeeping "$new" || return 1
    # A rename is only housekeeping if the path it LEFT was housekeeping too.
    if [ -n "$old" ]; then is_housekeeping "$old" || return 1; fi
  done <<< "$files"
  # An empty diff is not a docs diff; refuse to vouch for it.
  test "$any" = true || return 1
  # The after-the-diff recheck: a force-push or retarget landing between the
  # pin and the files call would put the REPLACEMENT's diff under the pinned
  # snapshot's verdict. Movement refuses the skip; the next event's own run
  # judges the new state.
  still_pinned
}

# On the docs lane every commit subject must carry a housekeeping prefix. A
# commits listing that cannot be completed fails the lint — an unverified
# prefix is not a verified one.
lint_prefixes() {
  local declared subjects listed bad=0 subject
  # Same reconciliation as pr_files, for the same reason: the commits
  # endpoint stops at 250 commits and exits cleanly, so an unprefixed
  # subject past the cap would simply never be seen. The PR's own commit
  # count says how many there are supposed to be.
  declared=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.commits') || {
    echo "::error::Could not read the pull request's commit count — the prefix rule cannot be verified."
    return 1
  }
  # Parent count travels with each subject so merge commits are identified
  # structurally — a docs commit whose subject merely starts with "Merge "
  # is not a merge commit and gets no exemption.
  subjects=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}/commits" --paginate \
               --jq '.[] | [(.parents | length), (.commit.message | split("\n")[0])] | @tsv') || {
    echo "::error::Could not enumerate the pull request's commits — the prefix rule cannot be verified."
    return 1
  }
  if [ -z "$subjects" ]; then
    echo "::error::Commit enumeration returned nothing — the prefix rule cannot be verified."
    return 1
  fi
  listed=$(printf '%s' "$subjects" | grep -c . || true)
  if [ "$listed" -ne "$declared" ]; then
    echo "::error::Commit list incomplete: listed ${listed} of ${declared} commits (the API caps at 250) — the prefix rule cannot be verified."
    return 1
  fi
  local parents
  while IFS=$'\t' read -r parents subject; do
    # Merge commits are exempt — the repo rebase-merges, so they never land
    # on main — and a merge commit is one with more than one parent, not one
    # whose subject happens to start with the word.
    if [ "${parents:-1}" -gt 1 ]; then continue; fi
    if has_lane_prefix "$subject"; then continue; fi
    echo "::error::Docs-lane commit subject lacks a housekeeping prefix:" \
         "'${subject}' — prefix it ($(printf '%s:/' $LANE_PREFIXES | sed 's,/$,,'))" \
         "so it never reads like a behavior-change subject."
    bad=1
  done <<< "$subjects"
  return "$bad"
}

# On a dispatched run the named PR must BE the checked-out commit: `--ref`
# selects the branch and `-f pr=` supplies the input independently, so
# nothing else stops a dispatch on code PR A's branch from naming docs PR B
# and landing B's clean verdict on A's head SHA. Verified in BOTH modes —
# classify failing already cascades to a red gate, and gate re-checks so the
# required check never reports for a commit the named PR does not head.
# (Kept in the shared engine even where a repo's workflow declares no
# dispatch trigger: engines stay identical, and a trigger added later is
# born guarded.)
verify_dispatch_binding() {
  test "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" || return 0
  # An unnamed PR cannot be verified, so it is refused — unless the repo's
  # config says a PR-less dispatch is legitimate here (deploy-force on the
  # default branch), in which case docs_only classifies it as code and the
  # full lane runs.
  if [ -z "${PR:-}" ]; then
    if dispatch_without_pr_ok; then return 0; fi
    echo "::error::A dispatched run must name the pull request it reports for (the pr input) — refusing without one."
    return 1
  fi
  local head
  head=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.head.sha') || {
    echo "::error::Could not read PR #${PR}'s head SHA — refusing to report for it."
    return 1
  }
  if [ "$head" != "${GITHUB_SHA:?}" ]; then
    echo "::error::Dispatched commit ${GITHUB_SHA} is not PR #${PR}'s head (${head}) — a verdict computed for one pull request must not label another's commit."
    return 1
  fi
  # SHA equality alone is not a complete association: a commit can head more
  # than one open PR (same branch, different bases), and a check run is
  # per-commit, so a gate minted for the docs PR would satisfy the code PR
  # too. Require the named PR to be the ONLY open PR this commit heads;
  # ambiguity is refused rather than resolved, the fail-closed direction.
  local heads
  heads=$(open_prs_heading "${GITHUB_SHA}") || {
    echo "::error::Could not list the pull requests this commit heads — refusing to report for it."
    return 1
  }
  if [ "$(printf '%s' "$heads" | grep -c .)" -ne 1 ] || [ "$(printf '%s' "$heads" | head -n1)" != "$PR" ]; then
    echo "::error::Commit ${GITHUB_SHA} heads these open pull requests: $(printf '%s' "$heads" | tr '\n' ' ')— a per-commit gate cannot vouch for exactly one, so a dispatched run refuses to report."
    return 1
  fi
}

case "${1:?usage: docs-lane.sh classify|gate}" in
  classify)
    verify_dispatch_binding || exit 1
    # Any failure to establish docs-only — code paths, an untrustworthy file
    # list, a non-PR event — classifies as code: the heavy jobs run, which is
    # always the safe direction. The gate is where an unjustified SKIP fails.
    if docs_only; then echo "docs_only=true"; else echo "docs_only=false"; fi
    ;;
  gate)
    verify_dispatch_binding || exit 1
    verify_event_binding || exit 1
    # Results arrive via env: CLASSIFY (needs.classify.result) and RESULTS —
    # space-separated `job=result` pairs for every heavy job, supplied by the
    # workflow so the engine needs no per-repo job names.
    if [ "${CLASSIFY:?}" != "success" ]; then
      echo "::error::classify did not succeed (result: ${CLASSIFY}) — nothing vouches for this diff."
      exit 1
    fi
    all_success=true
    all_skipped=true
    for pair in ${RESULTS:?}; do
      case "${pair#*=}" in
        success) all_skipped=false ;;
        skipped) all_success=false ;;
        *) all_success=false; all_skipped=false ;;
      esac
    done
    if [ "$all_success" = true ]; then
      exit 0
    fi
    if [ "$all_skipped" = true ]; then
      # The skip is only as good as the reason for it: re-derive the
      # classification here, independently of the output that caused it.
      # docs_only's failure modes (code file, truncated or unlistable file
      # list) all land here as a refusal.
      if ! docs_only; then
        echo "::error::Heavy jobs were skipped but the diff could not be verified as housekeeping-only — refusing the skip."
        exit 1
      fi
      lint_prefixes
      # The lint read the commit list AFTER docs_only's own recheck; a
      # force-push in that window would have the replacement's subjects
      # vouch for the pinned commit. One more settlement check closes it.
      if ! still_pinned; then
        echo "::error::The pull request moved while the gate was reading it — refusing the skip."
        exit 1
      fi
      exit 0
    fi
    echo "::error::Heavy job results '${RESULTS}' — not all green, and not a justified skip."
    exit 1
    ;;
  *)
    echo "unknown mode: $1" >&2
    exit 2
    ;;
esac
