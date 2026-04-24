# AGENTS.md

Instructions for AI coding agents (Claude Code, etc.) working in this repo.

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
4. Keep the UI mobile-first and the default palette burnt orange (`#e65c00`, exposed as `--nh-orange`) on cream (`#f6f6ef`). The original HN orange `#ff6600` was lighter but only scored 2.69:1 contrast against the cream banner, so the mono / duo presets ship the slightly darker shade. The opt-in Classic chrome preset still paints `#ff6600` (full-orange bar with white text — a different contrast pair, and HN-fidelity is the whole point of Classic) by overriding `--nh-orange` and `--nh-orange-dark` under `:root[data-chrome='classic']` in `chromePreview.css`. See SPEC.md *Visual Design* for the rationale.
5. **Fewer, larger tap targets.** A story row has at most three possible tap zones — the row body (title + meta as a stretched link) on the left, the pin button on the right, and one reserved slot in between for at most one additional per-row action. The shipped UI uses only two (row body + pin). No inline text links in metadata rows. Min 48×48px per target, ≥8px between adjacent targets (≥12px between the title column and the pin button). See *Story row layout* in `SPEC.md`; if a change would add a fourth tappable element, or fill the reserved slot, push back or flag it.
   - Corollary: per-story actions that don't already have a row zone (Favorite, Upvote, etc.) live on the thread/comments page's action bar, not on the row. Upvoting is in the thread action bar, logged-in-only, next to Pin and Favorite — see *Thread action bar* in `SPEC.md`.
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
- **Coverage floor:** 80% for files in `src/lib/` and `api/`.
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

## Safe vs. risky actions

- Safe: edit files, add dependencies, run tests, run the dev server,
  creating new `claude/<short-topic>` feature branches, creating PRs
  via `mcp__github__create_pull_request` once the user has asked you
  to open one (and for subsequent follow-up PRs in the same thread —
  don't keep re-asking), `git push --force-with-lease` to your own
  live feature branch after a rebase (this is normal hygiene, not a
  risky action).
- Ask first before: force-pushing to `main`/`master` or to a merged
  branch, rewriting history on shared branches, deleting branches
  you didn't create, changing Vercel project settings, changing CI
  secrets, adding paid/third-party services.

## Branching

- **Workflow.** `claude/<short-topic>` branch off `origin/main` → PR → merge via rebase or squash. One topic per branch. Follow-up work after a merge goes on a new branch. Never commit to `main` / `master`.
- **One commit per logical surviving change on the branch.** Rewrite unmerged commits freely (squash, amend, reorder, split with `git rebase -i` / `git reset --soft`) so each landing commit is one coherent change, with fix-ups and review responses folded into the commit they belong to. A PR can be a single commit or a short series — but review-fix noise doesn't survive into `main`.
- **Check state before you push or branch.** Query the branch's PR via the GitHub MCP first.
  - No PR yet, or PR open → `git push` (`--force-with-lease` to your own feature branch after a rebase is fine; don't ask).
  - PR merged / closed → don't push. Merge-path hygiene: `git fetch origin`, cut a fresh `claude/<short-topic>` branch off `origin/main`, announce the switch.
- **Merge cue (`merged` / `I merged` / `landed` / merge webhook) runs hygiene *before* engaging with the rest of the message.**
- Creating new `claude/<short-topic>` branches and creating PRs via `mcp__github__create_pull_request` (once the user has asked for one in the thread) are safe — don't re-ask.
- Sandbox git proxy can't delete branches (HTTP 403). Flag it and move on; auto-delete-on-merge handles GitHub's side.
- End every reply with the open-PR link (or `.../compare/main...<branch>` until a PR exists). Never link to a closed or merged PR.

## When in doubt

- Check `SPEC.md` for product decisions.
- Check `IMPLEMENTATION_PLAN.md` for phase ordering.
- Check `CRON.md` for warm-summaries cron operating questions (enable, verify, tune, disable, troubleshoot).
- Check `INSTALL.md` for env-var / API-key setup.
- Check `OBSERVABILITY.md` for alerting / monitors / paging decisions and runbook stubs.
- If a task seems to conflict with any of these docs, flag it and ask rather than silently diverging.
