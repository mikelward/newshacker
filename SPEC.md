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

1. **At most three tap zones per row**, always in the same positions: optional upvote on the left, the row body (title + meta) as a single stretched link, and a pin button on the right. No hide, no past, no web, no flag, no inline author link, no rank number, no separate comments button.
2. **Large, well-spaced hit areas.** Minimum 48×48px per tappable, ≥8px dead space between adjacent targets.
3. **Metadata is display-only.** Domain, points, comment count, and age are plain text inside the row's stretched link; only the explicit upvote arrow, row body, and pin button are distinct tap targets.
4. **The pin button is a real icon button** on the right, not an inline text link — visually obvious and easy to aim for.
5. **Obvious zones, not clever ones.** A reader should be able to glance at the row and know, without reading, what each tap will do.

## Goals

- Mobile-first responsive layout; also usable on desktop.
- Fast, minimal-JS bundle; good Lighthouse scores.
- Familiar HN look & feel — orange `#ff6600` header, cream background, compact typography — but with **fewer, larger, better-spaced** tap targets than HN's own mobile site.
- Read the main HN story feeds (top, new, best, ask, show, jobs).
- View a story's comment thread (read-only for MVP).
- Optional: log in and upvote stories/comments via HN's existing web endpoints.

## Non-Goals (MVP)

- Submitting comments or replies.
- Submitting new stories.
- Flagging stories or comments.
- Moderation features (hide, mark as dupe, etc.).
- Push notifications.
- Native app shell (PWA installability is a nice-to-have, not required).

## Users

- Anonymous readers who just want to browse HN on a phone.
- Logged-in HN users who want to read and upvote from mobile.

## Feature List

### Pinned vs. Favorite — two intents, two buckets

"Pin" and "Favorite" are deliberately separate so a single row-level action
doesn't have to do double duty.

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

The two lists live side by side in the drawer ("Favorites" above "Pinned")
and each has its own localStorage key (`newshacker:favoriteStoryIds`,
`newshacker:pinnedStoryIds`) so one is never silently interpreted as the
other. The pinned-stories module performs a one-shot rename of the legacy
`newshacker:savedStoryIds` key so existing readers don't lose their list.

### MVP (read-only)

1. **Story feeds**
   - Default (and `/`) is the HN front page (Top).
   - Tabs / routes also available for: New, Best, Ask, Show, Jobs.
   - Infinite scroll or "Load more" pagination (30 items per page, matching HN).
   - Each list item shows: title, domain, points · age (display-only), and an "N comments" button.
   - See *Story row layout* for tap-target rules.

2. **Thread view**
   - Story header (title, link, points, author, age, text if self-post).
   - Nested comments, each collapsed by default with a 3-line body preview. See *Comment row layout*.
   - Deep-linkable: `/item/:id`.

3. **User view (minimal)**
   - `/user/:id` shows karma, created date, about text. Submissions/comments lists are out of scope for MVP.

4. **Navigation & Chrome**
   - Sticky orange header with HN "Y" logo and current feed name.
   - Top nav tabs for feed switching, integrated into the header.
   - Back button on thread/user pages.

### Stretch (behind a feature flag)

5. **Login**
   - POST to `https://news.ycombinator.com/login` with `acct` + `pw` form fields.
   - Store the returned `user` cookie client-side... but **the browser cannot set third-party cookies for news.ycombinator.com from our origin**. This means login must be proxied through our own serverless function so the cookie is attached to requests the server makes on the user's behalf. See *Architecture* below.

6. **Voting**
   - Each story and comment's HN HTML contains a vote link like
     `vote?id=12345&how=up&auth=<token>&goto=news`.
   - To upvote we need:
     1. The user's session cookie.
     2. The per-item `auth` token, obtained by scraping the HN HTML for that item or list.
   - Voting is therefore implemented as a serverless endpoint that scrapes the `auth` token and issues the GET to `/vote`.

7. **Unvote** (same mechanism, `how=un`).

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
│   ▲     Story title goes here, wrapping to two lines     │
│         if needed.                                       │   ☆
│         example.com · 412 points · 128 comments · 3h     │
│                                                          │
└──────────────────────────────────────────────────────────┘
   ^     ^                                                    ^
   |     |                                                    |
  Vote  Row tap → thread (/item/:id)                         Pin toggle:
  (opt) (title + meta share one stretched link)             pin / unpin
```

Tap zones — there are never more than these three:

- **▲ Upvote** (only when logged in; when logged out, the column collapses and the title shifts left). Min 48×48px. Stretch feature; see *Architecture*.
- **Row body** — the title and meta line share a single stretched `<Link to="/item/:id">`, so a tap anywhere on the row opens the thread. The article itself is opened from a prominent "Read article" button on the thread page. Self-posts behave the same way (they've never had an external article to begin with).
- **Pin button** — a real icon button on the right, not an inline text link. Tapping toggles pinned state. Has its own 48×48px hit area and ≥8px horizontal gap from the row body.

Everything else is display-only:

- Points, age, comment count — plain text inline in the metadata row inside the row link.
- Domain — plain text in the metadata row, not a link. (We intentionally do not let users tap a domain to filter by site; that's a power-user feature incompatible with the "few targets" goal.)

What is deliberately **not** rendered:

- Rank numbers (visual noise; never tapped).
- "hide", "flag", "past", "web", "via" links.
- Inline author link. The author appears on the thread page, where there's room for it as a distinct tap zone.

Spacing / sizing:

- Row vertical padding: 16px top and bottom. Min row height: 72px.
- Min hit area per tap zone: 48×48px.
- Min dead space between adjacent tap zones: 8px.
- Pressed state (subtle background darkening) on every tap zone so the user sees which region received their tap.

Thread page mirrors the same discipline: a single, full-width "Read article" button at the top of a story view (hidden for self-posts), and a single primary tap target per comment row. See *Comment row layout* below.

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
- Meta row sits directly **below** the body: author link, then plain text " · age · N replies" (reply count omitted when there are none), all on one baseline at 13px. The meta row hugs the body above it (no `margin-top`; the toggle button's own 4px top padding is the only gap) so it reads as belonging to the comment it follows, not the one below. The comment's 6px bottom padding sits between the meta and the next comment's top border.
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

## Top bar controls

On feed pages the sticky orange header carries two feed-scoped action icons on the right. Both icons stay in place (never shift) so the layout doesn't jump; each is disabled when the action is unavailable rather than being hidden.

- **Undo** (Material Symbols `undo`) — restores the most recent dismiss action: either the last swipe-to-dismiss, the last menu "Ignore", or the last sweep (the whole batch at once). One level of undo only; recording a new dismiss replaces the stored batch. Disabled when there is nothing to undo. Not persisted across reloads.
- **Sweep unpinned** (Material Symbols `sweep`) — dismisses every visible unpinned story in one shot. Disabled when there are no unpinned stories to dismiss.

Icons are inlined monochrome SVG (Apache 2.0, Google Material Symbols, outlined weight, viewBox `0 -960 960 960`, drawn with `fill="currentColor"`). No icon font, CSS, or web request is used to load them at runtime.

On non-feed pages (thread, `/pinned`, `/ignored`, etc.) these icons do not render at all.

No dismiss/sweep toast: the Undo button is the recovery path. Dismissing is always deliberate (swipe right, broom, or menu Ignore) — scroll-past does not auto-dismiss. Pin/unpin don't toast either; the pin button's pressed state is the single source of truth for pinned state.

## Visual Design

- Primary color: `#ff6600` (HN orange) for the header and accents.
- Background: `#f6f6ef` (HN cream) for the page, white for cards/rows.
- Text: `#000` primary, `#828282` metadata.
- Font stack: system UI (`-apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif`). HN's Verdana looks dated on mobile; we use system.
- **Tap targets: ≥48×48px, ≥8px spacing between any two distinct targets.**
- **At most 2 tappable zones per story row** (3 when logged in, counting the vote arrow): the stretched row link and the pin button. Anything else is display-only.
- Layout: single column, max-width ~720px, centered on desktop.
- Active/pressed state on every tappable zone (subtle background darkening) so the user sees which region received their tap.

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
| `/ignored` | recently dismissed stories (7-day history) |
| `/login` | login form (stretch) |

## Accessibility

- Semantic HTML (`<main>`, `<nav>`, `<article>`).
- Visible focus styles.
- `prefers-reduced-motion` respected for the collapse animation.
- Color contrast ≥ 4.5:1 for body text (HN orange on white fails for small text — only used on large headers / buttons).

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

## Deployment

- Vercel project connected to the repo. `main` → production, all branches → preview.
- Environment variables (only needed for stretch features):
  - `HN_COOKIE_NAME=user` (matches HN's cookie name)
  - `SESSION_COOKIE_NAME=hn_session` (our own cookie name on our origin)

## Open Questions

- Rate limiting: HN will throttle scraped requests. For MVP the read path doesn't touch HN's HTML (Firebase is the source), so this only matters once voting is enabled.
- Do we keep comments out of MVP entirely or show them read-only? *Decision: read-only threads are in MVP; writing is not.*
