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
- Add CSS variables for the HN palette (`--nh-orange`, `--nh-bg`, `--nh-meta`).
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
- Keyboard navigation on list pages (j/k/↑/↓, Enter, Space → row menu, `o` → article, `p` → pin, `d` → dismiss, `?` → help overlay). Active row = native DOM focus on `.story-row__body`; `:focus-visible` paints the active treatment. See SPEC.md *Accessibility → Keyboard shortcuts*.

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

### 5b. Keep pinned stories visible on the main feed (shipped)

**Historical context — the problem this solved.** Before this landed, a
pinned story appeared only in `/pinned`: once HN's own ranking dropped it
off the front page it disappeared from `/top` (and `/new`, `/best`, …)
entirely, so you had to navigate to `/pinned` to find it again. Fine when
pinning is cheap-and-forgettable, less so once the reader has a curated
list they expect to run down from their home screen. It was built before
sync (5c, since shipped) because it is purely client-side and works for
logged-out readers, and it gave sync a concrete curated list to carry
across devices.

- [x] **Float pinned stories onto the feeds.** Pinned rows are
  prepended to the home feed, oldest-pin-first, in the same row layout
  rather than a visually distinguished block — one unified list, each
  pin rendered exactly once, with the feed body excluding pinned ids.
  Pinning a row that's already on screen leaves it in place until the
  next feed refetch, so nothing jumps under the reader. See SPEC.md
  § *Pinned stories pinned to the top*.
- **Cost/reliability (rule 11):** pure client-side layout, plus a
  refresh fetch for pins outside the loaded feed window. That fetch is
  **not** one the pin warm already made: `prefetchPinnedStory` fills
  `['itemRoot', id]` via `getItem`, which reads Firebase directly
  (`src/lib/hn.ts:56`) and costs us no serverless time, whereas
  `usePinnedFeedStories` refreshes via `getItems` → `/api/items`
  (`src/lib/hn.ts:98`), so these are **added function invocations** on
  the existing items proxy. No new infra, no new endpoints.
  **Arithmetic:** `ceil(n / 30)` invocations per feed load that has
  off-window pins — one chunk up to 30 pins, and **every figure below
  is per chunk, so multiply it by `ceil(n / 30)` for a heavier
  pinner.** At one chunk: ~30× the daily count of qualifying loads per
  month — 1,000/day is ~30k/month, 3,000/day is ~90k. Against the
  million invocations a month Vercel Pro ($20, already paid here)
  includes, that is ~3% and ~9%: not a rounding error, but not close to
  the ceiling either. The ceiling scales down as the multiplier scales
  up — exhausting the allowance takes ~33,000 qualifying loads a day at
  one chunk, but only ~11,000 at 90 pins (3 chunks) and ~8,000 at 120.
  All of those are well past anything this project will see, and the
  uncapped-list decision above is what makes the multiplier unbounded
  in principle, so it is the number to re-derive rather than reuse if
  the pin distribution ever turns out to have a long tail. Past it, overage runs
  around a dollar per million invocations, so a tenfold overshoot of
  the allowance is **single-digit dollars a month — not cents**, which
  is the number to quote if traffic ever gets there. **At expected
  traffic: $0/month.** Re-check both the allowance and the overage rate
  against Vercel's current pricing page if this becomes load-bearing.
  Added failure mode: a
  pin whose item fetch fails
  and which has nothing cached to fall back on is **dropped from the
  block entirely** — it does *not* get the `[unavailable]` placeholder
  used elsewhere, because this block filters unresolved ids rather than
  rendering them. See the failure-mode note under *Open questions*
  below; this bullet claimed the placeholder before that was checked.
- **Open questions, as resolved when it landed:** ordering is
  pin-time, oldest first (matching `/pinned`), not most-recent
  activity. Long lists are *not* capped — every pin floats, on the
  reasoning that the block is the reader's active list and a silent
  cap is how a pin goes missing; `/pinned` remains the dedicated view.
  Item data comes from the loaded feed window where possible, then the
  persisted cache, then an `/api/items` refresh — batched, but *chunked
  at 30*: `getItems` splits the missing ids and fires `ceil(n / 30)`
  calls in parallel, so an uncapped list is what decides how many. A
  handful of pins is one call; 90 pins off the loaded window is three,
  and any chunk failing rejects the whole batch. **What the reader sees
  then depends on whether that pin was ever warmed.** `usePinnedFeedStories`
  builds the block from three sources — the loaded feed window, the
  persisted `['itemRoot', id]` cache, and the batch — and drops any id
  none of them resolved (`.filter(x => x != null)`). A pin with a warmed
  root paints from disk, so the failure is invisible. A **cold** pin —
  one just synced from another device whose warm hasn't landed, or a
  legacy pin predating the warm — has no row to fall back on and simply
  **disappears from the feed** until a later refresh succeeds. That is
  the failure mode worth fixing (an `[unavailable]` placeholder, or
  retrying the failed chunk alone rather than rejecting the batch); the
  rest of the feed renders either way.

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
- Service Worker runtime cache rule (`ai-comment-summaries`, StaleWhileRevalidate, no expiration) — sibling to the article-summary rule. Expiration was removed (both time- and LRU-count-based) alongside `hn-items` and `ai-summaries` so pinned stories keep their summaries available offline forever; see SPEC.md *Caching strategy* for the rationale.
- Shared `api/lib/referer.ts` + `api/lib/hnFetch.ts` helpers so `api/summary.ts`, `api/items.ts`, and `api/comments-summary.ts` don't duplicate the allowlist / Firebase fetch.

### Phase 6c — Summary latency tuning

Shipped:
- `thinkingConfig: { thinkingBudget: 0 }` on both `/api/summary` and `/api/comments-summary`. Gemini 2.5 runs hidden "thinking" tokens by default; for these extractive tasks they dominate wall-clock latency and are billed as output tokens. Baseline measurements (n=4, preview env) before the fix: comments Gemini ~8.4s, article Gemini ~2.9s, HN fetches <2% of total.
- Switched both endpoints from `gemini-2.5-flash` to `gemini-2.5-flash-lite`. Side-by-side eyeballing showed slightly faster, slightly less wordy, quality at least as good. Output pricing drops $2.50/M → $0.40/M, input $0.30/M → $0.10/M — roughly 6× cheaper per call.

- [x] **Scheduled cache warming.** Shipped as `/api/warm-summaries`, wired in `vercel.json` as a cron over the top 30 every 5 minutes — a tighter cadence than the 1–2 h sketched here, which the change-analytics work justified separately. Both summary tracks are warmed, and the store is Redis rather than the edge CDN (see *Cross-instance cache* below), so one generation serves every region.
  - **Cost (rule 11), and it is not the "well under $1/mo" this bullet originally estimated.** At the 5-min cadence: Vercel 288 invocations/day (inside Pro's limits). **Upstash is *not* free-tier, contrary to what this bullet and `SPEC.md` both claimed** — `processStory` reads both records for every selected id unconditionally, so 288 ticks × 30 stories × 2 GETs is **17,280 commands/day (~520k/month) before any write or user traffic**, against a free allowance `SPEC.md` itself states as 10k/day. At Upstash's pay-as-you-go rate (~$0.20 per 100k commands, i.e. ~$0.000002 each) that baseline is **~$1/month**, and it grows with reader traffic since every warmed row adds two more reads. The *reliability* consequence is the part that matters: the record reads are `.catch(() => null)`, and a null record is indistinguishable from `first_seen`, so a quota-exhausted or unreachable Redis loses the age / interval backoff — the only gate that reads the record — and every *eligible* track regenerates instead of skipping. **Eligible, not every**: the record-independent gates sit after that block and still fire (`skipped_unreachable`, `skipped_low_score`, `skipped_no_content`, `skipped_payment_required`, plus the comments track's content gates), and the min-kids gate gets *stricter*, since it reads `if (!existing && …)`. So the outage signature is a `first_seen` spike among eligible tracks rather than universal regeneration, and the spend is bounded by what share of the slice was eligible that tick — the cheap failure mode turning into the expensive one for that share. `WALL_CLOCK_BUDGET_MS` (50 s) is not the backstop it looks like — it gates *starting* a queued story, so it bounds how many a runaway tick begins, not how long the in-flight ones run (the Gemini call carries no timeout of its own), and nothing bounds it across ticks. **The Gemini and Jina lines don't need projecting at all — production was measured, and the projection was low.** `reports/2026-04-29-cache-strategy.md` (Findings 3 and 5) has a 24-hour token census from this exact configuration — its 8,550 outcomes against the 8,640 that 288 ticks × 30 stories implies — and this bullet's "Gemini ~$3–5/month realistic, ~$15 worst case" ignored it. Measured, per day: **Gemini 5,440,518 prompt + 31,283 output tokens** cron-only (article 5.04M/16.6K, comments 398K/14.7K — the article track is 12.7× the comments track on prompt tokens, which is where any future cut has to land), and **Jina 12.93M tokens**. At this document's own flash-lite rates ($0.10/M in, $0.40/M out) that is **$0.557/day of Gemini, ~$17/month**, plus **$0.259/day of Jina at $0.02/M, ~$8/month**. With the Redis baseline above: **~$26/month before hosting** — not the ~$9–16 projected here, and the Jina line is the only one the projection got right. **Two rates for flash-lite are recorded in this repo** and the gap is ~25%: the Phase 6 note above says $0.10/$0.40, the report computes at $0.075/$0.30 (and flags "confirm against current Google AI pricing"), which puts the same census at ~$21/month all-in. Budget on the higher pair and confirm against Google's current published rates before quoting either. The cadence itself needs **Vercel Pro** — Hobby allows daily schedules only.
  - **Reliability.** Jina is a *hard dependency for link posts* (the raw-HTML fallback was removed) — and **only** for them: both the article track and `/api/summary` gate the Jina call behind `hasArticleUrl` (`api/warm-summaries.ts:1465`, `api/summary.ts:962-968`) and summarize a self-post straight from the HN `text`, so Ask HN / Show HN / text-only stories ride out a Jina outage untouched, as does the comments track. On a link post, with no key the article track logs `skipped_unreachable` and `/api/summary` returns 503 `not_configured`; between top-ups it's 503 `summary_budget_exhausted` and `skipped_payment_required`. (Gemini has no carve-out by story *type* — a missing `GOOGLE_API_KEY` stops both tracks and both endpoints, `api/summary.ts:936-942`.) **Every one of those provider failures is a cache-*miss* failure, though.** Both endpoints read the stored record *before* they look at any provider key (`api/summary.ts:872-891`, `api/comments-summary.ts:622-638`) and return it on a hit, so a story that is already warm keeps serving normally straight through a Jina or Gemini outage, right up to its Redis TTL. **A cron-only failure** — the cron misfires, is disabled, or falls behind while Gemini and Jina are healthy — splits by whether the story already has a record, and the two halves are not equally benign. A story the cron never reached degrades to a **cold generation on thread open**: the reader waits, nothing is lost. A story it *had* been maintaining goes **silently stale instead** — `handleSummaryRequest` returns any record it finds with no hash or age test (`api/summary.ts:876-887`), so nothing on the read path ever re-checks the source, and the summary stays as it was until the record expires at 30 days. That is the mode to watch for: it has no error state, no latency signal, and no user-visible symptom at all. **A shared-dependency failure lands on exactly the stories the warm never reached**: on an *uncached* link post the thread-open path uses the same Jina key, so a missing key or a 402/429 means `/api/summary` 503s there too and the card shows its error state. So the rule is narrower than "warming can only hide latency, never an outage" — warming **does** mask a provider outage, for the stories it already covered; what it cannot do is rescue one it never got to. Operating it — enable, verify, tune, disable, troubleshoot — is in `CRON.md`.

Next up:
- [ ] **Intent-based prefetch.** Warm the summary on story-row `touchstart` (strong intent signal) rather than speculatively on list-page render. Avoids paying for stories the user never opens.

  **This can't be picked up as written, because "speculatively on list-page render" is now three separate paths and touchstart is downstream of all of them.** In arrival order for any row the reader scrolls past:
  1. **The warm cron** (`/api/warm-summaries`) *checks* the top 30 every 5 minutes, whether or not anyone looks. It does not regenerate on every tick: most return `skipped_interval` on the backoff ladder, and a due check that finds the source hash unchanged updates `lastCheckedAt` without calling Gemini. Generation happens on `first_seen` and `changed` only.
  2. **`warmFeedSummaries`** (`StoryList`, on a row entering the viewport) calls both summary endpoints for *every* visible row — but those endpoints serve the stored record when there is one, so on a warmed story this is a Redis read, not a generation. Its comment still says it "replaces a periodic cron", which is no longer true: the cron above is live.
  3. **`prefetchFeedStory`** (the trending drive-by warm, `score > 100`) delegates to `prefetchPinnedStory`, which warms the item root and first comment page *and prefetches the summary queries too* — the comments summary unconditionally, the article summary when the story has a `url` or a self-post body (`src/lib/feedStoryPrefetch.ts:25-30`, `src/lib/pinnedStoryPrefetch.ts:86-95`). It is a third summary warm, not just an item warm — so it fires on long-tail feeds too, where the cron never reaches.

  So the overlap is cheaper than it looks: 1 and 2 do not both pay for the same *generation*, they mostly both pay for the same cache read. The generation is *usually* paid once, by whichever path reaches a cold or changed story first — but not guaranteed once: `handleSummaryRequest` is a plain read-generate-write with **no single-flight or distributed lock**, so two callers who both miss before either writes Redis will both call Jina and Gemini. The window is one generation's latency wide and only opens on a genuinely cold story, but it is a real burst cost. See *Single-flight the generation* below.

  A `touchstart` warm added on top of these saves nothing — by the time a finger lands, 1 and 2 have already paid, and on a popular long-tail story 3 has too. So the task is really *which speculative path to retire*, and a touch-only cost profile needs the summary half of path 3 retired as well, not just path 2.

  The two questions are separable, because **the cron only covers `/top`'s first 30 ids** (`?feed=top&n=30`). Everything else a reader scrolls — `/new`, `/best`, `/ask`, `/show`, `/hot`, and every page past the first 30 — has no cron tick scheduling a warm for it, so the touchstart-vs-warm-on-view question can be decided out there *whether or not the cron stays*; the cron does not have to be retired first. How much that actually saves is a separate matter, and smaller than it looks — see the long-tail paragraph below.

  **On the top 30, the cron is decided — keep it — and warm-on-view is a separate question that those arguments do not settle.** The cron earns its place because **it is the only thing in the system that re-checks a source**: `handleSummaryRequest` returns *any* record it finds, with no hash or age test (`api/summary.ts:876-887`, whose own comment says freshness is owned by the cron). So retiring the cron does not mean "stale until someone's viewport re-warms it" — nothing on the read path ever re-warms a record that exists. It means stale until the record expires: **30 days** (`RECORD_TTL_SECONDS`). The `warm-run` analytics behind the `/admin` cards ride along with it for free.

  Neither of those arguments transfers to `warmFeedSummaries` — but the two paths are **not** simply duplicates either, because they fill *different caches*. The cron writes the shared **server** record in Redis. `warmFeedSummaries` issues a bare `fetch` from the page, which the service worker's `ai-summaries` / `ai-comment-summaries` `StaleWhileRevalidate` rules store in **this device's** Cache API with no expiry (`vite.config.ts:183-208`). So on a story the cron has already generated, viewport warming buys no generation — but it does buy a local copy, which is the difference between the summary card painting from disk on thread open and paying a round trip to Vercel plus Redis for it. What it costs is **two** Redis reads per visible row — `/api/comments-summary` unconditionally and `/api/summary` whenever the story has a `url` or a self-post body (`src/lib/feedSummaryWarm.ts:41-44`), each handler doing its own `store.get`; only a titled-only stub costs one. Its top-30 benefits are therefore two, and only the first is about generation: a story that entered the slice **since the last tick** (up to 5 min), or one ranked in the loaded window but outside `n=30`, gets generated before the reader reaches it; and every warmed row leaves a device-local copy that makes the eventual open instant rather than merely fast. Whether that beats two reads on every row of every feed view is not established here — it is the same measurement question as the long tail, and it belongs with it rather than being waved through on the cron's arguments.

  That leaves **the long tail as the only live question**, and it is decidable on its own, because **the cron only covers `/top`'s first 30 ids** (`?feed=top&n=30`). Everything else a reader scrolls — `/new`, `/best`, `/ask`, `/show`, `/hot`, and every page past the first 30 — has no cron *tick* scheduling a warm for it, which is what makes this question separable from the cron's. It is **not** the same as "a summary generated there was generated because a row scrolled past": the story may carry a cron record from up to 30 days ago, and a thread open, a pin or a favorite generates just as well. So this is where the Gemini spend *could* fall; how much of it is actually attributable to impressions is the measurement the instrumentation item below exists to make — see the next paragraph, which bounds the saving from above rather than pricing it. The **cost** side is certain either way: touchstart makes the reader wait out the generation on stories they do open, since nothing has paid ahead.

  **But "long tail" is a property of the story, not the route, and that shrinks the saving.** The cron's slice is a set of story *ids*; the record it writes is keyed on the id and lives 30 days. So a row on `/new`, `/best` or `/hot` that is *also* in `/top`'s current 30 — or was at any point in the last 30 days — already has a warm record, and `/hot` unions `/top` and `/new` by construction, so it is the feed most likely to be reading cron-warmed ids. For those rows touchstart saves only the two viewport cache reads, not a generation. The genuine saving is the stories the cron has *never* seen: most of `/new` (submissions that never reach the front page — the bulk of HN's ~1,000–1,500/day), the deep pages of every feed, and `/ask`/`/show` posts that never crest the top 30. **And "the cron never saw it" still doesn't prove scrolling paid for it.** A never-cron-seen story is also generated by opening its thread (`Thread.tsx`), and by the pin and favorite prefetches — all of which the reader wanted anyway and none of which touchstart would remove. So absence from `warm-run` bounds the long tail from above; it doesn't attribute it. **Treat the saving as a hypothesis, not a settled number, until the instrumentation item below ships** — that's the only thing that separates an impression warm from a deliberate open. See SPEC.md §§ *Trending-score drive-by warm*, *Warm-on-view server summary cache*, *Scheduled warming and change analytics*.

- [ ] **Attribute summary generations to the path that caused them.** The decision above can't be sized with what we log today: `summary-outcome` / `comments-summary-outcome` carry `outcome`, `storyId` and token counts, but nothing about *why* the call happened, so a generation caused by scrolling `/new` is indistinguishable from one caused by opening a thread. Add a `trigger` field, passed by the caller since the endpoint can't infer it. **The enum has to split speculative from deliberate at the value level, or it answers nothing** — a single `prefetch` bucket would put the `score > 100` drive-by (the thing under review) in with the pin and favorite prefetches (things the reader asked for), and the query would come back unusable. One value per call site: **speculative** — `feed-view` (`warmFeedSummaries`, fired for every visible row) and `feed-prefetch` (`prefetchFeedStory`, the `score > 100` warm — which fires from a **render effect over the visible rows** (`StoryList.tsx:651-658`), *not* from a touch: there is no `touchstart` handler in the feed today. Keeping that straight matters here more than anywhere, because touchstart is precisely what the item above proposes to add, and an analytics bucket that reads as "touch warm" would make the proposal look already-shipped); **deliberate** — `pin` (pinned on this device), `pin-sync` (a pin arriving from another device), `pin-list` (rendering `/pinned`, `/offline`, or the pinned-top block), `favorite`, `thread`, `deep-link`; plus `cron`. **`prefetchFeedStory` delegates to `prefetchPinnedStory` (`src/lib/feedStoryPrefetch.ts:30`)**, so the shared helper cannot derive its own value — `trigger` has to be a required parameter threaded from each call site, which is most of the work in this item and the reason it isn't a one-line change. **Send it as a request header, not a query param.** The service worker's `ai-summaries` / `ai-comment-summaries` rules match `/\/api\/summary(?:\?.*)?$/` and Workbox keys entries by the full request URL with no cache-key normalization, so `?id=1&trigger=feed-view` and `?id=1&trigger=thread` would be *different* cache entries — the warm would no longer satisfy the open, which is precisely the device-local benefit described above, and the caches would fill with one duplicate per trigger category. A header sidesteps it (same-origin, so no preflight); a `cacheKeyWillBeUsed` plugin stripping the param would also work but adds a moving part for nothing. `/admin`'s token-spend card can then group by it, and "what does the long tail cost" becomes one query instead of a cross-reference against `warm-run` story ids. **Cost:** none — no new requests, one extra request header and one extra field on a line already emitted. **Privacy:** a fixed category enum, no user or story-content data (rule 12 / *Privacy* unaffected). **Reliability:** an unrecognized or absent value must log as `unknown` rather than reject the request; instrumentation must never be able to fail a summary.

- [ ] **Ship `WARM_MIN_DELTA_BYTES` — the measured waste that was analyzed and then never landed.** `reports/2026-04-29-cache-strategy.md` Finding 1 identified that **>50% of article-track Gemini spend is regeneration on content deltas too small to change a one-sentence summary** — in-body timestamps and cache-busters that survive Jina's scrub — and specified the fix: a byte-delta threshold (default 256 B) checked between the hash mismatch and the Gemini call, logged as a new `skipped_minor_delta` outcome. Neither the knob nor the outcome exists in `api/warm-summaries.ts` today, so the finding is still costing money: **~$9/month at this document's rates** (the report says ~$7 at its own lower pair), against a measured article-track Gemini bill of ~$15/month. The report's *What to ship* section is a complete work order — handler check, both regression tests, `admin-stats` histogram entry, `CRON.md` knob docs and APL snippet — and its threshold rationale (catches the ~60% of events under 100 B, misses real edits ≥1 KB, accepts missing sub-256 B typo fixes) is worked through. **Don't extend it to the comments track**: Finding 2 measured 96–99% real-change rates there, because threads accumulate replies continuously, so the same threshold would suppress genuine new content.

- [ ] **Single-flight the generation.** `/api/summary` and `/api/comments-summary` read Redis, generate on a miss, then write — with nothing serializing concurrent misses for the same story, so a cold story fetched by two readers (or two regions, or a reader and the cron) can pay for two Jina fetches and two Gemini calls. Two prior designs already exist to copy from rather than invent:
  - **readmo** (`supabase/functions/summary/index.ts`, `_shared/coalesce.ts`) leases on the row itself — `ai_summary_generated_at` set while `ai_summary` is still null *is* the in-flight marker — claimed by an atomic conditional UPDATE, with a TTL and stale-before check so a crashed generation can't hold the lease. One caller generates; the rest poll and return its result the moment it lands.
  - **newshacker's own unmerged `c27ddfb`** (branch `claude/add-article-prefetching-3B6bj`) built the Redis-shaped equivalent: a `setIfAbsent` store method over `SET NX`, used as a 5-minute per-id dedup that doubled as the negative cache for failed generations.

  **Cost (rule 11).** The *winner* pays one extra command per cache miss (the lease claim); hits are untouched. The **losers are where the real envelope is, and it depends on a design decision this item has to make first**: with the polling shape above, each waiter costs one `GET` per poll for as long as the winner takes — readmo's constants are a 2 s first retry doubling to a 5 s ceiling, so a 10 s generation is ~3 polls per waiter, and **every** caller pays a claim attempt first, because a loser only discovers it lost by trying — so a burst of *n* simultaneous readers costs roughly `n + 3(n−1)` commands (n claims, exactly one of which wins, plus the losers' polls) instead of *n* Jina + Gemini pairs. That is still a large net win (Redis commands are ~$0.000002 each against ~$0.0013 a generation), but it is not "one extra command". The alternative — return a retryable "generating, try again" to the losers and let the client re-ask — **does not remove the polling, it moves it across the HTTP boundary, and makes each poll more expensive**: every retry is a fresh serverless invocation plus at least the endpoint's cache `GET`, plus another lease attempt if the winner is still running. So it needs its own cadence and max-attempt budget estimated exactly like the server-side loop, and it adds a user-visible pending state that has to be designed. Its real advantage is that no request sits open holding a function warm, not that it is free. **Pick the wait strategy before estimating; the two have different latency and failure surfaces, and the plan should name which one before any code.** Either way the change should be net-negative on spend, since it removes duplicate Gemini and Jina calls.

  **Reliability:** the new failure mode is a lease outliving a crashed generation, which is why both designs above bound it with a TTL; get that wrong and a story is unsummarizable until the lease expires. A polling waiter needs its own max-wait so a stuck winner can't hang the request. Fail-open throughout — a Redis error on the lease path must fall through to generating, exactly as the existing cache read does.

  Worth noting the two apps have converged from opposite directions here. readmo warms on **intent only** — `useSummaryPrewarm` warms pinned articles (pinned here, pinned on another device, or already pinned at boot) and the guarantee is a server-side DB trigger on the pin write; nothing in readmo warms a row for merely scrolling past. Its single-flight is what makes cross-device warming cheap, since every duplicate warm collapses to a cache hit. That is the same shape the long-tail decision above is reaching for, arrived at independently.

### TODOs

Shipped:
- [x] **Cross-instance cache.** Initially done via Vercel edge CDN; replaced with **Redis** (provisioned through Vercel's Storage Marketplace) as the shared store. The CDN was regional, so popular cross-region reads still paid one Gemini call per region; one central Redis means one generation serves everyone globally, at the cost of the cross-region readers paying a network hop instead of a regional edge hit. The per-instance `Map` was removed at the same time — a ~5 ms same-region Redis read is the right shared-cache latency, and an extra process-local Map next to it just creates incoherent state. Handler is fail-open (Redis unreachable → live Gemini, no error). **Current topology: single primary in `us-east-1`, no replicas** — ample for today's single-region traffic; replicas in other regions are a straight upgrade when needed. See SPEC.md "Shared server-side cache (Redis via Vercel Storage Marketplace)".
- [x] **Default-on summaries.** `<SummaryCard>` auto-fetches on thread mount (`useSummary(storyId, true)`) whenever the story has a URL. No click required.
- [x] **Per-item-id lookup.** `/api/summary` now takes `?id=<storyId>` and fetches the HN item server-side to derive the article URL. Closes the abuse vector where any caller could spoof Referer and point the endpoint at arbitrary URLs. Cache key is now the story id (not the article URL), and the legacy `?url=` parameter is rejected with 400.
- [x] **Rate limiting.** Per-IP bucket (IPv4 exact, IPv6 `/64`) shared across `/api/summary` and `/api/comments-summary`, gated on cache miss only *and* placed after every free validation branch so 400/404/503 responses don't consume quota — only requests that would actually reach the paid Gemini/Jina call get counted. Two env-tunable fixed-window tiers — burst (default 20 cold calls / 10 min / IP) and daily (default 200 / 24 h / IP). Counter lives in the existing Upstash Redis: `INCR` + conditional `EXPIRE` per enabled tier, so a cold call is typically 2 Redis commands steady-state and up to 4 in the first window after a counter rolls (no explicit pipelining — the Upstash REST client issues each as its own HTTP request). No new infra. Returns 429 + `Retry-After` + structured `{ reason: 'rate_limited', retryAfterSeconds }`; the UI renders "Too many requests — try again later." Fail-open if Redis is unreachable or the client IP is unknown. See SPEC.md § "Per-IP rate limiting on cache misses".

Open:
- [ ] **Require a logged-in account.** Once Phase 5a (login) ships, gate `/api/summary` on a valid session cookie. Return 401 when unauthenticated. Not urgent — the per-IP rate limiter above covers the abuse shape login would have guarded against, and forcing a login for anonymous readers would be a real UX regression for what is primarily a read-only reader app.
- **Observability** (in progress, phased — see `OBSERVABILITY.md`):
  - [x] Phase 1 — log event taxonomy + per-request telemetry. `summary-outcome` / `comments-summary-outcome` structured log lines on every request, carrying outcome (cached/generated/rate_limited/error), reason (for errors), summary length, Gemini prompt/output/total tokens, and Jina tokens on URL-post generations. Closes the gap where user-path Gemini + Jina spend was invisible (previously tracked only by the cron).
  - [x] Phase 1.5 — in-app analytics dashboard on `/admin`. Five cards (cache-hit ratio, token spend, top failure reasons, rate-limited count, warm-cron last run) backed by `GET /api/admin-stats`, which issues APL queries against the same Phase 1 log lines. Lets the operator see the alert conditions in motion before Phase 2's monitors are wired. Configured via `AXIOM_API_TOKEN` + `AXIOM_DATASET`; degrades per-card so a single failed query never takes the dashboard down. See `SPEC.md` § *Operator analytics dashboard* and `OBSERVABILITY.md` § *Phase 1.5*.
  - [ ] Phase 2 — Axiom monitors keying off those events. Four initial conditions: cache-hit collapse, Jina credit exhaustion, Gemini failure rate, rate-limit burst.
  - [ ] Phase 3 — OpsGenie or PagerDuty paging wired to the Axiom monitors.
  - [ ] Phase 4 (optional) — migrate monitoring layer from Axiom to Datadog for the learning dividend.
  - [ ] Phase 5 (optional) — daily Jina wallet cron as a proactive backstop to `summary-jina-payment-required`.
- [~] **Summary length metric + cap.** Length metric shipped as part of Phase 1 above — every `summary-outcome` / `comments-summary-outcome` line now carries a `chars` field on cached + generated outcomes. Cap half is deferred; revisit once a few weeks of real data are in and we know the distribution we're sizing against.

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
