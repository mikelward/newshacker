# AGENTS.md

Instructions for AI coding agents (Claude Code, etc.) working in this repo.

## Project at a glance

- **Newshacker** — an unofficial mobile-friendly reader *for* Hacker News. Not affiliated with Y Combinator. Primary domain `newshacker.app`; `hnews.app` 301s to it.
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
5. **Fewer, larger tap targets.** A story row has exactly three possible tap zones — upvote (logged-in only), title, and the "N comments" button — in that left-to-right order. No inline text links in metadata rows. Min 48×48px per target, ≥8px between adjacent targets (≥12px between title column and the comments button). See *Story row layout* in `SPEC.md`; if a change would add another tappable element to a row, push back or flag it.
6. Don't introduce a backend service or database — HN's API + serverless proxy is enough.
7. Don't implement flagging, moderation, submitting stories, or submitting comments.

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
