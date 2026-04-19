# Implementation Plan

Staged so each phase lands as a working, shippable increment. Each phase ends with tests passing and a deployable preview on Vercel.

## Phase 0 — Project skeleton

**Goal:** Empty but deployable Vite + React + TS app on Vercel.

- `npm create vite@latest . -- --template react-ts`
- Add ESLint + Prettier config (or Biome — pick one).
- Add Vitest + React Testing Library + jsdom.
- Add a single smoke test (`App` renders "Hacker News").
- Add `vercel.json` if needed (SPA rewrite to `/index.html`).
- CI: GitHub Actions workflow that runs `npm ci && npm run lint && npm test && npm run build`.

**Done when:** `npm test` and `npm run build` pass locally; Vercel preview deploy of the empty app works.

## Phase 1 — Design system & shell

**Goal:** Orange header, mobile layout, routing skeleton.

- Install React Router.
- Add CSS variables for the HN palette (`--hn-orange`, `--hn-cream`, `--hn-meta`).
- Build `<AppHeader>` with top tabs for feed switching.
- Routes: `/`, `/:feed`, `/item/:id`, `/user/:id`, with placeholder pages.
- Tests: header renders logo + current feed; routing renders correct page for each path.

## Phase 2 — Story list (MVP core)

**Goal:** Browse Top/New/Best/Ask/Show/Jobs.

- Install TanStack Query.
- `lib/hn.ts`: typed wrappers for Firebase endpoints.
  - `getStoryIds(feed)`, `getItem(id)`, `getUser(id)`.
- `hooks/useStoryList(feed, page)`: fetches IDs, slices 30 per page, fetches each item in parallel (batched).
- `<StoryListItem>` implementing the *Story row layout* from `SPEC.md`:
  - Title is a link (`<a>`) that opens the external URL in a new tab. For self-posts (no URL), it links to `/item/:id` instead.
  - A separate right-aligned "N comments" button links to `/item/:id`; `stopPropagation` on its click so a tap on it never also triggers the title.
  - Optional left-side upvote arrow slot, rendered only when logged in (behind Phase 5 flag). The slot collapses when logged out so the title shifts left.
  - Metadata (points · age) is plain text. Domain under the title is plain text.
  - Min row height 72px; ≥12px gap between the title column and the comments button; ≥48×48px per tap zone.
- Test for the layout rules explicitly:
  - Title tap on a URL story opens the external URL in a new tab (assert `href` and `target=_blank`).
  - Title tap on a self-post (no URL) navigates to `/item/:id`.
  - "N comments" button navigates to `/item/:id` and does not open the external URL.
  - No rank number, no hide/past/web/flag/via links, no inline author link are present in the row DOM.
  - When logged out, no upvote button is rendered; when logged in (Phase 5), exactly one upvote button is present.
- `<StoryList>` with "Load more" button (infinite scroll is Phase 4).
- Utilities: `formatTimeAgo(unixSeconds)`, `extractDomain(url)`.
- Tests:
  - Unit: `formatTimeAgo`, `extractDomain`.
  - Component: `<StoryListItem>` snapshot + meta interaction.
  - Integration: MSW-mocked `<StoryList>` shows 30 items and pagination.

## Phase 3 — Thread view

**Goal:** Read comments for a story.

- `hooks/useItemTree(id)`: fetch the item then recursively (and in parallel, with concurrency cap) fetch `kids`.
- `<Comment>` component: author, age, HTML body (sanitized), collapse/expand.
  - HN comment text is HTML; sanitize with `sanitize-html` or `DOMPurify`.
- `<Thread>` page: story header + nested comments.
- Handle `deleted` / `dead` items with placeholder.
- Tests:
  - Unit: sanitizer allowlist (no `<script>`, preserves `<a>`, `<p>`, `<i>`, `<pre>`, `<code>`).
  - Integration: thread with 3-level nesting renders and collapses.

## Phase 4 — Polish

- Infinite scroll with IntersectionObserver.
- Skeleton loaders for lists and threads.
- Empty / error states with retry.
- `prefers-color-scheme: dark` variant (optional; HN itself is light).
- User page: karma, about, created.
- Tests for loading/error/empty states.

## Phase 5 (stretch) — Login & Vote

Gate everything in this phase behind an env flag (`VITE_ENABLE_AUTH=true`) so MVP can ship without it.

### 5a. Login

- `api/login.ts` (Vercel serverless):
  1. Accept `{ username, password }`.
  2. `POST https://news.ycombinator.com/login` with `application/x-www-form-urlencoded`, body `acct=<u>&pw=<p>&goto=news`.
  3. If the response sets a `user` cookie → success. Otherwise parse the HTML for "Bad login."
  4. On success, set an HTTP-only, Secure, SameSite=Lax cookie on our origin containing the HN `user` cookie value.
- `api/me.ts`: returns `{ username }` or 401 based on our session cookie.
- `api/logout.ts`: clears our cookie.
- Client: `<LoginPage>`, `useAuth()` hook.
- Tests:
  - Serverless handler with mocked `fetch`: success sets cookie; bad login returns 401.
  - Client: login form submits and redirects; `useAuth` reflects state.

### 5b. Vote

- `api/vote.ts`:
  1. Require our session cookie.
  2. `GET https://news.ycombinator.com/item?id=<id>` with the HN cookie → parse the page for the item's `auth` token. (Or, for list pages, the token is on `/news` etc.)
  3. `GET https://news.ycombinator.com/vote?id=<id>&how=<up|un>&auth=<token>&goto=news` with the HN cookie.
  4. Return 204 on success; 401/403 on auth issues.
- Client:
  - Story list / thread items render a vote arrow when logged in.
  - Optimistic update via TanStack Query `onMutate`; rollback on failure.
- Tests:
  - Auth-token scraper: given a fixture HTML page, returns the right token.
  - Serverless vote handler: mocks item fetch + vote fetch; asserts correct URL & cookie.
  - Client: optimistic update + rollback.

## Phase 6 — AI article summaries

**Goal:** Reader can tap "Summarize" on a story page and get a one-sentence AI summary inline.

Shipped:
- `api/summary.ts` serverless function calling Gemini 2.5 Flash with the `urlContext` tool.
- `useSummary` hook + `SummarizeCard` component (button swaps to a card with loading → summary → error states).
- Per-instance in-memory cache with a 1-hour TTL.
- Referer allowlist as a first-line defense (`SUMMARY_REFERER_ALLOWLIST` env var, plus hardcoded localhost / `*.vercel.app` / `newshacker.app` / `hnews.app`).
- Requires `GOOGLE_API_KEY` in Vercel project env.

### TODOs

- [ ] **Cross-instance cache.** The current `Map`-based cache is per serverless instance. Move to Vercel KV (or Upstash Redis) keyed by article URL so warm summaries are shared across invocations and survive deploys. Keep the 1-hour TTL; consider longer if abuse guards prevent cache poisoning.
- [ ] **Require a logged-in account.** Once Phase 5a (login) ships, gate `/api/summary` on a valid session cookie. Return 401 when unauthenticated. Optionally rate-limit per-user (e.g., N summaries/hour) to keep spend predictable.
- [ ] **Rate limiting.** Even with login gating, add a simple per-user or per-IP rate limit in Vercel KV (e.g., 30 summaries / 10 minutes) to blunt burst abuse.
- [ ] **Per-item-id lookup.** Take an `item_id` param instead of a raw URL; fetch the HN item server-side and derive the URL. Stops anyone from pointing the endpoint at arbitrary URLs.
- [ ] **Observability.** Log aggregate request count, cache hit rate, and error classes to a cheap sink (Vercel logs + periodic dashboard). Flag if cache hit rate collapses (spend spike).
- [ ] **Optional: default-on summaries.** Once costs + caching are proven safe, consider auto-fetching the summary on story page load (keyed by item id) so it appears without a click.

## Cross-cutting

### Testing policy

- Every PR must include tests for new behavior.
- `npm test` runs on pre-commit (via `simple-git-hooks` or `husky`, optional) and in CI.
- Coverage target: 80% on `lib/` and `api/`; components covered by at least one integration test per screen.

### Linting / formatting

- Biome or ESLint+Prettier. Fails CI on errors.

### Dependency hygiene

- Prefer small, maintained libraries. Avoid UI kits — hand-roll with CSS to stay small.

## Milestones / ordering

| # | Phase | Ships |
|---|---|---|
| M1 | Phase 0–1 | Deployable shell with routing |
| M2 | Phase 2 | Browse all feeds (MVP-ready) |
| M3 | Phase 3 | Read comments |
| M4 | Phase 4 | Polish + user page (full MVP) |
| M5 | Phase 5a | Login behind flag |
| M6 | Phase 5b | Voting behind flag |
