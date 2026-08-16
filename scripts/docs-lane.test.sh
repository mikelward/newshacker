#!/usr/bin/env bash
# Tests for scripts/docs-lane.sh, run by the classify job before it
# classifies anything — so a broken lane rule fails the workflow closed
# instead of skipping the heavy jobs on a diff nobody actually checked.
#
# The harness stubs `gh` on PATH: fixtures arrive as environment variables
# (FILES, SUBJECTS, CHANGED to override the changed_files count, *_FAIL to
# simulate API failures). Its own failure mode is a false pass, so every
# behavior is asserted in both directions — the case that must succeed and
# the case that must be refused.
set -u

here=$(cd "$(dirname "$0")" && pwd)
stub=$(mktemp -d)
cat > "$stub/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"/files"*)
    [ "${FILES_FAIL:-0}" = 1 ] && exit 1
    # Fixture entries are "newpath" or "newpath:oldpath" (a rename); emit the
    # same TSV shape the real --jq produces.
    for f in $FILES; do
      new=${f%%:*}; old=""
      [ "$f" = "$new" ] || old=${f#*:}
      printf '%s\t%s\n' "$new" "$old"
    done
    ;;
  *"/commits/"*"/pulls"*)
    [ "${PULLS_FAIL:-0}" = 1 ] && exit 1
    # Space-separated fixture of open-PR numbers heading this commit.
    # Counted like the head reads, so a fixture can open a twin PR on the
    # same commit mid-run (from the PULLS_AFTER-th read onward the stub
    # answers "1 2").
    n=$(cat "$STUB_DIR/pulls" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STUB_DIR/pulls"
    if [ -n "${PULLS_AFTER:-}" ] && [ "$n" -ge "$PULLS_AFTER" ]; then set -- 1 2; else set -- ${SHARED_PRS:-$PR}; fi
    for p in "$@"; do printf '%s
' "$p"; done
    ;;
  *"/git/ref/heads/"*"#"*)
    # A literal fragment character reaching the API means the engine failed
    # to escape the ref — fail loudly so the encoding stays asserted.
    echo "unescaped ref in URL" >&2
    exit 1
    ;;
  *"/git/ref/heads/"*)
    # The live tip of a (stacked) base branch.
    [ "${TIP_FAIL:-0}" = 1 ] && exit 1
    echo "${BASE_TIP:-basesha}"
    ;;
  *"/commits"*)
    [ "${COMMITS_FAIL:-0}" = 1 ] && exit 1
    # Fixture lines are "subject" (one parent) or "N:subject"; emit the same
    # parent-count TSV the real --jq produces.
    printf '%s
' "$SUBJECTS" | while IFS= read -r s; do
      case "$s" in
        [0-9]:*) printf '%s	%s
' "${s%%:*}" "${s#*:}" ;;
        *) printf '1	%s
' "$s" ;;
      esac
    done
    ;;
  *"/git/ref/heads/"*)
    # The live tip of a (stacked) base branch.
    [ "${TIP_FAIL:-0}" = 1 ] && exit 1
    echo "${BASE_TIP:-basesha}"
    ;;
  *"/commits"*)
    [ "${COMMITS_FAIL:-0}" = 1 ] && exit 1
    # Fixture lines are "subject" (one parent) or "N:subject"; emit the same
    # parent-count TSV the real --jq produces.
    printf '%s\n' "$SUBJECTS" | while IFS= read -r s; do
      case "$s" in
        [0-9]:*) printf '%s\t%s\n' "${s%%:*}" "${s#*:}" ;;
        *) printf '1\t%s\n' "$s" ;;
      esac
    done
    ;;
  *".head.sha"*)
    [ "${HEAD_FAIL:-0}" = 1 ] && exit 1
    # Reads are counted so a fixture can move the head mid-run: from the
    # HEAD_AFTER-th read onward the stub answers `otherhead` instead.
    n=$(cat "$STUB_DIR/heads" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STUB_DIR/heads"
    if [ -n "${HEAD_AFTER:-}" ] && [ "$n" -ge "$HEAD_AFTER" ]; then echo "otherhead"; else echo "${HEAD_SHA:-headsha}"; fi
    ;;
  *".base.ref"*)
    [ "${BASE_FAIL:-0}" = 1 ] && exit 1
    # Same counting for the base, so a fixture can retarget mid-run.
    n=$(cat "$STUB_DIR/bases" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STUB_DIR/bases"
    if [ -n "${BASE_AFTER:-}" ] && [ "$n" -ge "$BASE_AFTER" ]; then echo "other"; else echo "${BASE_REF:-main}"; fi
    ;;
  *".changed_files"*)
    if [ -n "${CHANGED:-}" ]; then echo "$CHANGED"; else echo $FILES | wc -w; fi
    ;;
  *".commits"*)
    if [ -n "${NCOMMITS:-}" ]; then echo "$NCOMMITS"; else printf '%s' "$SUBJECTS" | grep -c .; fi
    ;;
esac
EOF
chmod +x "$stub/gh"
export STUB_DIR="$stub" PATH="$stub:$PATH" GITHUB_REPOSITORY=example/repo PR=1 GITHUB_EVENT_NAME=pull_request GITHUB_SHA=headsha EVENT_HEAD=headsha EVENT_BASE_REF=main GITHUB_REF_NAME=claude/topic

fails=0
check() {
  local desc=$1 want_exit=$2 want_out=$3 got got_exit
  shift 3
  rm -f "$stub/heads" "$stub/bases" "$stub/pulls"
  # Invoked exactly as CI invokes it — directly, not via `bash` — so a
  # missing executable bit fails here, before a push, instead of as a
  # Permission denied in the classify job.
  got=$(env "$@" "$here/docs-lane.sh" "${MODE:-classify}" 2>&1)
  got_exit=$?
  if [ "$got_exit" -ne "$want_exit" ]; then
    echo "FAIL: $desc — exit $got_exit, wanted $want_exit"; echo "$got" | sed 's/^/    /'
    fails=1
  elif [ -n "$want_out" ] && ! printf '%s' "$got" | grep -qF "$want_out"; then
    echo "FAIL: $desc — output lacks '$want_out'"; echo "$got" | sed 's/^/    /'
    fails=1
  else
    echo "ok: $desc"
  fi
}

# --- classify: the rule itself, both directions per shape
check "markdown-only diff is docs"        0 "docs_only=true"  FILES="README.md SPEC.md"
check "code file makes it code"           0 "docs_only=false" FILES="README.md src/App.tsx"
check "markdown under src/ is a build input" 0 "docs_only=false" FILES="src/notes.md"
check "markdown under api/ is a build input" 0 "docs_only=false" FILES="api/notes.md"
check "markdown under public/ ships verbatim" 0 "docs_only=false" FILES="public/help.md"
check ".gitignore is code like any config" 0 "docs_only=false" FILES=".gitignore README.md"
check "a shared head never rides the docs lane" 0 "docs_only=false" FILES="README.md" SHARED_PRS="1 2"
check "a lone foreign head PR never rides the lane" 0 "docs_only=false" FILES="README.md" SHARED_PRS="2"
check "a run outlived by a force-push is code"  0 "docs_only=false" FILES="README.md" HEAD_SHA=otherhead
check "a swap after the diff read is code" 0 "docs_only=false" FILES="README.md" HEAD_AFTER=2
check "a retargeted run is code"           0 "docs_only=false" FILES="README.md" BASE_REF=other
check "a retarget after the diff read is code" 0 "docs_only=false" FILES="README.md" BASE_AFTER=2
check "unreadable base is not docs"        0 "docs_only=false" FILES="README.md" BASE_FAIL=1
check "a twin PR after the diff read is code" 0 "docs_only=false" FILES="README.md" PULLS_AFTER=2
check "docs on a stacked base still ride the lane" 0 "docs_only=true" FILES="README.md" EVENT_BASE_REF=claude/lower BASE_REF=claude/lower EVENT_BASE_SHA=basesha
check "a force-pushed stacked base is code" 0 "docs_only=false" FILES="README.md" EVENT_BASE_REF=claude/lower BASE_REF=claude/lower EVENT_BASE_SHA=basesha BASE_TIP=movedsha
check "an unreadable stacked-base tip is not docs" 0 "docs_only=false" FILES="README.md" EVENT_BASE_REF=claude/lower BASE_REF=claude/lower EVENT_BASE_SHA=basesha TIP_FAIL=1
check "a base ref with a fragment character still resolves" 0 "docs_only=true" FILES="README.md" EVENT_BASE_REF=claude/lower#1 BASE_REF=claude/lower#1 EVENT_BASE_SHA=basesha
check "unlistable head PRs are code on a PR event" 0 "docs_only=false" FILES="README.md" PULLS_FAIL=1
check "an unnamed dotfile is code"         0 "docs_only=false" FILES=".editorconfig"
check ".claude contents are code"          0 "docs_only=false" FILES=".claude/hooks/session-start.sh"
check "markdown is docs even under a dot-directory" 0 "docs_only=true" FILES=".claude/NOTES.md"
check "workflow edits are code"           0 "docs_only=false" FILES=".github/workflows/ci.yml"
check "empty diff is not docs"            0 "docs_only=false" FILES="" CHANGED=0
check "non-PR events are code"            0 "docs_only=false" FILES="README.md" GITHUB_EVENT_NAME=push

# --- classify: a dispatched run judges the PR its input names, or nothing
check "dispatch naming a PR classifies it" 0 "docs_only=true"  FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch
check "PR-less dispatch is refused"        1 "must name the pull request" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch PR=
check "PR-less dispatch is refused even on main" 1 "must name the pull request" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch PR= GITHUB_REF_NAME=main
check "shared head is refused"             1 "cannot vouch for exactly one" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch SHARED_PRS="1 2"
check "unlistable head PRs are refused"    1 "refusing to report" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch PULLS_FAIL=1
check "dispatch for another PR's commit refused" 1 "must not label" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch HEAD_SHA=otherhead
check "unreadable head refuses the dispatch" 1 "refusing to report" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch HEAD_FAIL=1

# --- classify: renames are judged on both sides
check "md-to-md rename stays docs"        0 "docs_only=true"  FILES="NEW.md:OLD.md"
check "code renamed into docs is code"    0 "docs_only=false" FILES="A.md:src/a.ts"

# --- classify: an untrustworthy file list must never classify as docs
check "truncated file list is not docs"   0 "docs_only=false" FILES="README.md" CHANGED=3000
check "files API failure is not docs"     0 "docs_only=false" FILES="README.md" FILES_FAIL=1

# --- gate: every verdict combination (RESULTS carries the heavy jobs)
export MODE=gate
ALLOK="build=success"
ALLSKIP="build=skipped"
check "all heavy jobs green passes"       0 "" FILES="src/a.ts" CLASSIFY=success RESULTS="$ALLOK"
check "justified skip with prefixes"      0 "" FILES="README.md" SUBJECTS="docs: Fix a typo" CLASSIFY=success RESULTS="$ALLSKIP"
check "deps prefix rides the lane"        0 "" FILES="TODO.md" SUBJECTS="deps: Update dependencies (2026-08-16)" CLASSIFY=success RESULTS="$ALLSKIP"
check "merge commits are exempt"          0 "" FILES="README.md" SUBJECTS="2:Merge branch 'main' into x" CLASSIFY=success RESULTS="$ALLSKIP"
check "a fake merge subject is not exempt" 1 "lacks a housekeeping prefix" FILES="README.md" SUBJECTS="Merge installation sections" CLASSIFY=success RESULTS="$ALLSKIP"
check "bare subject fails the lane"       1 "lacks a housekeeping prefix" FILES="README.md" SUBJECTS="Fix a typo" CLASSIFY=success RESULTS="$ALLSKIP"
check "a prefix outside the table fails"  1 "lacks a housekeeping prefix" FILES="README.md" SUBJECTS="internal: tidy" CLASSIFY=success RESULTS="$ALLSKIP"
check "a dispatched skip still lints"     1 "lacks a housekeeping prefix" FILES="README.md" SUBJECTS="Fix a typo" CLASSIFY=success RESULTS="$ALLSKIP" GITHUB_EVENT_NAME=workflow_dispatch
check "gate refuses a mis-bound dispatch"  1 "must not label" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" GITHUB_EVENT_NAME=workflow_dispatch HEAD_SHA=otherhead
check "gate refuses a shared head"         1 "cannot vouch for exactly one" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" GITHUB_EVENT_NAME=workflow_dispatch SHARED_PRS="1 2"
check "skip on a code diff is refused"    1 "refusing the skip" FILES="src/a.ts" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP"
check "a shared head cannot earn a gate"  1 "cannot vouch for exactly one" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" SHARED_PRS="1 2"
check "a foreign PR's head cannot earn a gate" 1 "cannot vouch for exactly one" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" SHARED_PRS="2"
check "gate refuses a run outlived by a force-push" 1 "own run owns the verdict" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" HEAD_SHA=otherhead
check "skip after a mid-read swap is refused" 1 "refusing the skip" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" HEAD_AFTER=2
check "gate refuses a retargeted run"     1 "own run owns the verdict" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" BASE_REF=other
check "skip after a mid-read retarget is refused" 1 "refusing the skip" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" BASE_AFTER=2
check "skip after a post-lint swap is refused" 1 "moved while the gate was reading" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" HEAD_AFTER=4
check "skip after a late twin PR is refused"   1 "refusing the skip" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" PULLS_AFTER=2
check "gate refuses a force-pushed stacked base" 1 "own run owns the verdict" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" EVENT_BASE_REF=claude/lower BASE_REF=claude/lower EVENT_BASE_SHA=basesha BASE_TIP=movedsha
check "docs on a stacked base pass the gate" 0 "" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" EVENT_BASE_REF=claude/lower BASE_REF=claude/lower EVENT_BASE_SHA=basesha
check "green results from an outlived run are refused" 1 "own run owns the verdict" FILES="src/a.ts" CLASSIFY=success RESULTS="$ALLOK" HEAD_SHA=otherhead
check "green results from a retargeted run are refused" 1 "own run owns the verdict" FILES="src/a.ts" CLASSIFY=success RESULTS="$ALLOK" BASE_REF=other
check "green results on a shared head are refused" 1 "cannot vouch for exactly one" FILES="src/a.ts" CLASSIFY=success RESULTS="$ALLOK" SHARED_PRS="1 2"
check "a push run's green gate reports"   0 "" FILES="src/a.ts" CLASSIFY=success RESULTS="$ALLOK" GITHUB_EVENT_NAME=push
check "skip on a truncated list refused"  1 "refusing the skip" FILES="README.md" CHANGED=3000 SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP"
check "commits API failure fails lint"    1 "cannot be verified" FILES="README.md" COMMITS_FAIL=1 CLASSIFY=success RESULTS="$ALLSKIP"
check "truncated commit list fails lint"  1 "Commit list incomplete" FILES="README.md" SUBJECTS="docs: x" NCOMMITS=300 CLASSIFY=success RESULTS="$ALLSKIP"
check "red job fails the gate"            1 "not all green" FILES="src/a.ts" CLASSIFY=success RESULTS="build=failure"
check "cancelled job fails the gate"      1 "not all green" FILES="src/a.ts" CLASSIFY=success RESULTS="build=cancelled"
check "failed classify fails the gate"    1 "nothing vouches" FILES="src/a.ts" CLASSIFY=failure RESULTS="$ALLSKIP"

rm -rf "$stub"
if [ "$fails" -ne 0 ]; then echo "docs-lane tests FAILED"; exit 1; fi
echo "docs-lane tests passed"
