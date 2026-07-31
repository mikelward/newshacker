# Readmo — SPEC

> **Paste-ready spec for a new app.** **Readmo** is a mobile-first RSS/Atom
> reader PWA that reuses *newshacker*'s UX **as-is** — same row layout, same
> tap-target discipline, the **same Pinned / Favorite / Done / Hidden /
> Opened model**, same swipe gestures, same library views, same Sweep/Undo,
> same offline/PWA behavior. The **only** intended differences are the data
> source (your RSS subscriptions instead of Hacker News) and the plumbing
> that requires (server-side fetch/parse + accounts + sync). Where this says
> "same as newshacker," it means *copy that behavior*, not reinterpret it.
> Read this alongside newshacker's `SPEC.md`; this document calls out only
> where Readmo must differ and why.

---

## Overview

**Readmo** is a mobile-friendly, installable reader for the RSS/Atom/JSON
feeds you subscribe to. You add feeds, Readmo polls them on the server, and
you triage articles with the **exact newshacker interaction model**: a clean
chronological feed with **Pinned** items at the top, fading **Opened**
titles, swipe to **Hide**, **Pin** to keep in your reading list, **Favorite**
to keep forever, **Done** to complete — synced across devices and readable
offline.

- Primary domain: **readmo.app**.
- Stack: **React + TypeScript + Vite**, frontend on **Vercel** (same as
  newshacker).
- Backend: **Supabase** — Postgres (data), Auth (social OAuth), Row-Level
  Security (per-user isolation), and scheduled Edge Functions (feed polling).
  Feed fetching/parsing runs in serverless functions, never the browser
  (CORS forbids cross-origin feed fetches).
- **No AI features in MVP.** RSS items usually carry full content; we don't
  summarize. (Deferred — would reuse newshacker's Gemini/Jina caching path.)

Readmo is independent and not affiliated with any feed publisher; it renders
publishers' own syndicated content and always links back to the original.

## What is identical to newshacker (do not redesign)

The following are inherited **verbatim in behavior** — only the data behind
them changes. Treat newshacker's `SPEC.md` as the normative description and
copy it:

- **Story/item row layout** — at most three tap zones, two shipped (row body
  stretched link + right-side icon button), reserved middle slot. Min 44×44px
  touch targets, ≥8px gaps, 48px+ rows, pressed-state on every zone, metadata
  display-only.
- **Pinned / Favorite / Done — three intents, three buckets**, plus **Hidden**
  and **Opened**, with the same semantics, the same shields, the same
  retention. See *Item state model* below.
- **Pinned prepended to the top of every feed**, rendered once, oldest-pinned
  first; pinning a body row keeps its position; **Sweep** consolidates.
- **Swipe gestures** — swipe-right = Hide, swipe-left = Pin, rubber-band
  shields with outcome labels.
- **Library views** — `/pinned`, `/favorites`, `/done`, `/hidden`, `/opened`,
  reusing the feed row with the right-side button swapped to the view's
  inverse action.
- **List toolbar** (sticky Undo + Sweep) and **bottom action bar**
  (Back-to-top + More + Undo + Sweep).
- **Thread/reader action bar** discipline, **pull-to-refresh**, **keyboard
  shortcuts**, **header account chip**, **offline pill**, **/offline** view.
- **PWA install identity, service worker (`autoUpdate` + PTR update-check),
  caching strategy, persisted query cache, offline UX** — same shapes.

## What necessarily differs from newshacker (and why)

1. **Data source: your RSS subscriptions, not Hacker News.** The "feed" is
   the chronological merge of items from the feeds you subscribe to, newest
   first — wherever newshacker says "Top/New/Best/Ask/Show/Jobs," Readmo
   substitutes "your subscriptions / a folder / a single feed."
2. **Server-side fetch + accounts + sync.** RSS origins don't send CORS
   headers, so feeds are fetched/parsed server-side; per-user subscriptions
   and item state live in Postgres and sync across devices. newshacker was
   stateless (HN's API is public); Readmo owns a backend.
3. **No comments, no votes.** RSS items have neither. So: no comment thread,
   no comment-summary card, no "N new comments" badge, no Upvote/Downvote in
   the action bar. The "thread page" becomes the **reader view** (the article
   itself). Everything else on that page (Open original, Pin, Done, Favorite,
   Share, More) is unchanged.
4. **AI summaries off** (see Overview).

Everything not in this list should match newshacker.

## Language & spelling

**US English everywhere** — copy, identifiers, CSS class names, storage keys
(now DB column names), comments, docs (e.g. *favorite*, *color*). Same as
newshacker.

## Visual design

Indigo on paper — distinct from newshacker's orange, and (unlike orange)
indigo clears 4.5:1 on white so it can be used for links, not just as a glyph
backdrop. Everything else about the visual system mirrors newshacker.

- **Accent / primary:** indigo `--rm-accent: #3a4ec4` (logo tile behind the
  white glyph, focus rings, the primary "Open original" button, active library
  icons, links). Verify the final hex clears 4.5:1 on both light and dark.
- **Background:** warm off-white paper `--rm-bg: #faf9f5`; white
  `--rm-bg-card: #ffffff` for rows/cards.
- **Text:** `--rm-text: #1a1a1a`; **opened/read titles** `--rm-read: #4a4a4a`
  (mid-tone below unopened, above meta); meta `--rm-meta: #6b6b6b`. The
  opened-title fade is the same read/unread treatment newshacker uses (color
  gap + weight step), identical in light and dark.
- **Mark:** indigo rounded-square tile, white glyph biased toward the top,
  white **home-indicator pill** near the bottom (same mobile-first motif as
  newshacker). Generate the icon set once (`scripts/generate-icons.mjs`) into
  `public/`.
- **Dark mode:** full light/dark/system via tokens.
- Icons inlined monochrome SVG (Material Symbols, `fill="currentColor"`), no
  icon font / runtime request.

CSS gotchas inherited verbatim: wrap painted `:hover` in `@media (hover: hover)`
(keep `:active` outside) to avoid sticky touch-hover; use a `<TooltipButton>`-style
wrapper for interactive buttons; icon-only buttons carry an `aria-label`.

---

## Item state model (Pinned / Favorite / Done / Hidden / Opened)

**This is newshacker's model, unchanged.** Five states per `(user, item)`,
stored server-side and synced. Same intents, same shields, same retention —
the only difference is they're DB columns instead of localStorage keys.

- **Pinned (📌)** — your **active reading list**. Pin from a row (pin button,
  swipe-left, or long-press → Pin). Pins stay until you remove them (explicit
  in, explicit out, no auto-pruning). **Pinned items are prepended to the top
  of every feed** (see *Feed views*). Verb pair Pin / Unpin.
- **Favorite (♥)** — a **permanent keepsake**. Favorite from the **reader
  view** (action bar) — a row-level heart on a feed would add a fourth tap
  target and break the fewer-targets rule. On `/favorites` the row's
  right-side slot carries a filled heart that unfavorites. Never swept, never
  expired.
- **Done (✓)** — your **completion log**. Mark done from the **reader view**;
  on `/done` the row carries a filled check that unmarks done. Marking Done
  also **unpins** (Pin is the queue, Done is where items go when they leave
  it; mutually exclusive). Done items are filtered out of every feed
  (permanent, unlike Hidden's TTL).
- **Hidden** — dismiss (not interested). Hide via swipe-right or the row menu.
  Hidden items are filtered from every feed and surface only on `/hidden`
  (a 7-day recovery view). Same semantics as newshacker.
- **Opened** — auto, set when you open an item. Fades the title (`--rm-read`),
  shows on `/opened` (7-day history). "Mark unread" in the row menu clears it.
  (newshacker's "N new comments" badge does **not** apply — RSS items don't
  accrue comments — so the opened entry stores only the open timestamp.)

**Shields (identical to newshacker):**

- **Pin shields against every swipe.** On a pinned row both swipe directions
  are suppressed (swipe-right Hide and swipe-left Pin — the latter because
  re-pinning would re-stamp the timestamp and reorder the pinned list). The
  row-menu "Hide" item is hidden on pinned rows. A pinned item leaves the list
  only via **Done** (normal lifecycle, also unpins) or **Unpin** (explicit).
- **Hide shields against Pin.** On a hidden row, swipe-left and the menu "Pin"
  are suppressed — pinning an already-hidden item would reintroduce a
  pin ∩ hidden collision.
- **Suppressed swipes rubber-band, don't silently absorb** — the row tracks
  the finger and snaps back; the revealed edge label names the outcome
  (`Pinned` on both edges of a pinned row; `Hidden` on a hidden row's
  swipe-left; otherwise `Hide` / `Pin`). Same `useSwipeToDismiss`
  fall-through-to-`setOffset(0)` mechanism.
- **Enforcement at the mutation layer, not just the UI** (newshacker enforces
  in its store hooks; Readmo enforces in the write path / DB): pinning removes
  Done and Hidden; hiding removes Pinned; marking Done removes Pinned. Hide ↔
  Done may coexist (Done's filter supersedes Hide's anyway).
- **Coupled mutations carry — and the server checks — the version of *every*
  field they touch, not just the primary one.** Because the above side effects
  cross fields (Pin clears `done`+`hidden`; Hide and Done clear `pinned`), a
  flush must include the caller's last-seen versions for each field it will
  write, and the server applies the whole mutation only if **all** of those
  versions are current; otherwise it reconciles and replays. Without this, a
  stale offline Pin would silently erase a newer cross-device Done: device A
  queues Pin offline, device B marks the item Done, A reconnects with a current
  `pinned_ver` — and the "pinning clears Done" side effect would wipe B's
  `done` without ever checking `done_ver`. Grouping the version check over the
  coupled cluster (`pinned`/`done`/`hidden`) closes that gap; `favorite` and
  `opened` are independent and keep single-field checks.

**Retention (same as newshacker "Retention today"):** Favorite, Pinned, and
Done are **permanent**; Hidden and Opened expire after **7 days**. The 7-day
sweep keys off the wall-clock `hidden_at` / `opened_at` columns, and `/opened`
sorts by `opened_at desc` — the per-field `*_ver` columns are server conflict
tokens only and are **never** used for expiry or ordering (they're a sequence,
not a time). (Revisit TTLs with real usage data — same standing TODO as
newshacker.)

**Cross-device sync:** all five states ride the Postgres `item_state` row and
sync automatically (server is the source of truth — see *Sync*).

**Pinned/Favorite offline warm:** pinning or favoriting an item prefetches its
full content + images into the offline cache so `/pinned` and `/favorites`
work offline — same shape as newshacker's pin/favorite prefetch (see *PWA &
Offline → Prefetch on Pin/Favorite*).

---

## Data & backend architecture

### Why server-side (vs. newshacker's stateless client)

newshacker needed no backend — HN's Firebase API is public, CORS-enabled, and
cacheable, so the client called it directly. RSS origins **do not** send
permissive CORS headers, so the browser can't fetch them. Feed fetch, parse,
and de-dup **must** run server-side, which is also where accounts and sync
live.

### Stack

- **Frontend:** React + TS + Vite on Vercel (same as newshacker).
- **Supabase:** Postgres (all relational data); Auth (social OAuth — Google /
  Apple / GitHub, no password storage); Row-Level Security (every per-user
  table gated on `auth.uid()` — the DB-enforced analog of newshacker's
  "fail closed, verify against the source of truth" `/admin` discipline);
  scheduled Edge Functions (`pg_cron` + an Edge Function) for the poller.
- **Serverless feed functions** — fetch/parse/discover; stateless and
  idempotent. (If on Vercel, observe newshacker's `api/` gotchas: inline
  helpers, no cross-`api/` imports — Vercel's bundler drops them at deploy
  time.)

### Schema (sketch)

```
users         (id, oauth_subject, email, created_at, …)               -- Supabase auth
feeds         (id, fetch_url_hash UNIQUE, secret_url, display_url, site_url,
               title, etag, last_modified, last_fetched_at, next_fetch_at,
               fetch_interval_s, error_count, last_error)             -- shared; keyed by the actual fetch URL
items         (id, feed_id FK, guid, url, title, author, published_at,
               content_html, summary, enclosures, content_hash,
               dedup_key NOT NULL, created_at)                        -- shared; UNIQUE(feed_id, dedup_key)
item_resources(item_id FK, ref TEXT, original_url, content_type,
               fetched_at)                                            -- PK(item_id, ref); hash→URL map for the image proxy
subscriptions (user_id FK, feed_id FK, folder, title_override,
               muted bool, sort, created_at)                         -- PRIMARY KEY(user_id, feed_id)
item_state    (user_id FK, item_id FK,
               pinned bool, pinned_at, pinned_ver bigint,
               favorite bool, favorite_at, favorite_ver bigint,
               done bool, done_at, done_ver bigint,
               hidden bool, hidden_at, hidden_ver bigint,
               opened bool, opened_at, opened_ver bigint)            -- PK(user_id,item_id)
               -- per field: *_at = wall-clock (drives TTL + sort), *_ver = server conflict token
folders       (user_id FK, name, sort)
```

- **Feeds and items are shared at the storage layer** (poll each distinct feed
  once regardless of subscriber count) — poll cost scales with *distinct
  feeds*, not users. "Shared storage" does **not** mean "world-readable" (see
  RLS).
- **`item_state` is sparse — one row per item the user has *acted on*, not per
  item that exists.** The poller writes only to shared `items`; it does **not**
  fan out an `item_state` row to every subscriber when a new item arrives
  (that fan-out would make poll/write cost scale with *users × items* and
  contradict the "scales with distinct feeds" claim above). A brand-new item
  therefore has **no** `item_state` row for anyone, which is correct: absence
  of a row means unopened, not-pinned, not-done, not-hidden.
- The hot query is "feed items across a user's subscriptions, newest first,
  paginated, minus Done/Hidden, with Pinned lifted to the top." Because
  `item_state` is sparse, the feed query **drives from `subscriptions` →
  `items` and LEFT JOINs `item_state`** (on `user_id = auth.uid()`), treating a
  missing row as the default state — so new items surface immediately without
  requiring a pre-inserted state row. Filters read as
  `WHERE NOT COALESCE(is.done, false) AND NOT COALESCE(is.hidden, false)`;
  the Opened fade reads `COALESCE(is.opened, false)`; Pinned items are
  collected by a separate small query (`item_state.pinned = true` for the user)
  and prepended. Index `subscriptions(user_id)`, `items(feed_id, published_at)`,
  and `item_state(user_id, item_id)` (plus partial indexes on
  `item_state(user_id) WHERE pinned` / `WHERE done` / `WHERE hidden`) to keep
  the join cheap. A write happens only when the user actually pins/favorites/
  dones/hides/opens something — that's the first time a row is upserted.

### RLS — reads scoped to the caller; `feeds`/`items` are NOT world-readable

- `subscriptions`, `item_state`, `folders`: readable/writable only where
  `user_id = auth.uid()`.
- `feeds` and `items` are physically shared but **must not** be exposed to
  every signed-in user — a feed URL and stored `content_html` are
  user-sensitive whenever a feed is private or tokenized (paid newsletters,
  per-user feed URLs with a secret in the path/query). The policy exposes a
  row only when the caller either **(a)** has a matching `subscriptions` row
  (`EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = feeds.id AND s.user_id = auth.uid())`)
  **or (b)** has a **permanent** item_state row pointing at the item
  (`EXISTS (SELECT 1 FROM item_state st WHERE st.item_id = items.id AND st.user_id = auth.uid() AND (st.pinned OR st.favorite OR st.done))`,
  parent feed by extension). Branch (b) is **required** so unsubscribing
  doesn't orphan permanent Pinned/Favorite/Done items pinned against GC.
  (Hidden/Opened are TTL'd and get no such exemption.) Enforce via RLS
  predicates or a security-definer view/RPC applying the same test. The poller
  writes with the service role, bypassing RLS.
- **Feeds are keyed by the *actual fetch URL*, with the secret kept in its own
  column.** Three URL-ish fields, deliberately separated: `secret_url` = the
  real fetchable URL (may embed a per-user token; the poller reads it),
  `display_url` = a scrubbed, token-free URL safe to show, and
  `fetch_url_hash` = `hash(normalize(secret_url))`, the **UNIQUE** de-dup key.
  Keying on the fetch URL (not a display URL) is required: if `display_url`
  were the unique key, two different per-user tokens from the same publisher
  would collide into one shared row and attach a subscriber to the wrong secret
  feed; and storing the token in a `url` unique column would contradict
  column-secrecy. Two users who paste the *same* tokenized URL still share one
  row (same `fetch_url_hash`); different tokens get different rows. The hash is
  a salted/opaque digest so it doesn't leak the token even if exposed.
- **Keep feed secrets out of client-readable *columns* — row RLS is not enough.**
  Row-level RLS only decides *which rows* a caller may read; once a row is
  visible, a PostgREST/Supabase client can `SELECT` **any column the role is
  granted**, including `secret_url` and `fetch_url_hash`. So column secrecy is
  enforced at the privilege/interface layer: **(1)** `REVOKE SELECT
  (secret_url, fetch_url_hash)` on `feeds` from the `authenticated`/`anon`
  roles (the poller's service role keeps access); and **(2)** route **all**
  client feed reads through a **client-safe view / RPC** projecting only
  display-safe columns (`id`, `display_url`, `site_url`, `title`,
  health/status), never the fetch URL or its hash. Tests assert the
  `authenticated` role cannot select `secret_url`/`fetch_url_hash` and that the
  client-safe view omits them.
- **Owner-scoped OPML export RPC.** Locking the fetch URL to the service role
  leaves OPML export (an MVP requirement) with no way to emit `xmlUrl`. Close
  the gap with a narrow **security-definer RPC** that returns the feed URLs for
  **only the caller's own `subscriptions`** (joins `subscriptions` on
  `user_id = auth.uid()` and reads the **service-side fetch URL** `feeds.secret_url`
  inside the definer context — the actual `xmlUrl`, which for every feed (public
  or tokenized) lives in `secret_url`), never arbitrary feeds. (Reading the
  scrubbed `display_url` would emit unusable OPML for tokenized feeds; the RPC
  is the *one* place the fetch URL is returned, and only for the caller's own
  subscriptions.) This is the single sanctioned read path for feed URLs on the
  client side — it doesn't reopen the secret columns on `feeds`, and it can't
  be used to enumerate feeds the caller isn't subscribed to. For a tokenized
  private feed the user pasted themselves, exporting their own `xmlUrl` back to
  them is correct (it's their secret); a test asserts the RPC refuses
  `feed_id`s the caller isn't subscribed to.

### Feed fetching & parsing (server)

- Conditional GET with stored `etag`/`last_modified` (`304` is free — bump
  `last_fetched_at`, done).
- Parse RSS 2.0, Atom, RSS 1.0/RDF, JSON Feed into a normalized item shape
  `{ guid, url, title, author, publishedAt, contentHtml, summary, enclosures }`
  (maintained parser, e.g. `fast-xml-parser` + a normalizer).
- **Sanitize** `contentHtml` server-side (DOMPurify/sanitize-html) before
  storing — strip scripts/handlers/disallowed tags, absolutize relative URLs
  against the item URL, force `rel="noopener"`. Never store/serve raw
  publisher HTML.
- De-dup on a **non-null, stable `dedup_key`** computed as
  `COALESCE(guid, url, normalize(title) || '\n' || published_at)` — never on
  raw `guid` (Postgres `UNIQUE` permits multiple NULLs, so a GUID-less feed
  would insert a fresh row every poll) and **never on `content_hash`**, which
  is *mutable*: hashing the body would change the key whenever the publisher
  edits the item, breaking update-in-place and duplicating the row. The
  title+published-time fallback is stable across edits. `UNIQUE(feed_id,
  dedup_key)` makes the upsert idempotent for every feed. `content_hash` is
  kept as a **separate** column used only to *detect* an edit (to refresh
  `content_html` on the existing row), never as identity. (An item with no
  guid, no url, **and** no title/date is unidentifiable and can't be updated in
  place — rare; logged and inserted as-is.)
- **One subscription per (user, feed):** `subscriptions` is `PRIMARY KEY
  (user_id, feed_id)`. The hot feed query drives from `subscriptions → items`,
  so a duplicate `(user_id, feed_id)` from a double-clicked Add, a retry, or an
  OPML re-import would duplicate every item from that feed and make
  unsubscribe/export ambiguous — the constraint prevents it at the DB, not just
  in the UI (add is an idempotent upsert on the key).
- **Image-ref mapping is persisted** in `item_resources` at sanitize time: for
  each sub-resource rewritten to `/api/img?item=<id>&ref=<hash>`, store
  `(item_id, ref=hash, original_url)`. The proxy resolves `ref → original_url`
  from this table, so it keeps working across poller restarts / deploys — the
  original `src` is removed from `content_html`, so the mapping can't live only
  in the HTML.

### Feed discovery

- `POST /api/discover { url }` accepts a site or feed URL; for an HTML page,
  parse `<link rel="alternate" type="application/rss+xml|atom+xml|json">` and
  common fallbacks (`/feed`, `/rss`, `/atom.xml`, `/feed.json`); validate by
  fetching+parsing each candidate before offering it.
- **Reddit is a first-class supported source** (Reddit no longer offers open
  API access, but every listing exposes Atom over RSS by appending `.rss`).
  Discovery recognizes `reddit.com` URLs and derives the feed form rather than
  relying on `<link>` autodiscovery (Reddit's pages don't always advertise it):
  subreddit `…/r/<sub>.rss` (and `/top`, `/new`, `/hot`, `/rising` →
  `…/r/<sub>/top.rss` etc.), multireddits `…/user/<u>/m/<name>.rss`, user
  posts `…/user/<u>.rss`, search `…/r/<sub>/search.rss?q=…&restrict_sr=1`, and
  the logged-out home/popular `…/.rss`. Reddit feeds parse as standard Atom
  through the normal pipeline; the post body (selftext / link) lands in
  `content_html` and is sanitized like any other feed.
- All discovery fetches go through the **SSRF-hardened fetcher** below
  (discovery is the highest-risk path — a brand-new user-supplied URL).

### Fetch hardening (SSRF — required for every server-side fetch)

`/api/discover`, the poller, the image proxy, and any future full-text
extraction fetch URLs that originate from users, so every outbound fetch
**must** route through one hardened helper enforcing:

- **Scheme allow-list:** `http`/`https` only (reject `file:`, `gopher:`,
  `ftp:`, `data:`, …).
- **Resolved-IP denylist:** block loopback (`127.0.0.0/8`, `::1`), link-local
  (`169.254.0.0/16`, `fe80::/10`, incl. cloud-metadata `169.254.169.254`),
  RFC1918 (`10/8`, `172.16/12`, `192.168/16`), ULA (`fc00::/7`), `0.0.0.0/8`,
  and other reserved ranges. Check the **resolved IP(s)**, not just the literal
  (DNS rebinding).
- **Re-validate every redirect** (manual follow, scheme+IP check per hop;
  reject a 302 to `169.254.169.254`; cap depth ≤5).
- **Timeouts and size caps** (e.g. 10s; 5–10MB body) to bound slowloris /
  decompression bombs.
- **No credential forwarding / no proxy trust** — never attach user session or
  service creds; ignore client `Host`/forwarding headers for target selection.

This is the RSS analog of newshacker's "never trust external input" posture.
Funnel all server fetches through it; a unit test asserts it rejects
loopback/link-local/private/metadata targets and redirects to them.

### Polling (the cron)

- A scheduled Edge Function runs ~every 5 min, selecting feeds with
  `next_fetch_at <= now()` **and** ≥1 subscriber, in batches: conditional GET,
  parse, upsert new items, schedule `next_fetch_at`.
- **Adaptive & polite:** honor `Cache-Control`/`ttl`/`<sy:updatePeriod>`; back
  off on `429`/`Retry-After`; exponential backoff + jitter on errors
  (`error_count`), capped ~6h; circuit-breaker parks a feed after N failures
  (surfaced as a feed-health badge). Healthy interval ~15–30 min.
- **Send a descriptive, contactable `User-Agent` on every fetch** (e.g.
  `Readmo/1.0 (+https://readmo.app)`). Some publishers — **Reddit notably** —
  return `429`/`403` to generic or empty UAs, and Reddit rate-limits by IP.
  Because all users share the poller's IP, a popular Reddit feed could hit
  Reddit's per-IP ceiling for *everyone* at once; mitigate by respecting
  `Retry-After`, polling Reddit feeds no faster than their `ttl`, deduping
  identical Reddit listings to a single shared `feeds` row, and (if it becomes
  a problem) routing Reddit polls through a small pool of egress IPs. Reliability
  note (rule 11): Reddit throttling degrades gracefully to the circuit-breaker
  + feed-health badge; no new infra unless the egress-pool mitigation is needed,
  which we'll cost out only if Reddit volume warrants it.
- **On-demand:** adding a feed or pull-to-refresh triggers an immediate
  server-side fetch for the relevant feed(s), debounced server-side.

### Cost & reliability (rule-11 discipline, carried from newshacker)

- **Supabase free tier** (Postgres 500MB, 50k MAU, scheduled functions) is $0
  at this project's scale; Pro ~$25/mo if it grows.
- **Poll cost scales with distinct feeds, not users**; conditional GETs are a
  few KB (`304`s nearly free).
- **New failure modes vs. newshacker:** DB + OAuth provider become hard
  dependencies; on a Supabase outage, login/sync fail but the offline cache
  still serves already-synced + pinned/favorited content. A flaky publisher
  can't take the app down (per-feed isolation + circuit breaker).

---

## Auth & sync

### Auth (Supabase social OAuth)

- Sign in with Google / Apple / GitHub. No password handled by us. Sessions
  are Supabase's HTTP-only refresh-token cookies; the access token is attached
  to API/DB calls.
- First launch (no session) routes to a clean sign-in screen (one-liner +
  OAuth buttons + short privacy disclosure). Deep links round-trip through
  sign-in then land on the target.
- **Account UI = header chip** (mirrors newshacker): one always-visible
  control, far right, 44×44+, every page. Signed out → "Sign in". Signed in →
  32px avatar (OAuth picture, falling back to an initial-on-color disc —
  deterministic, offline, zero requests); tap → popover with name, link to
  settings, "Sign out". Not in the drawer.

### Sync (server is the source of truth)

- Subscriptions, folders, and item state live in Postgres; the client keeps an
  optimistic local mirror (persisted React Query cache) and an offline outbox.
- **Offline mutation outbox.** Because Readmo owns its backend, state changes
  made offline are **queued and replayed** (newshacker dropped offline votes;
  Readmo keeps offline pin/favorite/done/hide/open). A toggle writes to a local
  outbox keyed by `(item_id, field)` recording the desired value + local order;
  on reconnect it flushes to Postgres. The UI reflects it immediately, rolling
  back only on a non-transient server rejection.
- **Conflict resolution uses a server-assigned, per-field version — not client
  wall time, and not a single row version.** Each field carries its own
  monotonic token (`pinned_ver`, `favorite_ver`, `done_ver`, `hidden_ver`,
  `opened_ver`), bumped **by the server** (from a sequence) on a write to *that*
  field. A flush, keyed by `(item_id, field)`, applies an incoming value only if
  the caller's last-seen version **for that field** is current, else returns the
  winning value to reconcile. Per-field tokens are required precisely because
  the outbox is per-field: a single row-level version would make unrelated
  fields collide — e.g. one device marking `opened` would bump the row version
  and cause another device's queued `favorite` flush (carrying the older row
  version) to be rejected even though it touches a different boolean. With
  per-field versions the independent booleans genuinely can't cross-conflict.
  We deliberately do **not** compare a client `updated_at` (a skewed/fast clock
  could stamp a future time and clobber newer changes). (newshacker's
  client-timestamp LWW was fine for single-user list reconciliation with no
  server in the path; Readmo has a real backend, so the authoritative clock
  lives there.)
- Realtime (optional, post-MVP): Supabase Realtime can push `item_state`
  changes to other open sessions. MVP relies on refetch-on-focus + PTR.

---

## Feature list (MVP)

1. **Subscriptions & organization**
   - **Add feed** by URL or site URL → discovery → confirm (shows title + a
     sample of recent items before subscribing).
   - **OPML import/export** (table-stakes RSS courtesy — never trap a user's
     list). Export emits real `xmlUrl`s, which the client can't read directly
     (the fetch URL is server-only — see *RLS*), so it goes through an
     **owner-scoped export RPC** that returns the caller's *own* subscriptions
     with their feed URLs and nothing else (see below).
   - **Folders/categories**, per-feed title override, drag-to-sort.
   - **Mute feed** — stays subscribed but excluded from the aggregate feed;
     still reachable on its own page. (This is per-feed; per-item dismissal is
     **Hide**, unchanged from newshacker.)
   - **Feed-health badge** when the poller parks a feed, with "retry now".

2. **Feed views (the lists)** — the chronological merge of subscription items,
   newest first, with newshacker's rules applied verbatim:
   - **`/` (Home)** — all non-muted subscriptions merged. A drawer *Home*
     picker can swap `/` to a chosen folder, persisted per-device (mirrors
     `useHomeFeed`). URL stays `/`.
   - **`/folder/:name`** — a folder's merge. **`/feed/:feedId`** — one feed.
   - **Pinned prepended to the top** of every feed view, rendered once,
     oldest-pinned first; **pinning a body row keeps its position** (Sweep
     consolidates) — newshacker's exact *Story feeds* rule.
   - **Done and Hidden filtered out**; **Opened** items render with the faded
     title.
   - **Initial paint one page (30 items)**; further pages only via an explicit
     **More** button (no infinite scroll). Same pagination discipline.
   - **Background refresh status strip** at the foot ("Checking for new
     items…" / "Couldn't refresh." + Retry), appearing only when rows are
     already on screen. Verbatim mirror.
   - **`/offline`** — items cached on this device.

3. **Item row** — see *Item row layout*. Right-side button = **Pin/Unpin** on
   feed views; the view-contextual inverse on library views.

4. **Library views** — `/pinned`, `/favorites`, `/done`, `/hidden`, `/opened`,
   reusing the feed row with the right-side button swapped to the view's
   inverse action (filled, accent-colored). Per-view "Forget all" toolbar on
   `/done`, `/opened`, `/hidden`; none on `/favorites`/`/pinned`. `/hidden` is
   the recovery view (drops items also opened). Same as newshacker.

5. **Reader view** — `/item/:id` — the article, with the action bar. No
   comments. See *Reader view*.

6. **List toolbar** — sticky below the header: right-aligned **Undo** +
   **Sweep unpinned** (Hide unpinned). Sweep plays the single slide-out and
   commits on animation end; Undo restores the last hide / swipe / sweep batch.
   Same component/behavior as newshacker.

7. **Bottom action bar** — Back-to-top + More + Undo + Sweep on feed footers;
   Back-to-top only on library footers. Same slot order.

8. **Pull-to-refresh** — re-runs the view's fetch **and** force-checks for a
   newer bundle. Identical to newshacker.

9. **Search** — `/search` over feed + item titles (Postgres `ILIKE`/`tsvector`
   on titles for MVP; body search deferred). Search-glass in the header
   right-actions group, suppressed on `/search`. Same placement.

10. **Settings** — `/settings`: subscriptions/folders, OPML in/out, theme
    (light/dark/system), Home picker, account/sign-out.

11. **Keyboard shortcuts** — same letter scheme (see below).

12. **Account UI** — header chip (see *Auth*).

---

## Item row layout

Identical to newshacker's *Story row layout*; only the meta content differs
(source feed instead of HN domain; no points/comments).

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│   Article title goes here, wrapping to two lines         │
│   if needed.                                            │   📌
│   ◐ The Verge · 3h · Jane Doe                            │
│                                                          │
└──────────────────────────────────────────────────────────┘
   ^                                                          ^
  Row tap → reader (/item/:id)                               Pin toggle:
  (title + meta share one stretched link)                   pin / unpin
```

- **Row body** — title + meta share one stretched `<Link to="/item/:id">`. Tap
  opens the reader (marks **Opened**).
- **Right-side icon button** — real icon button, 44×44+, ≥12px gap. On **feed
  views** it's **Pin/Unpin** (`push_pin` outline→filled). On **library views**
  it's the view's inverse: `/pinned` → Unpin, `/favorites` → Unfavorite
  (`favorite` filled), `/done` → Unmark done (`check_circle` filled),
  `/hidden` → Unhide (`visibility_off` filled), `/opened` → Mark unread —
  filled, accent-colored. Same table as newshacker's *Library views*.
- **Reserved middle slot** — unused; same high bar for any future use.

Display-only meta (plain text inside the row link): **source** (feed/site
name, favicon, trimmed to the registrable domain the way newshacker trims
domains — `old.reddit.com` → `reddit.com`); **age**; **author** when present.
**Opened** titles render `--rm-read`. Not rendered: rank numbers, inline
source/date links, external-link chevron (the reader's "Open original" owns
that). (No points/comments/Hot flag/"N new" — those are HN-specific.)

Sizing: 16px vertical padding, ≥72px row, 44×44 hit areas, ≥8px gaps,
pressed-state on every zone.

### Swipe gestures (same as newshacker)

- **Swipe-right → Hide** (reveals `Hide`).
- **Swipe-left → Pin** (reveals `Pin`).
- **Shields rubber-band:** pinned rows show `Pinned` on both edges and snap
  back; hidden rows show `Hidden` on swipe-left and snap back. Same mechanism +
  "every swipe names its outcome" rule.
- **Undo** (toolbar) restores the last swipe/menu-hide/sweep — one level, not
  persisted.

---

## Reader view (`/item/:id`)

Replaces newshacker's *Thread* page. No comments, no votes — the rest of the
page's discipline is unchanged.

- **Header:** source feed (favicon + name, links to `/feed/:feedId`), title
  (links to the original, `target="_blank"`, marks Opened), author, date.
- **Body:** the sanitized `content_html`; images lazy-load (proxied — see
  *Privacy*); relative URLs already absolutized. Enclosures render
  appropriately (`<audio>` for podcasts, image/figure, else a download link).
- **Reading affordances:** comfortable measure, paper surface, light/dark,
  `prefers-reduced-motion`.

### Reader action bar (mirrors newshacker's Thread action bar shape)

Single row, single-row invariant at ≥320px, pointer-vs-touch sizing, top **and**
bottom bars. Left→right:

**Open original** (primary, accent; marks Opened, fades to neutral once opened)
→ **Pin/Unpin** (📌) → **Done** (✓) → **More ⋮**. On wide viewports (≥960px)
**Favorite** (♥) and **Share** surface inline between Done and ⋮; below 960px
they live in the overflow. (No Upvote — RSS has no votes.)

- **Done** also unpins and **navigates back** (the "I'm finished, move on"
  gesture); **Unmark done** does not navigate. Same as newshacker.
- Bottom bar swaps the primary slot to **Back to top** (neutral, stretched) so
  Pin/Done/⋮ land at the same x-position.
- **More ⋮** overflow: Favorite/Share (when not inline), **Open feed**, **Copy
  link**, **Mute feed**. Anchored dropdown (sheet fallback), 44px touch / dense
  pointer.
- **Share** shares the **original article URL** (publishers want canonical-page
  traffic; there's no on-site discussion page to prefer — the one place Readmo
  differs from newshacker, which shared its own `/item/:id`). Web Share API +
  clipboard fallback + "Link copied" toast.

---

## Routes

| Path | View |
|---|---|
| `/` | aggregate feed of all non-muted subscriptions (drawer Home picker can swap to a folder; URL stays `/`) |
| `/folder/:name` | folder aggregate |
| `/feed/:feedId` | single feed |
| `/pinned` | pinned items (active reading list) |
| `/favorites` | favorite items (permanent) |
| `/done` | completed items |
| `/hidden` | recently hidden (7-day recovery) |
| `/opened` | recently opened (7-day history) |
| `/offline` | items cached on this device |
| `/item/:id` | reader view |
| `/search` | search over feed + item titles |
| `/settings` | subscriptions, folders, OPML, theme, account |
| `/signin` | OAuth sign-in (unauthenticated landing) |

---

## Accessibility

- Semantic HTML, visible focus, `prefers-reduced-motion` honored.
- Body contrast ≥4.5:1 (indigo accent clears it on white/dark — verify final
  hex).
- Every icon-only button has an accessible name; the long-press tooltip is
  visual-only.

### Keyboard shortcuts (same scheme as newshacker)

List pages (`/`, `/folder/:name`, `/feed/:feedId`, library views):

| Key | Action |
|-----|--------|
| `j` / `↓` | Focus next row (first press focuses the first row) |
| `k` / `↑` | Focus previous row |
| `Enter` | Open the focused row's reader |
| `Space` | Open the row's actions menu |
| `o` | Open the focused row's original article in a new tab |
| `p` | Toggle Pin on the focused row |
| `d` | Hide (dismiss) the focused row |
| `?` | Help overlay · `Esc` close |

Reader page (`/item/:id`):

| Key | Action |
|-----|--------|
| `j` / `k` | Scroll to next/previous section heading (or page top/bottom) |
| `o` | Open original · `p` Pin · `f` Favorite · `d` Done (navigates back) |
| `?` / `Esc` | Help / close |

Same bail-out conditions as newshacker (skip in inputs, open dialog/menu,
modifier held, pre-defaulted). No auto-focus on load.

---

## PWA & Offline

Installable; offline reading of already-synced and explicitly pinned/favorited
content. Closest mirror of newshacker.

### Install identity

- Manifest (via `vite-plugin-pwa`): name "Readmo", theme `#3a4ec4`, background
  `#faf9f5`, `display: standalone`, `start_url: /`.
- Icon set into `public/`: `icon-192/512`, `icon-512-maskable`,
  `apple-touch-icon` (180), `favicon.svg`, `favicon-maskable.svg`,
  `favicon-32.png`. Maskable full-bleed, glyph in the 80% safe zone.
- `index.html` declares manifest + apple-touch-icon + `apple-mobile-web-app-*`.

### Service worker

- `registerType: 'autoUpdate'` — background download, silent activate on next
  navigation, no prompt. Same rationale.
- **PTR force-checks for updates** (`registration.update()`, reload on
  `controllerchange`) since the browser only re-checks `/sw.js` on full
  navigation and our PTR overrides native swipe-to-reload. `src/lib/swUpdate.ts`.
- **Passive surfaces:** `controllerchange` → "New version available · Reload"
  toast; `visibilitychange`-after-≥30s passive `registration.update()` ping.
- Disabled in `npm run dev`.

### Caching strategy

Client reads through Supabase rather than newshacker's `/api/*` proxies, so the
keys differ; the strategies map one-to-one:

- **App shell** — precached; navigation falls back to `index.html`.
- **Data reads (Supabase REST/RPC)** — **NetworkFirst** (~10s timeout, short
  TTL, bounded), cache fallback offline. (Same NetworkFirst-over-SWR reasoning.)
- **Pinned/Favorite item content** — **no expiration** (the exemption
  newshacker grants pinned/favorited items); bounded only by per-origin quota.
- **Article images** (via the proxy below) — StaleWhileRevalidate, capped.
- **Favicons** — CacheFirst, long TTL, capped.

### Persisted query cache (client mirror)

- React Query cache persisted to **IndexedDB** (larger payloads than
  newshacker's localStorage — article bodies + image metadata — avoid
  `QuotaExceededError`).
- `networkMode: 'offlineFirst'` globally (true cache miss rejects fast → offline
  UI, not a hung skeleton). Same rationale.
- `CACHE_BUSTER` wipes the persisted blob on schema change; the outbox and
  Supabase data are unaffected (server is canonical).
- **All client caches are scoped to the signed-in user and purged on account
  change.** Because Readmo supports sign-out and renders private/tokenized
  content, a shared cache on a shared device could let user B rehydrate user
  A's data before the network corrects it. Key the IndexedDB store **and** every
  Workbox runtime cache by `auth.uid()`, and on any auth transition (sign-out,
  or sign-in as a different subject) purge the previous user's IndexedDB store +
  named Cache Storage buckets before the new session paints (treated like a
  `CACHE_BUSTER` bump). The outbox is per-user, flushed-or-discarded on
  sign-out. The one place Readmo must be stricter than newshacker, which never
  had multiple identities or private content on a device.

### Prefetch on Pin/Favorite (mirrors newshacker's pin/favorite prefetch)

- **Pinning** calls `prefetchPinnedStory` — stores the item's full
  `content_html` + referenced images in the persisted cache at pin time, so
  `/pinned` works offline.
- **Favoriting** calls `prefetchFavoriteStory` — same for `/favorites`.
- Pinned/Favorite cache entries lock at `gcTime: Infinity` while the state
  holds and re-lock on cross-tab change / rehydrate / late image fetch (the
  `subscribeToPinnedCacheLocking` pattern). Never evicted while pinned/favorited.

### Offline UX (mirrors newshacker)

- `useOnlineStatus` → small **"Offline" pill** in the header linking to
  `/offline`.
- **Combined detection** (`networkStatus.ts`): `online = browserOnline &&
  fetchOnline`; `trackedFetch` flips `fetchOnline` on `TypeError` / any response
  (ignore `AbortError`); AND-ing protects both directions; keep React Query's
  `onlineManager` in sync.
- **Offline reader miss:** "This article isn't saved offline. Pin it while
  online to keep a copy." — no retry button offline.
- **Writes queue offline** (the outbox) — pin/favorite/done/hide/open reflect
  immediately and flush on reconnect; hard failures roll back + toast.

### Pull-to-refresh

- Feed + library views: PTR re-runs the view's Supabase fetches **and**
  force-checks for a newer bundle. Gesture shape identical (arm at
  `scrollTop===0` on a downward-dominant drag, 0.5× rubber-band, cap 96px, fire
  past 64px, spinner ≥400ms; `overscroll-behavior-y: contain`).

---

## Performance targets

- FCP < 1.5s on a 4G mobile profile · initial JS < 150KB gzipped · list render
  < 100ms after data arrives.

## Error handling

- Network/DB errors: inline retry + the background-refresh strip.
- Parked feed: feed-health badge + "retry now", never a silent stall.
- Missing/blank content: "No content — open the original".
- Offline write failures roll back + toast.

## Testing (inherited expectations)

- **Vitest + RTL + jsdom**; MSW for network mocking. **Always add tests**;
  **always run** `npm test` / `lint` / `typecheck` (and `build` when touching
  build/routing/deploy) before done; 80% coverage floor for `src/lib/` + server
  handlers.
- Server feed-parser tests over RSS 2.0 / Atom / RDF / JSON Feed fixtures,
  malformed feeds, missing GUIDs, relative-URL absolutization, and sanitization
  (no script survives). SSRF helper test (rejects loopback/link-local/private/
  metadata + redirects to them).
- Avoid racy tests — gate async resolution explicitly (newshacker's `gateFetchOn`).

## Deployment

- Frontend on Vercel (`main` → prod, branches → preview).
- Supabase project (Postgres + Auth + scheduled functions); migrations in-repo
  (Supabase CLI). Secrets: Supabase URL/anon key client-side; service role +
  OAuth client secrets server-side only — never ship the service role key to
  the client.
- **Privacy.** Feed **fetching/parsing** is server-side, so for *polling* the
  publisher sees the poller's IP (shared), not individual readers. This is
  scoped to polling only and does **not** by itself cover rendered content:
  feed bodies embed images (and 1×1 tracking beacons) the reader would
  otherwise load from their own browser, exposing reader IP/UA. Readmo
  therefore serves all article sub-resources through a **server-side image
  proxy**.
- **Stored HTML holds stable opaque image refs, not signed/expiring URLs.**
  When sanitizing, rewrite each `<img src>` (and other sub-resource URL) in the
  stored `content_html` to a stable, non-secret placeholder — `/api/img?item=<item_id>&ref=<hash>`
  where `ref` is a hash of the original URL, resolved server-side via the
  persisted **`item_resources`** table (see schema) back to the real URL for
  that item — durable across poller restarts / deploys. Crucially the stored markup contains **no HMAC and no expiry**:
  `items.content_html` is shared and the pinned/favorite client cache never
  expires, so embedding signed expiring URLs would either break images on
  already-saved content when the token expired, or force long-lived tokens that
  weaken the boundary. (This corrects an earlier draft that put signed URLs in
  the stored HTML.)
- **The proxy is the authorization boundary — it authorizes per request via the
  caller's session, not via a token in the URL.** `/api/img` is outside the
  Supabase RLS path, so it must itself enforce the same two-branch read check:
  on each request it verifies the **authenticated** caller may read the
  requested `item_id` (subscription or permanent item_state) before fetching or
  returning cached bytes; an unauthenticated or cross-item request gets 401/403.
  Because auth is per-request and session-based, there's nothing to expire and a
  copied URL is useless to anyone not signed in as an authorized reader. Cache
  keyed by `(item_id, ref)`, not publicly addressable. (Offline reads need no
  proxy hit: prefetch-on-pin/favorite stores the already-authorized bytes in the
  per-user `auth.uid()`-scoped cache.)
- **What the proxy does and does not buy, privacy-wise.** It hides the reader's
  IP/UA from the publisher (the publisher sees only the proxy). It does **not**
  by itself stop a publisher from observing that *someone* loaded a beacon: on a
  cache **miss** the proxy still fetches the beacon URL from the publisher (from
  the proxy IP). To decouple the fetch from an individual read, sub-resources
  are fetched/cached at **poll/prefetch time** where practical (so the beacon
  hit isn't tied to a specific reader's view), and the sanitizer drops obvious
  zero-information beacons (1×1, known tracker hosts) as a **best-effort**
  heuristic — not a guarantee. The honest claim is: the proxy hides client
  network details and decouples most fetches from reads; it is not a promise
  that no publisher can ever record a read event.

## Analytics

- Cookieless web analytics at the app root (basic audience metrics), fail-open,
  same posture as newshacker.

## Open questions

- **Item retention / GC** — items per feed; exact pin-against-GC rule for
  Pinned/Favorite/Done. Start generous (e.g. 90 days or 200 items/feed,
  whichever is larger; never GC Pinned/Favorite/Done); revisit with data.
- **TTLs** — reconsider Pinned/Done permanence and Hidden/Opened 7-day windows
  with usage data (same standing TODO as newshacker).
- **Realtime sync** — ship in MVP or rely on refetch-on-focus + PTR? (Leaning
  defer.)
- **Per-feed full-text fetch** — Readability extraction for feeds that truncate
  (the only server fetch of *article* pages; opt-in per feed; through the
  SSRF-hardened helper).
- **Push notifications / Periodic Background Sync** — deferred; the poller is
  the natural trigger.

---

## Appendix: agent guardrails (carry these into the build)

The load-bearing rules from newshacker's AGENTS.md, applied unchanged:

1. **Always add tests; always run them** before reporting done. Fix a red
   baseline first, on its own commit.
2. **Fewer, larger tap targets.** ≤3 zones per row (two shipped); 44×44 touch
   floor; ≥8px gaps. Flag anything that adds a fourth tappable or fills the
   reserved slot.
3. **US English everywhere.**
4. **Keep this SPEC in sync with reality** — update it in the same commit as
   any reversed/extended decision or new user-visible behavior, tap target,
   storage surface, route, or layout reorder.
5. **Call out cost and reliability up front** for any new infra or external
   call (free-tier vs. paid, rough $/mo, failure modes, rate limits, latency).
   Say "negligible" explicitly rather than omitting.
6. **Sanitize all publisher HTML server-side** and **route every server-side
   fetch through the SSRF-hardened helper.** Feed content and user-supplied
   URLs are Readmo's untrusted input.
7. **RLS is the per-user boundary** — every per-user table gated on
   `auth.uid()`; client never gets the service-role key; fail closed.
   `feeds`/`items` are shared but **not** world-readable (subscription- or
   permanent-state-scoped); keep secret/tokenized feed URLs server-only —
   row RLS isn't enough for column secrecy, so `REVOKE SELECT` on the fetch URL
   and serve feeds through a client-safe view/RPC.
8. **Scope client caches by `auth.uid()` and purge on account change** — never
   leak one user's cached content to the next on a shared device.
9. **Match newshacker's UX by default.** When in doubt about an interaction,
   do what newshacker does; only diverge for the documented RSS-specific
   reasons (no comments/votes, server-side data, accounts/sync).
10. **Branching:** one topic per `claude/<short-topic>` branch off `main`; one
    commit per logical surviving change; PRs ready for review.
