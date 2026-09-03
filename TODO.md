# TODO

Short running list of things that aren't in flight but worth doing. For
user-facing feature decisions, see `SPEC.md`; for phase ordering, see
`IMPLEMENTATION_PLAN.md`.

## Finish the gate → lanes check rename

The consumer-facing required check was renamed from `gate` to `lanes`
(mikelward/lanes#9). `lanes` now runs alongside `gate` here (both green),
but two steps remain, outside what a session without ruleset API access can
do:

- [ ] Flip the ruleset to require `lanes` instead of `gate`, now that
      `lanes` has reported on a `pull_request` run here: `repo-rules
      mikelward/newshacker lanes ...` (naming every check the ruleset
      should require — `mikelward/scripts`' tool).
- [ ] Once the ruleset requires `lanes`, delete the now-redundant `gate`
      job and its parity test (`.github/workflow-check-rename.test.ts`)
      in a follow-up PR.

## Make zizmor a required check, not just advisory

Codex review on #532 (2026-08-20): removing the hand-rolled "no expression is
spliced into a run: script" test from `npm-update.test.ts` in favor of
zizmor's `template-injection` audit only holds if that audit actually blocks
a merge. `.github/workflows/zizmor.yml` declares itself advisory/non-blocking
today, so a future regression of that shape would turn the (non-required)
zizmor job red while every required gate stays green — a real gap, not a
false alarm. #532 itself became moot before merging (a concurrent PR migrated
`npm-update.yml`/`npm-update.test.ts` to the `mikelward/npm-update` reusable
workflow, deleting the very file the fix and the hand-rolled test lived in),
but the underlying gap this note is about is independent of that file and
still open: `zizmor.yml` itself is untouched by the migration and is still
advisory. The fix isn't a new in-repo unit test (re-adding a hand-rolled
parser would be going backwards even if there were still a file to add it
to: the one removed missed real cases across six separate Codex-found
rounds, so a "required but wrong" check is worse than an "advisory but
correct" one). The fix is making `zizmor` one of the ruleset's required
status checks, same as `lanes`/`codex`:

- [x] **First, widen `.github/workflows/zizmor.yml`'s trigger.** Codex
      review on #532 caught a prerequisite this note missed: both its `push`
      and `pull_request` triggers were scoped to `paths: ['.github/**']`,
      which was fine while the job was purely advisory but is a real
      blocker for making it required — GitHub leaves a required check
      pending (not passing) when its workflow is skipped by a path filter,
      so any PR touching `src/`, `api/`, or anything outside `.github/`
      would become permanently unmergeable the moment `zizmor` is a
      required check. `repo-rules`' own never-reported guard would not
      catch this, since the job HAS reported somewhere (on `.github/**`
      PRs) — the gap is "does it run on every PR", which is a different
      question than "has it ever run at all". Dropped the `paths:` filter
      on both triggers, added the explicit `pull_request` `types:` list
      (`edited` included, so a retarget re-scans against the new base
      instead of the old target's scan satisfying it unexamined) and
      updated `zizmor.test.ts` to assert the new shape; still $0/month per
      the workflow's own cost note (PyPI, free, keyless, unmetered) even at
      full volume. Same fix needed in every sibling repo's identical
      `zizmor.yml` (confirmed: readmo, homepage, gedmap, web all carry the
      same `.github/**` filter) before any of them can make `zizmor`
      required either.
- [ ] **Second, and this one is a real trade-off, not a mechanical
      fix — the repo owner's call, not this note's to make.** A second
      Codex review (on #534, the PR that recorded this note) pointed out
      what `zizmor.yml`'s own header comment already says outright:
      "Advisory MEANS advisory: nothing requires this check, on purpose.
      Running it fetches zizmor from PyPI, and a registry outage must not
      stall the merge gate." That is the exact thing "make it required"
      undoes. Once `zizmor` is a required status check, a slow or down
      PyPI, or a pinned release that stops resolving, makes `pipx run` fail
      or time out — and a required check that fails or never completes
      blocks every merge in the repo until it recovers, with no built-in
      way to bypass it short of editing the ruleset. So this is genuinely
      two competing costs, not one obviously-correct move: catching a real
      injection regression with a REQUIRED gate (what this whole note is
      for) against accepting PyPI's uptime as a new, external, merge-
      blocking dependency for every PR in the repo (what `lanes` and
      `codex` already are, worth weighing against their own track record
      here, but a new one nonetheless). Decide this explicitly — accept the
      new failure mode, add a mitigation first (a documented manual bypass
      via the ruleset's `bypass_actors`, a required-but-soft-fail shape,
      pinning to a vendored/cached zizmor instead of `pipx run`-fetching it
      every run, or something else), or decide advisory is actually the
      right permanent state and close this note — before running
      `repo-rules` below. Don't resolve it by guessing either
      direction; see this repo's own AGENTS.md on cost/reliability write-ups
      and on a Codex finding that cites a real trade-off correctly.
- [ ] **Also first: a dispatch route for the weekly dependency PR**
      (Codex review on the trigger-widening PR). That PR is authored with
      `GITHUB_TOKEN`, whose events start no workflows — the same trap
      ci.yml's `workflow_dispatch` fallback and the codex-review-check
      dispatch exist for — so a required `zizmor` would block every weekly
      batch forever. Before the flip, give zizmor.yml a `workflow_dispatch`
      trigger and teach mikelward/npm-update's reusable workflow to
      dispatch it alongside ci.yml — a shared-mechanism change that lands
      in that repository, piloted through one consumer per its
      conventions.
- [ ] Then, once the above is decided: `repo-rules mikelward/newshacker
      lanes codex zizmor` (or the bare `repo-rules mikelward/newshacker`,
      now that `lanes codex zizmor` is the script's default) once zizmor
      has reported on a `pull_request` run here — outside what a session
      without ruleset API access can do.

## Decisions needing review

- **DEFERRED: US-spelling enforcement (owner call, 2026-08-18).** gedmap
  enforces its US-English rule with a dictionary-difference test
  (usSpelling.test.js: an offense is a word valid in en-GB AND invalid in
  en-US, so names and jargon are unreachable false positives); porting it
  here was prepared and then set aside — "we can worry about that later."
  The prepared scan found ~68 British-only spellings — the doubled-l forms
  of canceled/canceling in the ShareResult literal and sync paths, and the
  British forms of initialized, behavior, defense, honors, gray, and
  signaling across api/, src/, and the guides — all mechanical,
  tsc-checked, suite-green when applied. Reviving
  it: add nspell + dictionary-en + dictionary-en-gb devDependencies, port
  the test, land the renames, and reword golden rule 8 and SPEC.md's
  US-English line so the rules stop quoting the British forms they forbid.

## Performance

- ~~**Stop awaiting the comment batch inside `loadRoot`.**~~ **Shipped.**
  Cold opens paint the story after one round trip; mounting `<Comment>`
  observers join the in-flight batch via a synchronously-registered
  id → slot map in `commentPrefetch.ts` instead of stampeding
  single-item fetches. See SPEC *Comment batching*.


- **Prefetch page N+1 after each landed page.** With `/api/items`
  batched and edge-cached, each prefetch is effectively free — so
  keeping one page of lookahead warm would eliminate nearly every
  visible pagination "Loading…" for steady scrollers. Cap the
  lookahead so we don't drain the whole feed on mount.
- **Algolia HN Search as a feed source.** `/search` already uses
  Algolia for full-text search (see SPEC.md *Search*); open question
  is whether Algolia's `front_page`, `ask_hn`, `show_hn`, `job`, and
  date-sorted `story` queries can also replace the Firebase
  `topstories` / `askstories` / etc. id lists. `best` has no direct
  equivalent — may need a different definition (e.g. "highest-voted
  story in the last 24h" via numericFilters). Worth prototyping a
  side-by-side to see if order / content differs meaningfully from
  Firebase's lists.
- **Persist item bodies across sessions.** React Query's persister
  caches the whole client; for item bodies specifically we could tier
  the persistence so they survive longer (days) than the ID lists
  (minutes), since titles/urls rarely change. **Partially decided the
  other way for comments**: `['comment']` queries now persist only for
  pinned stories (see SPEC *Comment bodies persist to disk only for
  pinned stories*) — the whole-cache blob had grown to ~7k comment
  queries / ~7 MB on a long-lived profile and its boot-time
  restore+hydrate was the measured slow-reload cost. Any future
  tiering applies to roots/summaries, not comments.

## PWA / offline

- **Offline support follow-ups.** Keep these tied to the existing offline
  product promise rather than growing new surfaces by default:
  1. Explicit **Save full thread offline** action for readers who want more
     than the default first-comment-page warm on mega-threads.
  2. **Cache status UI/debug signal** for `/offline` / pinned stories using
     `getOfflineCacheStatus` (root/comments/article summary/comments summary
     present, partial, or missing) so offline support is observable before a
     user loses connectivity.
  3. **Event-driven reachability probe** after failed fetches, browser
     `online`, app resume, or user refresh — not a periodic always-on timer.
  5. **Cache quota / eviction policy** that treats pinned/favorite/thread
     roots as higher-value than incidental feed data.
  Cost/reliability: keep the default path fail-open and cheap by reusing the
  existing `/api/items` batching and summary caches; any proactive probe must
  be low-frequency/backoff-based so it does not add a new battery or request
  tax while offline.
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

- **Web Share API — considered, not used.** A generic `⋮` entry that
  hands the article URL to `navigator.share` was the first sketch, but
  Web Share is unavailable on most desktop browsers, so it wouldn't
  work for a big slice of readers. We went with named per-service
  deep links instead (shipped below), matching how the companion
  Readmo app does it — a save URL works everywhere. The OS share
  sheet remains reachable for stories via the existing **Share**
  overflow entry (which shares the `/item/:id` discussion URL, a
  different intent).
- **Dedicated read-later save links — shipped (opt-in, one service).**
  A single **Save to <service>** entry in the thread `⋮` overflow menu,
  behind a per-device **Settings → Read later → Save to**
  single-select dropdown (None / Instapaper / Readwise Reader /
  Raindrop), **defaulting to None** so nothing shows until the reader
  picks their app; at most one is active. `src/lib/readLater.ts`
  (`readLaterStore` + `readLaterTarget`) builds the chosen service's
  deep link — Instapaper `https://www.instapaper.com/hello2?url=<enc>&title=<enc>`,
  Readwise Reader `https://wise.readwise.io/save?url=<enc>`, Raindrop
  `https://app.raindrop.io/add?link=<enc>&title=<enc>` (the save
  dialog, not the collection viewer) — opened via
  `window.open(href, '_blank', 'noopener,noreferrer')` (see SPEC.md
  § *Thread action bar*). Each is a plain deep link to the service's
  own save/confirmation page (login/signup prompt if the reader isn't
  signed in) — no API key, no credentials, no server involvement,
  zero cost. Shown only for stories with a safe http(s) article URL
  (self-posts are omitted). Coverage (unchanged from the analysis
  below): Instapaper's Readability-class extractor parses ~90% of HN
  link posts clean, degrading to a link-only save on SPA / JS-only
  sites; Readwise Reader renders JS server-side so it's a notch better
  (~95%). TOS: we're a link emitter, zero exposure. Failure modes:
  service outages (a few hours a year), account required, iOS PWA pops
  the destination out of `standalone`. Adding another service is one
  entry in the `readLater` service list plus its dropdown option.
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
  to). That covers retention and ad-hoc querying.
  **Phase 1.5 of the dashboard work shipped a partial answer**:
  `/api/admin-stats` and the matching `/admin` cards now report
  the most recent `warm-run` (timestamp + `processed` + `durationMs`)
  alongside the user-path summary stats. Per-host paywall share,
  per-host churn, and the article-track outcome histogram are still
  not in the dashboard — they remain Axiom-console-only.
  Two upgrades worth doing only if those Axiom queries turn out to be
  load-bearing for tuning decisions (and not if the answer is
  "knobs are fine, stop looking"):
  (a) **Aggregation endpoint.** Extend `/api/admin-stats` (or a
      sibling `/api/warm-summaries-stats`) with per-host paywall
      share + churn rollups, either via additional APL queries or
      via a pre-aggregated Upstash sorted-set populated by an
      hourly cron. ~2 h via APL, more via the cron route.
  (b) **Per-host card.** A sixth `/admin` card rendering the top-N
      hosts by paywall share, with a small bar chart. Only worth
      it once we're iterating on per-host policy (e.g. "stop
      re-fetching this domain after the first paywalled fetch").
  Don't pre-build these — the existing dashboard answers
  "is the cron doing anything" at a glance, and the Axiom console
  answers the rest until we know the per-host policy work is real.

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

- **Namespace every per-account store by username, or none of them.**
  Today it's split: votes and downvotes are keyed per user
  (`newshacker:votedStoryIds:<username>`, `…:downvotedItemIds:<username>`
  — `votes.ts` says so explicitly, "so signing in as a different account
  doesn't inherit"), while Pinned, Favorite, Hidden, Done, avatar prefs
  and Hot thresholds are single device-level keys shared by whoever is
  signed in. So a second account's pull *merges* its server lists into
  the first account's local ones and the device ends up with the union,
  with no un-merging — while its votes stay cleanly separate. Nothing is
  lost and nothing is slow (the boot-prime generation guard added in
  #497 is an integer compare; there is no per-account dimension in any
  hot path), so this is a consistency decision, not a performance one:
  either namespace the other stores the way votes already are, or drop
  the votes namespacing and say plainly that a device belongs to one
  reader. Half of each is the state that surprises. Picking "namespace
  everything" also needs a migration for existing un-namespaced keys and
  a rule for what an anonymous reader's lists do at sign-in (adopt them
  into the account, most likely — that's today's behavior).

- **Atomic `/api/sync` merge (unblocks unload-flush for in-flight
  edits).** `handleSyncRequest`'s POST path is a non-atomic
  get → merge → set, which is only safe today because the client
  never issues two POSTs at once (the `pushInFlight` lock in
  `cloudSync.ts`). That invariant is what forced the flush-on-hide
  path to *skip* flushing when a POST is already in flight (see the
  `flushPendingPush` comment): an overlapping keepalive flush would
  race the in-flight request's `set` and could clobber the very edit
  it's trying to save. Consequence: an edit made *during* an in-flight
  sync POST that's immediately followed by a tab close syncs on the
  next app open rather than during that unload (never lost locally —
  localStorage keeps it). To close that last window, make the merge
  atomic — optimistic concurrency (store a `version`/`rev` and
  compare-and-set, retrying on mismatch) or a Redis Lua script /
  WATCH-MULTI that does the read-merge-write in one round. Then a
  hide flush could safely fire an overlapping keepalive POST. Cost:
  same Upstash store, one extra field or a Lua eval per POST; no new
  infra. Only worth it if the in-flight-then-immediate-close edge
  proves to matter in practice.

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
- **User-selectable home feed (URL stays `/`) — shipped.** `/` now
  reads `newshacker:homeFeed` (default `top`, `hot` opts in to the
  filtered Top ∪ New view) via the `useHomeFeed` hook, with a Home
  picker in the drawer (`AppDrawer.tsx`). Deep links like `/top`,
  `/hot`, `/new` stay explicit for shareability; the setting only
  governs `/`'s content. Future home options (e.g. `/best`, a
  combined "everything I haven't seen") can extend the
  `HomeFeed` union in `src/lib/homeFeed.ts` without touching the
  router. **No first-visit nudge** — explicitly held off; readers
  discover the picker via the drawer. Revisit once thresholds
  settle and we have a real signal that prompting would help.

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
  1. ~~**Add Done to `HelpPage`.**~~ **Done.** `HelpPage` now has a
     *Marking stories done* section (what Done means — filtered out
     of every feed, lives at `/done`, mutually exclusive with Pin —
     plus the check-in-the-action-bar gesture), and the summary
     section is retitled *Pinned, favorite, done, hidden*. Closed
     the documentation gap; leaves gap (b), discoverability for a
     user who hasn't tapped either, still open below.
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

  Rough phasing: (1) shipped on its own as the doc-gap fix; next,
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

## Merge gates

- [ ] **Enable auto-merge and arm it on the weekly dependency PR.** The
  repository setting is off (Settings → General → Pull Requests → Allow
  auto-merge), and unlike gedmap the weekly `npm-update.yml` never
  runs `gh pr merge --auto --rebase` after opening its PR. The ruleset
  already does the reviewing — CI, the `codex` status, conversation
  resolution — so arming can only remove toil: a green weekly batch
  currently waits for a manual merge that the gates have already earned.
  One constraint gedmap's arming block does not carry: this repository
  excludes pre-1.0 (`0.x`) packages from auto-merge — SemVer permits
  breaking changes in a 0.x minor — so the arming step must first classify
  the batch's direct moves (the publish job's deps-summary.md already
  names them) and skip arming when any moved package is pre-1.0, leaving
  that batch for review. Add the workflow-test assertion alongside, and
  keep the arming deliberately non-fatal like gedmap's.
- Add an AGPL license gate to `ci.yml`: fail if a dependency declares an AGPL
  license, catching one added by hand in a normal PR, not just ones the
  weekly bot bumps. Likely `license-checker-rseidelsohn`. GPL/LGPL undecided,
  matching typelauncher#632. Independent of `npm-update`. Work out placement
  and gate/lanes wiring when actually building this.

## Funnel role, cost ceilings, and overload

newshacker's job in the portfolio is **reach**: it is the only product with a
natural launch channel (Show HN) and its audience is almost exactly readmo's
market. It stays free — a paywall would reduce the reach that makes it useful,
and a paywalled unofficial HN client would land badly on the one channel worth
having. Full reasoning in `readmo/MONETIZATION.md`.

That makes a traffic spike the *expected* case here, not the tail case, so the
items below are about surviving success.

### Cost ceilings and quota exhaustion

- [ ] **Audit what a 10,000-visitor launch day costs — and it is more than
      Gemini and Jina.** This was called a "10× traffic day" for several
      drafts, which was never true of the number under it: `SPEC.md` puts
      current traffic at **single-digit daily**, so 10,000 is roughly a
      thousand times the documented baseline, not ten. **Ten times expected
      traffic is the wrong question for this app** — ten times single-digit is
      still single-digit-times-ten, free on every tier here — and stating it
      that way is the point rather than a caveat: what this section budgets
      for is the **Show HN spike**, an event that arrives at once and bears no
      relation to the growth curve. So it is a fixed stress bound with a named
      visitor count, and every figure below carries the scenario it belongs to.
      An earlier draft also named only Gemini and Jina and called the
      same-story path near-free. That understates the spike, because two of
      the costs are **traffic-proportional even on a cache hit**:
      - **Upstash Redis, and it is the larger of the two.**
        `warmFeedSummaries` fires *both* summary endpoints as each story row
        scrolls into view, and both short-circuit on a KV hit — so the steady
        state is one Redis read per endpoint per visible row. `SPEC.md` puts
        the cron's own baseline at ~520k commands/month, already **~1.7× the
        free allowance** (~$1/month at pay-as-you-go), and says outright that
        it "rises with reader traffic since warm-on-view adds two reads per
        visible row." **Apply the launch arithmetic to that sentence rather
        than leaving it as "rises":** ~120 of the invocations a visitor makes
        (below) each do their own cache read — the two summary endpoints on
        every visible row — so 10,000 launch-day visitors is ~1.2 M commands,
        **~$2.40** at ~$0.20 per 100k, before writes and rate-limit commands.
        Several times the Vercel overage for the same day, so quoting only the
        ~$1 cron baseline hid the bigger of the two costs behind the smaller
        one. Gemini being cached does not make the
        view free.
      - **State the DURATION with every figure, and don't scale one
        dependency from another.** This estimate has been wrong six separate
        ways — the dependency omitted, the curve unquantified, cache hits
        uncounted, a multiplier standing in for a month, the scenario's own
        name misdescribing it, an invocation missed, and then a *CDN-absorbed*
        one counted per visitor — so name the scenario and re-derive each
        count rather than scaling by a number whose meaning has to be
        inferred:
        **Four origin invocations per hot row and four Redis-touching ones**
        — the same four summary-endpoint calls, which reach the function every
        time because those two endpoints moved off the edge CDN to Redis
        (`SPEC.md` §Caching strategy). `/api/items` is the exception in both
        directions: it reads no KV *and* is edge-cached, so it is neither
        a Redis command nor a per-visitor invocation. So ~**120 invocations
        and ~120 commands per visitor**, plus the `/api/items` fills below.
        - **One launch day** (10,000 visitors: ~1.2 M invocations, ~1.2 M
          Redis commands): Vercel ~**20¢** (0.2 M past the included million),
          Redis ~**$2.40**. **That Redis figure is a cache-read lower
          bound**, and the section's own cold-cache scenario is where it
          stops holding: the per-IP limiter is gated on a cache *miss*
          (`IMPLEMENTATION_PLAN.md` §Rate limiting), so a warm row spends
          nothing there, while every miss adds an `INCR` per enabled tier —
          two steady-state, up to four in the first window after a counter
          rolls. It is not linear either, because the burst tier short-
          circuits: `checkRateLimit` returns the moment a tier is over its
          limit (`api/summary.ts:163-181`), so one address's first 120 cold
          requests cost 40 `INCR`s for the 20 that clear the 20-per-10-min
          burst, 2 first-use `EXPIRE`s, and 1 apiece for the 100 rejected —
          ~142, not 240. Parameterize by miss count rather than folding a
          guess in: how much of a launch is cold depends on how much of it
          lands on rows the cron never warmed, which nothing here measures,
          same as the `/api/items` fills above.
        - **A month sustained at that daily rate** — 30 x: ~36 M invocations,
          ~35 M billable ≈ **$35**; Redis ~36 M ≈ **$72**; ~**$107**
          together. A *stress bound*, not a forecast: a Show HN is one spike
          and a decay curve, not thirty launch days.
        - **The realistic month** sits between the two and depends on how fast
          the curve decays, which nothing here measures. Don't invent a figure
          for it — the bound above is what to budget against.
        Around $100/month at the bound is real money and not existential,
        which is why the **threshold behavior** — pay the overage, or
        pause/throttle at the limit — is still the thing to settle for each
        before launch day rather than the total.
      - **Vercel invocations**, on the same curve and with the arithmetic
        applied, because it lands differently from the pin-prefetch estimate
        in `IMPLEMENTATION_PLAN.md`. That one is bounded by *qualifying loads
        per month* and comes to ~3–9 % of the million invocations Vercel Pro
        includes for the $20 already being paid. This one is bounded by
        *visible rows*, and **the server cache does not reduce it** — a KV hit
        short-circuits the expensive generation *inside* the handler, after the
        request has already been made and billed. So two invocations per row
        scrolled past, and **four on a row over the prefetch threshold,
        whatever the cache holds**: the duplicate warm below is a second HTTP
        request rather than a second generation, and those four
        summary-endpoint calls are all of it. **A fifth HTTP request goes out
        and mostly does not reach the function.** `prefetchFeedStory` →
        `prefetchPinnedStory` fires `prefetchCommentBatch` inside its root
        fetch, which calls `getItems` → `/api/items` — but that endpoint alone
        kept the edge CDN (`public, max-age=60, s-maxage=60,
        stale-while-revalidate=300`, `api/items.ts:124-134`; `SPEC.md`
        §Caching strategy says why it stayed), so on a hot story thousands of
        visitors share one fill rather than each billing an invocation.
        Exactly one *request*, not a chunked several: `prefetchCommentBatch`
        returns immediately for zero kids and otherwise slices to
        `COMMENT_BATCH_LIMIT` = 30 *before* calling `getItems`
        (`src/lib/commentPrefetch.ts:72-81`), so `getItems` never reaches its
        own chunking path from here however many top-level comments the story
        has. **What bounds the fills is content and geography, not traffic** —
        the cache key is the exact `?ids=<30 ids>&fields=full` URL, so a fill
        happens when the story's first-30 kid slice changes (comment threads
        accumulate continuously, per `reports/2026-04-29-cache-strategy.md`
        Finding 2) or the 60 s shared TTL lapses, once per POP serving it.
        That is thousands a day across the front page, not hundreds of
        thousands — but it is a *measurement*, not a figure to assert: read
        the actual origin count off Vercel's analytics before quoting one.
        The root `getItem` is free of all this: it goes straight to Firebase,
        not through our functions. On /top most of the front page is over the
        threshold, which puts a launch at the top of the range rather than the
        bottom: thirty rows a visitor is ~120 invocations, so
        **10,000 visitors in a launch day is ~1.2 M — the whole monthly
        allowance and a fifth again, in a day**, where the pin path takes a
        month to reach a tenth of it. Only the duplicated *generation* and
        the rate-limit debits depend on a cold cache; the invocations and the
        Redis reads do not. At ~$1/million overage the launch day itself is
        ~200k invocations past the included million, about **20¢** — but the
        allowance is gone on day one and every invocation for the rest of the
        month bills from zero, which is why the duration bullet above gives
        the monthly figures separately (~$35 here, ~$107 with Redis, at the
        sustained bound). **What the project is configured to do at the
        threshold is still the first question, ahead of the total**: paying
        the overage costs that; a spend limit that pauses the project takes
        the site down at its most-visited moment, which is the opposite of
        what a launch wants. Check which is set before launch day, not after.
        Re-derive every figure against Vercel's and Upstash's current pricing
        pages rather than reusing these — the `IMPLEMENTATION_PLAN.md` note
        says the same of its own.
      - **And a hot row pays that twice, not once.** Above
        `FEED_PREFETCH_SCORE_THRESHOLD` (100 points — most of the /top front
        page) a row entering the viewport fires *two* independent warms:
        `warmFeedSummaries` with a raw `fetch`, and `prefetchFeedStory` →
        `summaryQueryOptions` / `commentsSummaryQueryOptions` through React
        Query (`StoryList.tsx:813,847`, `pinnedStoryPrefetch.ts:86-95`). The
        raw fetch is never registered with the query cache, so React Query's
        own dedup cannot see it and both go out — which is where all four of
        the invocations above come from, already counted there rather than
        doubled on top. The worse case is the one to carry: two *cold*
        requests for the same story can both miss the KV cache and each start
        a Gemini call. Either count it in the estimate or deduplicate the two
        paths — routing `warmFeedSummaries` through the same query options
        would make React Query dedupe them for free.
- [ ] **Deduplicate those two warms BEFORE launch — this is not just an
      accounting line.** Both endpoints debit the same per-IP bucket
      (`newshacker:ratelimit:aisummary:`, identical prefix in `api/summary.ts`
      and `api/comments-summary.ts`), whose burst tier is **20 requests per 10
      minutes** and which gates cache *misses* only. On a cold cache a hot row
      with both an article and comments costs **four** debits — two endpoints,
      each requested twice — so **five rows exhaust an ordinary visitor's
      burst quota** and everything after it 429s. That is a launch-day
      cold-cache shape, not an abuse shape, and counting the duplicate spend
      does nothing about it.
      **But deduplicating is necessary and NOT sufficient, so this item needs
      both halves.** Dedup halves a cold row from four debits to two, which
      moves the wall from five rows to ten — still short of the thirty a
      visitor scrolls on `/top`, so the same reader still 429s, just later.
      The limit itself has to move with it: **re-tier the burst allowance to
      the real per-row cost of a cold scroll**, or stop charging speculative
      warms against a bucket sized for demand traffic — the underlying
      mismatch is that `warmFeedSummaries` is *prefetch*, and the limiter was
      built for a refetch loop from one bad client. (Not charging them at all
      reopens the abuse vector the limiter exists for, since anyone can call
      the endpoint directly; so if that is the route, the exemption has to
      turn on something a caller cannot assert about itself.) Whichever, the
      capacity change ships with the dedup, not after it.
      **Cost of the re-tier, before mandating it (rule 11).** Raising the
      burst tier to pass a cold thirty-row scroll means at least **60**
      endpoint requests per address per ten minutes, up from 20 — and since
      the tier gates cache misses, those are all provider-touching: for link
      stories with comments, ~**30 Jina fetches and ~60 Gemini generations
      from one address**, roughly **3× today's per-address exposure**. That
      is the real price of the fix and it is not obviously worth paying as
      stated, which is why the two options are not equivalent: re-tiering
      buys the cold scroll by widening what a single abusive address can
      spend, while exempting prefetch buys it without moving the ceiling for
      demand traffic — at the cost of needing an exemption signal a caller
      cannot forge. **Land cross-client single-flight first and the question
      shrinks**, since a shared winner means most of those misses never reach
      a provider at all. Record which option was chosen and what it costs
      before implementing either.
      **Pass criterion:** a single visitor scrolling all thirty rows of `/top`
      against a cold cache completes with **no 429**. "The duplicate is gone"
      is not the test — it passes while the reader still hits the wall.
      Exercise it in the spike test below on a cold cache, since a warm-cache
      test never touches the bucket at all and would pass regardless.
- [ ] **And the bigger duplicate at launch is CROSS-CLIENT, which no amount of
      React Query fixes.** Routing both warms through the same query options
      dedupes them *within one browser*; a Show HN sends thousands of separate
      browsers at the same cold story, and separate clients — and separate
      serverless instances — all miss Redis before any of them writes back.
      **Each one pays one Jina fetch and TWO Gemini calls**, not one: after
      browser-local dedup a cold hot row still sends one request to each
      endpoint, and `/api/summary` does the Jina fetch plus a Gemini
      generation while `/api/comments-summary` does a second, separate Gemini
      generation off the comment transcript (no Jina — it works from comments
      already fetched). So the Gemini stampede is **twice** the Jina one, and
      an estimate written from "a Jina fetch and a Gemini call" halves the
      side that is larger and hits its quota first. That is the duplicate
      that scales with the spike, and the in-browser one is the smaller half
      of the problem. `IMPLEMENTATION_PLAN.md` already carries
      the fix as **Single-flight the generation**, with two prior designs to
      copy from, its cost envelope, and the lease-TTL failure mode — read it
      there rather than re-deriving it here. What belongs on *this* list is
      the launch decision it forces: either single-flight lands **before**
      launch day, or this audit states the unbounded provider-cost and
      quota-exhaustion figure that not having it implies. Right now it does
      neither, which is the gap.
- [ ] **Include Redis quota-exhaustion behavior in that audit — it inverts the
      cost model.** `SPEC.md` is explicit: the record reads are
      `.catch(() => null)`, and a null record is indistinguishable from a
      never-seen one, so an unreachable or quota-exhausted Redis loses the
      age/interval backoff — the one gate that reads the record — and every
      *eligible* track takes the `first_seen` path and regenerates each tick.
      Losing the cache doesn't just cost more Redis; it turns the cheapest
      outcome into the most expensive one, on Gemini, exactly during the spike
      that exhausted the quota. The signature is an anomalous `first_seen`
      spike among eligible tracks. State this failure mode and its dollar
      impact (guardrail 11) as part of the audit, not after it.
- [x] **`summary_budget_exhausted` already degrades visibly, and is tested.**
      `summaryErrorDetail` maps it to user-facing temporary-unavailability copy
      (`src/components/Thread.tsx:257`), with a regression test driving the 503
      and asserting that copy renders (`src/components/Thread.test.tsx:1330`).
      Nothing to build. This is the property the gedmap geocoder lacked
      (mikelward/gedmap#164) — worth noting that newshacker already had it.
- [ ] What genuinely remains for **Jina** is confirming the budget copy
      appears against a real deployment, not just under jsdom — but **this is
      blocked on something to force it with, and that does not exist yet.**
      The handler branches on Jina's 402/429 only, so an invalid key won't do
      it (that is a 401, a different failure), and there is no fault-injection
      path in the tree. What is left is depleting or throttling the same
      `JINA_API_KEY` every uncached summary uses — deliberately breaking
      summaries for real readers to check a message. **Don't**, and the reason
      is worse than "wait for the window": the two branches this handler
      treats alike recover differently. A **429** is throttling and does come
      back on its own. A **402 is exhausted credit, and Jina's free grant is a
      one-time 10M-token allotment per key that does not refresh** (`SPEC.md`
      § *Cost/reliability*, and the cron's own measured ~12.9M tokens/day
      means the grant is a day or two of traffic, not a month's). Draining it
      leaves summaries down until someone tops up in paid blocks or rotates
      the key — an unbounded outage with a purchase in the middle of it, not a
      ten-minute wait. The prerequisite is either a
      throwaway Jina account whose credit is spent on purpose, wired to a
      preview deployment, or a test-only injection point that returns the
      `payment_required` failure on request. Build one of those first and this
      becomes a two-minute check; without one the item stays open rather than
      being satisfied against production.
      **This does not block `OBSERVABILITY.md` Phase 3**, and the two are
      worth keeping apart. That phase requires all four monitors — the
      Jina-credit one among them — to fire through the paging integration,
      which needs only an *event matching the monitor's query*, not a real
      402: post one into the Axiom dataset, or point the query at something
      benign and restore it. What is blocked here is the other half, and the
      more expensive one — proving the handler emits that line when Jina
      really does return 402. Phase 3 says so itself rather than reading as
      end-to-end.
- [ ] **The Gemini ceiling is a different, unverified path — cover it
      separately.** `summary_budget_exhausted` is emitted *only* for Jina's
      402/429 (`api/summary.ts`, the `jinaResult.failure ===
      'payment_required'` branch). A Gemini quota or ceiling rejection falls
      through the generation `try` instead and surfaces as
      `summarization_failed` / HTTP 502. So the tested degradation covers one
      of the two metered providers, and the provider-hard-cap item above adds a
      ceiling to the one that is *not* covered. Add a Gemini-cap test, and
      state the user-visible reliability impact of that path (guardrail 11's
      cost-and-reliability note) before calling launch degradation verified.
- [ ] **Cover BOTH Gemini-backed endpoints, not just `api/summary.ts`.**
      `/api/comments-summary` has its own ceiling path and its own
      user-visible outcome: its Gemini catch returns a bare
      `502 { error: 'Summarization failed' }`
      (`api/comments-summary.ts:733-739`), and `CommentsSummaryErrorReason`
      (`src/hooks/useCommentsSummary.ts:19`) recognizes only `rate_limited` —
      so there is no reason code a budget-exhaustion message could hang off,
      and the discussion-summary card degrades differently from the article
      one. An article-summary cap test passes while that stays unverified.
      Give the comments endpoint its own exhaustion outcome and copy, and its
      own test, before launch degradation counts as covered.
- [ ] **Set a hard spend ceiling at the provider — and note it would be the
      ONLY global hard control there is.** "Not just in code" implied an
      aggregate in-code guard exists. It does not: the summary handlers
      rate-limit per **IP** (`newshacker:ratelimit:aisummary:<tier>:<ip>:<win>`),
      which bounds one visitor and does nothing against a crowd of distinct
      ones — precisely the launch shape — and `WALL_CLOCK_BUDGET_MS` only stops
      a cron tick *starting* more work after 50 s. `SPEC.md` says so itself: it
      "bounds how many stories a runaway tick starts, not how long that tick
      runs or what it spends, and nothing bounds the damage across ticks."
- [ ] **Add an aggregate cost circuit breaker**, so the provider cap is a
      backstop rather than the only line. A global generation/spend counter per
      window that sheds generation (serving cached-or-nothing) once tripped,
      covering the user-request path and the cron alike. It would be the first
      **in-app, aggregate** control — not the first thing to notice a runaway,
      which the GCP billing budget already does at 50/80/100 % of the monthly
      cap (`OBSERVABILITY.md` § *Current state*, already configured). The gap
      it fills is between noticing and stopping: a budget alert is an email
      about spend that has already accrued, and the provider hard ceiling above
      it is all-or-nothing at the provider and not yet set. A breaker is the
      only one of the three that can shed the expensive path while keeping the
      app serving.
- [ ] **Cost and outage policy for that breaker, decided before it is built**
      (rule 11). It is a *shared* counter, so it adds a store round trip to
      both paths that spend money. **Increment where the spend is reserved,
      not where work is selected** — the two are far apart on the cron. A
      selected track exits before Gemini on two separate gates: a backoff skip
      returns before any fetch at all (`api/warm-summaries.ts:1429-1442`), and
      an `unchanged` verdict returns after the content fetch but without
      generating. So charging the counter per selected track would count
      non-spend and shed summaries early — the breaker tripping on work that
      cost nothing is worse than no breaker, because it takes the feature down
      to protect a bill that was never accruing. Note the asymmetry the two
      gates create: a backoff skip spends nothing, while `unchanged` has
      already spent a Jina fetch, so a counter that means *spend* rather than
      *generations* has to decide whether Jina counts. Say which before
      building it. **It has to count it, and that means two reservation
      points rather than one** — the answer this item kept deferring. The
      cron's Jina fetch happens at `api/warm-summaries.ts:1464-1467`, and the
      outcomes that pay for it and then never reach Gemini are not an edge
      case: `reports/2026-04-29-cache-strategy.md` Finding 5 puts `unchanged`
      at 700 events and 8.04M Jina tokens with zero Gemini, plus `error` at 29
      events and 250K — together **64% of the day's 12.93M Jina tokens**. A
      counter keyed on generations sits still while the majority of the Jina
      bill accrues, which is the failure this breaker exists to prevent. So
      reserve **before each Jina fetch and again before each Gemini call**, or
      keep a budget per provider; either way the shed decision is per
      provider, since exhausting Jina and exhausting Gemini are different
      outages with different degradations (`summary_budget_exhausted` versus
      the 502 path, per the item below).
      **And a count of summaries is not a count of spend, so a flat `INCR`
      cannot enforce a cost ceiling at all.** An article generation costs far
      more Gemini prompt tokens than a comment one *and* adds a Jina fetch the
      comments track never makes, so one counter against one threshold is
      wrong in both directions: an article-heavy window trips it only after
      the budget is already spent, and a comments-heavy one sheds summaries
      costing a fraction of what the threshold assumed. So the unit is
      weighted cost — charge each **billable call** an estimate of its own
      spend — or the two tracks get separate budgets. **And an estimate is
      not a ceiling, so say which instrument this is.** A weight derived
      from measured per-call spend under-reserves whenever a call runs long
      — article bodies vary by an order of magnitude, and nothing caps the
      tokens a single Jina fetch feeds Gemini — so accepted work can outrun
      its reservation with no concurrency involved at all. Two honest
      options and they are not the same product: reserve a **conservative
      per-call upper bound** and reconcile against actual usage after the
      call, which costs a second write per call and sheds earlier than the
      budget strictly requires; or call this a **soft expected-cost
      throttle** and leave the provider-side cap as the only hard ceiling,
      which is cheaper and admits it can overshoot. The second is probably
      right here — the provider cap is already the item above, and a
      breaker that sheds early is the failure mode this item opened by
      warning about — but it must be *written down as a soft throttle*
      rather than described with "ceiling" language it cannot deliver. Note "call", not
      "generation": the paragraph above is what fixes the unit, and this one
      must not quietly re-key the counter to generations and drop the Jina
      fetches that never reach one. That is the same decision as the Jina
      question above seen from the other side: both ask what one tick of the
      counter is denominated in. **The Redis bound below rises, though it
      stays small** — a weighted increment is still one command, but the
      article track now reserves twice per check where it reserves at all
      (Jina, then Gemini) against the comments track's once — which is the
      ~26k `INCR`s/day the **Cost** paragraph below now prices. Still the
      bound and not the bill, for the same reason: in steady state the
      backoff means most tracks reserve nothing at all.
      **Measure the weight; do not derive it from the track totals.** The
      tempting number is Finding 3's headline **12.7×**, and it is a ratio
      between 24-hour *track totals* (article 5.04M prompt tokens, comments
      398K), not between calls — turning it into a per-call weight needs the
      generation counts, and the obvious shortcut for those does not hold.
      Near-equal output totals (16.6K vs 14.7K) do **not** imply near-equal
      call counts, because the two prompts ask for different amounts: an
      article summary is one sentence (`api/summary.ts:466`), a comments
      summary is up to five insights (`api/comments-summary.ts:425-452`), so a
      comments call emits several times the output of an article one. The two
      sides of the report also point opposite ways on frequency — Finding 5's
      per-outcome table and Finding 2's 96–99% comments change rate — which is
      the tell that no per-call ratio is recoverable from track aggregates at
      all. **One side is directly available and the other is not.** Finding 5
      gives the article track per outcome: 410 `changed` + 89 `first_seen` =
      **499 generations/day** against 5.04M prompt tokens, i.e. **~10,100
      prompt tokens per article generation** (and ~33 output, consistent with
      one sentence). The comments track has no equivalent table — the report
      says its deeper analyses were filtered to `track == "article"` — so its
      per-call figure has to come from the logged `first_seen`/`changed`
      counts for that track, or from per-call token spend measured directly.
      Do that before setting any weight; an earlier draft of this item
      asserted ~11× off the equal-output shortcut and it was wrong.
      **Define the window before any of this is implementable.** "A global
      counter per window" is not yet a ceiling: three things decide what it
      enforces, and none is settled here. **Duration** — a short window lets
      the same budget be spent again every time it rolls, so an hourly window
      with a daily-sized threshold protects nothing; the window has to be the
      period the ceiling is expressed in, which for this app means matching
      the **monthly** GCP billing budget the breaker backstops, with a
      shorter window only as a separate burst tier on top. **Align it to
      the provider's actual reset boundary, not to an arbitrary 30 days.**
      A window starting at the first increment, or an epoch-aligned fixed
      window of the kind `checkRateLimit` uses, straddles a calendar
      billing reset — and a window straddling the reset admits close to two
      thresholds inside one billed month, which is the one thing a monthly
      breaker exists to prevent. Either pin the window to the provider
      budget's own reset date, or use a rolling window with carry-over.
      Cheap to get right at design time and invisible until the month it
      fails. **Reset** — a
      fixed-window key with a TTL (the shape `checkRateLimit` already uses)
      resets cleanly; a counter with no expiry eventually sheds every
      generation permanently, which looks identical to the feature being
      broken. **Threshold** — a spend number, not a call count, per the
      weighting above. Until those three exist, none of the daily and monthly
      figures below can be related to what the breaker actually protects,
      which is the point of computing them.
      **Cost:** priced that way the cron's ceiling and its
      steady state are far apart. With the two reservation points above —
      Jina then Gemini on the article track, Gemini alone on the comments
      track — 288 ticks/day x 30 stories x 3 reservations bounds it at
      **~26k `INCR`s/day, ~778k/month, ~$1.56/month** at Upstash's ~$0.20
      per 100k commands, on top of the ~$1 the two-key backoff read already
      costs (`SPEC.md` §Warm-summaries cron). (It was ~17k/day and ~$1 when
      this assumed one reservation per track; the Jina fetches being metered
      is what moved it, and the two figures have to stay in step.) That is
      the pathological case where nothing is skipped and everything
      regenerates. In steady state the backoff is doing its job and most
      tracks never reach the increment, so treat ~$1.56/month as the bound,
      not the bill. **The request path is priced by the same
      two-reservation rule, so it is not one `INCR` per uncached summary
      either** — it is one per billable call, and how many that is depends on
      the story. An uncached `/api/summary` on a **link** story reserves
      twice, Jina then Gemini; on a **self-post** it reserves once, because
      the Jina fetch is gated on `hasArticleUrl` (`api/summary.ts:962`) and a
      self-post is summarized from the stored HN `text`. An uncached
      `/api/comments-summary` reserves once — that endpoint has no Jina at
      all. So a cold link story with comments is three reservations, a cold
      self-post two. **Bound it rather than calling it "cheap", since the
      section above supplies the traffic to bound it with — and the answer
      turns entirely on whether cross-client single-flight lands first.**
      Reservations happen only on a cache *miss* (a hit returns before any
      provider call), so:
      - **Single-flight first:** the reservations are bounded by *distinct
        cold stories*, not by visitors — one winner reserves and everyone
        else waits on it. The cron already keeps the top 30 warm, so the
        cold set is the long tail: order thousands of commands a day,
        genuinely negligible, and it stays negligible as traffic grows.
        That is a second, independent reason to land single-flight before
        the breaker rather than after.
      - **Without it:** every client that misses reserves, so it scales with
        visitors × cold rows. At the launch-day bound — 10,000 visitors,
        thirty rows, three reservations for a cold link story with comments —
        that is up to **~900k commands (~$1.80) in a day**, on top of the
        ~1.2 M cache reads, and it is the same shape as the Gemini stampede
        rather than a separate risk. The realistic figure is far lower
        because most of `/top` is warm, but it is the same unmeasured
        cold-row share as everywhere else in this section, so don't invent
        one — record the ordering assumption instead.
      Don't reuse the cron's per-check figure here either way: same rule,
      different mix.
      **Outage:** Redis unavailable is the case that decides what the breaker
      is *for*, and both answers are bad in a different direction. Failing open
      matches `checkRateLimit`'s existing per-tier `continue` and keeps
      summaries live, but removes the only global spend protection at exactly
      the moment the record reads have *also* stopped gating (same section: an
      unreachable Redis loses the backoff and pushes eligible tracks into the
      regenerate path), so the two failures compound into the worst-case bill.
      Failing closed bounds the spend and takes live summarization down with
      it. Recommendation: **fail closed on both paths**, written down with its
      reason before the breaker ships rather than after. Open on the request
      path is the tempting answer and it is wrong for this app's launch shape:
      `warmFeedSummaries` fires `/api/summary` **and** `/api/comments-summary`
      for every row that scrolls into view (`StoryList.tsx:813`), so a crowd of
      first-time visitors *is* the request path, not a side channel to it. And
      during a Redis outage everything else there has already failed open — the
      cache read treats an error as a miss and proceeds to live generation, and
      the per-IP limiter `continue`s past its own failure — so a breaker that
      also fails open leaves nothing bounding spend at the one moment it is
      needed. Closed costs live summarization during the outage; the page still
      serves cached-or-nothing, which is a degradation rather than a broken app.
- [ ] **Give the shed path its own outcome code and copy.** The existing
      `summary_budget_exhausted` / 503 degradation is emitted *only* for Jina
      402/429 (see the Gemini-ceiling item above), so a request shed by the
      breaker would fall through to `summarization_failed` / 502 and read to a
      visitor as a broken summary rather than a temporary limit. A breaker that
      sheds into the generic error path repeats the exact failure the
      degradation work above exists to prevent.
- [ ] **Confirm rate limiting holds under a real spike, not just a loop —
      and drive it from SHARED addresses, not distinct ones.** The existing
      limiter was built for a refetch loop from one bad client; thousands of
      legitimate first-time visitors is a different shape and must not be
      mistaken for abuse. But `checkRateLimit` keys every bucket by
      `normalizedIp` (`api/summary.ts:157-165`, IPv6 truncated to its `/64`),
      so a spike from **distinct** addresses cannot trip it however large it
      gets — a check built that way passes without exercising anything. The
      false-positive case is many legitimate readers **behind one address**:
      carrier-grade NAT, an office or campus egress, a shared `/64`. With four
      debits per hot row against a 20-per-10-minute bucket, five cold rows
      spend it, so a handful of readers on one NAT start seeing 429s.
      **So this is ONE test, from one machine, not two** — the shared-address
      cohort is the whole rate-limit check, and one load generator is already
      one address. Don't pay for the other one: `extractClientIp` prefers
      Vercel's `x-real-ip`, which the proxy sets from the actual peer
      specifically so a client cannot influence it (`api/summary.ts:101-116`
      says so in its own comment), so a distinct-address cohort cannot be
      faked with headers — it needs genuinely distributed egress, a paid
      load-testing service, to run a check established above as unable to
      fail. What that infrastructure *would* exercise is Vercel/Redis/Gemini
      capacity under concurrency, which is a real question but a different one
      and a separately-costed item, not a rate-limit test.
- [ ] **Re-derive this test's objective from whichever limiter design is
      chosen — as written it now describes a system the prerequisite above
      removes.** "Exhaust a 20-per-10-minute window with a shared-address
      cold scroll" was written against today's limiter, and the dedup +
      capacity change makes that arithmetic obsolete in both directions: run
      it *before* the fix and it cannot meet the pass criterion (thirty rows,
      no 429), run it *after* and the four-debits-per-row scenario it
      describes no longer exists. So the load and the expected threshold are
      not writable until the design is: **re-tiered burst** means a
      shared-address scroll of N rows against the new allowance, checking the
      wall lands where the new tier says; **prefetch exempted** means proving
      speculative warms cost nothing while a demand-traffic burst still trips
      at the old figure, which is a different test with a different fixture.
      Write it once the choice is recorded, and keep only the two things that
      hold either way: it must run on a **cold** cache (a warm one never
      touches the bucket) and from a **shared** address (the cohort that
      matters, per the item above).
- [ ] **Prerequisite for running that check at all — it spends a real bucket.**
      Whatever threshold it ends up exercising, exhausting it is the *point*
      of the test, so against production every reader sharing that egress
      address eats 429s until the window rolls. Same shape as the Jina smoke
      test above — with the difference that this one *does* recover on its
      own: run it somewhere else, and name where before requiring it.
      The catch is that "somewhere else" is not automatic:
      `RATE_LIMIT_KEY_PREFIX` is a bare constant with no environment segment
      (`api/summary.ts:37`,
      `api/comments-summary.ts:95`) and the store comes from
      `KV_REST_API_URL` / `UPSTASH_REDIS_REST_URL`, so a preview deployment
      that inherits production's Upstash credentials shares production's
      buckets exactly. Confirm the preview has its own store (or give the
      prefix an environment segment) **before** the first run; the recovery
      window is bounded — ten minutes, no manual cleanup — but it is ten
      minutes of real 429s if this is got wrong.

### Alerting — see `OBSERVABILITY.md`, don't restate it here

An earlier draft of this section said there was no alerting and proposed
picking "two or three" conditions. Both were wrong, and a second plan competing
with the real one is worse than no plan: `OBSERVABILITY.md` is the ground truth
and already has a **configured** Gemini spend alert emailing the operator
(§"Gemini spend alert"), already selects **four** alert conditions
(§"What we want to know"), and already defines the phases from Axiom monitors
to phone paging — with the cost and failure analysis the paging dependency
needs.

- [ ] Work the remaining phases there (Phase 2 monitors → Phase 3 paging),
      rather than re-deciding conditions that are already chosen.

### Funnel instrumentation (for the readmo bridge)

The `newshacker-sync` bridge already mirrors Done and Pinned state both ways
(readmo's `newshacker_link`, 0050, and the `apply_newshacker_state` RPCs), so
the usual funnel-killer — starting over with an empty account — is largely
solved. What is missing is knowing whether anyone crosses.

- [ ] Instrument the crossing: link established, and how many linked users are
      active in both. Without it, "does cross-promotion work?" is unanswerable
      and the 1–3% expectation stays a guess.
- [ ] Present the bridge as a product feature, not an ad — *"You read HN here.
      Read everything else the same way, and your Done and Pinned state comes
      with you."* Propose the wording to the repo owner and wait for a yes
      before it ships. (Stated here rather than cited: this repo's `AGENTS.md`
      has no copy sign-off rule — that is readmo's guardrail 12 — so an earlier
      draft's "see AGENTS.md" pointed at nothing.)

### Before any Show HN

- [ ] Confirm the "unofficial, not affiliated with Y Combinator" framing is
      unmissable on first load. It is already a golden rule; a launch day is
      when it gets tested.
- [ ] Have the spend ceiling and the degrade path verified first. The failure
      mode of a good launch is a bill or a broken app, and both are avoidable.
