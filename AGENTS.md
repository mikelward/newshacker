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
4. Keep the UI mobile-first and the palette HN orange (`#ff6600` / `#f6f6ef`).
5. **Fewer, larger tap targets.** A story row has exactly three possible tap zones — upvote (logged-in only), the row body (title + meta as a stretched link), and the pin button — in that left-to-right order. No inline text links in metadata rows. Min 48×48px per target, ≥8px between adjacent targets (≥12px between the title column and the pin button). See *Story row layout* in `SPEC.md`; if a change would add another tappable element to a row, push back or flag it.
   - Corollary: per-story actions that don't already have a row zone (e.g. Favorite) live on the thread/comments page, not on the row.
6. **Prefer HN's API + stateless Vercel functions** for both the read and write paths. A shared backend store (Vercel KV, Upstash, etc.) or a scheduled job is acceptable when clearly justified — rate limiting, scheduled cache warming, and abuse mitigation are the plausible first uses — but it needs the rule 11 cost/reliability note up front, not as an afterthought. Don't reach for a database when localStorage, the edge CDN cache, or a stateless function would do.
7. Don't implement flagging, moderation, submitting stories, or submitting comments.
8. **US English everywhere.** Product copy, identifiers, CSS class names, localStorage keys, and comments all use US spelling (e.g. `favorite`, not `favourite`).
9. **Pinned ≠ Favorite.** Pinned (📌, on the row) is the active reading list — explicit pin, explicit unpin, no auto-pruning. Favorite (heart, on the thread page) is the permanent keepsake — never swept, never expired. Keep the two stores, hooks, and UI paths independent. localStorage keys: `newshacker:pinnedStoryIds`, `newshacker:favoriteStoryIds`.
10. **Keep `SPEC.md` in sync with reality.** Whenever a change reverses or modifies an existing documented decision in `SPEC.md`, or introduces a non-trivial change (new user-visible behavior, new tap target, new storage key, layout reorder, route, etc.), update `SPEC.md` in the same commit. Don't let the spec and the code drift.
11. **Call out cost and reliability up front.** Whenever you recommend new infrastructure (a hosting tier, database, queue, cache, CDN, monitoring service, etc.) or a new external API call (including adding another HN fetch, a third-party API, or a serverless function invocation), include a brief dollar-cost estimate — at minimum, free-tier vs. paid thresholds and a rough $/month at expected traffic — and note reliability implications: new failure modes, rate limits, added latency, extra points of failure, and what happens to the user if the dependency is down. If the cost is effectively zero or the reliability impact is negligible, say so explicitly rather than omitting the note.

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

## Safe vs. risky actions

- Safe: edit files, add dependencies, run tests, run the dev server.
- Ask first before: force-pushing, rewriting git history, deleting branches, changing Vercel project settings, changing CI secrets, adding paid/third-party services.

## Branching

- Develop on the branch the harness assigns (see the session instructions — currently `claude/hackernews-mobile-app-E2eoZ`).
- Commit with clear messages. Don't create PRs unless the user asks.

## When in doubt

- Check `SPEC.md` for product decisions.
- Check `IMPLEMENTATION_PLAN.md` for phase ordering.
- If a task seems to conflict with either doc, flag it and ask rather than silently diverging.
