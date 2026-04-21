# TODO

Short running list of things that aren't in flight but worth doing. For
user-facing feature decisions, see `SPEC.md`; for phase ordering, see
`IMPLEMENTATION_PLAN.md`.

## Performance

- **Faster sweep.** The broom currently rebuilds the dismissed-ids
  localStorage entry once per swept story, firing a storage change
  event each time. Batch the write so a sweep of 30 rows is one
  write + one event.
- **Prefetch page N+1 after each landed page.** With `/api/items`
  batched and edge-cached, each prefetch is effectively free — so
  keeping one page of lookahead warm would eliminate nearly every
  visible pagination "Loading…" for steady scrollers. Cap the
  lookahead so we don't drain the whole feed on mount.
- **Experiment with Algolia HN Search** as an alternative data source.
  One request returns a page of items with the fields we need; tags
  map to most of our feeds (`top`→`front_page`, `ask`→`ask_hn`,
  `show`→`show_hn`, `jobs`→`job`, `new`→`search_by_date&tags=story`).
  `best` has no direct equivalent — may need a different definition
  (e.g. "highest-voted story in the last 24h" via numericFilters).
  Worth prototyping a side-by-side to see if the order / content
  differs meaningfully from Firebase's `topstories` etc.
- **Persist item bodies across sessions.** React Query's localStorage
  persister caches the whole client; for item bodies specifically we
  could tier the persistence so they survive longer (days) than the
  ID lists (minutes), since titles/urls rarely change.

## PWA / offline

- **Pull-to-refresh gesture** on feed and thread pages. Intercept
  `touchstart`/`touchmove` at `scrollTop === 0`, show a pull indicator,
  and on release past the threshold call
  `queryClient.invalidateQueries({ queryKey: ['storyIds', feed] })` for
  feeds or `['itemRoot', id]` + visible comment keys for threads. Pairs
  with the SW's StaleWhileRevalidate so both caches refresh. Important
  because the browser's native pull-to-refresh disappears in
  `display: standalone`.
- **Explicit "save thread for offline" action** on the thread page that
  fetches the whole comment tree (or a deeper slice than the 30
  top-level prefetch) into cache in one burst. Useful for mega-threads
  a user wants to read offline in full.

## Thread overflow menu

- **Add Ignore / Un-ignore.** The thread `⋮` menu currently only has
  Open on Hacker News + Share article. Add a single context-sensitive
  entry — `Ignore` if the story isn't dismissed, `Un-ignore` if it
  is — wired through `useDismissedStories`, mirroring how
  `StoryListItem` exposes Ignore on the row menu.
- **Add Share on newshacker.** Companion to `Share article`: shares
  `https://newshacker.app/item/:id` (the discussion view with our
  reader chrome and AI summaries) instead of the source URL. Always
  shown, including on self-posts. Together with `Share article` the
  user picks whether the recipient lands on the source or in our
  reader. Naming convention is documented in `SPEC.md` (noun =
  *what* is shared; `on <platform>` suffix = *where* the recipient
  lands).
- **Rename `ignore` → `hide` to match upstream.** HN itself uses
  "hide" (and "unhide") for the same action; our codebase uses
  "ignore" / `dismissed*` everywhere (`useDismissedStories`,
  `lib/dismissedStories`, `/ignored` route, `IgnoredPage`,
  `newshacker:dismissedStoryIds` localStorage key, "Ignore" menu
  label). Worth a sweep so the user-visible vocabulary matches HN —
  including the route, page title, and storage key. Migration path
  needed for the localStorage key so existing users don't lose state.

## Backend / infrastructure

- **Re-evaluate server-side prefetch of summaries.** Currently
  rejected in `SUMMARIES.md` § "Alternatives considered" on
  cost-plus-complexity grounds — the edge CDN and service worker
  already absorb the common case, and a cron prefetching the top 30
  stories would multiply Gemini spend against items no reader opens.
  Re-open the question if any of these signals show up: (a)
  consistently high time-to-summary on fresh `summary_layout` events
  from low-`score` stories (those are the cold-cache cases nothing
  else warmed), (b) a material share of thread-page sessions where
  the summary is still loading when the reader navigates away, (c)
  Gemini pricing where prefetching top-N stories is cheaper than
  the current on-demand model. A positive decision here also opens
  the KV question below, since "which stories have we warmed in the
  last N minutes" is the kind of state a cron needs.

- **Redis (Vercel Storage Marketplace) is now in use** (summary
  endpoints, shipped). `AGENTS.md` rule 6 was satisfied by the
  cost-and-reliability case in `SPEC.md` § "Shared server-side cache
  (Redis via Vercel Storage Marketplace)". Current deployment: **free
  tier, single primary in `us-east-1`, no replicas, no HA** — enough
  for today's traffic and the fail-open handler. Remaining natural
  triggers for upgrading the store:
  (a) per-user or per-IP rate limiting on the summary endpoints
  (already flagged in `IMPLEMENTATION_PLAN.md` § "Rate limiting" —
  rate limiting is less comfortable as fail-open than summaries,
  so this is the most likely trigger to move off the free tier),
  (b) scheduled prefetch bookkeeping if the server-side prefetch
  cron lands (see Phase B sketched in chat / `SUMMARIES.md`),
  (c) session state for the login/vote stretch features if
  HTTP-only cookies prove insufficient,
  (d) `summary_layout` (or a new server-side metric) showing a
  material share of reads from far-from-`us-east-1` regions — that's
  the signal to add a read replica.
  Cost today: $0 on the free tier. Reliability: one failure mode
  (store unreachable) — summary handler is already fail-open; rate
  limiting handler should fail-open too (serve the request rather
  than fail closed).

## Sweep edge cases

- **Row taller than the visible viewport.** Sweep currently dismisses
  only rows whose bounding box is fully inside the viewport minus the
  app header. A very long wrapped title on a narrow phone could, in
  theory, make a row taller than that clipped area — it would then be
  un-sweepable. If this bites in practice, either truncate titles to
  N lines or relax the "fully visible" check (e.g. "fully visible OR
  row height > viewport height").
- **Header height changes mid-session.** The sweep observer measures
  the `.app-header` height on mount and on `window resize`. If we ever
  add a banner or a state that grows/shrinks the header without a
  resize (e.g. a toast docking into the header), we'll want a
  `ResizeObserver` on the header so the rootMargin stays correct.
