---
trigger: always_on
alwaysApply: true
last_modified: 2026-10-22
---

# AGENTS.md

`CLAUDE.md` and `GEMINI.md` are symlinks to this file. Edit `AGENTS.md` and bump
`last_modified`.

**At the start of every session, print the full absolute path of the `AGENTS.md` you
loaded and its `last_modified` date**, so a stale or wrong copy is caught first.

Keep this file short — one-liners over essays, **under 24,000 bytes** (`wc -c AGENTS.md`):
Antigravity caps rule files at 24 KB and silently truncates the tail. State the rule and
the *why* in the fewest words; add a rule the first time something bites, rewrite or trim
rather than append, delete rules that stopped biting. Incident narratives belong in
commits; background and history in `AGENTS-REFERENCE.md`.

## Project at a glance

- **newshacker**: an unofficial mobile-friendly reader *for* Hacker News, not affiliated
  with Y Combinator; `newshacker.app` (`hnews.app` 301s to it). Never call the app "Hacker
  News" or use HN's logo as its icon; copy may name HN as the source.
- **React + TypeScript + Vite** on **Vercel**, auto-deployed on push; a docs-only change
  (per `.github/lanes.conf`) skips the build via `scripts/vercel-ignore.mjs`, except a
  branch's first preview, and fails open, saying why in the build log.

## Golden rules

1. **Always add tests**: every new function, hook, component or serverless handler; a bug
   fix gets a regression test that fails before the fix.
2. **Always run tests automatically**: `npm test` (plus `npm run lint` / `npm run build`
   when relevant) passes before you report done.
3. Prefer editing existing files to creating new ones; no new docs/README unless asked.
4. Mobile-first; brand orange `#ef5f00` (darker than HN's `#ff6600`) on cream `#f6f6ef`.
5. **Fewer, larger tap targets.** A story row has at most three tap zones — row body
   (stretched link) left, pin right, one reserved slot between; two are shipped. No inline
   text links in metadata rows. **Min 44×44px per touch target** (HIG 44pt / WCAG 2.5.5
   AAA), ≥8px apart (≥12px title-to-pin); story rows 48px (*Story row layout*, `SPEC.md`).
   Push back on or flag a fourth tappable or a filled reserved slot.
   - Per-story actions without a row zone (Favorite; Upvote, logged-in only) go in the thread
     action bar beside Pin (*Thread action bar*, `SPEC.md`): **44px on touch, 36px on
     pointer** (below the floor only because a cursor needs no fingertip target).
6. **Prefer HN's API + stateless Vercel functions.** A shared store (Vercel KV, Upstash) or
   scheduled job needs clear justification (rate limiting, cache warming, abuse mitigation)
   and rule 11's note up front; no database where localStorage, the edge CDN cache or a
   stateless function would do.
7. Don't implement flagging, moderation, submitting stories, or submitting comments.
8. **US English everywhere** — copy, identifiers, CSS classes, localStorage keys, comments.
9. **Pinned ≠ Favorite.** Pinned (📌, row) is the active reading list: explicit pin/unpin,
   no auto-pruning. Favorite (heart, thread page) is permanent: never swept or expired.
   Independent stores, hooks and UI; keys `newshacker:pinnedStoryIds`,
   `newshacker:favoriteStoryIds`.
10. **Keep `SPEC.md` in sync**: reversing a documented decision or adding anything
    non-trivial (behavior, tap target, storage key, layout reorder, route) updates `SPEC.md`
    in the same commit.
11. **Call out cost and reliability up front** for new infrastructure or external calls
    (another HN fetch, third-party API, serverless invocation): free-tier vs. paid,
    $/month at expected traffic, failure modes, rate limits, latency, and what the user
    sees when it's down. Say so if negligible.
12. **Sensitive operator data lives behind `/admin` only** (billing balances, quotas, vendor
    credentials, wallet state — anything awkward for any signed-in user to see): `/admin`
    and `/api/admin`, never `/debug`, `HeaderAccountMenu`, drawer pages, contributor-readable
    logs, or an "admin-ish" endpoint. `/debug` is public: booleans and latency only. Keep and
    extend the no-leak tests (`status.test.ts` § "does not leak env var values").
13. **Only the HN-verified admin can view `/admin`.** A `hn_session` cookie claim is
    forgeable, so `/api/admin` round-trips to news.ycombinator.com, parses HN's "logged in
    as X", and serves data only when it is `ADMIN_USERNAME`; a cookie-prefix check is a bug.
    Fail closed: HN unreachable or verification throws → 503, never 200. Never link the page
    publicly.

## Building and testing

- `npm install`, `npm run dev`, `npm test`, `npm run test:coverage` (what CI runs),
  `npm run test:watch`, `npm run lint`, `npm run typecheck`, `npm run build`; add a missing
  one to `package.json` with your change.
- Vitest + React Testing Library + jsdom; MSW for Firebase/HN; serverless tests call the
  handler with a mocked `Request`/`Response` and mocked `fetch`.
- **Coverage floor 80%** for `src/lib/` and `api/` (`coverage.thresholds`, lines per area);
  `api/` branch/function coverage is still under it — raise those metrics as it closes;
  never lower the floor.
- **Before done:** `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build` when
  touching build config, routing or deploy. **Never disable a failing check.**
- **Fix preexisting failures as the first commit**; skipping one as unrelated needs the
  user's confirmation — never report done on a red tree.
- **No sleeps, retries or bumped `findBy*` timeouts** for racy tests: controlled promises,
  fake timers, `act(...)`, or a gated fetch (`gateFetchOn` in `Thread.test.tsx`).

## Code style

- TypeScript `strict`, no `any` without a comment; function components + hooks; CSS Modules
  or plain CSS, no UI kits; components < ~150 lines; comments explain *why*.
- **New interactive buttons use `<TooltipButton>`** (long-press `tooltip`, cross-browser
  fixes). Icon-only ones MUST set `aria-label` or a `visually-hidden` caption; text buttons
  may stay native `<button>`.

## CSS gotchas

- **Sticky `:hover` on touch**: wrap painting `:hover` rules in `@media (hover: hover)` and
  keep `:active` outside (`.story-row__body` in `src/components/StoryListItem.css`).

## Architecture notes

- Read path: client → Firebase HN API, no server. Write path: client → `/api/*` →
  news.ycombinator.com, with HN's `user` cookie in our own HTTP-only cookie, never exposed to
  client JS. Voting scrapes the per-user, per-item `auth` token from the item page first.

## Vercel `api/` gotchas

- **No shared modules for `api/*.ts` — inline helpers, even duplicated**, with a comment
  naming the siblings. Imports from outside `api/` or a `_`-prefixed directory both broke
  *only at deploy time* (`ERR_MODULE_NOT_FOUND`), and `api/lib/` would route each file as a
  function. `api/imports.test.ts` guards it; delete it only after a new approach is proven on
  a Vercel preview.

## Talking to the user

- **One question at a time** — in plain chat or the client's question tool
  (`AskUserQuestion` in Claude Code, `ask_question` in Antigravity). Stop and wait; don't
  proceed on an assumed answer, pick a "recommended" option, or keep working on what it
  affects. Never ask while the user is typing.
- **Answer a mid-turn message first**, before any further tool call (except a merge cue,
  whose hygiene runs first and whose announced switch is the answer).
- **Message only when the user needs to see it** (maintainer, 2026-10-15): each notifies
  their phone. Work in silence; speak up for a question/blocker, something to merge or act
  on, a merge, an autopilot decision (to review when seen, never waited on), or a change
  from the plan, `SPEC.md` or their instructions (review-prompted included). Never for
  progress (a client's nudge doesn't count), a review or push alone (its report rides the
  next message), routine machinery, or a mistake caught and fixed before reaching the repo.
  The session-start `AGENTS.md` line still opens every session.
- **Keep replies short**: lead with the most important point; ask before unloading more.
- **End the turn by restating any pending decision** — the last line is the question (or
  autopilot guess) you are waiting on, written out, every turn until answered, with the
  open-PR link just above it. Nothing pending, no line. A scheduled check that finds nothing
  new re-arms silently and sends no reply.

## Error handling

- **Don't silently swallow exceptions.** Every catch **logs** the error with sanitized
  context ("vote on item 123 failed: 403" — never a cookie, token, `auth` param, key or
  raw body), **cleans up** what `try` acquired (abort controllers, in-flight fetches,
  partial writes, UI state), and **handles the edge case explicitly** (default, `null`,
  typed error, rethrow). Narrow the type or check `signal.aborted` so a deliberate
  `AbortError` isn't swallowed. To ignore a failure on purpose, say why in a one-line
  comment and still log at debug.

## Privacy

- **Never put user data in any artifact leaving this machine** (commits, PRs, replies,
  issues, branches, comments, fixtures, logs): the operator's HN username, `hn_session` / HN
  `user` cookie, `ADMIN_USERNAME`, API keys, vendor credentials, billing or quota figures.
  Use placeholders (`hnuser`, `sk-example`, `$0.00`); paraphrase bug reports; ask when in
  doubt.

## Safe vs. risky actions

- **Safe**: editing, adding dependencies, running tests or the dev server, creating
  `<agent>/` branches, opening PRs, `--force-with-lease` to your own live branch after a
  rebase, replying to and resolving review threads on your own PRs.
- **Ask first**: force-pushing `main`/`master` or a merged branch (resetting a merged name
  included), rewriting shared history, deleting a branch outside your prefix or not this
  session's, changing Vercel project settings or CI secrets, adding paid/third-party services.

## Commit messages

- Plain-English sentence-case subject, ≤ ~70 chars incl. prefix; mechanism and file:line in
  the body (a commit with nothing to explain, like the weekly batch, needs none).
- **Prefix a subject that doesn't change what the app does**: `docs:` (prose, `SPEC.md`,
  this file), `todo:` (`TODO.md` alone), `test:`, `build:` (toolchain, CI, lint/build
  config, `scripts/`), `refactor:`. Bare means a user could notice. No `feat:`/`fix:`, and
  no `deps:` — a dependency bump, the weekly batch included, is bare.
- `TODO.md` and `SPEC.md` ride along and decide the prefix only when they are the whole
  change. A mixed commit goes bare if any part changes behavior; below that the prefix says
  why the commit exists (a toolchain pin that edits its guides is `build:`). Two independent
  categories are two commits.
- **No model identifier** — never name the coding agent's model or version (`Opus 4.8`,
  `Sonnet`, `Gemini …`, `claude-*`, `gemini-*`) in a commit, PR, comment, or pushed
  artifact; keep it to chat. A model the product calls (the summaries' Gemini model ID) is
  not covered. Generic attribution (`Co-Authored-By: Claude` / `Gemini`, `Claude-Session:`,
  "Generated with Claude Code") is fine.

## Branching

- **`<agent>/<short-topic>` off `origin/main` → PR → rebase-merge** (`claude/…` Claude Code,
  `gemini/…` Gemini / Antigravity, `codex/…` Codex, `cursor/…` Cursor — use your own, not
  `claude/` unless you are Claude Code; humans pick theirs). One topic per branch;
  never commit to `main`. Squash merging is off, so commit subjects land, never the PR title.
- **Give the PR title the prefix a commit would carry**, judged over the whole branch on
  every push (convention only; `lint-title no` in `.github/lanes.conf`).
- `git worktree` per branch when available. **One commit per logical change**: rewrite
  unmerged commits so fix-ups and review responses fold into their commit.
- **Check the branch's PR before you push or branch.** None or open → push
  (`--force-with-lease` after a rebase, unasked). Merged/closed → don't push; run merge
  hygiene — except a sandbox-pinned name already reset onto `origin/main`, which is new
  work: push it with `--force-with-lease`.
- **Merge cue (`merged` / `I merged` / `landed` / merge webhook) runs hygiene first**:
  `git fetch origin +refs/heads/main:refs/remotes/origin/main` (`git fetch origin main`
  leaves single-branch `origin/main` stale), cut a fresh `<agent>/<short-topic>` off
  `origin/main`, announce the switch; without a remote, ask for a synced checkout instead.
- **After a merge take a fresh branch**, not the merged name reset (its remote ref keeps
  spanning merged commits). **When a sandbox pins the name, say so and ask before resetting
  it**: nothing short tells merged from unmerged, and a fetch defeats `--force-with-lease`.
- **Your `<agent>/` branches are yours** — create, push, force-with-lease, rename, delete
  the ones this session created or was assigned (this file is the standing grant); don't
  fold unrelated work into a pinned branch. Others and `main` need asking. The sandbox proxy
  can't delete branches (403): flag it.
- **Committer line**: the agent authors; rebase merges rewrite the committer to the
  merger — expected; never re-author, amend or mention it. Not a finding.
- **No remote** (Codex cloud): work from HEAD on this task's own branch, cut from a base free
  of earlier work (else ask for a synced checkout); commit locally, say fetch/push/PR were
  unavailable, claim nothing about unseen remote state.
- **Unshallow before history-depth answers** (`git rev-list --count`, `git log`, blame): the
  session-start hook runs `scripts/unshallow.sh` only in Claude Code; elsewhere run it (or
  `git fetch --unshallow`); with no remote, say history is truncated.
- **After every push and merge, report the SHA** for `/debug`'s `build` field: `pushed
  <short-sha>` or `merged at <short-sha>` (the commit on `origin/main`), once, last push only.
- **Update the PR title and body before each push** (body first) to match the whole
  branch, then print the PR link; with no PR yet, push, then do it as soon as one is opened. **End every reply with the open-PR link** (or
  `.../compare/main...<branch>`), never a closed or merged one; no remote: say it's local.

## Autonomy

- **Open the PR without being asked**, ready for review (this file is the standing
  request), unless told "just commit / no PR yet" (holds until lifted).
- **Watch your own PRs by subscription + one scheduled check.** Subscribe on open
  (automatic in Claude Code, or `subscribe_pr_activity` where `claude-code-remote` exposes
  it; a client with neither, like Antigravity, relies on the scheduled check alone); it
  misses CI success, pushes, the merge and Codex's `+1`, so keep exactly one
  relative-delay check armed (`send_later` in Claude Code; `schedule` with
  `DurationSeconds` in Antigravity, canceled via `manage_task` `kill`): minutes while CI
  or Codex is out, longer once only a human is left. Settle a fired check first; re-time a
  wrong fire time; name the PR, not a SHA. Under drive, arm auto-merge at open only where
  the ruleset requires the Codex verdict AND resolved conversations.
- **Read `mergeable_state` at every check, wake and drive step**: `dirty`, or `behind`
  where required, means fetch base and head by refspec (unshallow), confirm your branch
  has every remote head commit, rebase onto the fetched `origin/<base>`, and push
  `--force-with-lease --force-if-includes` unasked (rejected: integrate their tip, retry).
  Unsure: stop and ask.
- **Wake PRs a merge leaves behind.** First turn after your PR merges, message every other
  open PR on that base whose body ends with a session URL: name that PR and say only that
  its base now points at `<sha>`, whatever its state reads (name no merge or other PR). On
  receipt, fetch base and PR head by refspec (unshallow) and test against the fetched tip,
  not `<sha>`: `behind` if `git merge-base --is-ancestor <tip> <head>` exits 1, `dirty` if
  `git merge-tree --write-tree` (Git 2.38+) exits 1; any other exit is a failure to report.
  Skip with no session URL or local-only messaging; don't retry a failed send.
- **On merge/close**, take one last reply-and-resolve pass; real work on a merged PR goes
  to a follow-up PR named on the thread (closed-unmerged: open nothing). Then cancel the
  check and unsubscribe, if subscribed; `list_triggers` spans the account, so match
  session and PR.
- **A scheduler, GitHub or `git push` prompt is said once, then carry on.**
- **"Drive"**: loop through actionable `TODO.md` items in `IMPLEMENTATION_PLAN.md` phase
  order (not deferred or awaiting a product decision) — implement, open PR, wait for Codex,
  address every comment, merge on green CI plus Codex's verdict for the head — until the work
  runs out or the user says stop.
- **A red baseline is the next task**: `npm test`, `npm run lint`, `npm run typecheck` green
  before pulling from `TODO.md`; skipping a failure as unrelated needs the user, never a guess.
- **"Autopilot"**: drive without blocking, outranking stop-and-wait — take the
  cheapest-to-undo guess and log it under `TODO.md` *Decisions needing review* (decision,
  alternative, why reversible). The loop's steps (commit, push, PR, checks, merge green)
  are authorized; destructive or irreversible actions outside the loop, anything reaching
  beyond this repo, resetting a pinned merged branch, the ask-first list and privacy
  uncertainty (an HN username, cookie, key, billing figure) wait for a real answer.

## Pull requests and reviews

- Prefer `mcp__github__*` tools where mounted (Claude Code requires them); else `gh`. Open
  PRs ready for review, not draft, unless asked otherwise.
- **Drive to merge**: wait for Codex, address every comment, merge once CI is green, the
  `codex` status is green for the head and no review comment is open — don't ask whether to.
- **Ordered work ("next", "then", "after that", "follow-up")** may open in parallel but merges
  only after every earlier session item and named PR has merged (any repo, no time cap; hold
  and ask if one stalls, autopilot included; no auto-merge until its turn; check the session
  record).
- **Codex is the automated reviewer** (not Copilot), triggered automatically. Address every
  comment unasked (human reviewers' too) — fix and fold into its commit, or decline with a
  sentence of why — then push, reply on each thread citing the sha, and resolve
  (`resolve_review_thread` or `gh api graphql` `resolveReviewThread` takes `PRRT_*`, not
  `PRRC_*`). Never resolve an unanswered thread or dismiss one silently; acknowledgment
  beats silence.
- **Judge comments on merit.** A cited rule is a reading — check what it says; over-strict
  privacy readings quietly cost needed capability. Quote and decline, then poke as below (or
  let the next push); escalate if it re-raises. Rule-vs-need conflicts go to the maintainer.
- **A second verified finding in the same mechanism is a design question**: look for the
  shape elsewhere; a design change is the maintainer's call, autopilot included.
- **Defer an out-of-scope finding** by pushing a `TODO.md` entry, replying with that sha, and
  resolving (a threadless finding skips only the resolve).
- **Read the Codex verdict, don't infer it**: its PR-body reaction (`eyes` reading, `+1`
  clean, revoked on push; `+1` + green CI = merge; leave those reactions to Codex), plus
  `get_review_comments`, `get_comments` and `get_reviews` to the last page; findings block
  the merge until fixed, rebutted or deferred (an acknowledgment isn't an answer). A pending
  `codex` status: address findings; a clean review with no reaction or an unanswered
  rebuttal gets `@codex review` five minutes on; nothing back five minutes after the push,
  or a review stuck at running (👀) ten minutes on, gets a poke. A poke that hangs the same
  way gets a second an hour later; escalate only if that one hangs too, never after one
  (maintainer, 2026-10-22).
- **Once Codex +1s a head, make no unnecessary change without asking** (maintainer,
  2026-10-13); required rebases, red-CI fixes and drive/autopilot steps proceed unasked.
- **Report each review (any reviewer's) in your next message**: commit read (say if no
  longer the head), finding count, one bullet per finding, most blocking first (claim,
  location, action); ask only the most blocking question.
- **List every open PR in a stack, one URL per line.** Skip your own webhook echoes silently.

## CI

- **Wait for CI** before claiming a change works where you can't test locally; don't
  busy-poll. Report a significant CI slowdown (>25% or >30 s on a job under ~5 min) with its
  likely cause.

## Dependency updates

- **The weekly batch lives in mikelward/npm-update**; `.github/workflows/npm-update.yml` is a
  thin caller — fix the mechanism there. Zero dollars; if that repo or `@main` stops
  resolving, the run fails at `uses:` with no PR, visible only in the Actions log.
- **Auto-merge only minors and patches on green CI**; majors and `0.x` wait for review; a
  red or skipped check is a stop sign.
- **Renovate is off** (`"enabled": false`, asserted by `renovate.test.ts`; config kept
  dormant). **Dependabot security updates are off** (2026-09-11; alerts on): act on an
  advisory by hand, bumping peer-pinned partners together (`@vitest/coverage-v8` with
  vitest), unless the weekly batch carried it.
- **`.npmrc` `min-release-age` (5 days) needs npm 11.10.0**, pinned exactly in `engines.npm`
  and `constraints.npm`; raise it only if a later npm is genuinely required and the pinned
  Node major bundles it. `min-release-age-exclude` unblocks an urgent `npm audit fix`.
  Dormant Renovate rules and reasons: `AGENTS-REFERENCE.md`.

## Node version

- **Three pins move together**: `.nvmrc` (CI, `nvm use`, the session-start hook),
  `engines.node` (Vercel) and `@types/node` (`tsc`). `nodeVersion.test.ts` checks them,
  reading `@types/node` as **resolved in the lockfile** (transitive deps hoist newer majors).
  Currently Node **24**; a major is a deliberate migration of all three.
- **`.claude/hooks/session-start.sh`** (auto-invoked only in Claude Code; others run it)
  provisions the newest `.nvmrc` release each run, best-effort. Without `$CLAUDE_ENV_FILE`
  it symlinks `node`/`npm`/`npx` into the first PATH dir under `$HOME` (creating only
  `~/.local/bin`), linking nothing if a tool is missing, an earlier PATH entry supplies one,
  or a real file is in the way; it re-links its own shims.
- **The hook and its test are identical in gedmap, newshacker and readmo**: change all three,
  keeping the Node block byte-identical. The test runs the real hook on `file://` fixtures;
  assert behavior, not structure.
- **Renovate can't bump Node**: `.nvmrc` holds the bare major on purpose. A major waits
  behind `dependencyDashboardApproval`; checking it means migrating now and restoring the bare
  major by hand.

## When in doubt

`SPEC.md` (product), `IMPLEMENTATION_PLAN.md` (phases), `CRON.md` (cron), `INSTALL.md` (env
vars, keys), `OBSERVABILITY.md` (alerting), `AGENTS-REFERENCE.md` (background). On a
conflict with any of them, flag it and ask.
