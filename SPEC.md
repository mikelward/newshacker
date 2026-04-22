# newshacker — SPEC

## Overview

**newshacker** is a mobile-friendly, responsive web **reader for [Hacker News](https://news.ycombinator.com)**, built with React + TypeScript and deployed on Vercel. The goal is to deliver a clean, fast, thumb-friendly reading experience that keeps the familiar HN orange look while trimming the interface down to the features that matter on a phone.

Primary domain: **newshacker.app**. `hnews.app` is also owned and redirects (301) to `newshacker.app`.

"Hacker News" and "Y Combinator" are trademarks of Y Combinator; newshacker is an unofficial third-party client and is not affiliated with or endorsed by YC. The app is always described as a *reader for Hacker News*, never as "Hacker News" itself, and does not use HN's logo as its own.

## Language & spelling

All user-visible copy, identifiers, comments, and documentation use **US English** (e.g. *favorite*, not *favourite*; *color*, not *colour*). This applies to code (variable and component names, localStorage keys, CSS class names) as well as to product text.

## Primary design problem

The existing HN mobile site crams many small, adjacent tappable elements onto each row (title, domain, author, "hide", "past", "web", flag, comments count). On a 6" phone that produces frequent mis-taps. The UX goal of newshacker is to **reduce the number of tap targets per row and give the ones that remain plenty of room**, while keeping the HN look.

We achieve that by:

1. **At most three tap zones per row**, always in the same positions: the row body (title + meta) as a single stretched link on the left, a pin button on the right, and a reserved slot in between for at most one additional action. No hide, no past, no web, no flag, no inline author link, no rank number, no separate comments button. The shipped UI uses only two (row body + pin); voting currently lives on the thread page rather than the row (see *Thread action bar*).
2. **Large, well-spaced hit areas.** Minimum 48×48px per tappable, ≥8px dead space between adjacent targets.
3. **Metadata is display-only.** Domain, points, comment count, and age are plain text inside the row's stretched link; only the row body and the pin button are distinct tap targets today.
4. **The pin button is a real icon button** on the right, not an inline text link — visually obvious and easy to aim for.
5. **Obvious zones, not clever ones.** A reader should be able to glance at the row and know, without reading, what each tap will do.

## Goals

- Mobile-first responsive layout; also usable on desktop.
- Fast, minimal-JS bundle; good Lighthouse scores.
- Familiar HN look & feel — orange `#ff6600` header, cream background, compact typography — but with **fewer, larger, better-spaced** tap targets than HN's own mobile site.
- Read the main HN story feeds (top, new, best, ask, show, jobs).
- View a story's comment thread (read-only for MVP).
- Optional: log in and upvote stories via HN's existing web endpoints (from the thread page action bar; the story rows stay a two-tap-zone read surface).

## Non-Goals (MVP)

- Submitting new stories.
- Flagging stories or comments.
- Moderation features (hide, mark as dupe, etc.).
- Push notifications.
- Background sync of offline votes/comments.

Deferred rather than ruled out (see *Planned / not yet implemented*
above for the shape we expect to ship):

- **Voting / unvoting** — waiting on the per-item `auth`-token scraper.
- **Submitting comments and replies** — possible future feature once
  voting is stable. Out of scope today.

## Users

- Anonymous readers who just want to browse HN on a phone.
- Logged-in HN users who want to read and upvote from mobile.

## Feature List

### Pinned vs. Favorite vs. Done — three intents, three buckets

"Pin", "Favorite", and "Done" are deliberately separate so no single
action has to do double duty.

- **Pinned (📌)** is your **active reading list**. You pin from a story row
  (pin button, swipe-left, or long-press → Pin). Pins stay until you remove
  them — explicit in, explicit out. The verb pair "Pin / Unpin" makes the
  intent obvious in both directions, which "Star / Unstar" never quite did.
- **Favorite (heart)** is a **permanent keepsake**. You favorite from the
  **article comments view** (thread page), not from the row — a row-level
  heart would add a fourth tap target and undo the whole "fewer, larger tap
  zones" rule. Favorites never auto-expire and are not swept. The intent is
  "I loved this and want to remember it", not "I want to come back to this
  soon".
- **Done (check)** is your **completion log**. You mark done from the
  **article comments view** (thread page, action bar), not from the row.
  Tapping Done also unpins the story — Pin is the active queue, Done is
  where items go when they leave the queue, and a story can't be in both.
  Done stories are filtered out of every feed (same as Hidden, but
  permanent instead of the Hidden list's 7-day TTL). The intent is
  "I engaged with this thread and I'm finished with it", not "not
  interested" (that's Hide) and not "keepsake forever" (that's Favorite).
  Favorites are orthogonal — favoriting and marking done are independent.

The four lists live side by side in the drawer ("Favorites", "Pinned",
"Done", "Hidden") and each has its own localStorage key
(`newshacker:favoriteStoryIds`, `newshacker:pinnedStoryIds`,
`newshacker:doneStoryIds`, `newshacker:hiddenStoryIds`) so one is never
silently interpreted as another. The pinned-stories module performs a
one-shot rename of the legacy `newshacker:savedStoryIds` key so existing
readers don't lose their list. The hidden-stories module does the same
one-shot rename of the legacy `newshacker:dismissedStoryIds` key to
`newshacker:hiddenStoryIds`, which is the current key — the vocabulary
switched from "ignore/dismiss" to "hide" to match HN's own term.

**Retention today:** Favorite, Pinned, and Done entries (and their
tombstones) are all permanent; Hidden entries (and tombstones) expire
after 7 days. Only Favorite is clearly intended to be forever — see
`TODO.md § Retention policy` for a standing item to reconsider TTLs
for Pinned, Done, and tombstones once we have real usage data.

**Cross-device sync:** all four lists — Pinned, Favorite, Hidden, Done —
ride `/api/sync` (Upstash Redis, per-user, per-id last-write-wins,
fail-open) for signed-in users. Max 10k entries per list, enforced
server-side with most-recent-first eviction.

### MVP (read-only)

1. **Story feeds**
   - Default (and `/`) is the HN front page (Top).
   - Tabs / routes also available for: New, Best, Ask, Show, Jobs.
   - **Initial paint is exactly one page (30 stories), matching HN's own web front page.** Additional pages are revealed only when the reader taps the explicit **More** button at the end of the list — no infinite scroll, no auto-prefetch of the next page. Each page is 30 stories. The button disappears when the feed's id list has been exhausted. Hidden stories still count against the 30 (we slice the 30-id window before filtering), so a heavily hidden session can leave fewer than 30 rows on screen; the reader recovers by tapping More.
   - **Off-feed pinned stories pinned to the top.** When the reader has pinned a story that is no longer in the feed's id list (e.g. it dropped off HN's front page), that story is prepended to the top of the feed list in the same row layout — one unified list, pinned rows first, newest-pinned first, followed by the normal feed. No section header, no duplication: a pinned story that is still in the feed id list stays in place at its natural position. This keeps the reader's active reading list reachable from the home view without jumping to `/pinned`. Cost: one extra `/api/items` batch call per feed load when off-feed pins exist (almost always a single request — pins fit well under the 30-id chunk size). Rides the existing items proxy; no new infra. Degrades silently if the fetch fails — the main feed still renders.
   - Each list item shows: title, domain, points · age (display-only), and an "N comments" button.
   - See *Story row layout* for tap-target rules.
   - **Minimum-upvote visibility (`score > 1`).** Every feed filters out stories whose `score` is ≤ 1. HN submissions start at score 1 (the submitter's implicit self-upvote), so `> 1` means "at least one other person has upvoted this." The primary motivation is **signal-to-noise**: this is especially load-bearing for `/new`, which on raw HN is mostly instant self-submits and brand-new drops most readers don't care about — requiring one organic upvote before we surface a story turns `/new` into a meaningful "rising" feed instead of a firehose. On `/top`, `/best`, `/ask`, `/show`, `/jobs` the filter is effectively a no-op because HN's own ranking already pushes score-1 items out. The filter is live and per-render: a story excluded on one fetch is pulled back in automatically as soon as a later feed refresh shows its score has risen. There is no persistent "hidden by score" list. As a side benefit, this also closes the "submit-a-link-to-get-a-Gemini-summary" abuse path — the summary endpoints enforce the same `> 1` floor, and a story the feed never renders never triggers a warm.

2. **Thread view**
   - Story header (title, link, points, author, age, text if self-post).
   - **Article summary card** (AI, Gemini 2.5 Flash-Lite) above the action row, for stories with an external `url`. Auto-runs on load.
   - **Comment summary card** (AI, Gemini 2.5 Flash-Lite) between the meta line and the comment list, for any story with at least one top-level comment — including self-posts (Ask HN, Show HN). Renders 3–5 short insights. Auto-runs on load. Reuses the same card visual as the article summary.
   - Nested comments, each collapsed by default with a 3-line body preview. See *Comment row layout*.
   - Deep-linkable: `/item/:id`.

3. **User view (minimal)**
   - `/user/:id` shows karma, created date, about text. Submissions/comments lists are out of scope for MVP.

4. **Navigation & Chrome**
   - Sticky orange header with HN "Y" logo and current feed name.
   - Top nav tabs for feed switching, integrated into the header.
   - Back button on thread/user pages.

### Accounts (shipped)

5. **Login via HN**
   - Users sign in with their existing news.ycombinator.com username and
     password — we do **not** maintain our own identity system. Credentials
     are posted through our `/api/login` serverless function to
     `https://news.ycombinator.com/login` (form body `acct=<u>&pw=<p>&goto=news`).
     On success HN returns a `Set-Cookie: user=<username>&<hash>` header;
     we capture the value and re-set it on our own origin as an HTTP-only,
     Secure, SameSite=Lax cookie named `hn_session`. The browser cannot
     send cookies to news.ycombinator.com from our origin, so every future
     write (vote, etc.) goes through a serverless function that attaches
     the HN cookie server-side. The raw HN cookie value is **never**
     exposed to client JS.
   - The username is parsed from the HN cookie value (`username&hash`,
     ampersand-separated) and returned in the login response. `GET /api/me`
     returns `{ username }` when the session cookie is present, `401`
     otherwise — used on client boot to rehydrate auth state without a
     round trip to HN.
   - `POST /api/logout` clears the cookie. Since the HN cookie lives on
     news.ycombinator.com, logging out of newshacker does not log you out
     of HN itself (by design).
   - Credentials pass through our server in plaintext over TLS, as the
     only way HN accepts them. We do not log, store, or cache the password
     anywhere; only the resulting opaque HN cookie is persisted (as the
     `hn_session` cookie on the user's browser). The login page carries
     a short, honest disclosure to that effect.

6. **Account UI** (header chip, not drawer). The sticky orange header
   gains a single always-visible account control on the far right — one
   extra tap target, 48×48 hit area, on every page. Surfacing auth
   state in the header (rather than behind the drawer) means a first-time
   visitor can see "this app has a login" without exploring the menu.
   - **Logged out:** a text `Sign in` button that navigates to `/login`.
   - **Logged in:** a 32 px circular **initial avatar** — the user's
     first letter on a color-hashed disc (color deterministically
     derived from the username hash, chosen from a non-orange palette
     so it never clashes with the brand mark's orange `n`). Tapping
     opens a small popover with the username, karma (via the existing
     Firebase `getUser` path, cached through React Query), a link to
     `/user/:username`, and a `Log out` button. Closes on Escape,
     outside click, or after a menu selection.
   - **Profile picture on top of the initial.** The letter-on-color
     disc is the baseline (offline, zero requests, deterministic), but
     a real picture can be layered over it. By default the header
     avatar tries `https://github.com/<hnUsername>.png?size=64` —
     GitHub's public, unauthenticated, CDN-served avatar endpoint —
     assuming the HN username is also a GitHub username. If the
     request 404s (no such GitHub user) or otherwise fails, the
     `<img>` errors, is unmounted, and the letter underneath is
     already painted, so there's no visual fallback flicker.
     Users can override this via the header menu's **Edit avatar**
     item: they can enter a different GitHub username, switch to
     Gravatar (enter an email — hashed with SHA-256 in the browser
     before the request), or turn pictures off entirely. Preferences
     live in `newshacker:avatarPrefs` (shape
     `{ source: 'github' | 'gravatar' | 'none', githubUsername?, gravatarEmail?, gravatarHash?, at? }`,
     where `at` is the Date.now() of the last save, used for
     cross-device LWW). For signed-in users, the `source`,
     `githubUsername`, `gravatarHash`, and `at` travel over
     `/api/sync` alongside Pinned/Favorite/Hidden so a picture
     override set on one device propagates to every other device.
     The raw `gravatarEmail` is intentionally **never** sent — only
     the SHA-256 hash leaves the device, so Gravatar email doesn't
     land on our server. On a new device the edit form's email field
     will be empty (we can't un-hash); the user can retype it if they
     want it echoed back for display, but the picture itself already
     works from the synced hash.
     The picture is rendered **only on the header avatar** — not on
     commenters or story posters, because HN usernames ≠ GitHub
     usernames in the general case and showing a stranger's face on
     another commenter would be a confident misattribution.
   - **Cost/reliability (rule 11).** Zero new infra and no new
     server-side dependencies. One extra public GET per session from
     the user's browser to github.com (or gravatar.com), both
     free-tier-forever CDN endpoints at any plausible scale for this
     app. New failure modes: both endpoints can 404 or time out; both
     degrade cleanly to the existing letter circle via `<img onError>`.
     Minor privacy consideration: fetching the picture tells
     github.com / gravatar.com that a user visited newshacker and
     what their HN username is; this is acceptable because the user
     is the one whose avatar is being shown (no third-party
     commenter avatars, so no fan-out across an entire thread).
   - **Why not also in the drawer.** The drawer's `App` section
     already carries static entries (Help, About, Debug); the header
     chip is the single canonical auth surface and the drawer stays
     focused on navigation.

7. **Voting & unvoting stories (shipped).** Each HN story page carries a
   per-user, per-item `auth` token in its vote link
   (`vote?id=<id>&how=up&auth=<token>&goto=news`). To cast a vote we
   need the user's session cookie (already have, from Login) **and**
   the per-item `auth` token, scraped from the rendered HN HTML for
   that item. `/api/vote` does the scrape + forward; the client calls
   it optimistically — the **Upvote button on the thread page action
   bar** (see *Thread action bar*) flips to orange on tap, a
   localStorage-backed per-user set (`newshacker:votedStoryIds:<user>`)
   keeps the arrow orange across reloads, and a failure (401 session
   expired, 502 HN HTML changed or item locked) rolls the local state
   back and toasts. Unvote uses the same endpoint with `how=un`. HN
   does not expose "which items have I voted on" via the Firebase API,
   so the local set is best-effort — a vote cast on another device
   shows the arrow as un-voted here; tapping it then 502s (HN's item
   page won't render a `how=up` link for an already-voted item) and we
   toast the failure. Acceptable for the MVP.
   - **Why on the thread page, not the row.** The story row is a
     focused browsing surface with exactly two tap zones (row body,
     pin). Adding a third target there — tiny by necessity, on the
     left of a scrolling list — would both mis-tap frequently and
     encourage hit-and-run voting without reading. The thread page
     already carries the reader's full context (title, domain, AI
     article summary, AI comment summary, the comments themselves),
     so an intentional tap on an action-bar button there is both
     easier to hit and a more deliberate act.
   - **Not yet shipped (follow-ups):** voting on individual comments
     (same mechanism, different tap target — see *Comment row layout*
     for the reserved slot), downvoting comments (only available to
     accounts with enough karma on HN, so the client needs to decide
     when to render the second arrow), and a pending/animation state
     during the in-flight POST (see `TODO.md` §
     *Optimistic-action feedback*).
   - **Cost/reliability (rule 11):** no new infra; two HN fetches per
     vote (item-page scrape + vote replay). Free on Vercel Hobby.
     Fragile point: HN HTML markup — the anchor scraper breaks if HN
     restructures vote links. Blast radius is small (the vote toast
     errors out; the read path is untouched). Per SPEC Non-Goals,
     there is no offline queue for votes — a vote attempted while
     offline toasts immediately and does not retry on reconnect.

### Planned / not yet implemented

8. **Cross-device sync of Pinned / Favorite / Hidden / Avatar prefs
   (shipped).** Each of the three lists plus the avatar-prefs record
   mirrors to a `/api/sync` serverless endpoint backed by the
   existing Upstash Redis (the same store powering the AI summary
   cache). Identity is the HN username from the `hn_session` cookie
   — no separate signup. Lists are `{ id, at, deleted? }` tuples;
   "deleted" is a tombstone so an unpin on device A cannot be
   resurrected by device B's stale local pin. Merge is last-write-
   wins per id, with the latest `at` winning. Avatar is a single
   record `{ source, githubUsername?, gravatarHash?, at }` with LWW
   on the single `at`; the raw `gravatarEmail` is **deliberately
   never sent**, so a user's email doesn't end up on our server and
   the switch-device flow shows the hashed picture but an empty
   email field in the edit form. Device-local defaults have no `at`
   (treated as 0 for LWW), so the server's record always wins on
   first login from a new device — solving "I set my override on
   my laptop but my phone still shows the default GitHub handle."
   The client pulls on sign-in and on reconnect, and debounces local
   changes (~2 s) into a single POST for whatever changed since the
   last successful push. Fails open: if the sync endpoint is down,
   `localStorage` keeps working exactly as today — sync is purely
   additive.
   - **Opened/read history is out of scope for v1, and may stay that
     way.** The `newshacker:openedStoryIds` store grows fast (one
     entry per story tapped, unbounded in principle) and its
     semantics are "noisy recent activity" rather than "curated
     intent", so the utility of syncing it is unclear — it's not a
     committed follow-up, just an open decision. `TODO.md` keeps
     notes for a future self in case we ever do decide to tackle it
     (cap ~5 k ids per user, probably whole-blob LWW per device
     rather than per-id tombstones, since losing a read mark in a
     conflict is cheap).
   - **Cost/reliability (rule 11):** reuses existing Upstash Redis; at
     ~1 KB × 3 lists + a <200-byte avatar record per user, thousands
     of users still fit the free tier. New failure mode: sync
     endpoint down — localStorage still works, no user-visible
     breakage. No additional external API calls and no new failure
     modes introduced by the avatar extension (same endpoint, same
     store, same fail-open behavior).

9. **Favorites round-trip with Hacker News (shipped).** For
   logged-in users, the newshacker favorite heart is mirrored to HN
   best-effort in both directions.
   - **Bootstrap pull.** On sign-in and app start, the client calls
     `/api/hn-favorites-list`, which scrapes
     `news.ycombinator.com/favorites?id=<user>` with the HN session
     cookie and returns the deduplicated story IDs. The client merges
     those IDs into the local `favoriteStoryIds` store with `at: 0`,
     so any subsequent local action wins the last-write-wins race.
     Local tombstones are preserved — an unfavorite recorded locally
     isn't resurrected by an HN entry the user hasn't yet had a
     chance to push.
   - **Write queue.** Each user-originated favorite/unfavorite is
     enqueued into a per-user `newshacker:hnFavoriteQueue:<user>`
     localStorage queue (coalesced — a favorite+unfavorite pair for
     the same id cancels before it ever reaches HN). A client-side
     worker drains the queue through `POST /api/hn-favorite`, which
     scrapes the per-item auth token off the item page and forwards
     the fave action to HN. On transient failures the entry backs off
     (2 s → 5 min capped) and retries; after 10 attempts it's
     dropped with `lastError` recorded. A 401 from HN stalls the
     worker until the next sign-in.
   - **Local wins.** Local favorites state remains authoritative for
     the UI. A queued write that eventually gets dropped doesn't roll
     local state back — the only observable effect is that HN's
     favorites page stays out of sync until the user retaps. This is
     the deliberate counterpart of the optimistic tap.
   - **Logged-out users** are unaffected: the queue is never
     consulted, the bootstrap pull never runs, favorites stay
     local-only exactly as before.
   - **Cost/reliability (rule 11):** 2 HN fetches per enqueued action
     (scrape + fave) + 1 Vercel invocation. Bootstrap is bounded at
     20 HN pages (600 favorites) per sign-in. No new infra — reuses
     the existing `hn_session` cookie. Fragile point: HN HTML shape
     changing; blast radius = HN round-trip stops and local state
     keeps working.

10. **Submitting comments and replies** is out of scope today (see
    *Non-Goals* below) but is a candidate for a future phase once voting
    is stable. Writing comments uses the same HN cookie + per-item `auth`
    token pattern as voting.

## Data Sources

### Read API — Firebase

Base: `https://hacker-news.firebaseio.com/v0`

| Endpoint | Purpose |
|---|---|
| `/topstories.json` | Top 500 story IDs |
| `/newstories.json` | New stories |
| `/beststories.json` | Best stories |
| `/askstories.json` | Ask HN |
| `/showstories.json` | Show HN |
| `/jobstories.json` | Jobs |
| `/item/<id>.json` | Story, comment, poll, or job |
| `/user/<id>.json` | User profile |

Story/comment shape (fields we care about): `id`, `by`, `time`, `title`, `url`, `text`, `score`, `descendants`, `kids`, `type`, `dead`, `deleted`.

### Write "API" — scraping HN HTML

HN does not expose a write API. Login and voting are done by driving the normal web forms:

- **Login**: `POST https://news.ycombinator.com/login` with `acct`, `pw`, `goto=news` → sets a `user` cookie.
- **Vote**: `GET https://news.ycombinator.com/vote?id=<id>&how=up&auth=<token>&goto=news` with the `user` cookie.
- **Auth token**: scraped from the rendered HTML of a story listing or item page. We'll parse with a light HTML parser (e.g. `node-html-parser`) on the server.

## Architecture

```
+-----------------+       +----------------------+       +-----------------------+
|  React SPA      | <---> |  Vercel Serverless   | <---> |  news.ycombinator.com |
|  (Vite)         |       |  Functions (/api/*)  |       |  + Firebase HN API    |
+-----------------+       +----------------------+       +-----------------------+
```

- **Client**: React + TypeScript, Vite, React Router, TanStack Query for data fetching/caching.
- **Read path**: client calls Firebase HN API directly (CORS-enabled, cacheable).
- **Write path** (login/vote): client calls our own `/api/login`, `/api/vote`, `/api/me`. Serverless function sets an **HTTP-only** cookie on our own origin that contains the HN `user` cookie value. On subsequent writes the function reads our cookie, attaches it as `Cookie: user=...` to the HN request.
- **No DB** — state lives in HN's cookie + client query cache.

## Story row layout

This is the single most important UI decision in the app, so it is specified in full.

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│   Story title goes here, wrapping to two lines           │
│   if needed.                                             │   ☆
│   example.com · 3h · 412 points · 128 comments · 5 new   │
│                                                          │
└──────────────────────────────────────────────────────────┘
   ^                                                          ^
   |                                                          |
  Row tap → thread (/item/:id)                               Pin toggle:
  (title + meta share one stretched link)                   pin / unpin
```

Tap zones — there are never more than three, and the shipped UI uses two:

- **Row body** — the title and meta line share a single stretched `<Link to="/item/:id">`, so a tap anywhere on the row opens the thread. The article itself is opened from a prominent "Read article" button on the thread page. Self-posts behave the same way (they've never had an external article to begin with).
- **Pin button** — a real icon button on the right, not an inline text link. Tapping toggles pinned state. Has its own 48×48px hit area and ≥8px horizontal gap from the row body.

A third slot is reserved between the row body and the pin button for at most one additional per-row action. It's currently unused — voting took the slot in an earlier design and has since been moved to the thread page action bar (see below). Any future use of the slot has to clear a high bar: the action has to be something the reader actually wants to do from a scrolling feed without opening the story, not merely something we're capable of adding.

**Voting deliberately lives on the thread page, not the row.** An earlier draft reserved a third tap zone on the left for the vote arrow (visible only when logged in). We dropped it: the row stays a pure browsing surface, and upvoting becomes an intentional act on the page where the reader has context — title, domain, points, article summary, comment summary, comments themselves. See *Thread action bar* below.

Everything else is display-only:

- Points, age, comment count — plain text inline in the metadata row inside the row link.
- **"N new" comment badge.** When the reader has previously opened the thread, the row's meta line gains a trailing ` · N new` segment equal to `max(0, current descendants − descendants at last open)`. The snapshot is taken when the row is tapped (and refreshed every time the thread page loads or refetches), so revisiting the thread clears the badge naturally. Storage rides on the existing `newshacker:openedStoryIds` entry as a new `seenCommentCount` field; no new localStorage key, no network call, inherits the same 7-day TTL as the rest of the opened-story state. Zero cost / reliability impact.
- Domain — plain text in the metadata row, not a link. (We intentionally do not let users tap a domain to filter by site; that's a power-user feature incompatible with the "few targets" goal.) **The display domain is always trimmed to the registrable domain** (`fingfx.thomsonreuters.com` → `thomsonreuters.com`, `sport.bbc.co.uk` → `bbc.co.uk`, `old.reddit.com` → `reddit.com`) — subdomains rarely carry reader-facing identity on a small row, and the thread page still shows the full hostname for anyone who wants the detail. The trim is ccTLD-aware (`9news.com.au` stays `9news.com.au`, never `9news`) and preserves owner-identifying subdomains on a hand-curated list of compound effective TLDs (`jasoneckert.github.io` stays intact). If the registrable domain itself exceeds 22 characters we fall back to a trailing-ellipsis truncation. The compound-eTLD list is a pragmatic subset of the Public Suffix List — a future change may swap it for the full PSL; the length cap is the backstop either way.

What is deliberately **not** rendered:

- Rank numbers (visual noise; never tapped).
- "hide", "flag", "past", "web", "via" links.
- Inline author link. The author appears on the thread page, where there's room for it as a distinct tap zone.

Spacing / sizing:

- Row vertical padding: 16px top and bottom. Min row height: 72px.
- Min hit area per tap zone: 48×48px.
- Min dead space between adjacent tap zones: 8px.
- Pressed state (subtle background darkening) on every tap zone so the user sees which region received their tap.

Thread page mirrors the same discipline: a single primary "Read article" button at the top of a story view (hidden for self-posts), with Upvote (logged-in only), Pin/Unpin, Done, and a vertical-ellipsis (⋮) **More actions** button laid out beside it on the icon row, and a single primary tap target per comment row. See *Comment row layout* below.

### Thread action bar

Row order, left-to-right: **Read article** (hidden on self-posts) → **Upvote** (hidden when logged out) → **Pin/Unpin** → **Done** → **More actions ⋮**. Each icon button is 48×48px with ≥8px spacing. The Upvote button uses HN's triangle shape (solid `▲`), colored `--hn-meta` by default and `--hn-orange` when voted; tapping flips local state optimistically and POSTs `/api/vote` in the background, rolling back and toasting on failure. See item 7 under *Features* for the full round-trip.

The **Pin/Unpin** button (Material Symbols `push_pin`, outline → filled on toggle) is the same pinned state as the row-level pin on feeds; label and tooltip flip between "Pin" and "Unpin" based on current state. Reachable from the thread page so stories opened directly from a share link (where there's no feed row to tap) can be pinned and unpinned in the same place. The **Done** button (Material Symbols `done`, outline → filled on toggle) sits immediately right of Pin/Unpin and marks the thread complete: the story is filtered out of every feed (see *Pinned vs. Favorite vs. Done* above) and added to the synced Done list. Tapping Done on a pinned story also unpins it; Done and Pin are mutually exclusive. Tapping **Mark done** also closes the thread — it pops back to the previous entry (usually the feed) via `navigate(-1)`, or lands on the home feed if there's no in-app history (deep link, refresh, shared URL). This mirrors the "mark read" gesture on Apollo-style Reddit clients: the Done tap is "I'm finished, move on". **Unmark done** does *not* navigate — the user is usually on the thread deliberately to revisit a completed item, so yanking them away would be hostile. Browser back is the recovery path for an accidental mark-done; there is no Done toast — the button state (and the story's disappearance from feeds) is the single source of truth, matching Pin.

The action bar also appears at the **bottom** of the thread, after the comments list. Same layout and handlers for Vote/Pin/Done/⋮ — reaching Pin/Done at the end of a long discussion shouldn't require scrolling all the way back to the top. The primary-slot button differs: the top bar shows **Read article** (when the story has a url), the bottom bar shows **Back to top** (always, including on self-posts). At the end of a long thread the reader has almost always already opened the article — what they need is a fast jump up, not another link to the article they're leaving. "Back to top" uses Material Symbols `vertical_align_top` and calls `window.scrollTo({ top: 0, behavior: 'smooth' })`, which major browsers short-circuit to an instant scroll when `prefers-reduced-motion: reduce`. The overflow menu is shared (one `StoryRowMenu`) so either ⋮ button opens the same sheet. Test ids on the bottom bar carry a `-bottom` suffix (e.g. `thread-done-bottom`, `thread-back-to-top-bottom`); the top bar keeps the original unsuffixed ids.

On narrow phones (≤480px viewport) the primary "Read article" button wraps to its own row above the icon buttons so all targets stay at the 48×48px minimum; wider viewports keep the whole bar on one row.

Tapping ⋮ opens a bottom-sheet menu (the same `StoryRowMenu` component used for long-press on a list row) with secondary actions for the story:

- **Favorite / Unfavorite** — the keepsake toggle (heart). Lives in the overflow because it's less frequent on the comments view than the queue/exit pair on the bar; see *Pinned vs. Favorite vs. Done* above for the distinction between queue (Pin), keepsake (Favorite), and completion (Done).
- **Open on Hacker News** — opens `https://news.ycombinator.com/item?id=:id` in a new tab. Lets users jump to the canonical HN page (e.g. to upvote/comment from their HN account, while we don't yet support write actions).
- **Share article** — invokes the Web Share API (or copies the link to the clipboard as a fallback) on the source URL, via the `useShareStory` hook. Hidden on self-posts (Ask HN, Show HN, etc.) since there's no off-site article to share.

Naming convention for share entries: a noun ("Share **article**") names *what* is being shared; the `on <platform>` suffix names *where* the recipient lands. This keeps the Share entries aligned with **Open on Hacker News** above and leaves room for a planned **Share on newshacker** entry that shares the discussion view on our origin.

## Comment row layout

Comments match the "fewer tap targets" rule: the whole row is one tap zone that toggles expand/collapse. Interactive children (the author link, the **Reply on HN** link on expanded comments, and any future upvote/downvote buttons) keep their own tap behavior via a `closest('a, button')` bail-out in the row's click handler; the row handler also stops propagation so tapping a nested reply only expands that reply, not its ancestors.

```
┌──────────────────────────────────────────────────────────┐
│ First three lines of the comment body are shown here     │
│ as a preview, clipped with an ellipsis if longer than    │
│ three lines…                                             │
│ alice · 4m · 12 replies                                  │
└──────────────────────────────────────────────────────────┘
```

Collapsed state (default):

- Body clamped to 3 lines (CSS `-webkit-line-clamp: 3`), 15px to match the AI summary card.
- Meta row sits directly **below** the body: author link, then plain text " · age · N replies" (reply count omitted when there are none), all on one baseline at 13px. The meta row hugs the body above it (no `margin-top`; the toggle button's own 4px top padding is the only gap) so it reads as belonging to the comment it follows, not the one below. The comment's 10px bottom padding sits between the meta and the next comment's top border. When the comment is expanded, the children list adds a matching 10px `margin-top` so the gap before the first nested reply's border matches the gap between sibling comments (the parent's own `padding-bottom` only takes effect after all children).
- No action row, no children.
- Cursor is `pointer`.

Expanded state:

- Background tints to `--hn-pressed` so the active node stands out in a long thread.
- Body shows in full.
- The meta row gains a muted `Reply on HN ↗` link (`news.ycombinator.com/reply?id=:id`, opens in a new tab) inline at its right-hand end, so the meta row doubles as the action row. The row is laid out as a flex row so upvote/downvote buttons can slot in alongside later.
- Immediate children render below as their own collapsed `<Comment>` nodes — i.e. each child is itself a 3-line preview until tapped.
- Cursor reverts to `default` (reading state).

A real `<button>` inside the meta row carries `aria-expanded` and the keyboard-accessible `Expand comment` / `Collapse comment` label, even though on-screen it just reads as the plain meta text.

Deleted, dead, and empty comments are not rendered at all — including their subtrees — so a thread never shows "[deleted]" placeholder rows.

Leading quote paragraphs (lines a commenter prefixes with `> ` to re-quote their parent) are stripped from the rendered body. The parent comment is already visible directly above, so the first line of the preview shouldn't be a duplicate of it — the reply's own content shows first instead. Stripping stops at the first non-quote paragraph, and a comment that is nothing but quotes is left alone rather than rendered empty.

## Top bar controls

On feed pages the sticky orange header carries two feed-scoped action icons on the right. Both icons stay in place (never shift) so the layout doesn't jump; each is disabled when the action is unavailable rather than being hidden.

- **Undo** (Material Symbols `undo`) — restores the most recent hide action: either the last swipe-to-hide, the last menu "Hide", or the last sweep (the whole batch at once). One level of undo only; recording a new hide replaces the stored batch. Disabled when there is nothing to undo. Not persisted across reloads.
- **Sweep unpinned** (Material Symbols `sweep`) — hides every visible unpinned story in one shot. Disabled when there are no unpinned stories to hide.

Icons are inlined monochrome SVG (Apache 2.0, Google Material Symbols, outlined weight, viewBox `0 -960 960 960`, drawn with `fill="currentColor"`). No icon font, CSS, or web request is used to load them at runtime.

On non-feed pages (thread, `/pinned`, `/done`, `/hidden`, etc.) these icons do not render at all.

No hide/sweep toast: the Undo button is the recovery path. Hiding is always deliberate (swipe right, broom, or menu Hide) — scroll-past does not auto-hide. Pin/unpin don't toast either; the pin button's pressed state is the single source of truth for pinned state.

## Back to top

Every scrolling list view — feed pages (`/top`, `/new`, `/best`, etc.), library pages (`/pinned`, `/favorites`, `/done`, `/hidden`, `/opened`), and the bottom of the thread page — offers a **Back to top** button at the very bottom. On lists it sits below the "More" (load-more) button when one is present; on threads it's the primary slot of the bottom action bar. Reaching the end of any long scroll shouldn't require a manual fling to get back up top. The button (Material Symbols `vertical_align_top`) calls `window.scrollTo({ top: 0, behavior: 'smooth' })`, which major browsers short-circuit to an instant scroll when the user has `prefers-reduced-motion: reduce` set. Same component (`<BackToTopButton>`) is used on feeds and library pages; the thread bottom bar has its own primary-styled variant for consistency with the Read-article button it replaces.

## Visual Design

- Primary color: `#ff6600` (HN orange) for the header and accents.
- Background: `#f6f6ef` (HN cream) for the page, white for cards/rows.
- Text: `#000` primary, `#828282` metadata.
- Font stack: system UI (`-apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif`). HN's Verdana looks dated on mobile; we use system.
- **Tap targets: ≥48×48px, ≥8px spacing between any two distinct targets.**
- **At most 3 tappable zones per story row**, 2 in the shipped UI (row body + pin). Anything else is display-only. Upvoting is not on the row today; it lives on the thread page (see *Thread action bar*).
- Layout: single column, max-width ~720px, centered on desktop.
- Active/pressed state on every tappable zone (subtle background darkening) so the user sees which region received their tap.
- **Long-press tooltip on every button.** Every interactive `<button>` in the app (icon-only and text alike) routes through the shared `<TooltipButton tooltip="…">` component. On a touch or pen pointer, a 500 ms hold shows a small floating tooltip with the button's label for ~1.2 s, then swallows the follow-up click so the user can inspect a control without firing it. On a mouse pointer the tooltip is suppressed — desktop users get the same copy through the native `title` attribute on hover. The tooltip is portaled into `document.body`, position-flipped when there isn't room above, and `position: fixed` with px offsets (no `vh`) so the mobile address bar collapsing doesn't misalign it. iOS Safari doesn't fire `contextmenu` on long-press, so the native callout / selection magnifier is suppressed via CSS instead (`touch-action: manipulation; -webkit-touch-callout: none; user-select: none; -webkit-tap-highlight-color: transparent`). Android Chrome's `contextmenu` (which does fire) is `preventDefault`-ed while the long-press is pending. No haptic feedback — the visual tooltip is the whole affordance, and `navigator.vibrate` behavior is inconsistent across iOS (unsupported) and Android (user-gesture timing rules, site-level opt-outs), so we avoid the platform split entirely. Icon-only buttons also carry an `aria-label` (or a `visually-hidden` caption) so the tooltip copy is only a *visual* augmentation, not an accessibility dependency — VoiceOver and TalkBack read the real label.

## Routes

| Path | View |
|---|---|
| `/` | redirects to `/top` |
| `/:feed` | story list (`feed` ∈ top, new, best, ask, show, jobs) |
| `/item/:id` | story + comments |
| `/user/:id` | user profile |
| `/favorites` | favorite stories (permanent) |
| `/pinned` | pinned stories (active reading list) |
| `/opened` | recently opened stories (7-day history) |
| `/hidden` | recently hidden stories (7-day history) |
| `/login` | HN login form |

## Accessibility

- Semantic HTML (`<main>`, `<nav>`, `<article>`).
- Visible focus styles.
- `prefers-reduced-motion` respected for the collapse animation and the tooltip fade-in.
- Color contrast ≥ 4.5:1 for body text (HN orange on white fails for small text — only used on large headers / buttons).
- Every icon-only `<button>` has an accessible name — either via `aria-label` or a `visually-hidden` caption inside the button. The long-press tooltip (see *Visual Design*) is visual-only; screen readers rely on the accessible name, not the transient tooltip DOM.

## Performance Targets

- First Contentful Paint < 1.5s on a 4G mobile profile.
- JS bundle (initial) < 150KB gzipped.
- Story list render < 100ms after data arrives.

## Error Handling

- Network/Firebase errors: inline retry button.
- Missing/dead/deleted stories: show `[deleted]` / `[dead]` placeholder, don't 500. Deleted, dead, and empty *comments* are filtered out of the thread entirely.
- Vote/login failures (stretch): toast with HN's returned message when possible.

## Testing

- Unit: Vitest + React Testing Library for components, pure functions (time formatting, auth-token scraper, URL domain extractor).
- Integration: MSW to mock Firebase responses; test the story list and thread view end-to-end.
- Serverless: Vitest with `supertest`-style calls against the handler functions; mock `fetch` for HN.
- Smoke: one Playwright test that loads the homepage against a preview deploy (stretch).

## PWA & Offline

newshacker is installable as a Progressive Web App on desktop and mobile, and supports offline reading of previously-seen content.

### Install identity
- Web app manifest (via `vite-plugin-pwa`): name "newshacker", theme `#ff6600`, background `#f6f6ef`, `display: standalone`, `start_url: /top`.
- Icons (generated once by `scripts/generate-icons.mjs`, checked into `public/`): `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `apple-touch-icon.png` (180), `favicon.svg`, `favicon-32.png`. The mark is an orange disc with a white ring and a white "n" centered inside, on a transparent background so the icon reads as circular — never the HN `Y` logo. The maskable variant fills its frame with orange and pulls the ring + glyph into an 80% safe zone so Android adaptive masks don't clip it.
- `index.html` declares the manifest, apple-touch-icon, and `apple-mobile-web-app-*` meta tags so iOS home-screen installs get a native-feeling shell.

### Service worker
- Registered with `registerType: 'prompt'`: a new build downloads in the background, then we surface a non-blocking "New version available — Reload" toast (via the existing `ToastProvider`). The user picks when to reload; no forced reloads.
- Disabled in `npm run dev` (devOptions.enabled: false) so iteration is unaffected. Active in `npm run build && npm run preview` and in production.

### Caching strategy
- **App shell**: precached at build time so the app boots offline. Navigation falls back to precached `index.html`; React Router takes over client-side.
- **HN items** (`/item/:id.json`): StaleWhileRevalidate, 7-day TTL, 500 entries.
- **Feed lists** (`topstories`, `newstories`, etc.): NetworkFirst with 10s timeout, 1-day TTL, 10 entries. The longer timeout stops ordinary mobile-data latency from flipping the strategy to "serve last-known list" on reload.
- **AI summary** (`/api/summary`): StaleWhileRevalidate, 7-day TTL, 200 entries.
- **AI comment summary** (`/api/comments-summary`): StaleWhileRevalidate, 7-day TTL, 200 entries. Server-side TTL is freshness-aware — 30 min for stories < 2 h old, 1 h otherwise — so hot front-page threads keep pace with the comment rush. React Query TTL on the client is 1 h.
- **Items batch proxy** (`/api/items`): NetworkFirst with 10s timeout, 1-day TTL, 50 entries. The batch URL keys on the exact id set, which means a refresh of the same feed page hits the same cache entry — SWR here would silently repaint yesterday's score/comment counts. NetworkFirst still falls back to the cache when the user is genuinely offline, so `/pinned` and friends keep working.

**Shared server-side cache (Redis via Vercel Storage Marketplace).**
`/api/summary` and `/api/comments-summary` use a **shared Redis store**
(provisioned through Vercel's Storage Marketplace, which auto-injects
`KV_REST_API_URL` / `KV_REST_API_TOKEN` into every deployment) as the
cross-instance cache. The handler reads the key on entry and returns
immediately on hit; on miss it generates via Gemini and writes the
result with the same TTL as before — article summary 1 h, comments
summary 30 min for stories <2 h old, 1 h otherwise. Reads from a
function in the same AWS region as the Redis primary are single-digit
ms — fast enough that the per-instance in-memory `Map` we used to keep
alongside the previous edge-CDN layer was removed (it just created
incoherent state across instances without a meaningful latency win at
~5 ms Redis reads).

**Current topology: single primary, no replicas.** Both the Vercel
functions and the Redis primary live in AWS `us-east-1` (Virginia), so
cross-component latency is dominated by the function cold-start, not
the Redis hop. Readers in other regions still end up running the
function in `iad1` (Vercel's default) and paying one cross-region hop
for the response itself — that's a Vercel concern, not a Redis one.
Because there are no replicas yet, the practical benefit over the
previous edge CDN at single-region, single-digit daily traffic is
modest: we save a few Gemini calls on the rare cross-region-new-reader
case, we gain a foundation for the follow-up work listed below, and
we lose the CDN's zero-function-invocation fast path. Accepted trade;
see IMPLEMENTATION_PLAN.md § Phase 6 for the follow-ups this unlocks.

**Eventual topology (when justified by traffic).** Redis Cloud and
Upstash both support read replicas in additional regions. Adding a
replica in e.g. `eu-west-1` or `ap-southeast-2` would let Vercel
functions in those regions read from a nearby replica (~5 ms instead
of ~100–200 ms cross-Atlantic). Today, with traffic almost entirely
on `us-east-1`, an extra replica is pure cost; if `summary_layout` or
a future server-side latency metric shows a material share of reads
from far regions, revisit. Writes always go to the primary; the cache
is eventually consistent across replicas (sub-second), which is fine
for a TTL'd summary — a replica briefly serving the previous value
after a new write is indistinguishable from a slightly-earlier cache
hit.

Both summary endpoints set `Cache-Control: private, no-store` on every
response so neither the edge CDN nor the browser HTTP cache pins
results — the function must always run so Redis is the freshness
boundary. The service worker caches `/api/summary` and
`/api/comments-summary` independently per its own Workbox runtime
rules (status-based, not header-based), so offline reads still work
as documented above.

`/api/items` is unchanged — it still uses the edge CDN (`s-maxage=60`)
because its short TTL and per-batch URL keying make CDN absorption the
right tool there.

The handler is **fail-open**: if Redis is unreachable, the request
falls through to live Gemini generation rather than erroring. The
cache is a latency optimisation, not a correctness boundary.

Cost and reliability (rule 11): current setup is the free tier
(~30 MB storage, no HA) — ample for the ~1 KB per key, ~50 key working
set we'll see at this traffic. Free tier is single-instance, so a
provider outage takes the cache offline until it recovers; the
fail-open path keeps the feature working (at cold-Gemini latency)
during that window, so no user-visible breakage, just slower
summaries. Paid tiers with HA / replicas are a few dollars per month
and a straight upgrade when the traffic or feature set justifies it
(e.g. if the follow-up items below start writing session or
rate-limit state to the same store, where fail-open is less
acceptable). New failure modes added by this change: one — Redis
provider unreachable. No new request paths to monitor beyond the
already-present Gemini and Jina dependencies.
- **HN write endpoints** (`news.ycombinator.com`): never cached — votes and login must never reuse a stale response.

The SW runtime cache is **additive** to the existing React Query persister (7-day localStorage). RQ hydrates the UI on cold boot; the SW covers fetches RQ decides to make.

**Feed freshness override.** The app-wide React Query defaults (`staleTime: 5 min`, `refetchOnWindowFocus: false`) are tuned for comment threads and AI summaries — once those land, users don't expect them to re-fetch on every tab switch. The feed queries (`['storyIds', feed]` and `['feedItems', feed]`) opt into `refetchOnMount: 'always'` and `refetchOnWindowFocus: true`, so a browser reload or a tab refocus always re-checks the network. Without this, the persisted cache would hydrate the UI with a hours-old list that the 5-minute staleTime still considers fresh.

### Comment batching
Comments use `src/lib/commentPrefetch.ts`'s `prefetchCommentBatch` helper everywhere we know a set of ids we're about to need. One helper, three callers:

- **Thread load** (`useItemTree`): when the root item resolves, warm the first 30 top-level kids via one `/api/items?fields=full` call. A 20-comment thread drops from 21 requests (1 root + 20 items) to 2 (1 root + 1 batch).
- **Infinite scroll** (`Thread.tsx` `onLoadMore`): each new page of 20 top-level comments fires another batch for the ids that aren't already cached. Mega-threads stay fast all the way down.
- **Comment expand** (`Comment.tsx` toggle): clicking a collapsed comment first batches its children, then flips `isExpanded`. Recursively-rendered `<Comment>` observers hydrate from cache instead of each firing a Firebase fetch. Re-expanding is free (cached ids are filtered out before the batch runs).

The helper is best-effort — on failure (`/api/items` 5xx, offline at pin time) the per-comment `useCommentItem` falls back to individual Firebase fetches, so nothing breaks visibly.

### Trending-score drive-by warm
- As the feed renders, `StoryList` calls `prefetchFeedStory` (in `src/lib/feedStoryPrefetch.ts`) for every row with `score > 100`. It delegates to the same `prefetchPinnedStory` used at pin-time, so the warm shape is identical: `['itemRoot', id]`, the first 30 top-level comments (one shared `/api/items?fields=full` batch), the article AI summary, and the comments AI summary. Tapping a popular headline renders the thread, summaries, and early comments without a round-trip.
- Tracked per-session via a `Set` in `StoryList` so re-renders don't re-fetch, and `prefetchFeedStory` short-circuits outright if `['itemRoot', id]` is already cached.
- Summary endpoints are shared-cached in KV (see *Shared server-side cache* below), so a trending story typically costs one Gemini call per hour globally even if thousands of clients warm it.

### Warm-on-view server summary cache
- When a story row scrolls fully into the viewport, `StoryList` fires fire-and-forget requests to `/api/summary?id=…` and `/api/comments-summary?id=…` via `warmFeedSummaries` (`src/lib/feedSummaryWarm.ts`). Both endpoints short-circuit on a KV hit without touching Gemini, so the steady-state cost is one Redis read per view; only the first viewer of a not-yet-cached story pays a Gemini generation, and every subsequent viewer (and every subsequent page load) is served from KV.
- Replaces the scheduled "summarize every front-page story every 30 minutes" cron we almost built. Impressions are the pacing signal, so we only pay for summaries people actually looked at.
- Session-scoped dedup via a `Set` in `StoryList` prevents the same row firing twice as it scrolls back into view. Ask-HN / Show-HN / job posts (no `url`) skip `/api/summary` but still warm `/api/comments-summary`.
- Score-gated to `> 1` on the client (cheap short-circuit) and on the server (authoritative). Combined with the feed-level `score > 1` visibility rule, a score-1 row never renders and therefore never triggers a warm.

### Pin/Favorite offline prefetch
- Pinning a story calls `prefetchPinnedStory` — stores the item root, the article AI summary, the AI comment summary (when the story has kids), **and the first 30 top-level comments** (via the shared `prefetchCommentBatch`) in the persisted cache at pin time.
- Favoriting a story calls `prefetchFavoriteStory` — same shape, so `/favorites` works offline with real discussion and both summaries.
- Top-level comments are fetched in a single `/api/items?ids=…&fields=full` batch (our edge-cached proxy), not per-comment against Firebase. This means one extra HTTP request per pin, ~30-60 KB typical. HN ranks `kids` roughly best-first, so slicing to 30 is a "top voted by HN's ranking" proxy for mega-threads.
- Nested replies are pre-fetched opportunistically on expand (see *Comment batching* above), not at pin/favorite time. Pinned-and-never-opened threads still have all their top-level comments offline; nested subthreads become available as the user has expanded them online at least once.
- When new comments arrive upstream after the pin, old cached comments are **not** invalidated — each comment lives under its own cache key. SWR surfaces the cached copy offline; next online visit refreshes silently.

### Offline UX
- `useOnlineStatus` hook drives:
  - A small "Offline" pill in the header.
  - An offline-specific message on the thread page when the item isn't in cache: "This story is not available offline. Pin it while online to keep a copy." No retry button while offline.
  - An offline-specific message in the AI summary card when no cached summary exists. The same message pattern applies to the AI comment summary card.
- Write actions (vote, login — once implemented) check `navigator.onLine` and show a toast instead of issuing a request that's guaranteed to fail.
- **React Query `networkMode: 'offlineFirst'`** (set globally in `main.tsx`). The default 'online' mode pauses queries whenever React Query's `onlineManager` reports offline, which leaves uncached thread/summary reads on a never-resolving loading skeleton. `'offlineFirst'` lets the queryFn run regardless, so the Workbox SW cache can answer from Cache API when it has an entry, and a true miss rejects fast enough for the offline error UI above to render.
- **Combined fetch-failure + browser-event detection** (`src/lib/networkStatus.ts`). `navigator.onLine` on mobile lags badly behind reality — walking into a tunnel can leave it stuck at `true` for tens of seconds, so the header pill would appear long after Brave's own offline banner. We keep two independent signals and AND them: `online = browserOnline && fetchOnline`. Either one flipping to false flips the pill immediately; both have to agree online before the pill hides again.
  - `fetchOnline`: every app fetch goes through `trackedFetch`, which flips `fetchOnline` to false the instant a request throws a `TypeError` (fetch's network-layer failure signal) and back to true the instant any response comes back (even a 500 proves we reached a server). `AbortError` is ignored so a superseded query doesn't masquerade as a connectivity drop.
  - `browserOnline`: `navigator.onLine` plus `online`/`offline` window events.
  - AND-ing protects both directions: a SW-served cache hit while genuinely offline won't falsely flip us online (browser still says offline), and a stuck `navigator.onLine=true` in a tunnel won't hide the pill while real fetches keep failing (`fetchOnline` is false).
  - The tracker keeps React Query's `onlineManager` in sync with the combined value so refetch-on-reconnect still fires. Zero new requests — we only instrument ones the app was already making.

### Pull-to-refresh
- **Feed pages** (`/top`, `/new`, `/best`, `/ask`, `/show`, `/jobs`) and
  the **library pages** (`/pinned`, `/favorites`, `/opened`, `/hidden`)
  support a pull-to-refresh gesture that re-runs the list's underlying
  React Query fetches. Feed lists refetch both `['storyIds', feed]` and
  `['feedItems', feed]`; library lists refetch their single
  `['libraryStoryItems', …]` query. Cache invalidation is implicit —
  React Query's own refetch path honours the SW's
  StaleWhileRevalidate/NetworkFirst strategies.
- Gesture shape: arm when the document is at `scrollTop === 0` and the
  pointer travels downward more than it does sideways. A horizontal-
  first drag aborts so `useSwipeToDismiss` owns per-row swipes. Pull
  translation has a 0.5× rubber-band factor and caps at 96 px; release
  past 64 px fires the refresh, shorter pulls snap back. The spinner
  stays visible for at least 400 ms (even on an instant cache hit) so
  the user actually perceives the refresh.
- Replaces the browser's native PTR, which disappears in
  `display: standalone` PWA mode. `overscroll-behavior-y: contain` on
  the wrapper prevents the native PTR from racing ours at the top of
  the scroll.
- **Cost / reliability (rule 11):** no new infrastructure and no new
  external API calls — pull-to-refresh just retriggers the fetches the
  list already knows how to run. Client-only gesture; no bundle-size
  concern beyond the ~2 KB hook + component. Reliability impact: the
  same HN Firebase / `/api/items` dependencies as the baseline load.
  A user who pulls-to-refresh while offline gets the existing offline
  error state (via React Query's `networkMode: 'offlineFirst'`) and the
  small header "Offline" pill — no regression.

## Deployment

- Vercel project connected to the repo. `main` → production, all branches → preview.
- Environment variables (only needed for stretch features):
  - `HN_COOKIE_NAME=user` (matches HN's cookie name)
  - `SESSION_COOKIE_NAME=hn_session` (our own cookie name on our origin)

## Analytics

Vercel Web Analytics is mounted at the app root (`<Analytics />` from
`@vercel/analytics/react` in `src/App.tsx`) to answer basic audience
questions: visitors, pageviews, country, OS/browser, device type. It is
cookieless (no consent banner needed in common jurisdictions) and
self-hosted under `/_vercel/insights/*`, so no new third-party origin is
added and ad-blocker breakage is the only user-visible failure mode —
the app itself is unaffected if the beacon is blocked or Vercel's
endpoint is down.

Cost and reliability (per AGENTS.md rule 11): Pro plan includes 25k
events/month; at current single-digit traffic this is effectively free.
Beyond 25k, custom events are billed at Vercel's posted rate — revisit
event volume before adding high-frequency custom events.

The thread page also emits a `summary_layout` custom event once per
summary card after data arrives, carrying bucketed card width,
summary length, reserved and rendered content heights, and (for the
comments card) insight count. It exists to retune the
skeleton-reservation constants in `Thread.tsx` from real usage data;
see `SUMMARIES.md` for the dashboard workflow.

## Open Questions

- Rate limiting: HN will throttle scraped requests. For MVP the read path doesn't touch HN's HTML (Firebase is the source), so this only matters once voting is enabled.
- Do we keep comments out of MVP entirely or show them read-only? *Decision: read-only threads are in MVP; writing is not.*
