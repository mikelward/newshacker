# AGENTS.md

Instructions for AI coding agents (Claude Code, etc.) working in this repo.
Keep this file short and concrete — add a new rule the first time something
bites, not the third. Every session loads it whole, so each rule costs context
on every turn: say it once in the fewest words that carry the *why*, rewrite or
trim an existing rule rather than appending beside it, and delete one that has
stopped biting.

## Project at a glance

- **newshacker** — an unofficial mobile-friendly reader *for* Hacker News. Not affiliated with Y Combinator. Primary domain `newshacker.app`; `hnews.app` 301s to it.
- Stack: **React + TypeScript + Vite**, deployed on **Vercel**.
- Stretch goals (login, voting) use **Vercel serverless functions** under `/api`.
- Read data comes from the Firebase HN API; write actions scrape HN's web forms.
- See `SPEC.md` for the product spec and `IMPLEMENTATION_PLAN.md` for the phased plan.
- Never call the app "Hacker News" or use HN's logo as the app icon. "Hacker News" may be referenced in copy as the source (e.g. "a reader for Hacker News").

## Golden rules

1. **Always add tests.** Every new function, hook, component, or serverless handler needs at least one test that exercises its behavior. Bug fixes get a regression test that fails before the fix.
2. **Always run tests automatically.** Before reporting a task as done, run `npm test` (and `npm run lint`, `npm run build` when relevant) and make them pass. Don't hand work back with red tests.
3. Prefer editing existing files to creating new ones. Don't create docs/README files unless asked.
4. Keep the UI mobile-first and the palette brand orange (`#ef5f00`, a slightly darker shade than HN's `#ff6600`) on cream (`#f6f6ef`).
5. **Fewer, larger tap targets.** A story row has at most three possible tap zones — the row body (title + meta as a stretched link) on the left, the pin button on the right, and one reserved slot in between for at most one additional per-row action. The shipped UI uses only two (row body + pin). No inline text links in metadata rows. **Min 44×44px per touch target** (Apple HIG 44pt / WCAG 2.5.5 AAA — the project floor; don't go below it on touch), ≥8px between adjacent targets (≥12px between the title column and the pin button). Story rows sit higher, at 48px. See *Story row layout* in `SPEC.md`; if a change would add a fourth tappable element, or fill the reserved slot, push back or flag it.
   - Corollary: per-story actions that don't already have a row zone (Favorite, Upvote, etc.) live on the thread/comments page's action bar, not on the row. Upvoting is in the thread action bar, logged-in-only, next to Pin and Favorite — see *Thread action bar* in `SPEC.md`. The thread action bar sizes by pointer type: **44px on touch** (at the floor) and **36px on pointer** — the 36px is below the touch floor on purpose, acceptable only because a precise cursor doesn't need a fingertip-sized target.
6. **Prefer HN's API + stateless Vercel functions** for both the read and write paths. A shared backend store (Vercel KV, Upstash, etc.) or a scheduled job is acceptable when clearly justified — rate limiting, scheduled cache warming, and abuse mitigation are the plausible first uses — but it needs the rule 11 cost/reliability note up front, not as an afterthought. Don't reach for a database when localStorage, the edge CDN cache, or a stateless function would do.
7. Don't implement flagging, moderation, submitting stories, or submitting comments.
8. **US English everywhere.** Product copy, identifiers, CSS class names, localStorage keys, and comments all use US spelling (e.g. `favorite`, not `favourite`).
9. **Pinned ≠ Favorite.** Pinned (📌, on the row) is the active reading list — explicit pin, explicit unpin, no auto-pruning. Favorite (heart, on the thread page) is the permanent keepsake — never swept, never expired. Keep the two stores, hooks, and UI paths independent. localStorage keys: `newshacker:pinnedStoryIds`, `newshacker:favoriteStoryIds`.
10. **Keep `SPEC.md` in sync with reality.** Whenever a change reverses or modifies an existing documented decision in `SPEC.md`, or introduces a non-trivial change (new user-visible behavior, new tap target, new storage key, layout reorder, route, etc.), update `SPEC.md` in the same commit. Don't let the spec and the code drift.
11. **Call out cost and reliability up front.** Whenever you recommend new infrastructure (a hosting tier, database, queue, cache, CDN, monitoring service, etc.) or a new external API call (including adding another HN fetch, a third-party API, or a serverless function invocation), include a brief dollar-cost estimate — at minimum, free-tier vs. paid thresholds and a rough $/month at expected traffic — and note reliability implications: new failure modes, rate limits, added latency, extra points of failure, and what happens to the user if the dependency is down. If the cost is effectively zero or the reliability impact is negligible, say so explicitly rather than omitting the note.
12. **Sensitive operator data lives behind `/admin` and nowhere else.** Live billing balances, per-account quotas, upstream vendor credentials, wallet state, and anything else that would be awkward if a random signed-in user saw it must be reachable only through `/admin` (and its backing `/api/admin` endpoint). Don't surface the same data on `/debug`, the `HeaderAccountMenu`, drawer pages, logs that any contributor can read, or a new endpoint that's "admin-ish but easier to wire up". `/debug` is deliberately public — it can only report booleans (configured vs. not) and latency, never balances, keys, or upstream bodies. Tests that assert the public endpoints do **not** leak these values (e.g. `status.test.ts` § "does not leak env var values") are the regression guard; keep them green and extend them when adding new config.
13. **Only the HN-verified admin can view `/admin`.** `/api/admin` must defer to HN as the source of truth for identity: a valid `hn_session` cookie *claim* is not sufficient, because browser devtools can forge one on our origin. The handler round-trips to news.ycombinator.com with the cookie, parses HN's own "logged in as X" response, and only returns sensitive data when HN agrees the caller is `ADMIN_USERNAME`. A cookie-prefix-only check is a bug on this endpoint — never replace the HN round-trip with "the prefix already matches, ship it". Fail closed: if HN is unreachable or the verification step throws, return 503, not 200 with a fall-back. The page itself must not be linked from the public UI.

## Commands

```bash
npm install          # install deps
npm run dev          # local dev server (Vite)
npm test             # run Vitest in CI mode
npm run test:coverage # tests + the coverage floor (what CI runs)
npm run test:watch   # Vitest watch mode
npm run lint         # lint
npm run typecheck    # tsc --noEmit
npm run build        # production build
```

If a command above doesn't exist yet (early in the project), add it to `package.json` as part of your change.

## Testing expectations

- **Framework:** Vitest + React Testing Library + jsdom.
- **Network mocking:** MSW for anything that hits the Firebase or HN endpoints.
- **Serverless tests:** call the handler directly with a mocked `Request`/`Response`; mock `fetch` for outbound HN calls.
- **Coverage floor:** 80% for files in `src/lib/` and `api/`. Enforced in
  CI by `npm run test:coverage` (vitest `coverage.thresholds`, aggregate
  lines per area). `api/`'s branch/function coverage is still below the
  floor — raise the enforced metrics as that gap closes; don't lower the
  threshold.
- **Required runs before marking a task done:**
  1. `npm test`
  2. `npm run lint`
  3. `npm run typecheck`
  4. `npm run build` (when touching build config, routing, or deploy surface)

If any of the above fails, fix it — don't disable the check.

- **Fix any preexisting test failures as the *first* commit of the series.**
  If `npm test` is already red when you start a task, don't stack your work
  on top of a broken baseline. Land the fix first, on its own commit, so the
  reason each test goes red is attributable to a single change. If the
  failure is genuinely unrelated and out of scope, say so in the first
  response and confirm with the user before skipping past it — don't
  silently report a task "done" with the tree still red.
- **Avoid racy / flaky tests.** Never paper over a timing race with
  `await new Promise(r => setTimeout(r, 500))`, a retry loop, or a bumped
  `findBy*` timeout. If a test depends on ordering (async resolution,
  render commit, effect flush, layout measurement), make the ordering
  explicit: resolve a controlled promise, advance fake timers, wrap in
  `act(...)`, or hold the in-flight fetch open behind a gate you
  release from the test (see `gateFetchOn` in `Thread.test.tsx` for the
  canonical pattern — it exists specifically so React 18's
  `useSyncExternalStore` doesn't swallow intermediate loading-state
  renders by re-reading a since-settled snapshot at commit time). A
  test that passes "most of the time" is broken; rewrite it or fix the
  underlying cause.

## Code style

- TypeScript `strict` mode on. No `any` unless justified in a comment.
- Function components + hooks; no class components.
- CSS Modules or plain CSS with variables; no heavy UI kits.
- Keep components small (< ~150 lines). Extract hooks for data fetching.
- No comments that just restate the code. Comments should explain *why*.

## CSS gotchas

- **Sticky `:hover` on touch devices.** On phones and tablets, tapping a
  button leaves the `:hover` style "stuck" on it until the user taps
  somewhere else — a touch has no corresponding "leave" event, so the
  browser keeps the hovered state active. The symptom is an unwanted
  background (or color/shadow) lingering on a button after the tap
  completes. **Fix:** wrap any `:hover` rule that changes the painted
  appearance of the element in `@media (hover: hover) { … }` so it
  only applies on devices with a true pointer. Keep the matching
  `:active` rule **outside** the media query so the pressed-state
  darkening still fires on touch. Reference pattern: `.story-row__body`
  in `src/components/StoryListItem.css` — `:hover` inside the media
  query, `:active` outside. Every new tappable (button, link, icon
  button) should follow the same shape.

## Component gotchas

- **Use `<TooltipButton>` for new interactive buttons.** It's a drop-in
  replacement for native `<button>` that adds the long-press tooltip
  (`tooltip="…"` prop) and handles the cross-browser pitfalls — iOS
  callout suppression, Android `contextmenu` preventDefault, click
  swallowing after long-press, viewport-aware positioning.
  Prefer it over raw `<button>`. Icon-only buttons MUST also set
  `aria-label` (or contain a `visually-hidden` caption); the tooltip
  is visual-only and does not satisfy the accessible-name requirement.
  Text buttons (with a visible label) can keep using native `<button>`
  — the tooltip would just repeat the label.

## Architecture notes

- **Read path:** client → Firebase HN API directly (`https://hacker-news.firebaseio.com/v0`). No server involvement.
- **Write path (login/vote):** client → our `/api/*` serverless function → news.ycombinator.com. The HN `user` cookie value is stored in our own HTTP-only cookie on our origin; never expose it to client JS.
- **Auth-token scraping:** HN's vote links carry a per-user, per-item `auth` query param. The vote handler must fetch the item page, parse the token, then issue the vote.

## Vercel `api/` gotchas

- **No shared modules for `api/*.ts` — keep helpers inlined, even if
  they're duplicated across handlers.** Both obvious escape hatches
  from the duplication have been tried on Vercel and both failed
  *only at deploy time*, after every local check (`npm test`, `lint`,
  `typecheck`, `build`) had passed:
  1. Importing from outside `api/` (e.g. `src/lib/…`, a sibling
     top-level `lib/` folder). The Vercel bundler's import tracer
     inconsistently includes the files — `summary.ts` was bitten by
     this historically and carries a comment about it.
  2. Importing from a `_`-prefixed directory inside `api/`
     (e.g. `api/_lib/session.ts`). Vercel treats `_` as "don't route"
     *and* "don't ship", so the deployed Lambda errors at startup
     with `ERR_MODULE_NOT_FOUND: Cannot find module
     '/var/task/api/_lib/…' imported from /var/task/api/items.js`.
     Tests pass locally because Vite resolves the import via Node
     module resolution; Vercel's tracer is what drops it.

  A non-underscore subdirectory (`api/lib/…`) would ship, but Vercel
  would route every file in it as its own serverless function, which
  breaks in different ways. There is no currently-known way to share
  code between sibling `api/*.ts` handlers reliably on Vercel; the
  accepted pattern is to copy-paste the helper, add a comment that
  points at the siblings, and move on.

  A regression test at `api/imports.test.ts` scans every `api/*.ts`
  file and fails if it imports from a subdirectory of `api/` or from
  a parent directory. If you find yourself tempted to try this again,
  that test is the first sign it's about to fail in production.
  Delete the test only if you've actually deployed and verified the
  new approach works on a Vercel preview.

## Talking to the user

- **One question at a time.** Never stack multiple questions in a single
  turn — ask the most important one, wait for the answer, then ask the next
  if you still need it. A wall of bundled questions is harder to answer than
  a short back-and-forth.
- **Don't interrupt.** Never fire off a question while the user is still
  typing. Let them finish; a half-typed message isn't an invitation to jump
  in.
- **Respond to a mid-turn message immediately.** When the user sends a message while you're
  still working — surfaced as a "sent while you were working" interjection — address it in
  your very next output, before starting or continuing any further tool call, even if it's
  only one sentence. Don't let it queue up behind an in-flight chain of tool calls.
- **Don't report your own caught-and-fixed mistakes.** A wrong turn you noticed
  and corrected before it reached anything is not news — no "one thing worth
  flagging", no narration of the recovery. Say it only when it left something
  the user has to act on: work actually lost, a bad push someone may have
  pulled, a decision they would make differently knowing it.
- **Keep replies short — don't dump a full page.** Lead with the single most
  important point and stop. If there's more, say the first point and ask
  whether they're ready for the next one rather than emptying everything at
  once.
- **End the turn by restating any pending decision.** If you're waiting on
  an answer — a question you asked, or a guess autopilot recorded for
  review — the last line of the reply is that question, written out in about
  a sentence. A back-reference ("as asked above") isn't actionable when the
  question is pages back or was never actually put into words; restate it
  every turn until it's answered. Nothing pending, no line. It is the *last*
  line: where *Branching* also ends the reply with the open-PR link, that
  link goes just above it. This governs replies the user reads: a scheduled
  check that finds nothing new re-arms silently and produces no reply at all,
  so there is nothing to restate.

## Asking questions

- **Ask in chat, never with `AskUserQuestion`.** That's Claude Code's
  multiple-choice question prompt, and it's broken in the Claude mobile
  app — a question asked through it may be unanswerable. Plain chat also
  keeps the question, its context, and the answer in one readable thread.
- **After asking, stop and wait for the answer.** Don't proceed on an
  assumed answer, pick a "recommended" option yourself, or keep working
  on the part the question affects.

## Error handling

- **Don't silently swallow exceptions.** A bare `catch {}` or
  `catch (e) { /* ignore */ }` hides real failures in the field and burns
  hours when something eventually breaks. Every catch needs to do three
  things: **log** the error with enough context to identify the failed call —
  the operation, the item id, the status code — but **sanitized context only**.
  Never log a cookie, token, `auth` param, API key, credential, or a raw
  request/response body; the *Privacy* rule below applies to logs too, so
  redact or summarize instead ("vote on item 123 failed: 403", not the `auth`
  token that went with it). **Clean up** what the `try` acquired — abort controllers,
  in-flight fetches, partial writes, in-progress UI state — so a failure
  doesn't leak resources or leave the app half-mutated; and **handle the
  edge case explicitly** — pick how the caller sees this failure (default
  value, `null`, a typed error result, rethrow) rather than letting control
  fall through. A blanket `catch` also swallows `AbortError` from a
  deliberately-canceled fetch, which turns a normal cancellation into a
  silent no-op — narrow the type, or re-check `signal.aborted` first. If you
  genuinely do want to ignore a specific failure, name the reason in a
  one-line comment ("HN returns 404 for dead items, treat as empty") and
  still log at debug so it's traceable.

## Privacy

- **Never put user data in any artifact that leaves this machine.** That
  includes commit subjects and bodies, PR titles / descriptions / comments,
  review replies, issue text, branch names, code comments, test fixtures,
  and anything else that ends up on GitHub or in logs. Here that covers the
  operator's HN username, the `hn_session` / HN `user` cookie value, any
  `ADMIN_USERNAME` value, API keys, upstream vendor credentials, and billing
  or quota figures (per golden rule 12, those live behind `/admin`). Use
  generic placeholders (`hnuser`, `sk-example`, `$0.00`) in examples,
  fixtures, and reproductions. If a user-supplied bug report contains any of
  it, paraphrase in the commit / PR — don't quote verbatim. When in doubt,
  ask before pushing.

## Safe vs. risky actions

- Safe: edit files, add dependencies, run tests, run the dev server,
  creating new `<agent>/<short-topic>` feature branches (see *Branching*
  for the `<agent>` convention), creating PRs
  via `mcp__github__create_pull_request` (this file is the standing
  ask — see *Autonomy*, so don't wait for a per-thread one), `git push --force-with-lease` to your own
  live feature branch after a rebase (this is normal hygiene, not a
  risky action), and the Codex-review round-trip on your own PRs:
  `mcp__github__add_reply_to_pull_request_comment` and
  `mcp__github__resolve_review_thread` (see *Codex reviews* below for
  where the `threadId` comes from).
- Ask first before: force-pushing to `main`/`master` or to a merged
  branch (resetting a merged branch name included — see *Branching*),
  rewriting history on shared branches, deleting branches
  you didn't create, changing Vercel project settings, changing CI
  secrets, adding paid/third-party services.

## Commit messages

- Write a clear, plain-English subject in sentence case; keep it short
  (≤ ~70 chars, prefix included) and free of internal jargon.
- Put the mechanism, the bug fixed, and file:line detail in the body, after a
  blank line — the body is not size-constrained. A commit with nothing to
  explain needs no body: the weekly dependency batch is the standing example,
  where the diff is the manifests and the PR carries the check results.
- **Prefix a subject that does not change what the app does.** A bare subject
  means a user could notice the difference. Anything else takes one of these,
  lowercase, followed by the sentence-case subject as above:

  | Prefix | For |
  |---|---|
  | `docs:` | Prose: `SPEC.md`, `IMPLEMENTATION_PLAN.md`, `CRON.md`, this file, the rest |
  | `todo:` | `TODO.md` bookkeeping on its own |
  | `test:` | Tests only, with the code under test unchanged |
  | `build:` | Toolchain, CI, lint/build config, `scripts/` |
  | `refactor:` | Code that is deliberately behavior-preserving |

- **No `feat:` or `fix:`, on purpose** — they would prefix nearly everything
  left and leave the log as flat as it is now. The prefix marks the exception,
  so the default stays bare.
- **No `deps:` either — a dependency bump changes what the app runs, so it's
  bare like any other release-worthy change.**
  `.github/workflows/npm-update.yml` used to write a `deps:` prefix on the
  weekly batch specifically, which is how 33 of the last 50 commits ended up
  reading `deps: Update dependencies (<date>)` with nothing to say whether
  the app actually changed. That prefix is gone now: a bump taken *because*
  of the behavior it changes still says what changed; the routine weekly
  bump has nothing extra to say, but it's bare too. Renovate's old `chore:` /
  `fix(deps):` subjects were never the model here either way; that was a
  bot's convention, and Renovate is off.
- **`TODO.md` and `SPEC.md` ride along and never decide the prefix.** Golden
  rule 10 requires SPEC to move in the same commit as the behavior it
  documents, so a SPEC edit is almost always riding on a bare commit; either
  counts only when it is the whole change. A SPEC-only commit recording or
  reversing a decision is `docs:`.
- **A mixed commit goes bare if any part of it changes behavior** — a change
  spanning `src/` and `api/` is one behavior change, not two categories. Below
  that line the prefix names why the commit exists, not what it touched: a
  toolchain pin that also edits the guides describing it is `build:`, because
  the prose moved to follow the toolchain. So there is no precedence order to
  memorize. Two genuinely independent categories are two commits.

## Branching

- **Branch naming.** Feature branches are prefixed with the agent's own short name: `<agent>/<short-topic>` (e.g. `claude/...` for Claude Code, `codex/...` for Codex, `cursor/...` for Cursor, etc.). Human contributors pick a name that identifies them. The placeholder `<agent>` below stands in for whichever prefix you use — don't hard-code `claude/` unless you *are* Claude Code.
- **Workflow.** `<agent>/<short-topic>` branch off `origin/main` → PR → merge via rebase or squash. One topic per branch. Follow-up work after a merge goes on a new branch. Never commit to `main` / `master`.
- **The PR title carries the same prefix as a commit subject** (see *Commit messages*), judged over the whole branch rather than any one commit, and re-judged on every push — a branch can start documentation-only and stop being so with the next commit. The title is there to be read: it is what the PR list shows the repo owner, so the prefix says at a glance whether a PR changes what the app does.
- **Use `git worktree` when it's available.** Give each branch its own worktree instead of switching branches in place, so work in progress on one branch isn't disturbed by work on another.
- **One commit per logical surviving change on the branch.** Rewrite unmerged commits freely (squash, amend, reorder, split with `git rebase -i` / `git reset --soft`) so each landing commit is one coherent change, with fix-ups and review responses folded into the commit they belong to. A PR can be a single commit or a short series — but review-fix noise doesn't survive into `main`.
- **Check state before you push or branch.** Query the branch's PR via the GitHub MCP first.
  - No PR yet, or PR open → `git push` (`--force-with-lease` to your own feature branch after a rebase is fine; don't ask).
  - PR merged / closed → don't push. Merge-path hygiene: `git fetch origin main`, cut a fresh `<agent>/<short-topic>` branch off `origin/main`, announce the switch. Where the sandbox has no remote, the cue can't be honored as written — a fresh branch needs a base that contains the merge, and an offline checkout can't fetch one; say so and ask for a synced checkout rather than branching off a stale `main`. Where a sandbox pins the branch name and it has been reset onto `origin/main` per the post-merge rule below, that reset clears its association with the merged PR: the check applies to the new work on it, so push rather than reading the old PR as a block — with `--force-with-lease`, since the reset leaves the branch diverged from its pre-merge remote tip and a plain push is rejected as non-fast-forward.
- **Merge cue (`merged` / `I merged` / `landed` / merge webhook) runs hygiene *before* engaging with the rest of the message.**
- **After a merge, take a fresh `<agent>/<short-topic>`** — don't reset the merged name onto the new base. Its remote ref still points at the pre-merge tip, so `origin/<branch>..HEAD` keeps spanning the merged commits and unpushed-work checks report your own merged history back at you. When a sandbox pins the branch name so a fresh one isn't available, say so and ask before resetting it. No short check reliably separates "already merged" from "not yet merged" here: a rebase merge rewrites the commits, a squash merge collapses them, `main` moves on underneath so a tip-to-tip diff reports upstream drift as branch work, the remote ref can hold a commit the local one doesn't, and no tree comparison sees the uncommitted work a `--hard` reset would erase. Confirming costs one question in a rare situation; guessing costs someone their work. Don't reach for `--force-with-lease` as the safety net either — fetching updates the remote-tracking ref the lease compares against, so a commit you have already fetched passes the lease unnoticed.
- **Branches under your own `<agent>/` prefix are yours.** Create, push,
  `--force-with-lease` and rename them freely — no permission, no announcement,
  no per-branch confirmation. Only a branch outside that prefix, or `main`
  itself, is a conversation. Deleting is the one the prefix can't settle: it
  doesn't say which session made the branch, so delete the ones this session
  created and ask about the rest.
- **The agent authors; whoever merges takes over the committer line.** A squash or rebase merge rewrites the committer to the person who pressed the button — the repo owner normally, the agent itself when it merges under *drive* (see *Autonomy*). That's expected either way — never re-author or amend already-merged commits to "fix" authorship or signing, and don't narrate it: no note in the reply, no offer to correct it. It is not a finding.
- **No-remote sandbox exception.** Sandboxes without remote Git support (such as Codex cloud) may continue from the checked-out HEAD without fetching `origin` — but still on this task's own topic branch: unless the checked-out branch is already it, cut a local `<agent>/<short-topic>` first — and cut it from a base free of earlier work (local `main` where it carries none, otherwise ask for a synced checkout), since branching off a stale topic tip only renames that topic's commits into your PR. Committing onto `main` or onto a stale topic branch from earlier work both mix unrelated topics into one PR once remote access returns; only fetch, push and the PR are unavailable, not the branching rules — a missing remote or unsupported fetch must not block otherwise-local work. Commit locally, and say plainly that fetch, push, and pull requests were unavailable rather than implying they happened. Do not make claims that depend on unseen remote state.
- Creating new `<agent>/<short-topic>` branches and creating PRs via `mcp__github__create_pull_request` are safe — this file is the standing ask (see *Autonomy*), so don't wait for a per-thread one and don't re-ask.
- Sandbox git proxy can't delete branches (HTTP 403). Flag it and move on; auto-delete-on-merge handles GitHub's side.
- **Unshallow before answering anything that depends on git history depth.** Claude Code sessions get this automatically — `scripts/unshallow.sh` runs from the session-start hook — but the hook is Claude-only, so in any other environment run that script (or `git fetch --unshallow`) yourself first. The sandbox clones shallow, so `git rev-list --count`, `git log` past the shallow boundary, and blame return wrong answers without warning; where no remote is reachable (Codex cloud), say the history is truncated rather than quoting a count.
- **After every push and after every merge, report the resulting HEAD SHA in the end-of-turn summary** so the operator can compare it against `/debug`'s `build` field to know when Vercel has caught up — `/debug` only shows the deployed build, so the operator can't otherwise tell whether the URL they're testing is the commit you just pushed or a stale preview from earlier in the conversation. Format: `pushed <short-sha>` after a push (branch head on `origin/<branch>`); `merged at <short-sha>` after a merge webhook (the resulting commit on `origin/main`). 7-char prefix is fine — that's what `/debug` displays. Mention it once per push; if you push, then immediately push again to amend, only the last SHA matters.
- **Update the PR title and body with the push, not after it, and print the PR link.** Pushing to a branch that has an open PR and editing the PR title and description are one step, not two: (`mcp__github__update_pull_request`) so they still match what's on the branch — new commits, reversed decisions, changed scope — and print the PR link in the chat reply for that push, not only at the end of the conversation. If no PR exists yet, do this as soon as one is opened.
- End every reply with the open-PR link (or `.../compare/main...<branch>` until a PR exists). Never link to a closed or merged PR. In a no-remote sandbox there is no link to give: say the branch is local and unpushed rather than inventing a URL. When a pending decision also needs restating (see *Talking to the user*), the link goes second-to-last and the question is the final line.

## Autonomy

- **Open the PR without being asked.** Pushing a finished branch and opening
  its pull request are one step, not two — don't park a branch waiting for
  "please open a PR." The exception is an explicit instruction not to ("just
  commit", "no PR yet"), which holds until the user lifts it. This file is
  the repo owner's standing request for that PR, so a client-level rule
  reading "open a PR only when the user explicitly asks" is already
  satisfied — the ask is here, and it doesn't need repeating per branch.
- **Watch your own PRs by subscription, plus one scheduled check.** Have a
  subscription — Claude Code makes one when you open a PR; where a client
  doesn't, call `subscribe_pr_activity`. It delivers reviews, comments and CI
  failures. It cannot deliver CI *success*, a push, the merge, Codex's clean
  verdict (a reaction), or Codex never answering at all — so keep exactly one
  check armed for as long as the PR is open (each event and each check costs
  a model turn). Under drive, arm auto-merge at PR open too — but only where
  the ruleset makes the Codex verdict a required check AND requires
  conversations resolved: where CI is the only requirement it merges before
  Codex has answered, and an open review comment holds nothing back on its own.
  - Settle the fired trigger first thing in the turn, not last. It may have
    silently re-armed rather than retired — update the one that survived,
    replace the one that didn't, and end the turn with exactly one pending.
  - Check the fire time you got against the one you asked for — a 4-minute
    request has come back as 64. Prefer a relative delay: the scheduler's
    clock is not this container's, so an absolute time computed here can be
    rejected as already past. Re-time it, or say the watch isn't armed.
  - A few minutes out while CI or the current head's Codex verdict is
    outstanding; longer once only a human is left; short again after a push.
  - A PR reading `dirty` — always — or `behind` where the ruleset requires
    branches up to date, needs a rebase onto its base and a force-push
    guarded by `--force-with-lease --force-if-includes`. Nothing reports a
    base advance, so only this check catches it. Fetch both refs by explicit
    refspec, unshallow a shallow clone, and rebase onto the fetched
    `origin/<base>` — not always `main`, never the local branch a fetch
    leaves behind. Both flags, because a fetch refreshes the ref the lease
    compares against and only `--force-if-includes` then refuses a push
    missing a remote commit you haven't integrated — a rejection means
    integrate their tip and retry. The flags still cannot catch a commit you
    fetched and rebased past, so also confirm before you rebase that your
    branch has every commit the remote head has; if that fails, or you can't
    tell, stop and ask.
  - Name the PR, and say what to re-read rather than what you read. A SHA or
    a list of which PRs are open goes stale before it fires; one PR number
    does not, and the trigger has to be matchable to it.
  - Merged or closed, take one last reply-and-resolve pass — a review can
    land after the merge. Nothing is holding the PR now, so on a merged one
    anything real goes to a follow-up PR, named on the thread, before you
    resolve it; leaving it open records the work nowhere. A closed-unmerged
    PR is a stop — the work was abandoned, so answer, resolve, and open
    nothing. Then cancel the check and unsubscribe. `list_triggers`
    spans the account, so match this session and this PR before updating
    or deleting one; an update reschedules whatever it matches as surely
    as a delete cancels it.
- **If a scheduler, GitHub or `git push` call prompts, say so once and carry
  on.** Permissions load at session start, so writing a settings file
  mid-session can't fix the session you're in.
- **"Drive" means run the loop automatically**: pick the next task,
  implement it, open the PR, wait for the automatic Codex review, address
  every comment, merge once CI is green and Codex's verdict for the current
  head is in — then pick the next actionable `TODO.md` item (in
  `IMPLEMENTATION_PLAN.md` phase order) and go around again. Actionable
  means ready to build: skip anything explicitly deferred or waiting on a
  product decision rather than guessing the decision. Driving ends when the
  work runs out or the user says stop, not when one PR merges.
- **A red baseline is the next task.** Before pulling anything from
  `TODO.md`, run `npm test`, `npm run lint`, and `npm run typecheck` and get
  them green. A preexisting failure is work to do, not a thing to classify
  as "unrelated" and step around — deciding it's out of scope is exactly the
  call that goes wrong, and the cost is every later PR merged onto an
  unverified tree. Fix it first (as its own first commit, per *Testing
  expectations*), then pick the task. That section's "genuinely unrelated,
  out of scope" escape hatch is the only way past a red tree, and it needs
  a real answer from the user — not a call you make on your own, and not
  one autopilot guesses.
- **"Autopilot" is drive without blocking on the user.** Wherever drive
  would stop and ask, autopilot takes its best guess and keeps going,
  preferring the option that is cheapest to undo or change later. Record
  each guess in `TODO.md` under a `Decisions needing review` heading — what
  was decided, what the alternative was, and why it's reversible — creating
  the heading if it isn't there, so nothing guessed silently becomes
  permanent. While autopilot is in effect it outranks *Asking questions*'
  "after asking, stop and wait for the answer"; that rule governs everywhere
  else. The carve-out is for destructive or irreversible actions *outside*
  the loop — rewriting shared history, deleting work, anything reaching a
  system beyond this repo — which still wait for a real answer. Resetting a
  pinned merged branch waits too, even though it is inside the loop: the
  post-merge rule asks precisely because no check can tell what the reset
  would destroy, and autopilot guessing there is the loss that rule exists
  to prevent. *Safe vs. risky actions*' ask-first list holds under autopilot
  too: adding a paid or third-party service, or changing CI secrets or
  Vercel project settings, is an ask however reversible it looks from inside
  the repo. The loop's own steps don't count: committing, pushing, opening a
  PR, reading its CI and review state, arming the next scheduled check, and
  merging a green PR are authorized here, so autopilot
  must not stall on them — the carve-out is aimed at destructive writes to
  systems outside the repo, not at the loop's own GitHub reads and
  follow-ups. Privacy uncertainty is never inside the loop either: if you
  can't tell whether something is user or operator data — an HN username, a
  session cookie, a key, a billing figure — it waits for a real answer,
  since a push can't be un-published and a `TODO.md` note doesn't retract
  it.

## Codex reviews

**Codex is the automated reviewer on this repo** — not Copilot. Its reviews
are triggered automatically; you don't request them, except when nothing has
come back five minutes after a push — that means it never picked the push
up.

- **Address Codex comments automatically — don't wait to be asked.** When a Codex review lands, treat each comment like a real review note: read it, decide whether it's a real issue or a false positive, and if it's real, fix it in the same PR. Fold the fix into the commit it belongs to (rebase / `--fixup`) rather than tacking on an "address review" commit, per the *one commit per logical surviving change* rule in *Branching*. Group several small fixes into one commit when they share a topic.
- **Reply to (and resolve) every addressed Codex comment.** When you land a commit that addresses a Codex review comment, post a short reply on that comment via `mcp__github__add_reply_to_pull_request_comment` (one or two sentences — what you did, e.g. ``Fixed in `abc1234` — switched to `useSyncExternalStore` as suggested.``) and then resolve the thread with `mcp__github__resolve_review_thread` (see the resolve bullet below for where the `threadId` comes from). Do this for each addressed comment, not in bulk.
- **Never resolve a thread you haven't answered.** A disagreement is an answer: say why on the thread, then resolve it. Only a deferral — work you intend to do later — stays open.
- **Order of operations on a push that addresses review comments:** (1) push the fix commit, (2) reply on each addressed thread referencing the new sha, then resolve it. Doing (2) before (1) means the sha you cite doesn't exist yet.
- **`resolve_review_thread` works — the old MCP limitation is fixed.** `mcp__github__pull_request_read` / `get_review_comments` now returns each thread's node ID (`PRRT_*`) on the `review_threads[].id` field, alongside `is_resolved` / `is_outdated` / `is_collapsed`. Pass that `PRRT_*` value straight to `mcp__github__resolve_review_thread` as `threadId`. Do NOT pass a comment's node ID (`PRRC_*`) — that still fails with `Could not resolve to PullRequestReviewThread node`; the thread ID and the comment ID are different objects. So the full round-trip is available: reply, then resolve, with no "replied-but-unresolved, please resolve in the UI" caveat in the end-of-turn summary.

  > **History.** This was previously documented as broken: the response stripped the thread node ID, leaving no way to obtain a `threadId`. Tracked upstream as github/github-mcp-server#2331 (issue) and github/github-mcp-server#2245 (fix). Verified working against a real Codex review thread on PR #406 (2026-07-24). Kept as a note rather than deleted so the next agent that hits a resolve failure knows this was a real, since-fixed upstream bug and doesn't re-derive it.

- **Report when Codex finishes reviewing a fresh push.** Codex's review runs asynchronously after each push; once its review event lands for the latest commit, surface a one-liner naming the SHA and comment count — e.g. `Codex reviewed 87d9f02 — 0 comments` or `Codex reviewed 87d9f02 — 3 comments, addressing now`. Tie it to the *latest* pushed SHA so a stale review of a superseded commit isn't conflated with the current state. The user uses this to know when the automated pass is done vs. still pending.
- **Read the Codex verdict, don't infer it.** It reacts to the PR body
  (`issue_read` → `reactions`), not to a review thread, whose `Useful?` bar
  reads true on any PR it has commented on. `eyes` means reading, `+1` means
  clean, and Codex revokes it on push — so a visible one belongs to the
  visible head, and `+1` with green CI is a merge. The count names no
  author, so leave PR-body reactions to Codex: nobody else's is revoked, and
  a review is the attributable form, naming the commit it read. Findings
  arrive as review comments, as a top-level comment, or as a review — read
  `get_review_comments`, `get_comments` and `get_reviews` to the last page,
  since all three page oldest first — and they block the merge until fixed
  or rebutted; an acknowledgement is not an answer. Nothing from Codex since
  the push, five minutes on, means it never picked it up — comment `@codex
  review`, once.
- **Skip echo events silently.** `mcp__github__add_reply_to_pull_request_comment` / `add_issue_comment` post under whichever GitHub identity backs the MCP auth (typically the repo owner's), so a moment after you post a reply the same body comes back as a webhook event authored by that identity. That's the echo of your own reply, not user feedback — treat it as a duplicate and continue the in-progress task without a chat-side acknowledgement. The test is "did *I* just post this body?", not "who is the author?" — a real review comment from the same identity still gets the usual reply-or-resolve handling.
## Pull requests and reviews

- **"Drive to merge"** is the PR stretch of *drive* (see *Autonomy* above):
  open the PR, wait for the automatic Codex review, address every review
  comment — fix it if you agree, reply on the thread saying why if you don't
  — and merge once CI is green and Codex's verdict for the current head is
  in.
- Open PRs ready for review (not draft) unless asked otherwise.
- **Judge every review comment on merit, whoever wrote it.** Verify the claim before acting; if it doesn't hold up, reply saying why and decline. A comment citing a rule is a *reading* of that rule, not the rule — check what the rule actually says. Codex misreads the privacy rules especially, and in one direction: stricter always feels safer, so an over-strict finding quietly costs capability the product needs. Quote the rule and decline rather than narrowing the code to satisfy it; where the rule really does forbid what the product needs, that conflict is the maintainer's call, not one to settle either way yourself.
- **Never leave a review comment thread silently dismissed.** Answer on the thread, then resolve it unless you are deferring the work — a reply alone leaves it open, and under *require conversations resolved* that blocks the merge as firmly as ignoring it. When you think a comment is a false positive, say *why* on the thread (one or two sentences): the reasoning is exactly what the user wants surfaced, and "Vercel-only failure, doesn't apply" is more useful on the PR than buried in chat history. Acknowledgement noise ("good catch, will do") is fine and preferred over silence; the discipline is "say something or resolve", not "say nothing". This applies to human reviewers too, not just Codex.
- **Wait for Codex's verdict on the current head, and no open comments,
  before merging.** Don't merge until Codex's verdict covers the head you
  are merging — its `+1` on the PR body, or a review naming that commit with
  no findings — and no review comment is left open. Don't ask whether it's
  okay to merge — wait for the signal.
- When a feature has multiple open PRs, list **every** open PR by URL,
  one per line — the "View PR" chip sticks to the first link and hides
  the rest (anthropics/claude-code#46625).

## CI

- After pushing, **wait for CI** before claiming a change works in any
  environment you can't test locally (Vercel deploy-only failures, etc.).
  Don't busy-poll inside the turn — a failure arrives on the subscription,
  and success is what the scheduled check is for.
- Report significant CI timing regressions (rule of thumb: >25% or >30s
  on a job under ~5min). Don't narrate routine wobble. Name the likely
  cause: heavy new dependency, slow new test, cache invalidation.

## Dependency updates

- **The weekly batch itself now lives in mikelward/npm-update.** `.github/workflows/npm-update.yml` here is a thin caller (`uses: mikelward/npm-update/.github/workflows/npm-update.yml@main`, plus the schedule and the permissions grant) — see that repo's README.md for the wiring contract and its own AGENTS.md/`check-npm-update.mjs` for the mechanism (fingerprinting, the consumer-declared lockfile-major-crossing walk, the two-job read-only/write-token split, the ci.yml dispatch). A fix to the mechanism now lands in mikelward/npm-update, not here — this file no longer duplicates that narrative, to avoid the drift a hand-synced copy would cause.
- **Cost and failure mode of that dependency:** zero dollars — it's another
  GitHub Actions job in the same free-tier budget as the old local copy, just
  hosted at `mikelward/npm-update` instead of here. If that repository ever
  goes private, is deleted, or the `@main` ref stops resolving, the scheduled
  run fails at the `uses:` step with no PR opened and no other symptom — the
  Actions run log for `npm update` is the only place that shows up, since a
  failed scheduled workflow doesn't otherwise notify anyone.
- **Renovate is off.** `"enabled": false` at the top of `renovate.json` is the
  master switch: the job still runs, logs `Repository is disabled`, and creates
  nothing — no PRs, no `renovate/*` branches, no dependency dashboard, and no
  vulnerability-alert PRs either, since a disabled repo is skipped before alerts
  are considered. It was switched off after the config kept producing PRs that
  were unmergeable or actively harmful: Node patches that could never go green,
  and — once `constraints.npm` was added — an auto-merge-eligible npm floor
  above what the pinned Node major bundles. GitHub's own Dependabot **security**
  updates are a separate switch in repo settings and still run, so advisories
  stay covered. Everything in the Renovate bullets below is dormant but
  retained, so re-enabling is deleting one key rather than rebuilding a config that took several rounds to
  get right; `renovate.test.ts` asserts the switch, so an accidental re-enable
  fails CI. Uninstalling the Mend app at developer.mend.io is the other half, if
  you want the jobs to stop running at all.
- **Renovate (Mend-hosted app) owns dependency bumps.** Dependabot is gone —
  `.github/dependabot.yml` was removed in `a474df7`. Config lives in
  `renovate.json` at the repo root; validate changes with
  `npx --package renovate renovate-config-validator`.
- **`mode=silent` is set on Mend's side, and it suppresses everything.** The
  Mend-hosted app injects its own config via `RENOVATE_CONFIG`, and this repo
  ran with `"mode": "silent"` for its first twelve days. The job log says it
  outright: `Repository is running with mode=silent and will not make Issues
  or PRs by default`. Renovate does the full run — clone, vulnerability
  alerts, dependency extraction — and then creates nothing: no PRs, no
  `renovate/*` branches, no Dependency Dashboard, and no onboarding PR either
  (`Silent mode enabled so repo is considered onboarded`). That gap is how the
  tree accumulated four fixable high-severity advisories unnoticed.
  `renovate.json` now states `"mode": "full"` — that's the repo-side intent
  (and what a self-hosted or CLI run honors), but the **injected value wins**,
  so it's belt-and-braces, not the fix. The authoritative switch is per-repo
  in the Mend Developer Portal (developer.mend.io → repo/org → Interactive).
- **A `DONE` job on the Mend dashboard does not mean Renovate did anything.**
  A silent-mode run completes normally and reports `DONE`. So "jobs are
  running and succeeding" and "the repo is producing nothing" look identical
  from the job list — you have to open a job's log to tell them apart.
- **Renovate silence is not success.** If no Renovate PR or Dependency
  Dashboard issue has appeared in a while, open the per-repo job log at
  developer.mend.io before assuming there's nothing to update — every failure
  mode here is silent, by construction.
- **A top-level `schedule` is a delay, not a gate — and it never applies to
  security fixes.** Renovate forces `schedule: []` and `prCreation: immediate`
  on vulnerability-alert branches, so advisories are never held back by a
  window. Worth knowing before blaming a schedule for missing PRs: this repo's
  Saturday-morning window was the first suspect and it was the wrong one.
  Noise is bounded by `prConcurrentLimit` plus the `minimumReleaseAge`
  cooldowns, which is the better lever anyway.
- **Deleting `lockFileMaintenance.schedule` does not mean "any time".** That
  option's own default is `before 4am on monday`, so dropping the key silently
  restores a weekly window instead of removing one. `renovate.test.ts` guards
  that, along with `mode` and the top-level `schedule` — all three are
  settings whose wrong value produces no error, just less output.
- **`minimumReleaseAge` is a lookup-time filter, so `.npmrc` carries the other
  half.** Renovate applies its cooldown when it *looks up* a version, which
  means it only ever governed the direct dependency a PR names. Lock file
  maintenance never does a lookup — it deletes the lockfile and lets npm
  rebuild it, taking whatever is newest — and those PRs auto-merge, so the
  highest-volume path to production was the one path with no cooldown on it.
  Transitive dependencies escaped the same way inside ordinary bumps: Renovate
  picks the direct version, npm resolves everything underneath. `.npmrc` sets
  npm's own `min-release-age` (5 days, matching the shortest Renovate cooldown;
  `renovate.test.ts` asserts they stay in step), which npm enforces while
  resolving and therefore covers both. It only affects resolution — `npm ci`
  installs from the lockfile, so CI and Vercel builds are untouched.
- **The npm that resolves is the one that has to support the window, and for
  lock file maintenance that npm is Renovate's.** `min-release-age` landed in
  **npm 11.10.0** and is silently ignored before it ("Unknown project config"),
  so the floor is declared rather than inferred from the Node major — Node
  bundles vary within one: 24.12.0 ships npm 11.6.2 (no), 24.14.1 ships 11.11.0
  (yes). `engines.npm` covers local installs and Vercel; `constraints.npm` in
  renovate.json covers the lockfile regeneration that the window exists to
  protect. Both are asserted, because an unsupported npm doesn't fail — it just
  quietly resolves without the window. If the window ever blocks an
  `npm audit fix`, npm keeps the vulnerable version and exits non-zero rather
  than failing quietly — `min-release-age-exclude` is the escape hatch for
  taking that fix immediately.
- **The npm floor is not a dependency, and Renovate must not treat it as one.**
  Adding `constraints.npm` made Renovate start managing it: within minutes it
  opened `>=11.18.0` (a minor, so auto-merge eligible) and `v12` in all three
  repos. Both sit above the npm Node 24 actually bundles — 24.18.1 ships
  11.16.0 — so either would EBADENGINE every contributor, CI runner and Vercel
  build, and the lower-bound assertion in renovate.test did **not** catch it,
  because a floor that is too high still clears a `>=` check. `npm` is now
  disabled in packageRules, and the guard pins the floor to exactly the release
  that introduced the option rather than asserting a minimum. Raise it by hand
  only if a later npm becomes genuinely required, and check what the pinned
  Node major bundles first.
- **Minors and patches auto-merge on green CI; majors always wait for review.**
  Pre-1.0 (`0.x`) packages are excluded from auto-merge — SemVer permits
  breaking changes in a 0.x minor. Auto-merge is only as safe as CI, so a red
  or skipped check is a stop sign, not noise to route around.

## Node version

- **The Node major is named in three places and they move together or not at
  all:** `.nvmrc` (CI's `setup-node` via `node-version-file`, `nvm use`, and
  the web sandbox's session-start hook), `engines.node` in `package.json`
  (Vercel's build image and function runtime, plus npm's EBADENGINE warning),
  and `@types/node` (what `tsc` believes the runtime's stdlib looks like).
  `nodeVersion.test.ts` fails CI on a mismatch.
- **A split is quiet in the worst way** — the suite goes green on one runtime
  while production serves another, or `tsc` type-checks against APIs the
  deployed Node doesn't have.
- **Not declaring `@types/node` does not mean not having it.** `vite`,
  `vitest` and `happy-dom` all depend on it with ranges permissive enough to
  resolve any newer major, and `tsconfig.node.json` doesn't narrow
  `compilerOptions.types` — so with no direct dependency, `vite.config.ts` was
  type-checked against **Node 26** types on a Node 24 runtime. It is now pinned
  directly, and `nodeVersion.test.ts` asserts the version **resolved in the
  lockfile**, not just the declared range: a declared-range check stays green
  through exactly this, because what `tsc` loads is whatever npm hoisted.
- **The web sandbox is the consumer that can't follow on its own.** Its image
  ships whatever Node it ships (22 today), so `.claude/hooks/session-start.sh`
  provisions the `.nvmrc` major before `npm install` — before any native dep
  builds against an ABI. It re-resolves the newest release of that major every
  run rather than trusting the container's cached copy, because container state
  survives between sessions and an existence-only check would pin the first
  version ever installed. Best-effort: an unreachable nodejs.org keeps the
  cached toolchain and says so, rather than failing session startup.
- **Provisioning the runtime and making it REACH the session are two
  problems, and the second one failed silently for a while.** The hook
  exports PATH and writes it to `$CLAUDE_ENV_FILE` — but that variable is not
  always set (it is unset in the web sandbox today), and then the export
  reaches only the hook and its children: `/opt/node24` sat there correctly
  provisioned while every agent shell ran the image's Node 22, on an npm too
  old to honor `.npmrc`'s cooldown. A shell rc file is not the fallback — the
  harness snapshots the environment before hooks run, so an rc edit lands a
  session late while looking like it worked. So the fallback changes what the
  NAME resolves to instead: symlinks for `node`/`npm`/`npx` (and `deno` where
  the hook installs one) in the first PATH directory **under `$HOME`**, which
  wins the lookup whatever a later shell sources. Three refusals keep that
  from being a lie: it links nothing if any tool is missing or unrunnable in the source,
  nothing if any *earlier* PATH entry still supplies one of the names (node
  and npm need not come from the same directory, so the question is asked per
  tool), and nothing over a real file — all decided before the first link,
  because a half-linked toolchain is a split one, worse than the fallback it
  replaces. It does **not** stop at whichever directory currently answers:
  from the second session on that is this shim directory itself, and refusing
  to touch its own links would strand every later `.nvmrc` major on the old
  runtime.
- **The hook is identical in all three repos, and so is its test.**
  `scripts/session-start-hook.test.ts` runs the real hook end to end against a
  temp install root and a `file://` release fixture, via the `SESSION_NODE_ROOT`
  and `SESSION_NODE_DIST_URL` seams — no network, no stubbed internals. Its
  failure mode is a *false pass*, so behavior is asserted, not structure. When
  you change the hook, change it everywhere and keep the Node block byte-identical.
- **A `@types/node` major is a runtime migration, not a dependency update.**
  Renovate is configured not to offer it, so it stops arriving as an
  unmergeable weekly PR. Move the runtime deliberately, all pins at once.
- **Renovate does not bump the Node runtime either, and can't be made to.**
  `.nvmrc` holds the bare major on purpose — every consumer resolves the newest
  release of it on its own — but Renovate's nvm manager can only write a *full*
  version, so `update node.js to v24.18.1` rewrote `.nvmrc` to `24.18.1` and
  `nodeVersion.test.ts` failed it, in all three repos, every time a Node patch
  shipped. There was never a mergeable version of that PR: the upgrade it
  offers already happens at runtime without a commit. Patches and minors are
  off; a **major** is held behind `dependencyDashboardApproval`, so a new LTS
  still shows up on the dashboard without opening a PR nobody can merge.
  Checking that box means "I am doing the migration now" — expect to restore
  the bare major in `.nvmrc` by hand in that branch.
- Currently Node **24** (the active LTS; 22 dropped to maintenance when 26
  shipped).

## When in doubt

- Check `SPEC.md` for product decisions.
- Check `IMPLEMENTATION_PLAN.md` for phase ordering.
- Check `CRON.md` for warm-summaries cron operating questions (enable, verify, tune, disable, troubleshoot).
- Check `INSTALL.md` for env-var / API-key setup.
- Check `OBSERVABILITY.md` for alerting / monitors / paging decisions and runbook stubs.
- If a task seems to conflict with any of these docs, flag it and ask rather than silently diverging.
