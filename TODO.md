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
- **Revisit PTR-triggered auto-reload if we ever add commenting or
  posting.** Today PTR calls `checkForServiceWorkerUpdate()` which
  does `window.location.reload()` the moment a newly-installed SW
  claims the tab. That's safe right now because the app is a pure
  reader with no in-progress state to lose on reload (same
  rationale SPEC uses for `autoUpdate` silent activation). Once we
  have a compose box or an in-flight vote/comment POST, a reload
  mid-PTR could drop unsent user input — swap in an update-available
  toast, defer the reload until after the POST resolves, or gate
  the reload on "no draft in flight".
- **iOS status-bar style on installed PWA.** `index.html` still sets
  `apple-mobile-web-app-status-bar-style=black-translucent`, which
  forces *white* status-bar text over whatever paints under it. Over
  the current cream `--nh-bg` header that's white-on-cream — fine in
  a browser tab (where the meta isn't consulted), but unreadable
  when the app is added to the iOS home screen and launched as a
  PWA. iOS can't swap this per color scheme, so the options are:
  (a) switch to `default` — black text, readable on a cream light
  header but unreadable over a dark header,
  (b) switch to `black` — fixed solid black strip above the page,
  always legible but a visible letterbox,
  (c) leave a fixed brand-colored safe-area strip (e.g. the orange
  disc color) under the status bar so the bar always sits over a
  known color regardless of theme.
  Only matters for iOS-installed PWAs; defer until someone actually
  uses the app that way.
- **Swap HN orange (`#ff6600`) to a non-HN hex if we want a distinct
  brand.** Today `--nh-orange` is HN's exact orange, used for the
  logo disc, focus rings, and accents. Replacing it is a one-token
  swap (plus a favicon re-rasterize and a manifest `theme_color`
  update to match) — easy to land independently once a preferred
  hex is chosen. Candidates surveyed in chat: Tailwind orange-500
  (`#f97316`), orange-600 (`#ea580c`), orange-700 / "Burnt"
  (`#c2410c`).

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

## Reading mode

Research note, not scoped work yet. Option space for letting a
reader consume the article itself from newshacker — either rendered
in-app or handed off to an external reading service — with rough
coverage, TOS posture, and failure-mode analysis per approach so
the final call can be made against the same yardstick. Cross-refs:
*Thread overflow menu* above (where the link-out entries would
live) and *Article-fetch fallback* + *Paywalled-article summary
fallbacks* below (which share the extraction pipeline a hosted
reader mode would extend).

### Link-out ("send to someone else's reader")

User stays on newshacker, we emit an outbound URL or a share-target
payload; the reader lands in another product that handles
extraction and rendering. Zero content-distribution liability for
us — the redistribution question belongs to whoever runs the
destination service.

- **Web Share API (already shipped).** Every iOS / Android reading
  app registers as a share target, so users who already own
  Instapaper / Readwise Reader / Raindrop / successor apps can
  route there today via the `⋮ → Share article` path. Cost: zero;
  reliability: best of the options — we're not on the hot path.
  Missing piece is *discoverability* — most users don't think of
  the share sheet as "add to reading list". A `Read later` entry
  in the overflow menu that just calls `navigator.share({ url })`
  with nothing else changed would fix the framing at zero
  engineering cost. Desktop browsers without Web Share fall back
  to the clipboard copy we already do.
- **Dedicated "Send to Instapaper".** The bookmarklet URL
  `https://www.instapaper.com/hello2?url=<enc>&title=<enc>` still
  works; unauthenticated users get bounced through login, then land
  on a confirmation page. A same-tap `window.open(..., '_blank')`
  avoids iOS's popup blocker. Coverage: Instapaper's extractor is
  Readability-class plus per-site rules — ~90% of HN link posts
  parse clean; SPAs / JS-only sites (Bloomberg, some Substacks, a
  chunk of Ghost themes) degrade to a link-only save. TOS: we're
  a link emitter, zero exposure for us. Failure modes: Instapaper
  outages (a few hours a year), account required, iOS PWA pops
  the destination out of `standalone`. Cost: zero — no API key,
  no server involvement.
- **Dedicated "Send to Readwise Reader".** `https://read.readwise
  .io/save?url=<enc>` is the equivalent deep link. Coverage is a
  notch better than Instapaper (they render JS server-side for
  extraction) — ~95% of link posts. Same TOS posture (link
  emitter). Paid-only service, but the subscriber base overlaps
  heavily with HN readers, so an entry earns its shelf space.
  Cost: zero to us.
- **Dedicated "Send to Raindrop".** `https://raindrop.io/collection
  /0?url=<enc>` — smaller audience and closer to a bookmark
  manager than a long-form reader, but zero cost to add. Only
  worth wiring if a user asks.
- **Pocket — skip.** Mozilla announced the Pocket shutdown in May
  2025; the service wound down mid-2025. Don't wire a save path
  to a dying product.
- **archive.ph / archive.org open-in.** `https://archive.ph/newest
  /<enc>` and `https://web.archive.org/web/<url>` render
  cleaned / snapshot copies, and HN commenters paste these into
  paywalled threads already. TOS: archive.ph is openly
  adversarial to publishers — promoting it as a general *reading
  mode* is closer to endorsing paywall circumvention than we
  probably want, and it's distinct from an escape hatch that only
  appears when the content is genuinely unreachable. Keep this
  paywall-specific if we ship it (matches the shape of
  *Paywalled-article summary fallbacks (a) archive links posted
  in comments* below), not a general reader entry.
- **"Use your browser's Reader View" hint.** Zero code, zero cost
  — a one-time tooltip pointing at Safari Reader (long-press the
  URL bar → Reader) or Firefox Reader View (`Ctrl+Alt+R`) for
  readers who don't know the native feature exists. We can't
  programmatically trigger Safari Reader from a web app, so a hint
  is as close as it gets. Coverage: Safari Reader fires on ~75%
  of "article"-shaped pages; Firefox Reader View wraps Mozilla's
  Readability (same ~85–90%). Zero TOS exposure — the browser
  does the rendering locally on the user's device.

### Hosted ("render the article body inside newshacker")

User stays and the article itself renders on `newshacker.app`.
Materially different legal posture from link-out: we become the
distributor of a cleaned copy of someone else's content, possibly
ad-stripped, on our origin. DMCAs land in our (and Vercel's)
inbox, not a third party's.

- **Extend the `/api/summary` extractor into a reader view.** We
  already fetch the article through Jina Reader to build the AI
  summary, and the planned self-hosted path under
  *Article-fetch fallback* in this file runs `@mozilla/readability`
  on the raw HTML. Feeding *the same extracted body* into a new
  `/item/:id/read` route costs one additional render — the
  expensive work is already done. Coverage: Readability on
  well-formed news/blog ≈ 85% of HN link posts; Jina (which runs
  JS) ≈ 95%. SPA shells, PDFs, arXiv PDFs, login-walls, geo-walls
  all fail. TOS: we are redistributing extracted article bodies
  on our origin without the publisher's explicit permission. The
  safer analogues are Safari Reader and Firefox Reader View
  (both run client-side, on the user's device — no
  redistribution). The riskier analogues are the server-side
  readers (Readability.com, old Mercury web reader, Outline.com)
  that drew publisher C&Ds and in Outline's case shuttered. Our
  posture would need to be closer to "Safari Reader shape, happens
  to live on our server": honor `robots.txt` and
  `noarchive` / `noindex`, surface a prominent `canonical` link
  back to the source, frame ad/tracker stripping as reader-
  selected rather than default, cap any cached body to a short
  TTL, and publish a takedown contact on `/about`. Even with all
  of that, the exposure is real — a niche reader probably flies
  under the radar, but it's not a zero-risk feature. Failure
  modes: paywalls (NYT's JSON-LD leaks the body so Readability
  walks right through; WSJ, FT, Economist, WaPo don't); Substack
  (full-post-in-email vs. web shell); sites that rate-limit
  datacenter IPs; publishers A/B-testing their DOM and breaking
  our selectors. Cost (rule 11): extraction is already budgeted
  for summaries; storage for cached bodies is ~10× summary size,
  so a 30-day TTL on 200 warmed stories is a few MB of Redis —
  negligible. Reliability impact: adds "newshacker is down" as a
  failure mode for reading articles the user *could* have read at
  the source, which is a regression vs. today's
  `window.open(originalUrl)` button.
- **Client-side Readability via our CORS proxy.** Ship
  `@mozilla/readability` in the bundle (~40 KB gzipped), fetch
  the HTML through a new `/api/fetch?url=…` proxy, extract in the
  browser, render locally. Saves server CPU but does *not* reduce
  TOS exposure — we're still the fetcher on the network path,
  which is what publishers object to. Marginal win; not worth a
  separate build.
- **Jina Reader as a client-side pass-through.** `https://r.jina
  .ai/<url>` returns clean markdown; render it in a reader view
  with no server of our own in the loop. Functionally the same as
  the summary extractor reuse from the user's angle, but the TOS
  exposure shifts to Jina (who so far shrug it off) and our
  reading-mode uptime becomes tied to Jina's uptime. Their free
  tier rate-limits at a level that's fine for a single tab but
  miserable for a trending-HN spike; a keyed tier is low single-
  digit dollars / month at current scale (rule 11). Already a hard
  dependency for summaries, so coupling reading mode to it too
  concentrates blast radius rather than spreading it.

### Coverage rough cut

Eyeballed, not measured — validate with an instrumented dry-run
over ~100 recent top-feed URLs before committing. Ranges, not
point values, because results depend heavily on which slice of HN
ends up on the front page on a given day.

- **Plain news / blog posts** (most of HN's front page most days):
  Instapaper ~90%, Readwise Reader ~95%, Safari Reader ~85%,
  self-hosted Readability ~85%, Jina Reader ~95%.
- **SPA / JS-only sites** (Bloomberg, some Substacks, some Ghost,
  modern news apps): Instapaper ~50%, Readwise Reader ~80%, Safari
  Reader ~40%, self-hosted Readability ~20%, Jina Reader ~90%.
- **Paywalled articles**: every approach degrades to a teaser
  unless JSON-LD `articleBody` leaks the full text (NYT yes; WSJ,
  FT, Economist, WaPo no). Archive hand-off is the only path that
  routinely gets the body, with its own TOS caveats.
- **PDFs and arXiv PDFs**: Readwise Reader has a native PDF
  viewer; Instapaper stores but doesn't render; Readability and
  Jina handle only the HTML versions; Safari Reader n/a. Best
  path: just open the PDF in the browser, no reader-mode layer.
- **GitHub READMEs, docs sites, gists**: already readable at the
  source; a reader-mode layer is redundant and sometimes worse
  (loses syntax highlighting, renders code in a prose font).
  Either exclude these hosts from the reader path or auto-bypass.

### Recommendation when this gets picked up

1. Start with link-out. `Send to Instapaper` + `Send to Readwise
   Reader` as named entries under the thread `⋮` menu, next to
   `Share article`, `Open on Hacker News`, and the planned
   `Share on newshacker` (the `on <platform>` naming convention
   still applies). Zero TOS exposure, days of work, covers the
   cohort that already uses a reading app. Skip Pocket (dead),
   hold Raindrop until a user asks.
2. Add a one-time onboarding hint pointing at Safari Reader /
   Firefox Reader View for users without a reading-app
   subscription — zero code beyond the hint itself.
3. Only then revisit hosted reader mode, and only after deciding
   on the publisher-opt-out story up front (robots.txt honored,
   `noarchive`/`noindex` honored, visible `canonical` link, short
   cache TTL, takedown contact on `/about`). Without that story
   in place the TOS exposure isn't worth the feature.

## Backend / infrastructure

- **Separate Redis instance for preview deploys.** Today the
  Storage Marketplace integration auto-injects the same
  `KV_REST_API_*` credentials into both production and preview
  environments, so prod and preview share one Upstash database.
  All current namespacing is per-key (`newshacker:summary:...`,
  `newshacker:sync:<username>`, `telemetry:user:<username>` /
  `telemetry:preview:anon` — the last is the only one that
  *needs* the env distinction at the key level). It works, but
  carries the operational rough edges of any shared store: one
  set of quotas, one set of metrics, no clean blast-radius
  separation if a buggy preview deploy hammers writes. The
  upgrade path: provision a second Upstash project, wire its
  `UPSTASH_REDIS_REST_*` as preview-only env vars in Vercel
  (overriding the Marketplace pair the way other env-specific
  overrides work), and let the per-handler `getRedis()` helpers
  pick up the right pair automatically. Free tier covers two
  projects; cost is mainly the second dashboard to keep an eye
  on. Revisit when (a) preview write volume starts showing up in
  the prod Upstash usage graph, or (b) a preview deploy
  accidentally writes garbage to a prod-shared key (e.g. a
  refactor mis-namespaces a key) — the second Redis would have
  caught the bug at deploy time instead of in the operator
  dashboard.

- **Threshold tuning telemetry follow-ups** (see SPEC.md
  *Threshold tuning telemetry*). The MVP that just landed is
  enough to start eyeballing the score-vs-age cluster; the
  follow-ups worth weighing once a few weeks of data are in:
  (a) **Library-view hide events.** Hides on `/opened` (and
      maybe `/done`) carry a "I read this and it wasn't worth
      my time" signal that complements the feed-row "I rejected
      this from a glance" signal — wire `recordFirstAction` into
      the library hide path if the feed-only data turns out too
      thin to suggest a confident threshold.
  (b) **Cross-device first-per-story dedup.** Today the
      "first" Set lives in localStorage per device, so first-
      pinning the same story on phone *and* laptop logs two
      events. A server-side `SADD telemetry:seen:<username>` +
      conditional write would dedup — at the cost of a second
      Redis op per emission. Worth doing only if the noise
      shows up in the cluster.
  (c) **Auto-recommended threshold values.** The current
      `/admin` view prints P25 / median / P75 and lets the
      operator decide. A natural next step is to print suggested
      `HOT_MIN_SCORE_*` and `HOT_RECENT_WINDOW_HOURS` values
      directly — e.g. "P25 of pin scores → suggested
      `HOT_MIN_SCORE_ANY_AGE = X`". Hold off on auto-suggestion
      until the human-readable stats have been useful enough
      times to know what shape of suggestion is actually
      wanted.
  (d) **Per-event TTL on `telemetry:preview:anon`.** Right now
      the only cap on the anon bucket is the 10 000-entry hard
      ceiling — old anon events linger forever, which clutters
      the scatter when you come back after a long gap. A simple
      "drop events older than 30 days" pass on read (or a
      one-shot Redis maintenance script) keeps the dataset
      relevant.
  (e) **Render the `/tuning` event list with the same feed-row
      style as `/hot`.** Today the list is a tabular drill-down
      (collapsed by default). Switching to `<StoryListItem>`-shaped
      rows — same title typography, same metadata line, same
      visited-link coloring — would make "if I tighten this slider,
      here's what `/hot` would look like" much more visually
      concrete. The "would be hot under current rule" cue could
      attach as a small leading badge or row outline. If it's
      cheap (~200 events × richer-than-tabular DOM is still a
      handful of ms), default the details panel to expanded — the
      whole point of the page is the list. Open question: capture
      `url` and `by` at event time so the row renders fully (small
      payload bump, schema migration the same shape as
      `descendants` / `type`), vs. render a stripped-down feed-row
      that uses only the fields already in the event. Probably the
      former — the visual goal is "this *is* what /hot would
      render".
  (f) **Auto-expand the `/tuning` Preview when the visible set is
      sparse.** The Preview shows the first `useHotFeedItems`
      page (up to 60 candidates from `/top ∪ /new`) and then
      relies on a "More" button at the bottom to load further
      pages. With a tight rule (e.g. `score >= 500`) and few
      pinned/done widening rows, page 0 can produce zero or one
      visible row, leaving the operator scrolling through the
      static analytics to find a button before the rule output
      starts being meaningful. Cheapest fix: auto-fetch the next
      page in an effect when `visibleStories.length < N` and
      `hasMore`, capped at some page count (e.g. 4) so a sparse
      rule can't accidentally walk the whole feed. Alternative:
      surface a sticky "expand candidates" button inline with the
      Preview heading, so the operator can opt in without leaving
      the section. Worth measuring the typical Preview density
      first — if 0-row pages are rare in practice, file under
      "won't fix".

- **Embed a build hash in HTML for a tighter `AppUpdateWatcher`
  suppression.** The current heuristic (only suppress the toast when
  the `newshacker:sw:installed` localStorage flag is unset) handles
  the common stale-bundle paths — hard reload, Chrome session
  restore, iOS PWA relaunch — but still has a narrow race: a tab
  opened *during* a deploy on a brand-new device can fetch the old
  `index.html` + old bundle from the network, then have the new SW
  install + claim in a single controllerchange that we'd suppress
  as "the initial install" (because the flag is also unset on a
  truly fresh device). User runs the stale bundle until the next
  reload with no toast. Fix shape: emit the toast unconditionally
  when the newly-claimed SW disagrees with a build-hash embedded in
  the HTML (e.g. `<meta name="commit" content="<sha>">`) and have
  the SW broadcast the same hash. vite-plugin-pwa doesn't expose a
  clean way to embed a single hash in the SW today (precache-manifest
  revisions are per-asset), so the fix needs either a custom SW shim
  via `injectManifest` or a postbuild rewrite. Surfaces rarely enough
  on a single-deploy-window race that the localStorage flag covers
  the realistic stranded-tab cases.

- **Consider asking Gemini to return markdown explicitly.** Today
  `api/summary.ts` doesn't mention markdown in the prompt and
  `api/comments-summary.ts` tells the model *not* to emit it — yet
  inline markdown (backticks, `**bold**`) still leaks through into the
  article summary, which we now render client-side via a hand-rolled
  inline converter (`<code>`, `<strong>`). If we ever want
  block-level structure in summaries (short lists, paragraph breaks,
  linked references), the move is to flip both prompts to "return
  markdown" and upgrade the converter (or a sanitizer) to handle a
  wider subset. Decide up front which tags are worth the risk surface
  — `<a>` means handling model-supplied URLs, which is a different
  trust story than the current two-tag inline allowlist. Not urgent;
  revisit the first time a product reason for block-level structure
  comes up (e.g. a "key facts" comments-summary variant).

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

- **Warm-summaries analytics surface.** The `warm-story` /
  `warm-run` JSON lines ride in Vercel function logs and are being
  forwarded to **Axiom** via the Vercel integration (done; the APL
  query templates in CRON.md § "Useful APL queries" are scoped to
  `newshacker` via the `['vercel.projectName']` filter — the
  integration itself ships all projects the Vercel team has access
  to). That covers retention and ad-hoc querying. Two further
  upgrades, to consider only if the logs turn out to be genuinely
  useful (not if the answer is "knobs are fine, stop looking"):
  (a) **Aggregation endpoint.** `/api/warm-summaries-stats` that
      reads rollups (counts per outcome, per age-bucket, per track,
      per hour/day) from a pre-aggregated Upstash sorted-set. Needs
      a second hourly cron that scans the last hour's `warm-story`
      lines and increments the counters. ~2 h. Lower-effort
      alternative: save the CRON.md APL queries as Axiom starred
      queries and skip the endpoint entirely.
  (b) **Visual dashboard.** Either an Axiom dashboard (point-and-
      click on the APL queries in CRON.md — probably 20 min) or
      something custom rendered from (a). Only worth it if we're
      iterating on the knobs regularly.
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

- **Paywalled-article summary fallbacks.** When Jina returns a
  paywall signature (very short body, known overlay markers, JSON-LD
  `isAccessibleForFree: false`, etc.), today we silently hand the
  user a summary built from the teaser. Options, roughly in order of
  upside-per-effort:
  (a) **Archive links posted in comments.** HN readers routinely
      paste `archive.org` / `web.archive.org` / `archive.ph` /
      `archive.today` / `archive.is` / `ghostarchive.org` URLs into
      the top-level comments on paywalled submissions — we'd just be
      automating what a reader does manually. We already pull the
      thread's comments for `/api/comments-summary`, so the
      incremental work is a regex scan over text we have in hand.
      Allowlist the archive hosts explicitly; don't follow arbitrary
      comment URLs (spam / malicious / off-topic). On a hit, re-run
      Jina against the archive URL and cache under the *original*
      article's key so we don't re-scan on every request. Label in
      the UI: "Summary based on archive copy linked by HN user
      `<username>`." Reliability: archive.ph's Cloudflare challenge
      blocks a lot of cloud IPs, so ~20–30% of archive.ph fetches
      will still fail; archive.org is more permissive. Cost: one
      extra Jina call per paywalled thread on cache miss, same
      rate-limit bucket as the article summary, free-tier Jina
      covers it at current traffic.
  (b) **JSON-LD `NewsArticle` schema.** Many publishers embed the
      full `articleBody` in a `<script type="application/ld+json">`
      block so Google's structured-data crawler can read the piece
      even when the rendered HTML is paywalled. It's public content
      intended for crawlers — no ToS grey area. Coverage is spotty
      and shrinking, but it's free when present. Shape: a cheap
      pre-Jina pass that does a raw `GET`, looks for `@type:
      NewsArticle` / `Article` in ld+json blocks, and uses the
      `articleBody` field if the string is long enough to be real
      (>~1 KB, not a teaser). Same safety rails as the removed
      raw-HTML fallback: curated allowlist + identifiable
      `newshacker-*` User-Agent.
  (c) **RSS / Atom full-text feeds.** Some blogs and smaller outlets
      still publish the full article in their feed (RSS
      `<content:encoded>`, Atom `<content type="html">`). Discovery:
      parse `<link rel="alternate" type="application/rss+xml">` off
      the article page, fetch the feed, locate the matching `<item>`
      by `<link>` URL. Minimal value on big-name paywalls (they
      stripped full-text years ago) but genuinely free when it
      works, and useful for the long tail of indie blogs.
  (d) **Labeled comments-only summary.** When (a)–(c) all fail, fall
      through to `/api/comments-summary` surfaced with a clear
      "based on the discussion, not the article" header so the user
      knows what they're reading. The fallback call is already
      wired; the honest label is the work.
  Explicit non-goals:
  (i) **Spoofing Googlebot / Bingbot.** Search engines get full
      text via IP-verified contractual access ("Flexible Sampling",
      publisher-side), not via the User-Agent string. Spoofing is
      ToS-hostile and fails on any site with reverse-DNS checks
      (all the big paywalls).
  (ii) **Paid bypass services** (12ft, Diffbot, Scrapfly, etc.) —
       real money, real ToS exposure, and they don't cover the hard
       ones anyway.
  Suggested phasing: detection + (d)-with-label first (smallest
  change, ends the "teaser masquerading as summary" problem on day
  one), then (a) as the first real recovery path, then (b) and (c)
  opportunistically if the paywall-detection signal shows them
  worth the effort.

- **Self-hosted fetch + content extraction.** Longer-term
  alternative, or first-pass complement, to Jina Reader: bring the
  fetch and extraction in-house for the sites where it's honest and
  safe. Motivations: Jina is a hard dependency today (see
  "Article-fetch fallback" above), its free tier is not promised
  forever, and for plain-HTML sites we pay latency going
  client → Vercel → Jina → origin → Jina → Vercel when we could go
  direct. Shape has three layers.

  **1. Fetcher.** Server-side `fetch` from the Vercel function with:
  (i) curated domain allowlist (GitHub, arXiv, Wikipedia, plain-text
  blogs — the "clearly welcome a plain GET" set called out in the
  Article-fetch fallback bullet), default-deny for unknown hosts so
  we're not sneak-scraping;
  (ii) identifiable User-Agent like
  `newshacker-summarizer/1.0 (+https://newshacker.app/about-bot)`,
  so publishers can block us via `robots.txt` or UA allowlist;
  (iii) `robots.txt` respect — cache per-host in Upstash with a
  short TTL, fail-closed on disallowed paths;
  (iv) hard timeouts (e.g. 5 s connect, 10 s body), redirect-depth
  cap, and a response-size cap (~2 MB raw) so one slow origin can't
  eat the function budget;
  (v) per-host rate limit so a cron tick can't accidentally pile on
  a small publisher;
  (vi) conditional HTTP (`ETag` / `Last-Modified`) — already
  sketched under "Pre-fetch short-circuits for the warm cron" (a);
  a self-hosted fetcher is what finally lets it pay off because we
  own the request headers, where Jina re-renders and upstream
  validators don't pass through.

  **2. Extractor.** Run the HTML through a real boilerplate remover
  rather than hand-rolled regex:
  - **Preferred: `@mozilla/readability`** (MIT, the library behind
    Firefox Reader View) on top of `linkedom` or `parse5` for DOM
    parsing. `jsdom` works but is heavy in a serverless bundle;
    `linkedom` is ~10× smaller and fast enough. Output is
    `{ title, byline, excerpt, textContent, content }`; we feed
    `textContent` into Gemini identically to today's
    Jina-markdown path. Readability returns `null` for short or
    non-article pages, which becomes our "fall through to Jina"
    signal.
  - **Alternative: `@postlight/parser`** (formerly Mercury). Has
    per-site custom rules, which can beat Readability on
    structured sites, but is less maintained.
  - **Opportunistic boosters** the extractor should also try when
    present: JSON-LD `NewsArticle.articleBody` (see paywall
    bullet (b) — free signal, sometimes cleaner than Readability's
    DOM heuristics); RSS / Atom full-text (see paywall bullet (c)
    — link-rel discovery from the article page, match by URL).
  - Gate with a minimum extracted-text length (e.g. ≥ 1 KB of
    `textContent`) before calling the model — under that, treat it
    as "didn't find an article" and fall through rather than have
    Gemini summarize noise.

  **3. Dynamic-rendering escape hatch** — the expensive option,
  opt-in per host. For sites that truly need JS to render the
  article (SPA news apps, some newsletters):
  - **`@sparticuz/chromium` + `playwright-core`** on Vercel. Works,
    but cold starts are 3–5 s, the Lambda bundle-size ceiling gets
    tight, and we pay CPU-seconds per page. Cost (rule 11): hard
    to pin without real traffic — order-of-magnitude 1–5 ¢ per
    1000 pages of compute plus cold-start tail; new failure modes
    include "new Chrome release breaks the pinned chromium bundle
    on deploy" and "cold start exceeds the function timeout".
  - **Offload to a dedicated renderer** (Browserless, ScrapingBee,
    Bright Data). Negates the self-hosted win — it's
    "Jina, different vendor" — so only worth it if Jina has been
    unreliable *and* we want a replacement, not a redundancy.
  Keep dynamic rendering off the default path; flip it on per-host
  once the fetcher confirms the plain-GET body is an empty shell.

  **Phased rollout.** Don't rip out Jina — add self-hosted
  fetch + Readability as the *first* pass, fall through to Jina on
  `null` / short output / disallowed host / fetch error.
  Instrument a `summary_source` field on the cached record
  (`self` / `jsonld` / `rss` / `jina` / `archive` / `comments`)
  so the warm-summaries logs can show hit rates by source before
  we decide whether Jina stays a hard dependency or becomes a
  fallback. Cost: engineering time only; no new paid services.
  Net savings on Jina quota if self-hosted covers a material
  share of hits.

  **Non-goals (principle, not effort):** stealth User-Agent strings,
  cookie-stuffing to appear logged-in, per-site login automation,
  reverse-engineered paywall circumvention. Same line drawn in the
  Article-fetch fallback and "Paywalled-article summary fallbacks"
  bullets — honest bots > stealthy bots, full stop.

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

## Feeds / views

- **"Hot" feed.** A dedicated view that only shows stories that
  `isHotStory()` currently flags (`src/lib/format.ts`), drawn from
  whichever base feed makes sense (probably `/top` + `/new` merged,
  since fast-risers live on `/new` before they hit `/top`).
  Client-side filter — `isHotStory()` is already pure and the feed
  items carry `score` and `time`. A natural extension of the orange
  "hot" text on the row; would live alongside `/top`, `/new`, `/ask`,
  etc. in the drawer. Think about empty-state copy for the quiet
  hours when nothing qualifies.
- **Tune `isHotStory()` thresholds.** Not just for the row flag —
  once we add the "Hot" feed above, the signal-to-noise ratio
  matters a lot more, since a too-loose threshold fills the whole
  view. See the `TODO: tune` comment next to `HOT_MIN_SCORE_ANY_AGE`
  in `src/lib/format.ts`.
- **Decide what to call it.** `hot` is the current placeholder on
  the row and in `isHotStory()`, but it's not perfect. Pick a short
  label that's easy to understand at a glance **and** doesn't
  collide with HN's upstream vocabulary. Off-limits because HN
  already uses them: `top`, `new`, `best`, `ask`, `show`, `job`,
  `front`. Candidates worth weighing: `hot`, `popular`, `trending`,
  `rising`, `buzzing`, `big`. Whatever wins has to work as a drawer
  label, a URL slug (e.g. `/hot`), and an inline word next to the
  story meta — `hot` currently reads fine in all three; `trending`
  would stretch the meta line; `big` is short but ambiguous ("big
  what?"). Revisit before shipping the "Hot" feed above, rename
  `isHotStory` / the CSS class / the SPEC bullets consistently.
- **User-selectable home feed (URL stays `/`).** The URL `/` is
  not configurable — it is and stays `/`. *What it renders* is
  (eventually) a per-user setting. Groundwork is in: `/` now
  renders the top feed inline via `<StoryList feed="top" />`, no
  redirect, no URL change. Remaining work: replace the hard-coded
  `"top"` in `src/App.tsx` with a preference read from a small
  store (localStorage, e.g. `newshacker:homeFeed`, default `top`)
  and add a control in the drawer / settings so users can switch
  which feed `/` serves (e.g. the `/hot` feed once it ships — see
  *Story feeds* in `SPEC.md`). Deep links like `/top`, `/hot`,
  `/new` remain explicit routes for shareability; the setting only
  governs `/`'s content. **No first-visit nudge.** A one-time
  Top-vs-Hot interstitial and a passive "Try the Hot feed — set
  as home?" banner were both considered and explicitly held off:
  for now `/hot` is reachable only via the drawer entry, with no
  prompt at first paint or above the feed. Revisit once the
  thresholds settle and we have a real signal that users would
  benefit from being asked rather than left to discover.

## Onboarding / education

- **Teach Pin and Done without getting in the way.** Today the
  Pin button (row + thread) and Done button (thread) carry
  long-press tooltips via `<TooltipButton>` — discoverable only
  *if* the user already pressed the button. The swipe-to-pin
  gesture self-teaches via the label reveal behind each swipe.
  `HelpPage` covers Pin in detail (`Pinning stories`, `Pinned,
  favorite, hidden`) but doesn't mention Done at all. `/pinned`
  and `/done` already carry instructional empty-state copy
  ("Tap the pin on a row, swipe a story left, or pin from the
  story page…" / "Tap the check on a thread when you've finished
  reading it.") — but only users who already navigate there see
  them. So the two real teaching gaps are: **(a)** `HelpPage`
  Done coverage, and **(b)** discoverability of Pin/Done for a
  user who hasn't yet tapped either. Options to weigh, cheapest
  → most intrusive:
  1. **Add Done to `HelpPage`.** Two paragraphs alongside the
     existing Pin sections — what Done means (filtered out of
     every feed, lives at `/done`, mutually exclusive with Pin
     — see `SPEC.md` *Pinned vs. Favorite vs. Done*) and the
     gesture (check button on the thread action bar). Zero
     intrusion, only reaches users who visit Help. **Treat this
     as unconditional** — it's a documentation bug, not an
     onboarding decision.
  2. **First-thread bottom hint.** On the user's first ever
     thread open (no `newshacker:openedStoryIds` entries yet),
     render a single sentence under the thread action bar:
     "Tip: pin to save, mark done when you're finished." Self-
     dismisses on second visit. One localStorage flag, one line
     of render. Sits inches from the buttons it describes; gone
     after one read. Doesn't introduce a new tap target.
  3. **Drawer subtitle on Pinned / Done while empty.** When the
     user has zero pins, the drawer's Pinned entry carries a
     one-line subtitle ("Save stories from the feed"); same for
     Done ("Mark threads finished to clear them from feeds").
     Subtitle disappears as soon as the list is non-empty. Zero
     new surface, very passive — pairs well with (2).
  4. **One-time toast on first feed visit.** `showToast('Tip:
     long-press the pin to save a story')` after ~2 s on the
     first ever feed paint. Auto-dismisses, never repeats. Risk:
     blocks the visual hierarchy of the first feed render;
     toast-trained users dismiss before reading. Don't ship
     unless (2) and (3) prove insufficient.
  5. **Coachmark / spotlight on Pin.** Brief overlay with an
     arrow pointing at the row's pin button on first feed visit.
     More attention-grabbing, more positioning code, "in the
     way" by design. Likely too intrusive for the project's
     stated tone — defer unless real data shows users never
     find Pin.

  Rough phasing: ship (1) on its own because it's a doc gap, then
  pair (2) + (3) as the first onboarding pass — both are passive,
  both fade as soon as the user gives any signal that they
  already know, and neither adds a new tap target. Hold (4) and
  (5) unless analytics (or feedback) show users still aren't
  discovering Pin/Done after that.

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
