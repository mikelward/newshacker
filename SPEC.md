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

1. **At most three tap zones per row**, always in the same positions: the row body (title + meta) as a single stretched link on the left, a right-side icon button, and a reserved slot in between for at most one additional action. No hide, no past, no web, no flag, no inline author link, no rank number, no separate comments button. The shipped UI uses only two (row body + right-side button); voting currently lives on the thread page rather than the row (see *Thread action bar*).
2. **Large, well-spaced hit areas.** Minimum 48×48px per tappable, ≥8px dead space between adjacent targets.
3. **Metadata is display-only.** Domain, points, comment count, and age are plain text inside the row's stretched link; only the row body and the right-side icon button are distinct tap targets today.
4. **The right-side button is a real icon button** on the right, not an inline text link — visually obvious and easy to aim for. On feed views it toggles pinned state (Pin/Unpin); on library views (/pinned, /favorites, /done, /hidden) it toggles the view's own state (see *Library views* under *Story row layout*).
5. **Obvious zones, not clever ones.** A reader should be able to glance at the row and know, without reading, what each tap will do.

## Goals

- Mobile-first responsive layout; also usable on desktop.
- Fast, minimal-JS bundle; good Lighthouse scores.
- Cream background and compact typography reminiscent of HN, with HN orange (`#ff6600`) reserved for the logo mark (a white "n" on an orange tile with a home-indicator pill at the bottom) and accents rather than painting the whole header. The sticky header uses the page surface tokens (`--nh-bg` / `--nh-text`) so the bar, the body, and the mobile browser URL-bar tint all agree. Tap targets are **fewer, larger, better-spaced** than HN's own mobile site.
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
  **article comments view** (thread page) on feeds — a row-level heart on a
  feed would add a fourth tap target and undo the whole "fewer, larger tap
  zones" rule. On the `/favorites` library view the row's right-side slot
  carries an orange filled heart that unfavorites (see *Library views*
  below). Favorites never auto-expire and are not swept. The intent is
  "I loved this and want to remember it", not "I want to come back to this
  soon".
- **Done (check)** is your **completion log**. You mark done from the
  **article comments view** (thread page, action bar) on feeds; on the
  `/done` library view the row carries an orange filled check that unmarks
  done (see *Library views* below). Tapping Done also unpins the story —
  Pin is the active queue, Done is where items go when they leave the
  queue, and a story can't be in both.
  Done stories are filtered out of every feed (same as Hidden, but
  permanent instead of the Hidden list's 7-day TTL). The intent is
  "I engaged with this thread and I'm finished with it", not "not
  interested" (that's Hide) and not "keepsake forever" (that's Favorite).
  Favorites are orthogonal — favoriting and marking done are independent.

**Pin is a shield against every swipe, not just Hide.** On a pinned
row both swipe directions are suppressed — swipe-right (the Hide
gesture) and swipe-left (the Pin gesture). The latter matters
because `addPinnedId` re-writes the entry with a fresh timestamp;
without this shield, a stray swipe-left on a pinned row would
silently reorder the pinned list to the top. The row menu's
"Hide" item is also hidden on pinned rows. A pinned story leaves
the reading list by one of exactly two routes:

- **Done** (normal lifecycle). Marking a story Done from the thread
  action bar also removes the pin (see *Pinned vs. Favorite vs. Done*
  above). Done is where reads go when they leave the queue.
- **Unpin** (explicit, rare). The pin button flips to "Unpin" when
  the row is pinned — tapping it removes the pin without implying
  completion. Useful when a reader pinned a story and later decided
  they don't want to read it after all.

Hide, Sweep, and per-row swipe-right are *never* allowed to remove a
pin. The sweep button already says "Hide unpinned" and skips pinned
rows by construction; the row-level suppression keeps the model
symmetric — a reader can't touch a pin except by Pin/Unpin itself or
by completing the story via Done.

**Hide also shields against Pin, by the same logic.** On a currently
hidden row — visible on `/hidden`, and occasionally on `/favorites`
if a story is both a keepsake and dismissed — swipe-left and the row
menu's "Pin" item are suppressed. `LibraryStoryList` withholds the
`onPin`/`onUnpin` callbacks when `hiddenIds.has(story.id)`, which
is enough to block both entry points in one place. Pinning a story
that's already hidden would reintroduce exactly the pin ∩ hidden
collision the shield rule exists to prevent; a reader who wants a
hidden story back on their reading list unhides it first (via the
row's recover action on `/hidden`, or the feed-header Undo button)
and then pins it.

**Suppressed gestures rubber-band; they don't silently absorb.** A
blocked swipe (swipe-right on a pinned row, swipe-left on a hidden
row) still tracks the finger — the row translates as the gesture
moves — and snaps back on release. The reader sees the row
acknowledge the gesture, then refuse it, so the shield feels
responsive rather than broken. Implementation-wise, this comes for
free from `useSwipeToDismiss`: the gesture activates whenever any
handler is wired (long-press always is), and on `pointerup` the
direction whose commit-handler is `undefined` falls through to the
hook's `setOffset(0)` snap-back with its existing 200ms CSS
transition. No second hook mode, no per-row flag.

**Every swipe reveals a label that names its outcome.** Behind each
row sit two absolutely-positioned status labels, clipped by the
list-item's `overflow: hidden` and covered by the row's opaque
background at rest; they peek out as the row translates. Each edge
labels what the swipe in that direction will do:

- Left edge (revealed when the finger pushes right): `Pinned` on
  pinned rows (shield), otherwise `Hide` when `onHide` is wired
  (action).
- Right edge (revealed when the finger pushes left): `Hidden` on
  hidden rows (shield), `Pinned` on pinned rows (shield — swipe-left
  is now blocked too; see above), otherwise `Pin` when `onPin` is
  wired (action).

Pinned rows therefore carry `Pinned` on *both* edges; any swipe
reveals the shield label and the gesture rubber-bands.

Shield and action labels share one visual style (small uppercase
muted caption) — the word carries the meaning, not the color.
Readers get both the rubber-band physics and a reason for it in one
gesture: "Pinned" explains why the swipe snapped back; "Hide"
previews what the committed swipe will do. No new DOM elements on
rows that don't need them; the hints render conditionally from
`pinned`, `hidden`, `onHide`, and `onPin` props in `StoryListItem`.

Hidden rows show only on `/hidden` (they're filtered from every
feed). They render with the standard opened/unopened coloring — no
separate "hidden" dim class. The dim modifier existed briefly to
flag pin ∩ hidden collisions on the home feed; under the shield rule
those collisions can't happen, so the extra visual signal has
nothing to say.

Legacy storage from before the shield rule can carry a pin ∩ hidden
pair. On first load after upgrade, the hidden-stores module runs a
one-shot migration (`migratePinHideCollisions` in
`src/lib/hiddenStories.ts`, gated by the
`newshacker:pinHideCollisionMigrated` version marker) and drops the
pin for any such pair — dismiss is the stronger, more recent signal,
so it wins. The migration is self-limiting (the hidden-store's 7-day
TTL clears surviving collisions on its own) and is scheduled for
removal after 2026-05-15.

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
   - Each list item shows: title, domain, points · age, and the comments count — all display-only plain text inside the row's stretched link. The comments segment renders as `"N comments"` normally, and flips to `"N/M comments"` when the reader has unseen comments to catch up on (N = new count since last visit, M = total). The "N new" piece deliberately rides inside the comments segment instead of adding a fourth meta item, per the fewer-tap-targets / lower-density goal.
   - See *Story row layout* for tap-target rules.
   - **Minimum-upvote visibility (`score > 1`).** Every feed filters out stories whose `score` is ≤ 1. HN submissions start at score 1 (the submitter's implicit self-upvote), so `> 1` means "at least one other person has upvoted this." The primary motivation is **signal-to-noise**: this is especially load-bearing for `/new`, which on raw HN is mostly instant self-submits and brand-new drops most readers don't care about — requiring one organic upvote before we surface a story turns `/new` into a meaningful "rising" feed instead of a firehose. On `/top`, `/best`, `/ask`, `/show`, `/jobs` the filter is effectively a no-op because HN's own ranking already pushes score-1 items out. The filter is live and per-render: a story excluded on one fetch is pulled back in automatically as soon as a later feed refresh shows its score has risen. There is no persistent "hidden by score" list. As a side benefit, this also closes the "submit-a-link-to-get-a-Gemini-summary" abuse path — the summary endpoints enforce the same `> 1` floor, and a story the feed never renders never triggers a warm.

2. **Thread view**
   - Story header (title, link, points, author, age, text if self-post). The title itself is a secondary tap target for the article URL (opens in a new tab); the HN-orange "Read article" button on the action bar below stays the primary affordance. Self-posts render the title as plain text since there is no external article. See *Thread action bar* for details.
   - **Article summary card** (AI, Gemini 2.5 Flash-Lite) above the action row, for any story with something to summarize — link posts (summarized from the fetched article via Jina) and self-posts (Ask HN / Show HN / text-only, summarized directly from `text`). Auto-runs on load. Stories with neither a `url` nor a `text` body (rare) don't render the card.
   - **Comment summary card** (AI, Gemini 2.5 Flash-Lite) between the meta line and the comment list, for any story with at least one top-level comment — including self-posts (Ask HN, Show HN). Renders 3–5 short insights. Auto-runs on load. Reuses the same card visual as the article summary.
   - Nested comments, each collapsed by default with a 3-line body preview. See *Comment row layout*.
   - Deep-linkable: `/item/:id` — `:id` may be a story or a comment.
     Comments render a focused single-comment view: eyebrow ("Comment"),
     the **root story's title as a heading link** (resolved by walking
     up the `parent` chain), author + age, the comment body, and the
     comment's own replies underneath. While the parent walk is in
     flight, or if it can't reach a story, a "View parent →" link is
     shown instead so the reader is never stranded with no context.
     Story-only chrome — title link, summary cards, story action bar —
     is omitted in the comment view. *Deferred:* whether to also render
     the article SummaryCard / CommentsSummaryCard on the comment view.
     Useful context but doubles the surface where article summaries
     auto-run; per AGENTS.md rule 11 the cost / "is it actually wanted
     here?" tradeoff deserves its own decision once we see how the
     title-only header feels in practice.

3. **User view (minimal)**
   - `/user/:id` shows karma, created date, about text, and the user's
     5 most recent comments (snippets, each linking to the comment in
     its thread). Submitted stories are skipped from the inline list —
     a "View all comments on Hacker News →" link below the list points
     at `news.ycombinator.com/threads?id=<id>` for the full history.
     Implementation: one `/api/items` batch fetch of the first 15 IDs
     from the user's `submitted` list, filtered to non-dead, non-deleted
     comments. The section is hidden entirely when the user has no
     submissions.
   - Deferred enhancements (TODO): grouping comments by their root
     story with the article title as a heading; surfacing the parent
     comment a reply was made to; rendering the cards with the same
     expand-in-place affordance the thread view uses. Each requires
     additional parent-walk fetches and is intentionally deferred until
     the focused-comment view at `/item/:id` lands first.

4. **Navigation & Chrome**
   - Sticky header with the orange "n" tile mark (home-indicator variant), wordmark, and current feed name.
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

6. **Account UI** (header chip, not drawer). The sticky header
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
│   example.com · 3h · 412 points · 5/128 comments · hot   │
│                                                          │
└──────────────────────────────────────────────────────────┘
   ^                                                          ^
   |                                                          |
  Row tap → thread (/item/:id)                               Pin toggle:
  (title + meta share one stretched link)                   pin / unpin
```

Tap zones — there are never more than three, and the shipped UI uses two:

- **Row body** — the title and meta line share a single stretched `<Link to="/item/:id">`, so a tap anywhere on the row opens the thread. The article itself is opened from a prominent "Read article" button on the thread page. Self-posts behave the same way (they've never had an external article to begin with).
- **Right-side icon button** — a real icon button on the right, not an inline text link. Has its own 48×48px hit area and ≥8px horizontal gap from the row body. On **feed views** (Top / New / Best / Ask / Show / Jobs, and the "off-feed pins" prepended to the home feed) this is the **Pin/Unpin** button and tapping toggles pinned state. On **library views** (/pinned, /favorites, /done, /hidden) every visible row already has the state the view is filtered to, so the right-side slot carries the view-contextual inverse — orange filled pin / heart / check / visibility-off respectively — and tapping removes the story from that library. See *Library views* below.

A third slot is reserved between the row body and the right-side icon button for at most one additional per-row action. It's currently unused — voting took the slot in an earlier design and has since been moved to the thread page action bar (see below). Any future use of the slot has to clear a high bar: the action has to be something the reader actually wants to do from a scrolling feed without opening the story, not merely something we're capable of adding.

**Voting deliberately lives on the thread page, not the row.** An earlier draft reserved a third tap zone on the left for the vote arrow (visible only when logged in). We dropped it: the row stays a pure browsing surface, and upvoting becomes an intentional act on the page where the reader has context — title, domain, points, article summary, comment summary, comments themselves. See *Thread action bar* below.

Everything else is display-only:

- Points, age, comment count — plain text inline in the metadata row inside the row link.
- **"N new" comment badge.** When the reader has previously opened the thread, the row's meta line gains a trailing ` · N new` segment equal to `max(0, current descendants − descendants at last open)`. The snapshot is taken when the row is tapped (and refreshed every time the thread page loads or refetches), so revisiting the thread clears the badge naturally. Storage rides on the existing `newshacker:openedStoryIds` entry as a new `seenCommentCount` field; no new localStorage key, no network call, inherits the same 7-day TTL as the rest of the opened-story state. Zero cost / reliability impact.
- **Hot flag.** A lowercase orange `hot` segment is appended to the meta line (`… · 5/128 comments · hot`) when a story is either a **big story** (`score >= 100`, any age) or a **fast riser** (`score >= 40` and age `< 2h`). It's plain text inside the same stretched link as the rest of the meta, so no new tap target and the "at most three tap zones" rule is unchanged. Purely client-side (`isHotStory` in `src/lib/format.ts`), derived from data already in the feed item, so no new network calls, storage, or cost.
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

### Library views

The library views — `/pinned`, `/favorites`, `/done`, `/hidden` — reuse the exact feed row layout (same row body on the left, same right-side icon button on the right, same `StoryListItem` component), with one deliberate swap: the **right-side button is whatever action the view implies**, not Pin/Unpin.

| View         | Right-side button          | Icon (Material Symbols)        | Tap → |
|--------------|----------------------------|--------------------------------|-------|
| `/pinned`    | Pin/Unpin (unchanged)      | `push_pin` — always filled     | unpin |
| `/favorites` | Unfavorite                 | `favorite` — always filled     | unfavorite |
| `/done`      | Unmark done                | `check_circle` — always filled | unmark done |
| `/hidden`    | Unhide                     | `visibility_off` — always filled | unhide |

The icon is always painted in HN orange (`.pin-btn--active`) because every visible row on a library view already has the state in question — the button is the "undo" for the filter the reader used to land on this view. After tapping, the row disappears from the list (it no longer matches the filter). Rule of thumb: the right-side button on a library row mirrors the bar button that puts a story into the library (Favorite heart on thread → Unfavorite heart on `/favorites`, Done check on thread → Unmark-done check on `/done`, and so on).

**What this buys us.** One visual language between feed rows and library rows — a reader who knows what the right-side button does on `/top` knows what it does on `/done`, because the geometry and pressed-state are identical. It also kills the old below-the-row "Forget" / "Unpin" text button that used to hang off library rows, and trims `/pinned`'s redundant double-affordance (the pre-refactor UI had both an active orange pin *and* a text Unpin beneath every row, doing the same thing).

**Tap-zone accounting is unchanged.** Still at most three zones per row, still two in the shipped UI (row body + right-side button). Swapping the action behind the right-side icon is a per-view re-skin, not a new tap target — and the corollary under CLAUDE.md rule 5 (Favorite / Upvote stay off feed rows) still holds: the heart only appears as a row-level button once you're already *inside* the Favorites library, never on a feed row.

**Things you lose.** On `/done`, `/favorites`, `/hidden` you can no longer pin a story with a single row tap — the right-side slot is the view-contextual action. Pin/Unpin is still one long-press away via the overflow menu (`StoryRowMenu`), and stays on the thread action bar. `/pinned` keeps the single-tap pin/unpin because that *is* the view-contextual action.

**Per-view "Forget all" toolbar.** `/done`, `/opened`, `/hidden` still render the standard chunky action button above the list for the bulk-clear action ("Forget all done", "Forget all opened", "Forget all hidden"), using the shared `.nh-action-btn` style (same visual vocabulary as the thread action bar; see `src/styles/global.css`). `/favorites` and `/pinned` don't have this toolbar — Favorites is the keepsake list (forgetting in bulk is never the right default) and Pinned auto-prunes nothing but can be emptied one row at a time.

### Thread action bar

Row order, left-to-right: **Read article** (hidden on self-posts) → **Upvote** (hidden when logged out) → **Pin/Unpin** → **Done** → **More actions ⋮**. Each icon button is 48×48px with ≥8px spacing. The Upvote button uses HN's triangle shape (solid `▲`), colored `--nh-meta` by default and `--nh-orange` when voted; tapping flips local state optimistically and POSTs `/api/vote` in the background, rolling back and toasting on failure. See item 7 under *Features* for the full round-trip.

**Read-article "read" state.** The HN-orange Read article button drops to the neutral secondary palette once the reader has opened the article at least once in this browser (tracked by `articleOpenedIds` in the `useOpenedStories` hook, persisted to `localStorage` under `newshacker:openedStoryIds`). Layout, icon, label, and href are unchanged — only the colors shift — so a re-visit still surfaces the link without visually shouting "read this!" at someone who already has. Implemented as a `.thread__action--read` modifier stacked on top of `.thread__action--primary`; ordering in `Thread.css` matters (read overrides primary). Tapping the button still calls `markArticleOpenedId`, which is a no-op if the id is already set. Matches the feed row's "visited" treatment where opened stories fade the title.

**Title also opens the article.** The `<h1>` headline is wrapped in an `<a>` to `item.url` when the story has an external URL — same `target="_blank"`, same `markArticleOpenedId(item.id)` side effect — so a reader who reaches for the title instead of the button gets the same behavior (and the "read" fade still kicks in on the button). The link stays styled as a heading at rest (inherits color, no underline) and tints HN-orange on pointer hover / press; the `:hover` rule is gated behind `@media (hover: hover)` to avoid sticky touch-hover (see CLAUDE.md § CSS gotchas). Self-posts render the title as plain text — no URL, no link.

The **Pin/Unpin** button (Material Symbols `push_pin`, outline → filled on toggle) is the same pinned state as the row-level pin on feeds; label and tooltip flip between "Pin" and "Unpin" based on current state. Reachable from the thread page so stories opened directly from a share link (where there's no feed row to tap) can be pinned and unpinned in the same place. The **Done** button (Material Symbols `done`, outline → filled on toggle) sits immediately right of Pin/Unpin and marks the thread complete: the story is filtered out of every feed (see *Pinned vs. Favorite vs. Done* above) and added to the synced Done list. Tapping Done on a pinned story also unpins it; Done and Pin are mutually exclusive. Tapping **Mark done** also closes the thread — it pops back to the previous entry (usually the feed) via `navigate(-1)`, or lands on the home feed if there's no in-app history (deep link, refresh, shared URL). This mirrors the "mark read" gesture on Apollo-style Reddit clients: the Done tap is "I'm finished, move on". **Unmark done** does *not* navigate — the user is usually on the thread deliberately to revisit a completed item, so yanking them away would be hostile. Browser back is the recovery path for an accidental mark-done; there is no Done toast — the button state (and the story's disappearance from feeds) is the single source of truth, matching Pin.

The action bar also appears at the **bottom** of the thread, after the comments list. Same layout and handlers for Vote/Pin/Done/⋮ — reaching Pin/Done at the end of a long discussion shouldn't require scrolling all the way back to the top. The primary-slot button differs: the top bar shows **Read article** (when the story has a url, HN-orange primary styling), the bottom bar shows **Back to top** (always, including on self-posts, but in the secondary/neutral style — *not* orange). The HN orange is reserved for the top bar because "go read the article" really is the primary action on that page; Back to top at the bottom is a utility, not the main CTA, so it sits visually on the same tier as Vote/Pin/Done. Back to top still fills the same primary-slot width as Read article does at the top (a `.thread__action--stretch` modifier, which shares --primary's `flex: 1; min-width: 0` but drops the orange), so Pin/Done/⋮ end up at the same x-position in both bars and the reader's thumb doesn't have to hunt for them. "Back to top" uses Material Symbols `vertical_align_top` and calls `window.scrollTo({ top: 0, behavior: 'smooth' })`, which major browsers short-circuit to an instant scroll when `prefers-reduced-motion: reduce`. The overflow menu is shared (one `StoryRowMenu`) so either ⋮ button opens the same sheet. Test ids on the bottom bar carry a `-bottom` suffix (e.g. `thread-done-bottom`, `thread-back-to-top-bottom`); the top bar keeps the original unsuffixed ids.

**Single-row invariant.** Both bars are laid out to fit on a single row at every realistic phone width (≥320px). The stretch slot (`flex: 1; min-width: 0`) absorbs the width pressure by ellipsis-truncating its label via `.thread__action-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }` — so on a Pixel-10-class phone the label may render as `Back to to…`, but ⋮ stays visible in the same row as Pin and Done. An earlier design force-wrapped the primary slot to its own row at `≤480px` via `flex-basis: 100%`; that was removed because (a) it gave every common phone a gratuitous 2-row bar, and (b) it still let the top and bottom bars wrap inconsistently whenever their two labels had different natural widths. `Thread.toolbarLayout.test.tsx` pins the new invariant down across a 320–1024px viewport matrix, including a raw-CSS check that blocks `flex-basis: 100%` from coming back on these classes.

Tapping ⋮ opens the overflow menu (the same `StoryRowMenu` component used for long-press on a list row) with secondary actions for the story. The menu renders as an anchored dropdown popover next to the ⋮ button on every device — pointer and touch alike — right-aligned, flipped above when there isn't room below, and dismisses on click-outside or Escape. Menu items size up on touch (48px tap targets, matching the per-row touch-target rule) and shrink to a denser layout inside `@media (hover: hover)` where a cursor doesn't need the extra room. The sheet variant — a full-width panel sliding up from the bottom with a darkened backdrop and a Cancel button — remains as the fallback for the rare case where no anchor element is available (e.g. a programmatic open with no trigger). Secondary actions:

- **Favorite / Unfavorite** — the keepsake toggle (heart). Lives in the overflow because it's less frequent on the comments view than the queue/exit pair on the bar; see *Pinned vs. Favorite vs. Done* above for the distinction between queue (Pin), keepsake (Favorite), and completion (Done).
- **Open on Hacker News** — opens `https://news.ycombinator.com/item?id=:id` in a new tab. Lets users jump to the canonical HN page (e.g. to upvote/comment from their HN account, while we don't yet support write actions).
- **Share article** — invokes the Web Share API (or copies the link to the clipboard as a fallback) on the source URL, via the `useShareStory` hook. Hidden on self-posts (Ask HN, Show HN, etc.) since there's no off-site article to share.

Naming convention for share entries: a noun ("Share **article**") names *what* is being shared; the `on <platform>` suffix names *where* the recipient lands. This keeps the Share entries aligned with **Open on Hacker News** above and leaves room for a planned **Share on newshacker** entry that shares the discussion view on our origin.

## Comment row layout

Comments match the "fewer tap targets" rule: the whole row is one tap zone that toggles expand/collapse. Interactive children (the author link, and the action toolbar's upvote / downvote / **Reply on HN** buttons on expanded comments) keep their own tap behavior via a `closest('a, button')` bail-out in the row's click handler; the row handler also stops propagation so tapping a nested reply only expands that reply, not its ancestors. The toolbar's own wrapper stops propagation too, so a tap in the strip's dead space between buttons doesn't leak up to the row and collapse the comment.

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
- Meta row sits directly **below** the body: author link, then plain text " · age · N replies" (reply count omitted when there are none), all on one baseline at 13px. The meta row hugs the body above it (no `margin-top`; the toggle button's own 4px top padding is the only gap) so it reads as belonging to the comment it follows, not the one below. The comment's vertical padding is asymmetric on purpose — `8px` top / `--comment-stack-gap` bottom — because the meta row's author and toggle buttons each carry an internal 4px vertical padding for tap-target height; a 4px card `padding-bottom` plus that 4px button padding visually matches the 8px gap above the body text, and a symmetric 10/10 used to read as noticeably heavier on the bottom. The gap between any two comment borders — whether the next comment is a sibling or the first nested reply — comes from the same `--comment-stack-gap` token, used by both `.comment`'s padding-bottom (sibling case) and `.comment__children`'s margin-top (nested case), so the two transitions can't drift apart. Tune the rhythm in one place.
- Horizontal gutter is a single `--comment-gutter` token (12px) applied as `.comment`'s left and right padding. `.comment__children`'s horizontal margin is **asymmetric** on purpose: `margin-left` is 0 (so a nested reply sits inside the parent's left padding, and stacked left indents are the visual cue for reply depth), and `margin-right` is `calc(var(--comment-gutter) * -1)` (so the nested list pulls back out of the parent's right padding and reaches the thread's right edge). Without the negative right margin, each nesting level would shrink the reading column by another gutter on the right, compounding into a lopsided right-hand margin that has nothing to do with depth. The left indent accumulates with nesting; the right gutter stays constant.
- No action row, no children.
- Cursor is `pointer`.

Expanded state:

- Background tints to `--nh-pressed` so the active node stands out in a long thread.
- Body shows in full.
- A thin borderless action toolbar appears below the meta row and above the nested replies. Left-to-right it carries **Upvote** (▲), **Downvote** (▼), and **Reply on HN** (`news.ycombinator.com/reply?id=:id`, opens in a new tab). Upvote and Downvote share the thread action bar's optimistic-vote path: tapping flips local state immediately, POSTs `/api/vote` in the background, and rolls back + toasts on failure. The voted button paints in `--nh-orange` (shape stays solid — HN's own shape+color convention, matching the story vote button). Switching direction (up → down, or down → up) chains two API hits — `un` then the new direction — because HN models it that way; if the second leg fails after a successful `un` the UI lands at neutral locally rather than restoring the original direction, so the client can't display a vote HN no longer has. Reply is a working link that hands off to HN (newshacker doesn't submit comments itself). Buttons have no individual borders — the strip reads as a single toolbar rather than a row of separate controls — and each is ≥44×44px so the icons stay tappable. Each icon button carries a tooltip + `aria-label` (icon-only buttons need an accessible name; the tooltip is visual-only).
- **Downvote is karma-gated and time-windowed by HN.** The `how=down` anchor is only rendered on HN's item page for viewers above a karma threshold (historically ~500) and not for the viewer's own posts, and HN also stops rendering the downvote anchor once a comment is past its downvote window (comments are only downvotable for a limited time after posting; HN's exact threshold is undocumented). For any of these cases the scrape step in `/api/vote` returns 502 (the expected anchor is absent) and the hook toasts. We deliberately don't pre-check any of this — it would cost an extra item-page fetch per Downvote button render for a minority case — and we also don't try to distinguish karma-gate from too-old from a genuine HN error in the toast; the user sees an action-specific message ("Downvote unavailable on this item. It may be too old, your karma may not qualify, or you may have already voted.") that they can act on, without us pretending to know which of the causes applies. Historically the toast surfaced the raw "Could not find vote link on Hacker News item page" scraper message, which was accurate but unhelpful; the handler now returns a reader-friendly string per `how`.
- Immediate children render below as their own collapsed `<Comment>` nodes — i.e. each child is itself a 3-line preview until tapped.
- Cursor reverts to `default` (reading state).

A real `<button>` inside the meta row carries `aria-expanded` and the keyboard-accessible `Expand comment` / `Collapse comment` label, even though on-screen it just reads as the plain meta text.

Deleted, dead, and empty comments are not rendered at all — including their subtrees — so a thread never shows "[deleted]" placeholder rows.

Leading quote paragraphs (lines a commenter prefixes with `> ` to re-quote their parent) are stripped from the rendered body. The parent comment is already visible directly above, so the first line of the preview shouldn't be a duplicate of it — the reply's own content shows first instead. Stripping stops at the first non-quote paragraph, and a comment that is nothing but quotes is left alone rather than rendered empty.

## Top bar controls

On feed pages the sticky header carries three feed-scoped action icons on the right, in order **Refresh → Undo → Sweep unpinned**. All three icons stay in place (never shift) so the layout doesn't jump; each is disabled when the action is unavailable rather than being hidden.

- **Refresh** (Material Symbols `refresh`) — refetches the current feed and pulls cross-device sync state in one go. Same handler the pull-to-refresh gesture already calls (`Promise.all([refetch(), cloudSyncPullNow()])`); wired through `FeedBarContext` so the header doesn't need to know which feed is on screen. The icon spins while the refresh is in flight and the button is disabled (also disabled when offline). Available on every device — pointer and touch alike — so desktop users (for whom pull-to-refresh is unusable) have a real refresh affordance, and touch users get the same button as a faster alternative to the pull gesture.
- **Undo** (Material Symbols `undo`) — restores the most recent hide action: either the last swipe-to-hide, the last menu "Hide", or the last sweep (the whole batch at once). One level of undo only; recording a new hide replaces the stored batch. Disabled when there is nothing to undo. Not persisted across reloads.
- **Sweep unpinned** (Material Symbols `sweep`) — hides every visible unpinned story in one shot. Disabled when there are no unpinned stories to hide. Tapping it plays the **same** slide-right + fade-out as `useSwipeToDismiss` (200ms ease-out, translate by the row's full width so each row leaves the viewport the way a manually swiped row would) on every swept row *together* (one gesture, not a staggered cascade — "sweep" is a single motion), and the actual hide + undo-batch record commits when the animation finishes, so the rows slide in place instead of popping. Readers with `prefers-reduced-motion: reduce` skip both the animation and the delay and see the rows disappear instantly. Double-tap is ignored while a sweep is already playing out.

Icons are inlined monochrome SVG (Apache 2.0, Google Material Symbols, outlined weight, viewBox `0 -960 960 960`, drawn with `fill="currentColor"`). No icon font, CSS, or web request is used to load them at runtime.

On non-feed pages (thread, `/pinned`, `/done`, `/hidden`, etc.) these icons do not render at all.

No hide/sweep toast: the Undo button is the recovery path. Hiding is always deliberate (swipe right, broom, or menu Hide) — scroll-past does not auto-hide. Pin/unpin don't toast either; the pin button's pressed state is the single source of truth for pinned state.

## Bottom action bar (list views)

Every scrolling list view — feed pages (`/top`, `/new`, `/best`, etc.) and library pages (`/pinned`, `/favorites`, `/done`, `/hidden`, `/opened`) — ends in a **bottom action bar** styled after the thread page's bottom action bar: a single horizontal flex row on `.story-list__footer`, 12px gap, wrap to a second row on narrow screens. The thread page has its own version of this bar (see *Thread action bar*); the list-view bar mirrors its layout conventions.

**Slots, left → right, always in this order:**

1. **Back to top** (left, text + icon). Same button as the thread page's bottom-bar Back to top — Material Symbols `vertical_align_top`, neutral styling, calls `window.scrollTo({ top: 0, behavior: 'smooth' })` (browsers short-circuit this to an instant scroll when the user has `prefers-reduced-motion: reduce` set). Always rendered. It sits leftmost to match the thread bottom bar's leftmost Back to top, so a reader who has learned the thread bar already knows where this button is. Implemented by the shared `<BackToTopButton>` component; testid `back-to-top` on feeds and library pages alike.
2. **More** (middle, text). Load-next-page. Only rendered when there is another page available (i.e. the feed's id list is not exhausted). Library pages never render this — they're bounded lists, not paginated feeds. Accessible-name-based test target; no specific testid.
3. **Hide unpinned** (right, icon only). A second entry point for the sweep action; shares the broom glyph, tooltip (`"Hide unpinned"` / `"Nothing to hide"` when there's nothing to sweep), `aria-label`, and disabled-when-nothing-to-hide state with the top-right header button. It's the *same* sweep — clicking it hides the currently fully-visible unpinned rows. Pinned to the right edge of the bar, matching its position in the top header. Testid `sweep-btn-bottom` (the top-right header button keeps the unsuffixed `sweep-btn`). Feed-only — library pages never render this slot.

Library pages therefore show only the Back-to-top slot; feed pages show all three when a next page is available and the header sweep is enabled, or Back-to-top + Hide-unpinned when the feed's id list has been exhausted, etc. Reaching the end of any long scroll shouldn't require a manual fling to get back up top — Back to top is always there, matching where the thread page puts it.

**Sizing — More is the one that stretches.** On the feed footer (`.story-list__footer--feed`), More is the action a returning reader came for ("give me the next page of stories"), so it's the one that grows to absorb the row's free space and becomes the biggest target. Back to top stays at its natural size — it's a nice-to-have escape hatch, not the reason the reader scrolled to the bottom. Hide unpinned stays at its fixed 56×56 square, right-pinned via `margin-left: auto`. When the feed has exhausted its id list and More is absent, Back to top still stays natural-width and `margin-left: auto` on the sweep button takes over the right-pinning on its own. Library footers don't carry the `--feed` modifier, so Back to top grows to fill the row there (it's the only button — a full-width target beats a small one stranded on the left edge).

**Depth caption above More.** Feed pages render a small muted caption immediately above the action bar — `Showing N stories`, where N is the count of currently-visible (rendered) rows, matching the rank shown on the last row. It's a passive signal that lets the reader notice they're at story 120 before they tap More again, without overloading the More label itself (which would read as a property of the *next* page, not what's already on screen). The caption renders whenever the More button renders, and only then — they share the same `hasMore` gate. When every loaded story is filtered (e.g. heavily-hidden `/new`) the caption can read `Showing 0 stories`, which is intentional: it tells the reader the next chunk is the only way out. Feed-only; library pages never render either widget. Class `.story-list__count`, testid `story-list-count`.

## Visual Design

- Primary color: `#ff6600` (HN orange) — reserved for the logo mark (the "n" on an orange tile with a home-indicator pill at the bottom, in the header and the favicon/PWA icon), focus rings, and accents. The sticky header bar itself uses `--nh-bg` / `--nh-text` (cream / near-black) so the bar, the page body, and the mobile browser's URL-bar tint all read as a single surface.
- Background: `#f6f6ef` (HN cream) for the page, white for cards/rows.
- Text: `#000` primary, `#5a5a5a` read/opened titles, `#828282` metadata. The opened-title color sits between primary and meta so a row the reader has already opened is clearly de-emphasized without fading into the meta line below it.
- Font stack: system UI (`-apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif`). HN's Verdana looks dated on mobile; we use system.
- **Tap targets: ≥48×48px, ≥8px spacing between any two distinct targets.**
- **At most 3 tappable zones per story row**, 2 in the shipped UI (row body + right-side icon button). Anything else is display-only. The right-side button is Pin/Unpin on feed views and the view's own "undo" toggle on library views (see *Library views*). Upvoting is not on the row today; it lives on the thread page (see *Thread action bar*).
- Layout: single column, centered on desktop. Max-width `720px` up to a viewport of `960px`, then `860px` at `≥960px` so a laptop/desktop monitor doesn't leave the layout feeling like a phone-stretched-wide. Same cap for feed and thread. Collapsed comments keep the same 3-line `-webkit-line-clamp` at every width — the wider column already fits more characters per line, so the same 3 lines surface meaningfully more text on desktop without touching the clamp. Iterating on the clamp (or widening the thread more than the feed) is open follow-up in `TODO.md § Desktop layout`.
- Active/pressed state on every tappable zone (subtle background darkening) so the user sees which region received their tap.
- **Tooltip on every button, touch, desktop, and keyboard.** Every interactive `<button>` in the app (icon-only and text alike) routes through the shared `<TooltipButton tooltip="…">` component. It shows the same styled floating tooltip in three modes: (a) on a touch or pen pointer, a 500 ms hold shows the tooltip for ~1.2 s and swallows the follow-up click so the user can inspect a control without firing it; (b) on a mouse pointer, a 500 ms hover shows the tooltip and holds it until the cursor leaves or the button loses focus (no auto-hide timer, no click-swallowing); (c) when the button receives `:focus-visible` (keyboard tabbing), the same tooltip is shown after the same 500 ms delay and hides on blur. Mouse-click focus does NOT trigger the tooltip (the `:focus-visible` match is false, so tabbing through is discoverable but clicking to activate doesn't flash the label). These three paths are the touch / mouse / keyboard trio of the same affordance. Native `title` is no longer emitted by default (it would double-overlap our portal tooltip on desktop); icon-only buttons carry an `aria-label` for screen readers. The tooltip is portaled into `document.body`, position-flipped when there isn't room above, and `position: fixed` with px offsets (no `vh`) so the mobile address bar collapsing doesn't misalign it. iOS Safari doesn't fire `contextmenu` on long-press, so the native callout / selection magnifier is suppressed via CSS instead (`touch-action: manipulation; -webkit-touch-callout: none; user-select: none; -webkit-tap-highlight-color: transparent`). Android Chrome's `contextmenu` (which does fire) is `preventDefault`-ed while the long-press is pending. No haptic feedback.

- **Right-click opens the row menu on desktop** — the mouse equivalent of the touch long-press on a story row. Gated on `(hover: hover)` so mobile touch long-press (which already opens the menu via our swipe/long-press hook) isn't double-triggered by the synthetic `contextmenu` some mobile browsers still fire. The anchor is the row itself. Whether the menu came from a right-click or a long-press, it renders as the anchored popover described under *Thread action bar* — the popover is the default on both pointer and touch devices.

- **Comment-card +/− expand icon (all devices).** Each comment row's meta line ends with a small +/− icon (Material Symbols `add` when collapsed, `remove` when expanded) right after the reply count. Visible on every device so the expand/collapse control is obvious regardless of whether the reader taps the card body or aims for the icon. Using +/− rather than a chevron keeps the affordance neutral on both orientations and leaves room to iterate on the exact shape later — see `TODO.md § Desktop layout` for the open question of whether a chevron or directional expand icon would read better once we have usage data.

## Routes

| Path | View |
|---|---|
| `/` | story list (top feed, rendered inline — URL stays `/`); brand/home link in the header points here |
| `/:feed` | story list (`feed` ∈ top, new, best, ask, show, jobs) |
| `/item/:id` | story + comments |
| `/user/:id` | user profile |
| `/favorites` | favorite stories (permanent) |
| `/pinned` | pinned stories (active reading list) |
| `/opened` | recently opened stories (7-day history) |
| `/hidden` | recently hidden stories (7-day history) |
| `/login` | HN login form |
| `/admin` | operator-only dashboard (quota / billing for Jina, Gemini, Redis) — gated server-side on an HN round-trip that confirms the `hn_session` cookie is real **and** belongs to `ADMIN_USERNAME` (defaults to `mikelward`); not linked from the UI |

## Accessibility

- Semantic HTML (`<main>`, `<nav>`, `<article>`).
- Visible focus styles.
- `prefers-reduced-motion` respected for the collapse animation and the tooltip fade-in.
- Color contrast ≥ 4.5:1 for body text. HN orange `#ff6600` hits only 3.14:1 on white, so it's never used for body text — only as a background behind white glyphs (the logo tile behind the white "n"), as an outline color (focus rings, borders, the Classic preset's disc ring), or as the *wordmark* in the Duo preset. WCAG 1.4.3 exempts logotypes from the text-contrast minimum, and "newshacker" in the header is the wordmark side of the logo, not running text — the 3:1 non-text threshold applies instead, which `#ff6600` on `--nh-bg` clears in both light and dark modes.
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
- Icons (generated once by `scripts/generate-icons.mjs`, checked into `public/`): `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `apple-touch-icon.png` (180), `favicon.svg`, `favicon-maskable.svg`, `favicon-32.png`. The mark is an orange rounded-square tile with a white "n" biased toward the top and a small white home-indicator pill near the bottom edge — the iOS / Android gesture bar people see every day, so the "mobile-first" signal is in the mark, not just the copy. At favicon scale the pill survives as a thin horizontal stroke; at 192/512 it reads plainly. Can never be mistaken for the HN `Y` logo. The maskable variant is rasterized from a separate `favicon-maskable.svg` that uses a full-bleed orange tile (no rounded corners, since the launcher applies its own shape mask) and pulls the glyph + pill into the 80% adaptive-icon safe zone so aggressive OEM crops can't clip them.
- `index.html` declares the manifest, apple-touch-icon, and `apple-mobile-web-app-*` meta tags so iOS home-screen installs get a native-feeling shell.

### Service worker
- Registered with `registerType: 'autoUpdate'`: a new build downloads in the background and the new service worker silently activates on the next navigation. No prompt, no toast, and no automatic reload of the page the user is currently viewing without a user gesture (the PTR-triggered reload described below is user-initiated). The 'prompt' variant was tried first — it strands updates on devices whose users never accept the prompt, which broke the rollout of the `/api/telemetry` wiring (devices kept running the pre-deploy bundle and never emitted telemetry). A reader app has no in-progress state to lose on refresh, so silent updates are the safer default.
- **Pull-to-refresh also force-checks for updates.** The browser only re-checks `/sw.js` on a full page navigation, and our custom PTR (with `overscroll-behavior-y: contain`) overrides the browser's native swipe-to-reload in regular tabs; installed standalone PWAs have no reload UI at all. Without an explicit trigger, a session parked on one SPA route can sit on a stale bundle until the tab is closed — the Vercel-preview-after-force-push failure mode. PTR's refresh handler therefore also calls `registration.update()` and, if a newer SW activates (`controllerchange`), reloads the tab. Implementation in `src/lib/swUpdate.ts`; see *Pull-to-refresh* under *Navigation* for details.
- **Passive surfaces for updates** (`src/components/AppUpdateWatcher.tsx`, mounted once inside `ToastProvider`):
  - **`controllerchange` → update-available toast.** A global listener on `navigator.serviceWorker` fires whenever a newer SW claims the tab. The watcher shows a sticky toast — "New version available · Reload" — that dismisses only when the user taps the action or a newer toast replaces it. This covers the new-tab case (user opens a second tab while an older SW is still controlling the origin; the new SW installs + claims shortly after the page loads; the toast appears and the user taps to reload) and cross-tab propagation (tab A's PTR swaps the SW; tab B's watcher surfaces the toast). A first-ever SW activation on a truly fresh visit (no prior controller at mount) is suppressed — the rendered bundle is already current, nothing to nudge. PTR's own `swUpdate` handler also observes the event and auto-reloads; in that case the toast paints for a blink before the reload replaces the DOM, which is acceptable.
  - **`visibilitychange` return-from-hidden → passive ping.** When the tab regains visibility after being hidden for ≥30 s (`pingServiceWorkerForUpdate()` in `swUpdate.ts`), we fire `registration.update()` and forget. If a new SW is discovered it installs + claims via the same `autoUpdate` path, the `controllerchange` listener above shows the toast, and the user gets a non-disruptive nudge when they come back to the tab. Short alt-tabs (under the threshold) don't trigger a ping.
- Disabled in `npm run dev` (devOptions.enabled: false) so iteration is unaffected. Active in `npm run build && npm run preview` and in production.

### Caching strategy
- **App shell**: precached at build time so the app boots offline. Navigation falls back to precached `index.html`; React Router takes over client-side.
- **HN items** (`/item/:id.json`): StaleWhileRevalidate, 7-day TTL, 500 entries.
- **Feed lists** (`topstories`, `newstories`, etc.): NetworkFirst with 10s timeout, 1-day TTL, 10 entries. The longer timeout stops ordinary mobile-data latency from flipping the strategy to "serve last-known list" on reload.
- **AI summary** (`/api/summary`): StaleWhileRevalidate, 7-day TTL, 200 entries. Server-side, summary records live in KV for **30 days** and freshness is owned by the warm-summaries cron (see *Scheduled warming and change analytics* below) rather than a short per-record TTL. The user-facing handler returns any present record unconditionally.
- **AI comment summary** (`/api/comments-summary`): StaleWhileRevalidate, 7-day TTL, 200 entries. Server-side, comment-summary records also live in KV for **30 days** and freshness is owned by the same warm-summaries cron.
- **Summary React Query cache (client):** both hooks use a **30-minute `staleTime` / 7-day `gcTime`** split. Retention (7 d) matches the SW runtime cache so a pinned story revisited mid-week is a synchronous cache hit with no loading flash. Freshness (30 min) matches the cron's default `WARM_REFRESH_CHECK_INTERVAL_SECONDS` — so we never ask for a version newer than what the cron could have produced, but we do ask often enough to surface cron-regenerated updates. The SW's StaleWhileRevalidate absorbs the refetch latency: the UI renders from the React Query cache immediately, the refetch hits the SW cache first, and only surfaces a changed response if the server actually has one.
- **Items batch proxy** (`/api/items`): NetworkFirst with 10s timeout, 1-day TTL, 50 entries. The batch URL keys on the exact id set, which means a refresh of the same feed page hits the same cache entry — SWR here would silently repaint yesterday's score/comment counts. NetworkFirst still falls back to the cache when the user is genuinely offline, so `/pinned` and friends keep working.

**Shared server-side cache (Redis via Vercel Storage Marketplace).**
`/api/summary` and `/api/comments-summary` use a **shared Redis store**
(provisioned through Vercel's Storage Marketplace, which auto-injects
`KV_REST_API_URL` / `KV_REST_API_TOKEN` into every deployment) as the
cross-instance cache. The handler reads the key on entry and returns
immediately on hit; on miss it generates via Gemini and writes the
result. **Both article and comment summaries** live 30 days and rely
on the cron for in-window freshness — the cron re-hashes the source
(article body for `/api/summary`, top-20-transcript for
`/api/comments-summary`) and only burns Gemini tokens when the hash
changes. See *Scheduled warming and change analytics* below.
Reads from a
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

**Per-IP rate limiting on cache misses.** Both `/api/summary` and
`/api/comments-summary` share a single per-IP bucket that counts only
*cache misses* — i.e., only calls that would actually pay Gemini +
Jina. Cached responses are free and never touch the bucket. The bucket
is shared across the two endpoints so that a single thread view
(article summary + comments summary) counts as 2 units against one
bucket, which matches the cost model.

Two fixed-window tiers are enforced, both env-var tunable without a
deploy:
- **Burst:** `SUMMARY_RATE_LIMIT_BURST` cold calls / 10 min / IP
  (default 20).
- **Daily:** `SUMMARY_RATE_LIMIT_DAILY` cold calls / 24 h / IP
  (default 200).

Either limit can be disabled independently by setting the matching
env var to `0` or `off`. Over-limit responses return
`HTTP 429 { error: 'Too many requests', reason: 'rate_limited',
retryAfterSeconds: N }` plus a `Retry-After: N` header; the UI renders
a short "Too many requests — try again later." message in the
affected summary card.

Client IP is read from `x-forwarded-for` (leftmost entry) with
`x-real-ip` as a fallback. IPv4 addresses are bucketed exactly; IPv6
addresses are reduced to their `/64` prefix so a single subscriber
can't trivially cycle source addresses within the subnet their ISP
delegated them. If neither header is present (localhost, unusual
proxy), the handler **fails open** and skips the check rather than
blocking. The rate-limit gate runs only after every free validation
branch (story eligibility, API-key presence, and — for
`/api/comments-summary` — existence of usable comments), so requests
that 400 / 404 / 503 for other reasons don't consume quota; only
requests that would actually reach the paid Gemini/Jina call get
counted. The backing counter uses the same Upstash Redis store as
the summary cache, with an `INCR` + conditional `EXPIRE` per enabled
tier. With both burst and daily tiers on, that's typically 2
commands steady-state (one `INCR` per tier) and 4 in the first
window after a counter rolls (adding one `EXPIRE` per tier); the
Upstash REST client issues each as its own HTTP request rather than
pipelining. If Redis itself is unreachable or errors mid-check, the
handler fails open per tier and lets the request through — an
abuse-prevention loss is strictly preferable to an outage on the
feature.

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
- Covers the long tail of stories the scheduled warmer doesn't touch (anything outside the top-30). Impressions pace the cost for those.
- Complemented by `/api/warm-summaries` (next section) for the hot top-30 slice, where the cron keeps records fresh even before a user scrolls the row into view.

### Scheduled warming and change analytics
- **What it does.** `/api/warm-summaries` is a Vercel cron that runs every 5 minutes against `?feed=top&n=30`, fetches the feed, takes the first N eligible ids (`score > 1`, not dead/deleted), and for each one runs **two independent tracks in parallel**:
  - **Article track.** For link posts, re-fetches the article via Jina Reader (markdown), SHA-256 hashes it, compares against `articleHash` on the stored record. Unchanged → bump `lastCheckedAt`. Changed → regenerate the one-sentence summary via Gemini and overwrite the record. Jina is a hard dependency for the link-post path — there's no server-side raw-HTML fallback (see TODO.md § "Article-fetch fallback" for the rationale). For self-posts (no `url`, body in `text`), the track skips Jina entirely and hashes the stripped plain-text body itself; Gemini is then prompted with a self-post-specific variant that references the post title and asks for the submitter's claim / question directly. Stories with neither `url` nor `text` log `skipped_no_content`.
  - **Comments track.** Fetches the top-20 top-level kids, builds the exact same transcript `/api/comments-summary` would feed to Gemini, SHA-256 hashes it, compares against `transcriptHash` on the stored record. Unchanged → bump `lastCheckedAt`. Changed → regenerate the insights via Gemini and overwrite the record.
  One HN item fetch serves both tracks (article needs `url`, comments needs `kids` + `title`). Each track has its own cache record and its own tiered-backoff state so a chatty thread and a stable article don't block each other.
- **Query params.** `?feed=top|new|best|ask|show|jobs` (default `top`) and `?n=<int>` (default `WARM_TOP_N`, hard ceiling 100). The cron URL in `vercel.json` is explicit — `/api/warm-summaries?feed=top&n=30` — so a future second cron (e.g. `?feed=new&n=10`) reuses the same handler without a code change.
- **Why both a cron and impression-driven warming exist.** The on-view warmer pays for what users look at; it can't keep a popular summary fresh if nobody has loaded the story page for it since an edit. The cron handles the top-30 slice where "the card matches the current article / the bullets match the current thread" matters most, without waiting for a user to trip the cache miss. Outside top-30, impressions still pace everything.
- **Shared cache records** (Upstash JSON, 30-day TTL, written by both user-facing handlers and the cron):
  - Article: `newshacker:summary:article:<id>` → `{ summary, articleHash, firstSeenAt, summaryGeneratedAt, lastCheckedAt, lastChangedAt }`
  - Comments: `newshacker:summary:comments:<id>` → `{ insights, transcriptHash, firstSeenAt, summaryGeneratedAt, lastCheckedAt, lastChangedAt }`

  Legacy pre-schema entries (plain summary string / bare `string[]` of insights) are treated as absent on read and silently overwritten by the next regeneration. The user-facing endpoints return any present record unconditionally — the cron owns freshness.
- **Tiered backoff (the knobs these analytics exist to tune).** The article and comments tracks have diverged: articles use a flat fresh/stable split, comments use a doubling-width ladder keyed off HN `story.time`. Bucket widths match the analytics `ageBand` axis below so the "when do polls stop being worth it" question is answered by the same histogram on both sides.
  - `WARM_REFRESH_CHECK_INTERVAL_SECONDS` (default **30 min**): article re-check cadence while content is "fresh". Also the fallback comments cadence when HN `story.time` is missing.
  - `WARM_STABLE_CHECK_INTERVAL_SECONDS` (default **2 h**): re-check cadence once content has been unchanged for ≥ `WARM_STABLE_THRESHOLD_SECONDS`. Both tracks. Stable wins even inside a short comments tier.
  - `WARM_STABLE_THRESHOLD_SECONDS` (default **6 h**): how long unchanged before we treat content as stable and back off to the longer interval. Both tracks.
  - `WARM_MAX_STORY_AGE_SECONDS` (default **32 h**): stop re-checking the article track entirely past this. Past this point the user-facing `/api/summary` still serves the cached summary until Upstash itself evicts the record at the 30-day boundary. *Article track only.*
  - `WARM_COMMENTS_MAX_AGE_SECONDS` (default **32 h**): the comments-track twin — stop checking a thread past this. *Comments track only.*
  - `WARM_TOP_N` (default **30**): how many feed ids to consider per tick when `?n=` isn't supplied.
  - **Comments tier ladder (compile-time constant `COMMENTS_TIERS`, not env-tunable).** Story-age keyed, doubling widths; first match wins:

    | story age | interval |
    |---|---|
    | 0 – 1 h | 15 min |
    | 1 – 2 h | 30 min |
    | 2 – 4 h | 60 min |
    | 4 – 8 h | 120 min |
    | 8 – 16 h | 240 min |
    | 16 – 32 h | 480 min |

    The ladder is hardcoded on purpose — ladder shape is a structural choice (matches the analytics buckets), not something worth tuning via env per deploy. Only the 32 h stop-age is env-tunable.
  - `WARM_COMMENTS_MIN_KIDS` (default **5**): the cron refuses to create a `first_seen` comments-summary record until a thread has at least this many usable top-level comments. Stops us from burning Gemini tokens on 2-comment threads whose insights will be unrecognisable 20 minutes later. *Gates cron first_seen only — user-facing `/api/comments-summary` is not min-gated, so a reader navigating to a thin Ask-HN thread still gets whatever summary is possible.*
- **Auth.** Vercel Cron passes `Authorization: Bearer $CRON_SECRET`. The handler requires a match whenever `CRON_SECRET` is set; missing `CRON_SECRET` falls through to open access for local dev.
- **Structured JSON logs (per story-and-track + per run).** Each story emits **two** lines per tick (one per track):
  ```
  {type: "warm-story", track: "article"|"comments", storyId, outcome,
   ageMinutes?, stableForMinutes?, sinceLastCheckMinutes?,
   storyAgeMinutes?, ageBand?, deltaBytes?,
   // article track:
   summaryChanged?, contentBytes?, tokens?, urlHost?,
   // comments track:
   insightsChanged?, commentCount?, transcriptBytes?}
  ```
  `storyAgeMinutes` is `now − story.time` (HN submission age, not cache age — they differ when the cron first saw the story after it was submitted). `ageBand ∈ {0-1h, 1-2h, 2-4h, 4-8h, 8-16h, 16-32h, 32h+}` is the doubling-width bucket derived from `storyAgeMinutes`. Both fields are present on every log line where the HN item is in hand and carries a `time` field; absent on the pre-fetch fallbacks (`skipped_budget`, pool-level `error`). `ageBand` widths line up 1:1 with the comments tier intervals, so grouping logs by `ageBand` tomorrow answers both "how often do things change at each age?" and "was the matching tier's poll rate appropriate?". `deltaBytes` is `|contentBytes_now − contentBytes_prev|` on article `changed` entries (and the transcript-bytes analogue on comments `changed`) — one column instead of a self-join for separating "real edit" (multi-KB delta) from "in-body timestamp / cache-buster noise" (tens-of-bytes delta). Persisted on the record so the very next `changed` tick can compute it; absent only on the one post-deploy `changed` against a record that predates the persistence.
  where `outcome ∈ {first_seen, unchanged, changed, skipped_age, skipped_interval, skipped_low_score, skipped_no_content, skipped_low_volume, skipped_unreachable, skipped_payment_required, skipped_budget, error}`. `skipped_payment_required` is the Jina-specific twin of `skipped_unreachable` for when Jina returns 402 / 429 — kept distinct so "our paid article-fetch quota is empty" is one grep away from "this host blocked us". The enrichment fields exist so the analyst can separate real changes from noisy ones. `contentBytes` lets you spot "hash flipped but the body barely moved" (in-body timestamp / cache-buster noise that survived Jina's scrub) vs "hash flipped with a multi-KB delta" (real edit). `tokens` is Jina Reader's own billed token count (from the `usage.tokens` field of its JSON response — we request `accept: application/json` for exactly this reason) and is the authoritative per-fetch cost number; it's present on `first_seen` / `unchanged` / `changed` (and on `error` if Jina succeeded but Gemini failed — tokens were still billed), and absent on the skipped_* outcomes where we didn't call Jina. `urlHost` is `story.url`'s lowercased hostname and rides along on every article-track log where the HN item was in hand — `first_seen` / `unchanged` / `changed` and the in-function `skipped_*` outcomes. The two pre-fetch fallbacks miss it by construction: `skipped_budget` (wall-clock budget blown in `handleWarmRequest` before the story is picked up) and the pool-level `error` (processStory threw before the item load resolved). So `grep urlHost` gives a near-complete per-publisher breakdown. On the comments side, `commentCount < 20` flags mass-deletions / empty-bodied slots, and `transcriptBytes` serves the same role as `contentBytes`. Each run emits a summary `{type: "warm-run", durationMs, processed, storyCount, outcomes: {article: {...}, comments: {...}}, topNRequested, feed, knobs, articleTokensTotal}` — `articleTokensTotal` is the sum of the per-story `tokens` fields across the run, so you can watch total Jina spend per tick without post-processing the per-story lines. Grep the per-story lines out of Vercel logs after a week and you have per-track scatterplots of (age, did-it-change) that tell you whether the stable / max-age knobs can be pushed further out without missing real changes.
- **Cost/reliability (rule 11).**
  - **Jina** (article track only). 5-min cadence × top 30 stories = up to 8,640 calls/day worst case (every story at the fresh interval, every tick). With the 30-min fresh interval, a hot story settles at ~48 Jina calls/day; the 6-h stable threshold knocks the long tail down to ~12/story/day. Realistic ballpark: **1,500–3,000 Jina calls/day, ~45k–90k/month**. Jina's free-tier grant is a **one-time 10M-token allotment per API key that does not refresh** (daily or monthly); once drained you top up in blocks at roughly $0.02/M tokens or rotate to a new key. Budget ~5,000 tokens per Reader call as a planning figure (mid-single-digit-thousand, varies with article length), so at 1,500–3,000 calls/day you're burning ~7.5–15M tokens/day — the 10M grant drains in **roughly a day or two of steady cron traffic**, not weeks. At that volume ongoing use costs ~225–450M tokens/month, i.e. **~$5–10/month in top-ups** at $0.02/M; the 402 / 429 handling (below) is the graceful-degradation path between top-ups.
  - **HN Firebase** (both tracks). 5-min cadence means up to 288 ticks/day × 30 stories = 8,640 story-item fetches/day (free). Comments track adds up to 20 child-item fetches per processed story; realistic steady-state ~5–10k/day. HN API is free and unauthenticated, no rate-limit concern at this scale.
  - **Gemini.** Fires only on actual content change (article-hash for articles, transcript-hash for comments). Articles churn ~10–30% of ticks; comments churn more on young threads but settle once HN-rank reshuffles stop (and the min-kids gate stops us from regenerating thin-thread noise). Realistic combined estimate: **~$3–5/month** at expected traffic, **~$15/month** worst-case.
  - **Upstash.** Two keys per story instead of one. Still small — well under free-tier quotas.
  - **Vercel Cron.** Sub-daily cadence requires Pro ($20/month — already paid for this project). 5-min vs 10-min doubles the invocation count but not the per-story work (backoff gates it).
  - **New failure modes:** (1) cron silently fails — mitigated by the per-run `warm-run` log; absence is easy to notice. (2) Jina down / blocking this host → article track logs `skipped_unreachable`, keeps the stored record, next tick retries (≤5 min recovery). Jina 402 / 429 (paid quota exhausted) → article track logs `skipped_payment_required` and the user-facing `/api/summary` returns HTTP 503 with `reason: "summary_budget_exhausted"`, surfaced in the UI as "Summaries are temporarily unavailable". Comments track is unaffected. (3) HN Firebase slow → both tracks degrade gracefully. (4) Runaway work — guarded by `WALL_CLOCK_BUDGET_MS = 50 s`, Jina per-fetch timeout 15 s, and concurrency cap of 5 stories-at-a-time.
- **What's explicitly not done.** Regenerating summary / insights when only the model output drifts but the source hash is unchanged — by construction we trust that unchanged source implies still-correct output. Flagging / moderation / submission are out of scope (AGENTS.md rule 7). Finer per-track knob splits beyond the comments tier ladder + min-kids pair aren't implemented yet; planned as TODOs once analytics justify.
- Session-scoped dedup via a `Set` in `StoryList` prevents the same row firing twice as it scrolls back into view. Self-posts (Ask HN / Show HN / text-only) warm `/api/summary` as well — the endpoint summarizes directly from `text` (no Jina round-trip), so the article-summary KV entry is populated for them too. Only stories with neither `url` nor `text` (rare: a titled-only stub) skip `/api/summary` entirely; `/api/comments-summary` still warms for them.
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
- **PTR also checks for a newer app bundle** (`src/lib/swUpdate.ts`,
  `checkForServiceWorkerUpdate()`). On every PTR the refresh
  handler calls `registration.update()` in parallel with the feed /
  cloudSync refetches. If a newer SW is discovered, it installs via
  the existing `autoUpdate` (skipWaiting + clientsClaim) path and
  claims this tab; we listen for the resulting `controllerchange`
  and then `window.location.reload()` so the user sees the new
  HTML and JS, not just the new SW serving stale rendered output.
  If nothing has changed, `registration.update()` is a cheap
  conditional GET against `/sw.js` and no reload happens. 5 s
  timeout on the activate-wait so a wedged install never pins the
  spinner. This exists because the browser normally only re-checks
  `/sw.js` on a full page navigation, and our custom PTR overrides
  the browser's native swipe-to-reload — without this hook, a
  session parked on one SPA route (or an installed standalone PWA
  with no reload UI at all) can sit on a stale bundle until the
  user closes the tab. This is the failure mode that made Vercel
  preview testing after a force-push unreliable. The header
  Refresh button shares the same handler, so it inherits the
  behavior for free. Safe today because the app has no in-progress
  user input to lose on reload; see `TODO.md` under *PWA / offline*
  for the note to revisit if we ever add commenting or posting.
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
  small header "Offline" pill — no regression. The added SW update
  check is a conditional GET against `/sw.js` (same-origin, already on
  the Vercel edge CDN) — effectively free, and gated to the PTR
  gesture so it doesn't fire in a background loop.

## Deployment

- Vercel project connected to the repo. `main` → production, all branches → preview.
- Environment variables (only needed for stretch features):
  - `HN_COOKIE_NAME=user` (matches HN's cookie name)
  - `SESSION_COOKIE_NAME=hn_session` (our own cookie name on our origin)
  - `ADMIN_USERNAME=mikelward` (HN username permitted to load
    `/api/admin` and see `/admin`; defaults to `mikelward`)

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

The same payload is also POSTed fire-and-forget to `/api/telemetry`,
which `HINCRBY`s a joint-distribution counter in the existing Upstash
Redis store (key `newshacker:summary_layout:counts`). Vercel Web
Analytics only exposes marginal per-property breakdowns in its UI,
which isn't enough to tune per-viewport skeleton reservations — the
self-hosted counter is read by `scripts/analyze-summary-layout.mjs`
(`npm run analyze:telemetry`) and produces a joint breakdown plus
recommended new constants. Per AGENTS.md rule 11: Upstash reuses the
existing summary-cache database, adds ~1 `HINCRBY` per summary card
mount (well under the free-tier 10k commands/day at foreseeable
traffic), and the client POST is non-blocking so a `/api/telemetry`
outage is invisible to users.

## Open Questions

- Rate limiting: HN will throttle scraped requests. For MVP the read path doesn't touch HN's HTML (Firebase is the source), so this only matters once voting is enabled.
- Do we keep comments out of MVP entirely or show them read-only? *Decision: read-only threads are in MVP; writing is not.*
