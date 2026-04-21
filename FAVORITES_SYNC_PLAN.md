# Plan — Sync Favorites with Hacker News

Status: **proposal, not yet agreed**. Once an option is picked, the chosen
path folds into `IMPLEMENTATION_PLAN.md` as a new phase and this file goes
away.

## Problem

Today `useFavorites` (`src/hooks/useFavorites.ts`) writes only to
`localStorage` under `newshacker:favoriteStoryIds`, and cross-device sync
is handled by our own `/api/sync` (Upstash Redis, last-write-wins). Nothing
propagates to HN itself. A user who favorites a story on newshacker sees
no heart next to it on `news.ycombinator.com/favorites?id=<them>`, and a
user who favorites on HN sees nothing on newshacker.

We'd like logged-in users' favorite state to round-trip between newshacker
and HN. Logged-out users keep the local-only behavior they have today.

## HN's mechanism

- **Write:** `https://news.ycombinator.com/fave?id=<item>&auth=<token>`
  to favorite; append `&un=t` to unfavorite. The `auth` token is
  per-user, per-item, and scraped from the logged-in `item?id=<id>`
  page — same pattern as the planned vote flow
  (`IMPLEMENTATION_PLAN.md` § 5d).
- **Read:** `https://news.ycombinator.com/favorites?id=<user>` renders
  the user's favorite stories as paginated HTML. Item IDs can be
  scraped from the `<tr class="athing">` rows; pagination is a "More"
  link at the bottom.
- **Hide:** `https://news.ycombinator.com/hide?id=<item>&auth=<token>`
  (append `&un=t` to unhide). There is **no** public page listing a
  user's hidden items — HN only exposes hide as a per-item action.

All of these require the HN `user` cookie. The browser can't call them
directly (CORS + HttpOnly cookie on our origin), so each one needs a
thin Vercel function that forwards on the user's behalf. This matches
the architecture in `CLAUDE.md` ("Write path: client → our `/api/*`
serverless function → news.ycombinator.com").

## Constraints we're designing against

- **Local-first.** The tap must feel instant. Network round-trips to
  `news.ycombinator.com` are slow and flaky — we can't make the UI
  wait on them.
- **Offline-tolerant.** Someone favoriting on the train should see the
  heart fill immediately; the propagation to HN can happen when the
  phone comes back online. We already lean on this pattern for
  `/api/sync`.
- **Don't punish logged-out users.** Favorites must keep working
  without an HN account — that's the whole point of the local store.
- **Cheap.** Each HN round-trip costs a serverless invocation + two
  HN fetches (scrape + action). Worst case at realistic traffic is
  still deep inside the Vercel Hobby tier, but we should coalesce.
- **HN HTML is the contract.** It changes. Design so that a scrape
  failure degrades gracefully — local state is still the source of
  truth.

## Option 1 — Local queue + stateless forwarder **(detailed plan below)**

Keep using the existing optimistic local write. On each favorite /
unfavorite, enqueue a pending HN action into a localStorage-backed
queue. A client-side worker drains the queue by calling a new
`/api/hn-favorite` endpoint; the endpoint scrapes the auth token and
forwards to HN. Failures retry with exponential backoff; 4xx-class
errors drop from the queue with a log. On login and on app start we
also pull `news.ycombinator.com/favorites?id=<user>` via a second
endpoint and merge into the local store.

This is what the user asked to plan in detail. See **Plan for Option
1** below.

## Option 2 — Server-first (persist locally only after HN 2xx)

Tap the heart → POST to `/api/hn-favorite` → wait → only then write
to localStorage. No queue; the server's response is ground truth.

- **Pros.** Single source of truth = HN. No divergence possible.
  Implementation is mechanically simple.
- **Cons.** The tap feels slow (one HN round-trip before the heart
  fills). Offline breaks the feature entirely. And it splits the code
  path for logged-out users, who still need the localStorage path —
  so we end up with two implementations, not one.

Discarded: breaks rule 1 (local-first) and the logged-out UX.

## Option 3 — Stateless reconciliation (no queue)

Same optimistic local write. But instead of recording discrete `add`
/ `remove` ops in a queue, a reconciliation loop periodically:

1. Pulls `favorites?id=<user>` to get HN's current set.
2. Diffs it against local.
3. Issues the minimum add/remove calls to make HN match local.

- **Pros.** No persistent queue to serialize/migrate. Simpler mental
  model — "make HN match me". Naturally self-healing if a queued op
  got lost.
- **Cons.** Every reconciliation fetches the **full** favorites list
  from HN, which is paginated (30 per page). A heavy user with 500
  favorites is 17 HN page fetches just to decide what changed. That's
  expensive and slow. Also doesn't play well with tombstones: HN
  deletes aren't tombstoned, so we can't tell "user unfavorited on HN"
  from "we haven't pushed the favorite yet".

Discarded for write-sync; **kept for periodic bootstrap/repair** — see
Plan for Option 1 below, which uses a periodic pull of HN's list to
reconcile drift.

## Option 4 — Read-only sync (HN → newshacker only)

Pull HN's favorites list on login and merge into local. Never write
back to HN.

- **Pros.** Trivial. No queue, no write endpoint, no auth-token
  scraping. Still delivers a real user-visible win: "log in and your
  HN favorites appear in newshacker automatically."
- **Cons.** Favoriting in newshacker is invisible on HN. That's a
  leak users will notice.

**Useful as a first cut**, but insufficient as the end state.

## Recommendation

**Ship Option 4 as phase A, then Option 1 as phase B, in separate
commits.**

Phase A (read-only) is small enough to land in a day and delivers the
most valuable half of the feature: newshacker shows a heart on stories
you already favorited on HN. It also lets us build and test the HN
favorites-list scraper in isolation before we wire up writes.

Phase B (local queue + forwarder) then closes the loop. If we ever
have to rip out the write path (HN HTML change, rate-limiting, abuse),
Phase A still works and newshacker still behaves sensibly.

I also recommend **not** extending this to hide/ignored in the same
change, even though the mechanism is parallel. HN has no public
"my hidden items" page, so the read half is impossible — we can only
push. That asymmetry earns it its own plan and its own phase. See
**Stretch: hide/ignored sync** at the bottom.

---

## Plan for Option 1 (client-side queue)

### New files

**`api/hn-favorite.ts`** — `POST` handler.

- Body: `{ id: number, action: "favorite" | "unfavorite" }`.
- Requires the `hn_session` cookie; 401 otherwise (same pattern as
  planned `/api/vote.ts` in `IMPLEMENTATION_PLAN.md:179`).
- Steps:
  1. `GET https://news.ycombinator.com/item?id=<id>` with the HN
     cookie.
  2. Parse the page for the logged-in user's `fave?id=<id>&…&auth=<T>`
     link. If the link isn't present (not logged in upstream, HN
     HTML changed), return 502.
  3. `GET https://news.ycombinator.com/fave?id=<id>&auth=<T>`
     (append `&un=t` for unfavorite) with the HN cookie.
  4. Return 204 on success; 401 if HN redirects to login (session
     expired); 502 on scrape failure.
- Desktop `User-Agent` + `redirect: manual`, matching `api/login.ts`.
- Referer allowlist, same as `api/summary.ts` etc.

**`api/hn-favorites-list.ts`** — `GET` handler.

- Requires `hn_session`; 401 otherwise. Username comes from the
  session cookie, same as `api/me.ts` and `api/sync.ts:198`.
- Fetches `https://news.ycombinator.com/favorites?id=<user>`,
  follows the "More" link until exhausted or until a 200-entry cap
  (first-page default) is hit.
- Returns `{ items: [{ id: number, at?: number }] }`. We don't get
  a real "favorited at" timestamp from HN's page; treat these as
  `at: 0` so local (tombstoned or timestamped) writes always win
  the merge if there's a conflict.
- Server-side cache the result in Upstash for 5 minutes per user to
  avoid hammering HN on every app open — bootstrap doesn't need to
  be fresh to the second.

**`src/lib/hnFavoriteQueue.ts`** — persistent queue.

- localStorage key: `newshacker:hnFavoriteQueue`.
- Shape:
  ```ts
  interface QueuedAction {
    id: number;
    action: "favorite" | "unfavorite";
    at: number;          // enqueue time, for debugging
    attempts: number;
    nextAttemptAt: number;
    lastError?: string;
  }
  ```
- API: `enqueue(id, action)`, `peekReady(now)`, `markSuccess(id)`,
  `markFailure(id, err, isRetryable)`, `drop(id)`, `list()`,
  `clear()`, plus a `QUEUE_CHANGE_EVENT` so the debug panel can
  subscribe.
- **Coalesce on enqueue.** If an existing entry for the same `id`
  is pending and the new action cancels it (favorite → unfavorite
  or vice versa), drop both (the net change on HN is zero). This is
  the important correctness property — otherwise a rapid tap-tap
  sequence could race with the forwarder and leave HN in the wrong
  state.
- **Backoff.** 2s, 4s, 8s, 16s, 32s, … capped at 5 min; max 10
  attempts then drop with a `lastError` on a telemetry event.
- The queue entries are the *intent*; the local favorites store is
  the *state*. They must stay consistent on rollback: if the queue
  drops an entry without success, the local state still wins —
  local is source-of-truth.

**`src/lib/hnFavoriteSync.ts`** — worker/orchestration.

Shape mirrors `src/lib/cloudSync.ts`: a module-level singleton with
`startHnFavoriteSync(username)` / `stopHnFavoriteSync()`.

- On start:
  1. Pull HN's favorites list (once), merge into local favorites
     (respect local tombstones — a locally-tombstoned id should
     *not* resurrect just because HN still has it; instead, enqueue
     an `unfavorite` so HN catches up).
  2. Drain the queue.
- Subscribe to:
  - `FAVORITES_CHANGE_EVENT` — if the change originated from a user
    tap (not from a merge), enqueue the corresponding HN action.
    We need a way to distinguish "user toggled" from "we merged
    server state in" to avoid echo loops; easiest is a dedicated
    entry point on `useFavorites` that both mutates local state and
    enqueues, rather than listening to the generic event.
  - `online` (via `subscribeOnline`) — flush queue.
  - `visibilitychange` — flush queue (gated like `cloudSync.ts:419`).
- **Auth-expired handling.** If `/api/hn-favorite` returns 401,
  stop the worker, surface a banner "HN session expired, sign in
  again to finish syncing favorites." Queue stays intact; worker
  resumes on next successful login.

**`src/hooks/useHnFavoriteSync.ts`** — lifecycle hook.

Mounts next to `useCloudSync` in `App.tsx`; calls
`startHnFavoriteSync(user.username)` when authenticated,
`stopHnFavoriteSync()` on logout/unmount.

### Modified files

**`src/hooks/useFavorites.ts`** — the `favorite` / `unfavorite` paths
call `hnFavoriteQueue.enqueue(...)` when `useAuth().isAuthenticated`
is true. Logged-out callers short-circuit and only touch local state
(unchanged behavior).

**`src/App.tsx`** — mount `useHnFavoriteSync` alongside
`useCloudSync`.

**`src/pages/DebugPage.tsx`** (if it exists, otherwise the existing
`/debug` surface) — add a panel showing queue length, last attempt,
last error, same pattern as the cloud-sync debug panel.

**`SPEC.md`** — document under *Favorites*: "For logged-in users,
newshacker mirrors favorite/unfavorite to HN best-effort. Local
state is authoritative; propagation retries on reconnect. Logged-out
users are local-only."

**`IMPLEMENTATION_PLAN.md`** — new phase (§ 5f, after 5d Voting), with
the same structure as the existing phases: goals, client/server
changes, tests, cost/reliability note.

### Tests

- `api/hn-favorite.test.ts` — fixture HTML for logged-in item page;
  assert correct URL and cookie forwarded; 401 when session missing;
  502 on missing `fave` link; handles both favorite and unfavorite.
- `api/hn-favorites-list.test.ts` — fixture favorites page with
  pagination; asserts all IDs scraped across pages; cap enforced.
- `src/lib/hnFavoriteQueue.test.ts` — enqueue, coalesce (fav→unfav
  cancels both), backoff schedule, max-attempts drop.
- `src/lib/hnFavoriteSync.test.ts` — bootstrap merge respects local
  tombstones; worker drains queue; retries on 5xx, drops on 4xx,
  stops on 401.
- `src/hooks/useFavorites.test.ts` — extend: logged-in toggle
  enqueues; logged-out toggle does not.

### Cost/reliability (rule 11)

- **Per user action:** 2 HN fetches (scrape + action) + 1 Vercel
  invocation. At 10 favorites/user/day across, say, 1 000 active
  users that's 20 000 fetches/day = ~600 k/month. Well inside the
  Vercel Hobby tier (100 k requests/day on serverless, but each
  bounce is internal — only the outer POST counts against the
  budget, so ~30 k/month of paid invocations).
- **Bootstrap:** up to 17 HN fetches for a 500-favorite user,
  once per login, 5-min server-side cache in Upstash means tab
  reopens don't re-fetch. At 1 000 users logging in / day that's
  ~17 000 fetches/day in the worst case, typically much less.
- **New failure modes:** (a) HN HTML changes → scraper breaks →
  syncing silently stops; we notice via the queue's telemetry
  counter. (b) HN rate-limits us → backoff handles it as long as
  the queue length stays sane. (c) Upstash down → bootstrap pulls
  hit HN every time, within HN's tolerance.
- **Blast radius if the whole feature breaks:** local favorites
  keep working, cross-device sync via `/api/sync` keeps working,
  the HN round-trip just stalls. User sees a "sync pending" hint
  in the debug panel. No data loss — the queue is persistent.

### Out of scope for this plan

- Hide/ignored round-trip (see stretch below).
- Voting (already its own phase, § 5d).
- Migrating the HN write path off HTML scraping — there is no
  official API.

---

## Stretch: hide/ignored sync

Our `dismissedStories` list is semantically close to HN's hide. The
write path is exactly parallel: `api/hn-hide.ts` takes
`{ id, action: "hide" | "unhide" }`, scrapes the same auth token
from the item page (HN uses the same token for hide and fave), and
forwards.

The read path has no equivalent — HN doesn't publish a user's hide
list. That means: push-only, no bootstrap, no reconciliation against
HN. A user who hides something on HN would not see it hidden in
newshacker. That may be fine — the dominant direction is probably
newshacker → HN.

Given the asymmetry, treat it as its own phase (§ 5g) to be decided
after we see how Phase B of this plan behaves in practice.

---

## Open questions for the reviewer

1. **Echo avoidance.** Does the distinction "user-originated vs.
   merge-originated" belong in `useFavorites`, or should it live in
   `favorites.ts` (e.g. a second change event for local user
   actions vs. sync-applied state)? Leaning toward the former for
   now — keeps `favorites.ts` dumb.
2. **Bootstrap merge of HN-only entries.** HN gives us no timestamp
   for favorites. If local has an id tombstoned at `at=T` and HN
   still has it, we enqueue an unfavorite. Good. But if local has
   no record and HN has it, we add it with `at=0` — meaning any
   future local action wins. Is that the desired semantic? Think
   so, but flagging.
3. **Server-side cache of HN's favorites page.** 5 min TTL in
   Upstash is arbitrary. Could also live in-memory per instance
   (shorter, cheaper) — tradeoff vs. bootstrap latency. Happy with
   whichever the reviewer prefers; defaulting to Upstash for
   consistency with `/api/sync`.
