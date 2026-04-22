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

- **Max-story-age should use HN `story.time`, not `firstSeenAt`.**
  Today the cron's `shouldSkipByBackoff` ages out a story when
  `now - record.firstSeenAt > WARM_MAX_STORY_AGE_SECONDS`. That's
  the age *since we first warmed the story*, not the age since HN
  received the submission. For steady-state top-30 stories the two
  are within minutes, so the current behavior is mostly fine. The
  edge case: a story that entered the warmed slice late (cron was
  offline, or it bubbled up into top-30 after 10 h on `/new`) will
  get re-checked for 48 h from `firstSeenAt`, which could be 58 h
  from HN's perspective. Fix: when `story.time` is present, prefer
  `now - story.time*1000 > maxAge`. Falls back to `firstSeenAt`
  when the HN item is unreachable. Would require either storing
  `time` in the cache record or passing the fresh `story` into
  `shouldSkipByBackoff` (the orchestrator already has it). Small
  efficiency win, not a correctness bug; punt until analytics show
  it matters.

- **Warm-summaries analytics surface.** Today the `warm-story` /
  `warm-run` JSON lines ride in Vercel function logs. That's enough
  for a weeks-long "eyeball the scatterplot" pass — grep + jq + a
  Python script. Three upgrades, ordered cheapest-first, to consider
  only if the logs turn out to be genuinely useful (not if the answer
  is "knobs are fine, stop looking"):
  (a) **Log sink.** Vercel keeps function logs ~1 day. Shipping to
      Axiom / Logtail / BetterStack (all have generous free tiers for
      our volume) gets weeks-to-months of retention. ~1 h setup.
  (b) **Aggregation endpoint.** `/api/warm-summaries-stats` that
      reads rollups (counts per outcome, per age-bucket, per track,
      per hour/day) from a pre-aggregated Upstash sorted-set. Needs
      a second hourly cron that scans the last hour's `warm-story`
      lines and increments the counters. ~2 h.
  (c) **Visual dashboard.** Anything from a static HTML page
      rendering (b)'s JSON as charts to a Grafana board pointed at
      (a). Only worth it if we're iterating on the knobs regularly.
      1–4 h depending on polish.
  Don't pre-build these — the MVP logs answer "is there a real
  signal here" in a week of data. Invest based on the answer.

- **Article-fetch fallback.** We used to have a server-side raw-HTML
  fallback (plain `GET` with a spoofed desktop Chrome UA) that kicked
  in when Jina Reader failed or wasn't configured. It was removed
  because (a) the UA spoof is poor hygiene — it blends in with real
  browsers specifically to get past anti-bot heuristics, which is
  exactly what those heuristics are there to prevent, and (b) the
  practical hit rate was tiny (Jina handles nearly every site we
  care about; when Jina fails it's usually a site that needs JS
  rendering or is paywalled — a plain GET from a Vercel IP won't
  succeed there anyway). Jina is now a hard dependency for
  `/api/summary` and the cron. If we ever want the fallback back,
  do it with two safety rails: (1) a curated domain allowlist
  (GitHub, arXiv, Wikipedia, plain-text blogs — sites that clearly
  welcome a plain `GET`) rather than an open any-URL fetch, and
  (2) an identifiable User-Agent like
  `newshacker-warmer/1.0 (+https://newshacker.app/about-bot)` so
  publishers can block us via `robots.txt` or UA allowlist if they
  want. Stealthy bots > nothing, but honest bots > stealthy bots.

- **Jina retry strategy.** Today a single Jina failure (5xx, timeout,
  rate-limit) returns `source_unreachable` / `source_timeout` on the
  user-facing path immediately, and logs `skipped_unreachable` on the
  cron. The cron effectively retries on the next tick (every 5 min),
  so transient Jina blips self-heal within ~5 min for warmed stories.
  For user-facing requests there's no retry — the card renders an
  error state. If that proves user-visible in practice, options are
  (a) in-handler exponential backoff on Jina 5xx (2–3 attempts with
  jitter, capped at maybe 3 s total — Jina itself already retries
  internally, so layering more is mostly belt-and-braces), or
  (b) have the client retry after a short delay on first failure.
  Not urgent.

- **Multi-region / multi-instance replication story.** Today everything
  runs in `us-east-1` (Vercel functions + Upstash primary). If we scale
  out to multiple function regions or multiple concurrent cron
  instances, two concerns: (1) last-write-wins on the Upstash record
  can cause two regenerations to race for the same story ("write 1
  generates summary A, write 2 generates summary B, both overwrite the
  other's `lastChangedAt`" — harmless but wasteful); (2) the tiered
  backoff assumes a single lock-step sequence of `lastCheckedAt`
  timestamps, which multi-region writes can reorder. Mitigations to
  consider when that happens: a per-story Redis SETNX lock with a
  short TTL before processing, or pin the cron to a single region via
  `vercel.json` `crons[i].region`. No action needed while we're
  single-region.

- **Cron jitter.** `*/5 * * * *` fires on the nose of the wall clock
  — hh:00, hh:05, hh:10, etc. At current volume publishers won't
  notice, but if we scale up (more stories, more cadence, more feeds)
  the burst pattern makes us a trivially-identifiable bot. Cheap fix:
  `setTimeout(randomInt(0, 60_000))` at the top of the handler so
  per-tick work spreads over the first minute. Track whether any
  publisher's logs flag us before bothering — no data yet that this
  matters.

- **Pre-fetch short-circuits for the warm cron.** The MVP warms via a
  "fetch → hash → compare" loop every time the tiered backoff says a
  re-check is due. We pay the bandwidth + the SHA hash even when
  nothing changed. Two follow-ups worth trying once analytics reveal
  the steady-state churn rate:
  (a) **Article track: conditional HTTP.** On the raw-HTML fallback
      path, save the origin's `ETag` / `Last-Modified` into the
      `SummaryRecord` next to `articleHash`. On the next re-check,
      send `If-None-Match` / `If-Modified-Since`; a 304 lets us
      bump `lastCheckedAt` and skip the hash + Gemini entirely. Does
      **not** help the Jina Reader path — Jina re-renders, so upstream
      validators don't pass through. Savings scale with how often we
      fall back to raw fetch, which is the minority path.
  (b) **Comments track: kid-id pre-check.** Before fetching 20 child
      items and building the transcript, compare `story.kids.slice(0, 20)`
      and `story.descendants` to values recorded last tick. If
      identical, the transcript can't have changed (HN ranks kids by
      score, so a reshuffle would change the slice) — skip straight
      to "unchanged" without the 20 child fetches. HN item JSON doesn't
      set ETag / Last-Modified, so HTTP-level conditionals don't
      apply here.
  Neither is urgent. Ship the MVP, let the `warm-story` logs tell
  us how many ticks per day hit the "unchanged" outcome, and cost
  these against the estimated Jina + Firebase spend before investing.

- **Tune the scheduled-warmer knobs once analytics are in.** The
  cron at `/api/warm-summaries` logs a `warm-story` line per id and
  a `warm-run` line per tick (see `SPEC.md` § "Scheduled warming
  and change analytics"). After a week or two of real traffic, grep
  the `warm-story` lines out of Vercel logs, filter to `outcome
  ∈ {unchanged, changed}`, and look at `stableForMinutes` vs
  `summaryChanged`. If articles reliably settle within 3–4 h, push
  `WARM_STABLE_CHECK_INTERVAL_SECONDS` up (e.g. 2 h → 4 h) or pull
  `WARM_STABLE_THRESHOLD_SECONDS` down. If stories past 24 h almost
  never change, pull `WARM_MAX_STORY_AGE_SECONDS` from 48 h down
  to 24 h. Both tweaks are env-var-only, no code change.

- **Consider alternate slices for the warmer.** Today the cron hits
  `topstories` first-30. Worth revisiting once the analytics are
  in: should `/new` or `/best` also be warmed? `/new` in particular
  is cold-cache-heavy (readers arriving at a freshly-submitted story
  currently pay a full Gemini generation), but most `/new` stories
  die at low score before anyone reads them — warming them would be
  waste. Possible shape: "top-30 ∪ best-10 ∪ new-stories-with-
  score>5" to catch rising stories before they're hot without
  paying for the whole firehose. Needs a cost pass before doing
  anything.

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

- **Consider a Done-undo toast.** Mark-done now pops back to the
  feed (see *Thread action bar* in `SPEC.md`), which means if a user
  taps Done by accident they've both hidden the row from every feed
  *and* left the thread. Browser back recovers it — they land back
  on the thread with the Done button filled, and tapping it unmarks.
  Adding `showToast('Marked done', { action: { label: 'Undo',
  onClick: () => unmarkDone(id) } })` via the existing `ToastProvider`
  would be a more discoverable recovery path. Held off until we see
  whether accidental mark-done is a real problem; SPEC currently
  calls out that button state is the single source of truth, and
  adding a toast cuts against that.

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

## Thread comment filtering

- **"New / all" comment filter on the thread page.** With each opened
  story we now persist `commentsAt` (when the thread was last opened)
  and `seenCommentCount` (the `descendants` at that moment). A toggle
  on the thread header could filter to comments with `time >
  commentsAt`, matching the "N new" badge the row already shows. The
  state is already in `openedStories`; this is purely a UI add. Stays
  out of the current change to keep the list-surface feature
  self-contained. Eventually we might also promote the hand-curated
  compound-eTLD list in `src/lib/format.ts` to the full Public Suffix
  List if the coverage matters; the length cap is the backstop until
  then.

## Desktop layout

- **Comment expand/collapse button — iterate on position and icon.**
  The first desktop pass shipped a Material `add` / `remove` (+/−)
  icon immediately after the meta ("alice · 4m · 12 replies [+]"),
  visible on every device. Known alternatives we want to try before
  committing:
  - Position: to the **left** of the card / meta (before the author
    link, in its own narrow gutter) so the expand control reads as
    a row-level control rather than a trailing meta decoration. The
    gutter can stay narrow (~20 px) if the tap target extends into
    the card via invisible padding so the visible icon is small but
    the hit area is still 48×48.
  - Icon: Material `expand_circle_down` / `expand_circle_up` — a
    semantic circled chevron that reads as "expand this" at a
    glance instead of a symbolic +/−. Heavier visual weight than
    +/− when sitting inline with meta text, so this one likely
    pairs with a left-gutter position rather than the current
    end-of-meta position. Plain `expand_more` / `expand_less`
    chevrons are *out* — too easily confused with directional
    "next" controls. So are `add_circle`, `add_box`, and the
    other non-directional decorators — those compete with the
    meta text for attention without adding semantic value.
  - Gating: whether the icon should be visible everywhere (current)
    or only on `(hover: hover)` pointer devices, where tap-anywhere
    discoverability matters less on mobile.
  Come back once we have actual usage data from the first pass.

- **Wider reading column on desktop — shipped (first pass).**
  `.app-main` bumps from 720→860 at `min-width: 960px` (feed and
  thread alike). Pure CSS in `global.css`; no JS, no API calls, no
  new infra. The collapsed-comment clamp stayed at 3 lines
  intentionally — the wider column already fits more characters
  per line, so the same clamp surfaces meaningfully more text on
  desktop without a second variable to tune. Next iterations to
  consider only if real usage nudges us: scale continuously with
  `clamp()` rather than a hard breakpoint, widen the thread more
  than the feed (would require per-page width plumbing that we
  avoided for now), or relax the comment clamp further (3→5+) at
  very wide viewports.

- **Separate action toolbar above the story (moved out of the top
  bar).** The sticky orange top bar is currently doing double duty
  on feed pages (brand + feed-scoped actions: refresh, undo,
  sweep, account). On desktop at least, consider lifting the
  feed-scoped actions into their own sub-toolbar that sits below
  the brand header and above the first story, so the top bar
  becomes pure chrome (brand + nav) and the action row becomes a
  more conventional secondary toolbar. Unclear whether that
  generalizes to mobile — the sticky-orange-bar look is part of
  the brand, and a two-tier header eats vertical space on a phone.
  Needs a design pass.

- **Bottom-sheet fallback still carries the sheet CSS and Cancel
  button — worth a cleanup pass once the popover has stuck on
  touch.** We flipped `StoryRowMenu` so the anchored popover is
  the default on both pointer and touch devices whenever an
  anchor is supplied, matching Android's PopupMenu convention.
  The bottom-sheet variant remains as the no-anchor fallback
  (darkened backdrop + Cancel button); in practice every real
  trigger supplies an anchor, so the sheet path is currently
  only exercised by tests. If a few weeks of Pixel/iPhone usage
  don't surface a reason to bring the sheet back for any trigger,
  the sheet markup, CSS, and `--sheet` class branch can all go —
  `StoryRowMenu` collapses to a single anchored-popover component
  and the `role="dialog"`/`aria-modal` branch disappears with it.

- **Desktop-specific layout ideas parked for later.** The
  following were suggested in the same pass but intentionally
  deferred pending UX discussion:
  - Visible ⋮ button on story rows (item #2) — where it appears,
    and whether it displaces the reserved middle slot. Right-click
    to open is already wired.
  - Keyboard shortcuts (item #7): `j`/`k` nav, `o` open, `p` pin,
    `.` open menu, `g t`/`g n`/`g b` feed switch, `?` help.
  - Persistent left-rail navigation at wide widths (item #5).
    Current off-canvas drawer is deliberately minimal; a sidebar
    needs its own look.
  - Two-column thread layout at wide widths (item #9).
  - Hover-only comment collapse controls vs tap-anywhere-to-toggle
    (item #10 shipped the chevron affordance; deeper behavior
    split is follow-up work).

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
