# TODO

Short running list of things that aren't in flight but worth doing. For
user-facing feature decisions, see `SPEC.md`; for phase ordering, see
`IMPLEMENTATION_PLAN.md`.

## Performance

- **Faster sweep.** The broom currently rebuilds the hidden-ids
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

## Optimistic-action feedback

- **Consider a pending state or animation for server-persisted
  actions.** Today voting, favoriting, pinning-with-HN-sync, and
  hidden-list cross-device sync all flip the local UI state
  instantly on tap, then POST silently, then roll back + toast on
  failure. That's fine in the happy case but gives the user no cue
  that something is happening during the ~500–1500 ms request
  window, which matters most on flaky connections. Two options to
  explore (not yet scoped):
  1. A short "received" animation on the target icon (e.g. a 150 ms
     `scale(1 → 1.2 → 1)` pulse on `.vote-btn.is-voted` /
     `.pin-btn--active` / the favorite heart). Low-risk, but doesn't
     communicate failure — just "we registered your tap".
  2. A proper pending state — hook tracks in-flight ids, button
     shows `aria-busy="true"` and a subtle dim until the POST
     resolves, double-taps within that window are debounced. More
     correct, more code, slightly heavier visually.
  Apply uniformly across vote / favorite / pin (and anywhere else
  we add optimistic server-persisted actions) — picking one style
  so behavior is consistent. Also revisit the toast copy for
  failures while you're in there.

## Thread overflow menu

- **Add Hide / Unhide.** The thread `⋮` menu currently only has
  Open on Hacker News + Share article. Add a single context-sensitive
  entry — `Hide` if the story isn't hidden, `Unhide` if it
  is — wired through `useHiddenStories`, mirroring how
  `StoryListItem` exposes Hide on the row menu.
- **Add Share on newshacker.** Companion to `Share article`: shares
  `https://newshacker.app/item/:id` (the discussion view with our
  reader chrome and AI summaries) instead of the source URL. Always
  shown, including on self-posts. Together with `Share article` the
  user picks whether the recipient lands on the source or in our
  reader. Naming convention is documented in `SPEC.md` (noun =
  *what* is shared; `on <platform>` suffix = *where* the recipient
  lands).

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

## Thread action bar

- **Consider a state-dependent middle slot.** Today's bar always shows
  both Pin/Unpin and Done side-by-side. A snapshot-at-mount variant
  could show only one — Pin/Unpin when the story wasn't pinned on
  load (so the user can pin and immediately undo in the same place),
  Done when it was (so the "I'm finished" action is front-and-centre
  for a saved item). Shrinks the bar to one slot instead of two, at
  the cost of having to hunt for the less-common action in the
  overflow. Tried and reverted once; revisit if the bar feels cramped
  on very narrow phones.

- **Consider dynamic overflow.** Measure available width at runtime
  via `ResizeObserver`; if the row would overflow, demote the
  right-most icons into the `⋮` menu until it fits. More flexible
  than fixed layout but costs a runtime measurement and can visually
  shuffle on orientation change. Not needed today — the ≤480px wrap
  fallback covers the narrow case — but an option if the bar grows.

- **Consider having Done auto-navigate back to the feed.** Today
  tapping Done on the thread action bar just flips the button to
  filled and updates local + sync state — you stay on the thread
  page. Alternative: tapping Done pops the thread and returns to
  the feed (or wherever the user arrived from), mirroring the
  Apollo-style "mark read" flow on Reddit clients.
  Pros: clearer "I'm finished" gesture; one tap clears both the
  thread and the row; matches muscle memory from other reader
  apps. Cons: breaks the consistency with Pin/Favorite/Upvote
  (which all toggle in place); removes the user's ability to
  see the filled icon as confirmation; needs a toast with Undo
  to stay forgiving (undo right after a route change is
  otherwise awkward).
  If we do this, the change is small: `navigate(-1)` (or
  `navigate('/')` if there's no history) in the markDone branch
  of the click handler, plus a `showToast('Marked done', { action:
  { label: 'Undo', onClick: () => unmarkDone(id) } })` via the
  existing `ToastProvider`. Skip on unmark-done (you're already
  on the story so there's nowhere meaningful to navigate).

## Retention policy

- **Reconsider TTL for Pinned / Done / tombstones.** Pinned, Done,
  and their tombstones are all currently permanent, mirroring
  Favorite. Only Favorite is *clearly* intended to be forever (it's
  a deliberate keepsake, and for authenticated users it's synced
  with HN). Pinned is an active reading list — stale entries from
  years ago probably aren't what the user wants. Done is a
  completion log — useful recent history, probably not useful at
  infinite age. Tombstones only need to live long enough for
  every device the user owns to pull them once.
  Worth revisiting:
  (a) Pinned entries: cap by age (e.g. 90 d or 180 d) or by count
      (e.g. 500), whichever bites first? Today the server-side 10k
      cap in `api/sync.ts` is the only bound.
  (b) Done entries: 30–180 d TTL would keep the Done page
      manageable for long-lived power users without ever silently
      losing a recent completion. Whatever we pick, the Done page
      UX should make the policy visible (e.g. footer "Showing
      completions from the last 180 days").
  (c) Tombstones across all three synced lists: a 90-day TTL on
      the tombstone itself would stop dead entries from consuming
      storage indefinitely. Safe as long as we're confident no
      user's device stays offline longer than that window.
  Not urgent — at realistic usage, none of these lists get large
  enough to matter for storage or performance. Revisit when we
  have real user data showing list sizes.

## Sync

- **Opened/read sync (maybe; notes only).** Cross-device sync v1
  covers Pinned / Favorite / Hidden. Opened (`newshacker:openedStoryIds`)
  may never ship — it grows fast, the semantics are "noisy recent
  history" not "curated intent", and the utility of syncing it is
  unclear. Not a committed TODO; a decision point. If we ever do
  decide to tackle it, notes for a future self: cap the list at the
  most recent ~5 k ids per user, and probably use whole-blob
  last-write-wins per device rather than per-id tombstones — losing
  an opened mark in a conflict is cheap, and per-id bookkeeping
  isn't worth the storage cost for a list this size. Revisit only
  if real demand appears after 5c has been live long enough to show
  how much cross-device frustration the curated three already
  solves.

## Sweep edge cases

- **Row taller than the visible viewport.** Sweep currently hides
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
