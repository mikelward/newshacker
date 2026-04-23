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
- Add CSS variables for the HN palette (`--hn-orange`, `--hn-bg`, `--hn-meta`).
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
  - No upvote arrow on the row. Upvoting lives on the thread page action bar (see § 5d); the row stays a two-tap-zone read surface regardless of sign-in state.
  - Metadata (points · age) is plain text. Domain under the title is plain text.
  - Min row height 72px; ≥12px gap between the title column and the comments button; ≥48×48px per tap zone.
- Test for the layout rules explicitly:
  - Title tap on a URL story opens the external URL in a new tab (assert `href` and `target=_blank`).
  - Title tap on a self-post (no URL) navigates to `/item/:id`.
  - "N comments" button navigates to `/item/:id` and does not open the external URL.
  - No rank number, no hide/past/web/flag/via links, no inline author link are present in the row DOM.
  - No upvote button on the row in any state. The Upvote button lives on the thread page's action bar instead (logged-in only — see § 5d).
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

## Phase 5 — Accounts & collaboration

### 5a. Login (shipped)

- `api/login.ts` (Vercel serverless):
  1. Accepts `{ username, password }` JSON.
  2. `POST https://news.ycombinator.com/login` with `application/x-www-form-urlencoded`, body `acct=<u>&pw=<p>&goto=news`, `redirect: 'manual'`.
  3. Reads the `Set-Cookie` header for `user=<value>`. A missing `user=` cookie means HN rejected the credentials; the endpoint returns 401.
  4. On success, sets an HTTP-only, Secure, SameSite=Lax `hn_session` cookie on our origin containing the HN cookie value. Username is parsed from the HN cookie value (`username&hash`, split on `&`) and returned in the response body.
- `api/me.ts`: returns `{ username }` parsed from the `hn_session` cookie; 401 if absent. No round trip to HN — the cookie is the source of truth on boot.
- `api/logout.ts`: clears `hn_session` with a `Max-Age=0` overwrite.
- Outbound HN fetch sends a realistic desktop User-Agent plus an `accept-language` header. Node's default `undici/*` UA can make HN reject the login without setting the `user` cookie, which surfaces to the user as "Bad login" even with correct credentials. The UA is logged-in browser-identical rather than identifying as `newshacker`, because HN's login flow does not advertise a bot-friendly path.
- Client: `useAuth()` hook (`['me']` React Query key), `<LoginPage>` form with username/password + inline error, and a header `HeaderAccountMenu` chip in the top-right — anonymous silhouette → `/login` when logged out; initial-on-colored-disc with a dropdown (username, karma, View profile, Log out) when logged in. Palette excludes HN orange so it never fights the brand mark.
- Tests:
  - Serverless handlers with mocked `fetch`: success sets the cookie and returns the username; bad login returns 401; missing fields return 400; logout clears the cookie; outbound request carries a realistic User-Agent.
  - Client: `useAuth` reflects `/api/me` state, login form submits, `HeaderAccountMenu` renders the silhouette, opens the dropdown, and flips to the silhouette after Log out.

### 5b. Keep pinned stories visible on the main feed (next)

Shipping this before sync because it's purely client-side, works for
logged-out readers too, and gives sync a concrete, curated list to
carry across devices once 5c lands.

Today a pinned story only appears in `/pinned`. Once HN's own ranking
drops it off the front page, it disappears from `/top` (and `/new`,
`/best`, …) entirely — you have to navigate to `/pinned` to find it
again. That's fine when pinning is cheap-and-forgettable, but less
so once the user has a curated reading list they expect to run down
from their home screen.

- [ ] **Float pinned stories onto the feeds.** On every feed page,
  render the user's pinned stories above the standard feed rows (or
  interleaved in pin `at` order), visually distinguished so they
  clearly aren't part of the HN ranking. When a pinned story also
  appears naturally in the feed id list, dedupe — the pinned copy
  wins. Hiding is a no-op on a pinned row (the pin itself is the
  authoritative "keep this here" signal).
- **Cost/reliability (rule 11):** pure client-side layout plus the
  item fetches the pinned-prefetch path already does. No new infra,
  no new endpoints. Added failure mode: none new — if the item fetch
  fails, the row renders the `[unavailable]` placeholder we already
  use elsewhere.
- **Open questions:** ordering (pin-time vs. most-recent activity),
  and how to handle long-pinned lists — capping at N most-recent
  pins is likely, with the full list still reachable at `/pinned`.
  Decide when the feature lands.

### 5c. Cross-device sync (shipped)

Shipped:
- `api/sync.ts` serverless handler with `GET` (returns the user's
  three lists from Redis) and `POST` (merges a delta of
  `Array<{ id, at, deleted? }>` per list, per-id LWW on `at`, returns
  the merged state). Uses the existing Upstash Redis store.
  Per-list entry cap (10 000) and 256 KiB body ceiling guard against
  runaway state.
- Client-side tombstone support added to `lib/pinnedStories.ts`,
  `lib/favorites.ts`, and `lib/hiddenStories.ts` — `remove*`
  writes `{ id, at: now, deleted: true }` instead of dropping the
  entry, so a subsequent server pull can't silently resurrect an
  un-pin/un-favorite/unhide from a stale peer device.
- `lib/cloudSync.ts` singleton owns the sync state machine: pulls on
  sign-in and on reconnect, listens to the three
  `newshacker:*Changed` events, debounces ~2 s, and POSTs the
  `at > lastPushed` delta. Server's merged response is re-merged
  into local stores.
- `useCloudSync` hook in `App.tsx` (mounted once via a
  `CloudSyncBridge` component) kicks the state machine on/off with
  auth state.
- Fail-open: any pull/push failure is swallowed; localStorage
  remains authoritative for the UI. Unauthenticated users simply
  don't sync.
- Tests: serverless round-trip (empty → POST → GET), per-id LWW
  including tombstones, body-validation and caps; client merge
  logic, debounce coalescing, retry on failed POST, stop unbinds
  listeners, tombstone propagation.

**Explicitly not in 5c: opened/read sync.** See `SPEC.md` § Planned /
not yet implemented #8 and the `TODO.md` entry. Not a committed
follow-up — may never ship; `TODO.md` just records the shape a
future decision would probably take (capped list, whole-blob
last-write-wins).

**Cost/reliability (rule 11):** reuses existing Upstash Redis; at
~1 KB/user × 3 lists = thousands of users on the free tier. New
failure mode = sync endpoint down → localStorage keeps working, no
user-visible breakage.

**Known limitations / open questions:**
- Users without an HN account: no sync path in this model. Decision
  deferred; revisit if real demand shows up.
- Conflict on edits within the debounce window: last-write-wins
  per-id is coarse. Fine for add/remove; revisit if we ever store
  richer per-item state (e.g., user notes).
- Tombstones accumulate over time in each user's Redis blob. At
  ~40 B/entry and a 10 000-entry cap the worst case is ~400 KB —
  well under Upstash's 1 MB value limit — and when the cap bites
  the oldest entries are pruned first. Not worth proactively GC'ing
  yet.

### 5d. Voting — story rows (shipped)

- **`api/vote.ts`** (shipped): POST `{ id, how }` where `how ∈ {"up","un"}`.
  1. Requires the `hn_session` cookie — 401 otherwise.
  2. `GET https://news.ycombinator.com/item?id=<id>` with the HN cookie;
     `redirect: 'manual'` so a 302 → `/login` is translated to a 401.
  3. Scrapes the per-item `auth` token out of the relevant
     `<a href="vote?id=<id>&how=<up|un>&auth=<token>…">` anchor.
  4. `GET https://news.ycombinator.com/vote?…` with the HN cookie.
  5. Returns 204 on 2xx or a non-login 3xx; 401 if either hop 302s
     to `/login`; 502 on unreachable / missing vote anchor / non-2xx.
  Helpers (`parseCookieHeader`, `usernameFromSessionValue`,
  `extractAuthToken`) are intentionally inlined rather than shared
  with `api/hn-favorite.ts` — see § "Vercel `api/` gotchas" in
  `AGENTS.md` and `api/imports.test.ts`.
- **Client** (shipped):
  - `src/lib/vote.ts` — `postVote(id, how)` fetch wrapper + `VoteError`.
  - `src/lib/votes.ts` — per-user localStorage set
    `newshacker:votedStoryIds:<user>` so the arrow stays orange after
    a reload. Best-effort only — HN doesn't expose "items I voted on"
    via the Firebase API.
  - `src/hooks/useVote.ts` — optimistic flip on tap, POST in
    background, rollback + toast on failure. Logged-out users get an
    empty set and a no-op `toggleVote`. Not a retry queue: per SPEC
    Non-Goals, offline votes don't queue.
  - **`<Thread>`** renders the Upvote button in its action bar next
    to Pin / Favorite, only when `useAuth().isAuthenticated`.
    Deliberately **not** on the story rows — the row is the two-tap-
    zone read surface (see *Story row layout* in `SPEC.md`), and
    keeping voting on the thread page means the reader has full
    context (title, domain, article summary, comment summary,
    comments) before casting a vote.
- **Not yet shipped (follow-ups):**
  - Voting on individual comments (same mechanism, different tap
    target). The `Comment` meta row already leaves space for it.
  - Downvoting comments (karma-gated on HN; client needs a signal
    from the scrape to decide whether to render the second arrow).
  - Pending/animation feedback during the in-flight POST — see
    `TODO.md` § *Optimistic-action feedback*.
- **Cost/reliability (rule 11):** no new infra; two HN fetches per
  vote (scrape + forward). Free on Vercel Hobby. Fragile point: HN
  HTML markup — the anchor scraper breaks if HN restructures the
  vote links. Blast radius = votes fail with a toast; read path
  untouched.

### 5f. Favorites round-trip with HN (shipped)

**Goal:** logged-in users' favorite state survives across devices
and across newshacker ↔ HN. Logged-out users stay local-only.

Shipped in two phases behind one PR:

**Phase A — read-only pull.**
- `api/hnFavoritesScrape.ts`: pure regex scraper that takes
  `news.ycombinator.com/favorites?id=<user>` HTML and returns
  `{ ids, morePath }`. Filters `athing` rows that carry the
  `comtr` token so comment favorites don't leak in.
- `api/hn-favorites-list.ts`: `GET` handler that walks the page
  with the signed-in user's HN cookie up to a 20-page cap
  (600 favorites worst case), returns
  `{ ids: number[], truncated: boolean }`.
- `src/lib/hnFavoritesSync.ts` · `mergeHnFavorites`: pure merge
  that adds HN-only ids with `at: 0` and preserves every existing
  local entry (live or tombstoned). `startHnFavoritesSync`
  fires a one-shot bootstrap pull; `useHnFavoritesSync` wires
  the singleton to `useAuth` and is mounted in `App.tsx`.

**Phase B — write queue.**
- `src/lib/hnFavoriteQueue.ts`: per-user localStorage queue at
  `newshacker:hnFavoriteQueue:<username>`. Enqueue coalesces
  canceling pairs (favorite+unfavorite for the same id drops
  both); 2 s → 5 min capped exponential backoff; `MAX_ATTEMPTS`
  of 10 before the entry is dropped with `lastError` recorded.
- `api/hn-favorite.ts`: `POST` handler that scrapes the per-item
  `fave?id=…&auth=…` anchor off the item page, then `GET`s
  `/fave` with that token (with `&un=t` for unfavorite). Returns
  204 on success, 401 on session expiry, 502 on scrape failure
  or rejected action.
- The same `hnFavoritesSync` singleton runs a worker that drains
  the queue one entry at a time through `POST /api/hn-favorite`.
  Drop on 204 / 400 / 404 / 405; stall on 401 until the next
  sign-in; `markFailure` (triggering backoff) on 429 / 5xx /
  network. The worker is kicked by enqueue, online transitions,
  visibilitychange, and a scheduled timer sitting on the earliest
  `nextAttemptAt`.
- `useFavorites` picks up the signed-in username via `useAuth`
  and calls `enqueueHnFavoriteAction` on every user-originated
  action. Bootstrap merges go through `replaceFavoriteEntries`
  directly, so merge-induced changes don't echo back to HN.

**Tests.** `hnFavoritesScrape.test.ts` (10), `hn-favorites-list.test.ts`
(9), `hn-favorite.test.ts` (15), `hnFavoriteQueue.test.ts` (18),
`hnFavoritesSync.test.ts` (21), plus `useFavorites.test.tsx`
extended to 9 covering logged-in enqueue behavior.

**Cost/reliability (rule 11):** each write = 1 Vercel invocation
+ 2 HN fetches; bootstrap ≤ 20 HN fetches per sign-in (5-min
server cache is a future optimization if traffic warrants it).
No new infra. New failure modes: HN HTML shape changing → scraper
degrades gracefully (empty result, local state untouched); HN
rate-limiting → backoff absorbs. Blast radius on total failure:
local favorites keep working, only the HN round-trip stops.

**Stretch (not in this phase):**
- Hide/ignored round-trip uses the same machinery (HN's
  `/hide?id=…&auth=…` endpoint shares the token source), but
  HN has no public "my hidden items" page so it'd be
  push-only — deserves its own phase after this settles.

### 5e. Comment submission (future, order vs. 5d undecided)

Out of scope today; previously listed under *Non-Goals*, now softened to
*deferred* in `SPEC.md` per a design change. Same mechanism as voting:
HN cookie + scraped per-item `auth` token, posted to HN's `/comment`
form endpoint. Not prioritised yet — decide after voting is in flight.

### 5-infra. Shared helpers inside `api/` (attempted, reverted — do not retry)

`api/summary.ts` carries a comment noting that Vercel's per-file
function bundler "has been flaky about tracing shared modules" and so
the HN fetch helper was inlined rather than imported. HN-cookie parsing
+ session-cookie serialization is likewise duplicated across
`api/login.ts`, `api/me.ts`, `api/logout.ts`, and `api/sync.ts`.

Attempted in a prior commit (reverted): pulled the shared helpers into
`api/_lib/` and imported them from each handler. The tests, lint,
typecheck, and build all passed locally — but at runtime on Vercel
the deployed `items.js` blew up with

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/var/task/api/_lib/hnFetch' imported from /var/task/api/items.js
```

Vercel's function bundler drops underscore-prefixed paths from the
Lambda bundle (the `_`-prefix is how you mark something non-routable,
and the bundler currently interprets that as "don't ship it"). The
sibling option — imports from outside `api/` — is the one the original
`summary.ts` comment flagged as flaky. Both routes are now confirmed
dead-ends.

**Current rule (see AGENTS.md § "Vercel `api/` gotchas"):** files in
`api/*.ts` must not import from any `api/` subdirectory or from
outside `api/`. Keep helpers inlined in each handler. There is a
regression test at `api/imports.test.ts` that scans every `api/*.ts`
file and fails CI if a disallowed import sneaks back in.

## Phase 5.5 — Favorites + Pinned rename

**Goal:** Two deliberate lists — Pinned (active reading list) and Favorites
(permanent keepsake) — so each verb can be unambiguous instead of one row
action doing double duty.

Shipped:
- `lib/favorites.ts` — localStorage store at `newshacker:favoriteStoryIds`,
  shape `{ id, at }[]`, `newshacker:favoritesChanged` change event.
- `hooks/useFavorites.ts` — `favorite`, `unfavorite`, `isFavorite`,
  `toggleFavorite`.
- **Favorite button on the thread page only.** No row-level heart, so the
  3-tap-zone rule for story rows is preserved.
- `/favorites` route + `FavoritesPage`, reusing `LibraryStoryList` with an
  "Unfavorite" recover button.
- Drawer entry "Favorites" in the Library group, listed above Pinned.
- **Star → Pin rename.** Row-level "Save / Unsave / Saved" replaced with
  "Pin / Unpin". `lib/savedStories` → `lib/pinnedStories`,
  `useSavedStories` → `usePinnedStories`, `SavedPage` → `PinnedPage`,
  `/saved` route → `/pinned`, sweep aria label → "Hide unpinned".
  The pinned-stories module performs a one-shot rename of the legacy
  `newshacker:savedStoryIds` localStorage key on first read so existing
  readers don't lose their list.
- Generic library list component renamed `SavedStoryList` → `LibraryStoryList`
  to reflect that it now backs Pinned, Favorites, Opened and Hidden.

Follow-ups (next commits, in order):
- [ ] **Filter opened-from-feed.** Hide stories you've already opened from
  the main feeds (they remain in `/pinned` and `/opened`) so the home
  screen stops growing forever.
- [ ] **Re-evaluate Pin terminology** once it has been used for a while —
  if "Pin" still confuses people we can revisit Bookmark / Read-later.

## Phase 6 — AI article summaries

**Goal:** Reader can tap "Summarize" on a story page and get a one-sentence AI summary inline.

Shipped:
- `api/summary.ts` serverless function calling Gemini 2.5 Flash-Lite with the `urlContext` tool.
- `useSummary` hook + `SummarizeCard` component (button swaps to a card with loading → summary → error states).
- Per-instance in-memory cache with a 1-hour TTL.
- Referer allowlist as a first-line defense (`SUMMARY_REFERER_ALLOWLIST` env var, plus hardcoded localhost / `*.vercel.app` / `newshacker.app` / `hnews.app`).
- Requires `GOOGLE_API_KEY` in Vercel project env.

### Phase 6b — AI comment summaries (shipped)

- `api/comments-summary.ts` serverless function — same referer allowlist and `GOOGLE_API_KEY` as Phase 6. Fetches the story's first 20 top-level comments via Firebase, strips HTML, feeds them to Gemini 2.5 Flash-Lite, and asks for a JSON array of 3–5 short insights.
- `useCommentsSummary` hook + `CommentsSummaryCard` inside `Thread.tsx`. Auto-runs on thread load whenever the story has kids — works for self-posts too.
- Freshness-aware server cache: 30-min TTL for stories < 2 h old, 1-h TTL for older stories. React Query TTL on the client is 1 h.
- Prefetched on pin and favorite via the shared `prefetchPinnedStory` / `prefetchFavoriteStory` paths so pinned/favorited stories have a cached comment summary available offline.
- Service Worker runtime cache rule (`ai-comment-summaries`, StaleWhileRevalidate, 7-day, 200 entries) — sibling to the article-summary rule.
- Shared `api/lib/referer.ts` + `api/lib/hnFetch.ts` helpers so `api/summary.ts`, `api/items.ts`, and `api/comments-summary.ts` don't duplicate the allowlist / Firebase fetch.

### Phase 6c — Summary latency tuning

Shipped:
- `thinkingConfig: { thinkingBudget: 0 }` on both `/api/summary` and `/api/comments-summary`. Gemini 2.5 runs hidden "thinking" tokens by default; for these extractive tasks they dominate wall-clock latency and are billed as output tokens. Baseline measurements (n=4, preview env) before the fix: comments Gemini ~8.4s, article Gemini ~2.9s, HN fetches <2% of total.
- Switched both endpoints from `gemini-2.5-flash` to `gemini-2.5-flash-lite`. Side-by-side eyeballing showed slightly faster, slightly less wordy, quality at least as good. Output pricing drops $2.50/M → $0.40/M, input $0.30/M → $0.10/M — roughly 6× cheaper per call.

Next up:
- [ ] **Scheduled cache warming.** With the edge CDN cache already live (see Phase 6b), a Vercel Cron job that hits `/api/comments-summary` for the top ~30 stories every 1–2h would lift near-100% of real user visits onto cache reads (~30ms at the edge) instead of cold Gemini calls. With Flash-Lite + smart cron cadence this is well under $1/mo.
- [ ] **Intent-based prefetch.** Warm the summary on story-row `touchstart` (strong intent signal) rather than speculatively on list-page render. Avoids paying for stories the user never opens.

### TODOs

Shipped:
- [x] **Cross-instance cache.** Initially done via Vercel edge CDN; replaced with **Redis** (provisioned through Vercel's Storage Marketplace) as the shared store. The CDN was regional, so popular cross-region reads still paid one Gemini call per region; one central Redis means one generation serves everyone globally, at the cost of the cross-region readers paying a network hop instead of a regional edge hit. The per-instance `Map` was removed at the same time — a ~5 ms same-region Redis read is the right shared-cache latency, and an extra process-local Map next to it just creates incoherent state. Handler is fail-open (Redis unreachable → live Gemini, no error). **Current topology: single primary in `us-east-1`, no replicas** — ample for today's single-region traffic; replicas in other regions are a straight upgrade when needed. See SPEC.md "Shared server-side cache (Redis via Vercel Storage Marketplace)".
- [x] **Default-on summaries.** `<SummaryCard>` auto-fetches on thread mount (`useSummary(storyId, true)`) whenever the story has a URL. No click required.
- [x] **Per-item-id lookup.** `/api/summary` now takes `?id=<storyId>` and fetches the HN item server-side to derive the article URL. Closes the abuse vector where any caller could spoof Referer and point the endpoint at arbitrary URLs. Cache key is now the story id (not the article URL), and the legacy `?url=` parameter is rejected with 400.
- [x] **Rate limiting.** Per-IP bucket (IPv4 exact, IPv6 `/64`) shared across `/api/summary` and `/api/comments-summary`, gated on cache miss only *and* placed after every free validation branch so 400/404/503 responses don't consume quota — only requests that would actually reach the paid Gemini/Jina call get counted. Two env-tunable fixed-window tiers — burst (default 20 cold calls / 10 min / IP) and daily (default 200 / 24 h / IP). Counter lives in the existing Upstash Redis: `INCR` + conditional `EXPIRE` per enabled tier, so a cold call is typically 2 Redis commands steady-state and up to 4 in the first window after a counter rolls (no explicit pipelining — the Upstash REST client issues each as its own HTTP request). No new infra. Returns 429 + `Retry-After` + structured `{ reason: 'rate_limited', retryAfterSeconds }`; the UI renders "Too many requests — try again later." Fail-open if Redis is unreachable or the client IP is unknown. See SPEC.md § "Per-IP rate limiting on cache misses".

Open:
- [ ] **Require a logged-in account.** Once Phase 5a (login) ships, gate `/api/summary` on a valid session cookie. Return 401 when unauthenticated. Not urgent — the per-IP rate limiter above covers the abuse shape login would have guarded against, and forcing a login for anonymous readers would be a real UX regression for what is primarily a read-only reader app.
- [ ] **Observability.** Log aggregate request count, cache hit rate, and error classes to a cheap sink (Vercel logs + periodic dashboard). Flag if cache hit rate collapses (spend spike). With rate limiting now in place, also log 429 counts per tier so threshold changes can be data-driven.
- [ ] **Summary length metric + cap.** Log summary character/line length so we can size the loading skeleton against real-world data instead of a hand-picked line count. Once we know the distribution, cap the response (prompt tweak or hard truncate) so the skeleton stays close to the median and reflow on arrival is minimised.

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
| M5 | Phase 5a | HN login + header account chip (shipped) |
| M6 | Phase 5b | Pinned stories visible on the home feed (shipped) |
| M7 | Phase 5c | Cross-device sync of Pinned / Favorite / Hidden (shipped) |
| M8 | Phase 5f | Favorites round-trip with Hacker News (shipped) |
| M9 | Phase 5d | Story-row voting (shipped — comment voting + downvote still to come) |
| M10 | Phase 5e | Comment submission (future) |
