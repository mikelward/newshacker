# OBSERVABILITY.md

How we notice when newshacker is burning money or serving errors, and
how we get paged about it. Playbook lives here; day-to-day log reading
still happens in Vercel + Axiom.

> **Status: planning doc.** Nothing in the § "Planned" sections below
> is wired up yet. The current state section is the ground truth for
> what is actually deployed today. Phases ship in small PRs; each one
> moves items from Planned → Current state in this file in the same
> commit.

## Goals

Two things, in priority order:

1. **Page when spend is about to run away.** Gemini spend or Jina
   credit draining faster than expected — the kind of thing that
   turns a $5/month bill into a $500/month bill while we sleep.
2. **Page when we're serving errors at a noticeable rate.** Summary
   generation failing, Jina returning CAPTCHAs, rate-limit 429s
   bursting (someone found us and is hammering), cache-hit rate
   collapsing (cron wedged).

Both goals are "wake me up"-grade; a dashboard-only solution isn't
enough.

## Current state

What's actually running today:

- **Gemini spend alert.** Google Cloud Billing budget on the project
  backing `GOOGLE_API_KEY`, with email alerts at 50 / 80 / 100 % of
  monthly cap. **Already configured by the operator.** This is the
  most authoritative spend signal — GCP bills us directly, so the
  number is ground truth rather than derived from logs.
- **Jina wallet visibility.** Manual eyeball via `/admin`, which
  includes a live Jina wallet balance probe (shipped in
  `a3cbe63` / `2844c46`). No automated alerting yet.
- **Log aggregation.** Vercel function logs forward to **Axiom** via
  the Vercel integration. APL query templates already live in
  `CRON.md` § "Useful APL queries (Axiom)" for the warm cron's
  outcome histogram. No alert monitors configured on top of Axiom
  yet — queries are ad-hoc.
- **Existing structured log lines.**
  - `summary-outcome` / `comments-summary-outcome` — `api/summary.ts`
    and `api/comments-summary.ts`, one line per request. Carries
    outcome (cached / generated / rate_limited / error), reason on
    errors, summary length, Gemini prompt/output/total tokens, and
    (for URL posts) Jina tokens. Schema in § "Log event taxonomy"
    below.
  - `summary-jina-payment-required` — `api/summary.ts`, fires when
    Jina returns 402 or 429 on an article fetch. Dedicated alert
    signal, still emitted alongside the `summary-outcome` line.
  - `warm-story` / `warm-run` — cron telemetry documented in
    `CRON.md`.

No paging tool is wired up. A budget alert email is the only thing
that actually pings the operator today.

## What we want to know (alert conditions)

Four conditions are the initial target set. Thresholds are starting
guesses — re-tune after a week of real data.

1. **Cache-hit-rate collapse on summary endpoints.** Over any 1 h
   window, `outcome == "cached"` share drops below 50 %. Usually
   means the warm cron is wedged or KV is flapping — either way
   we're about to pay Gemini per user rather than per story.
2. **Jina credit exhausted.** Any `summary-jina-payment-required`
   log line in the last 5 min (not already alerted in the last 1 h,
   to avoid storming the operator during a sustained outage).
3. **Gemini failure rate.** `summarization_failed` / total summary
   requests over 15 min > 5 %. Usually Gemini itself flaking, but
   could also be prompt-level refusals.
4. **Rate-limit 429 burst.** `outcome == "rate_limited"` > 50 per
   hour. Someone found us and is hammering; time to look at whether
   the per-IP thresholds need tightening or we want an explicit
   block.

These are all "page the operator" conditions, not "file a ticket"
conditions. If a condition is noisy enough to warrant a ticket
workflow instead, it doesn't belong on this list.

## Log event taxonomy

Every alert condition above has to resolve to a log query, which
means we need a small, stable set of event types. The contract: each
event is a single JSON line with a `type` field; downstream queries
key off `type` and filter on the fields documented here. New event
types get documented here in the same commit they ship in.

### Existing (deployed today)

- **`summary-jina-payment-required`** — `api/summary.ts`.
  Fires exactly when Jina returns HTTP 402 or 429 on an article
  fetch. Fields: `{ type, storyId, articleUrl }`. Dedicated alert
  signal for Jina credit exhaustion, emitted alongside the
  `summary-outcome` line below.
- **`summary-outcome`** — `api/summary.ts`, one line per request
  to `/api/summary`. Shape:
  ```json
  {
    "type": "summary-outcome",
    "endpoint": "summary",
    "outcome": "cached" | "generated" | "rate_limited" | "error",
    "reason": "<stable string, absent on cached / generated>",
    "storyId": 1234,
    "chars": 230,
    "geminiPromptTokens": 1234,
    "geminiOutputTokens": 56,
    "geminiTotalTokens": 1290,
    "jinaTokens": 4567,
    "paywalled": false
  }
  ```
  `outcome` covers the four alert conditions: cache-hit ratio
  (`cached / total`), error rate (`error / total`, broken down by
  `reason`), and 429 burst count (`rate_limited` over time).
  `chars` is the summary length (on `cached` / `generated`) — feeds
  skeleton sizing. Gemini token fields are present on every
  generated summary; `jinaTokens` is present on URL-post
  generations only (self-posts don't round-trip Jina).
  `paywalled` is the `detectPaywall()` verdict on the Jina-clean
  body — present on `cached` (when the stored record carries it)
  and `generated` (URL posts only); absent on self-posts, on
  errors before the Jina round-trip, and on legacy cached records
  written before the detector landed. Advisory only today: nothing
  in the handler branches on it, so a faulty detector can't hide a
  real summary. For paywall-prevalence queries, filter `outcome in
  ("cached", "generated") and isnotnull(paywalled)` to get the
  detector's universe; raw counts by `paywalled` tell you the
  share. See also the matching field on `warm-story` lines —
  prevalence from the cron's top-N slice is the cleanest
  per-domain signal.
  `reason` values: `forbidden`, `invalid_id`, `story_unreachable`,
  `story_not_available`, `low_score`, `no_article`,
  `not_configured`, `source_timeout`, `summary_budget_exhausted`,
  `source_unreachable`, `summarization_failed`, `source_captcha`.
- **`comments-summary-outcome`** — `api/comments-summary.ts`, one
  line per request. Shape mirrors `summary-outcome` with
  `endpoint: "comments-summary"` and two differences: `chars` is
  the sum of characters across all returned insights (so a single
  metric covers "total content surfaced to the user"),
  `insightCount` is added, and `jinaTokens` is omitted (this
  endpoint never calls Jina). Reasons omit Jina-specific ones;
  `no_comments` replaces `no_article` for the "nothing to
  summarize" case.
- **`warm-story`** — `api/warm-summaries.ts`, one line per id processed
  by the cron. See `CRON.md` § "Useful APL queries (Axiom)" for the
  full schema; the outcome field (`unchanged` / `changed` /
  `skipped_*` / `error`) is the primary cron-health signal.
  Article-track lines carry the Jina-billed `tokens` count from the
  Reader response on outcomes that fetched the article. Both tracks
  carry `geminiPromptTokens` / `geminiOutputTokens` /
  `geminiTotalTokens` on `first_seen` and `changed` outcomes —
  same field names as on `summary-outcome` / `comments-summary-outcome`,
  so a single APL query can sum Gemini spend across user + cron
  paths. Closes the gap that used to make warm-cron Gemini spend
  invisible to the `/admin` Token-spend card.
- **`warm-run`** — `api/warm-summaries.ts`, one line per cron tick
  with the roll-up counts. Schema in `CRON.md`. Carries
  `articleTokensTotal` (Jina), plus `geminiPromptTokensTotal` /
  `geminiOutputTokensTotal` summed across both tracks for tick-level
  Gemini spend visibility.

### Deliberately not logged

- **Client IP / normalized IP bucket.** The rate-limit path has
  access to the normalized `/64`-or-IPv4 key but the log line must
  not include it. An IP address in a log line is PII under most
  data-protection regimes, and we don't need it for any of the
  four alert conditions. If a future condition genuinely needs
  per-IP aggregation, revisit with a hashing scheme so the log
  line carries an opaque bucket id, not the address.
- **newshacker-user-generated content.** If/when this app gains
  user-submitted text (profile bio, saved-list notes, anything
  typed into our UI), that content does not go into logs. It's
  user-attributable, the user did not opt in to log retention,
  and we don't need it for alerts.
- **Article URL / title / body text.** Not needed for alerts;
  leaking user-visible content into logs is gratuitous. The
  warm-cron emits boolean / hash / count signals instead
  (`titleChanged`, `ledeChanged`, `correctionKeywordDelta`,
  `linkCountDelta`, `deltaBytes`) — same analytical leverage
  without the content.
- **Gemini / Jina raw request or response bodies.** Same reasoning;
  also expensive in log volume.

The `summary-jina-payment-required` line does carry
`articleUrl` — keep it, because the operator genuinely needs it to
triage which publisher tripped a CAPTCHA, and Jina's upstream URL
isn't user-identifying in the same way an IP is.

### Cached vs. logged: what `SummaryRecord` keeps in Redis

The warm-cron's `SummaryRecord` (Upstash Redis, 30-day TTL)
persists a small set of fields that look like content but never
leave the cron's own state path: the HN `title`, a `ledeHash`,
the markdown `bodySample` (first ~1 KB of the Jina-clean body),
plus the structured `correctionKeywordCounts` / `linkCount`
fingerprints. These are needed for tick-over-tick comparison —
"did the title change since last check?" requires comparing
this tick's HN title against the prior one — and may eventually
back an authenticated debug endpoint for spot-checking specific
events.

This is **not** a relaxation of the no-content-in-logs rule
above. Redis is internal cron state, not exported, not surfaced
to users, not in Vercel/Axiom's log retention. The `bodySample`
is a 1 KB prefix of HN-public article content (fetched from a
public API), not anything typed by a newshacker user. If/when
the debug-endpoint use case is built, that endpoint sits behind
the same HN-verified admin gate as `/api/admin` — see
`AGENTS.md` § *Sensitive operator data*.

## Monitoring layer (where the log queries + monitors live)

Two candidates, treated as peers. The "right" answer depends on
how much chainsaw you want to run vs how much integration-with-
existing-state matters.

### Axiom (current state)

Vercel's Axiom integration is already installed and shipping every
function log line. APL queries for the cron already live in
`CRON.md`.

- **Cost:** Axiom's free tier on the Vercel integration covers
  ~500 GB/month ingest and 30 days retention, which is orders of
  magnitude above this project's actual volume. Effectively $0.
- **Monitors:** Axiom has a "Monitors" feature in the paid tier;
  the free tier supports basic alert-on-query with a limited
  monitor count. Enough for the four conditions above.
- **Webhook delivery:** monitors can fire to arbitrary webhooks,
  email, and a handful of first-class integrations. This matters
  for the paging-layer decision below.
- **What you learn:** APL (Axiom's query language — a pipeline
  syntax similar to Kusto / Splunk SPL). Useful, but not as
  transferable as the mainstream alternatives.
- **Effort to use:** zero. Everything's already wired.

### Datadog (candidate)

Datadog is a full observability platform — log search, metrics,
APM, synthetic monitors, SLO tracking, anomaly detection,
dashboards, and alerting. Vercel has a first-class Datadog Log
Forwarder integration that ships logs the same way the Axiom
integration does.

- **Cost:** Datadog's free tier covers 5 hosts and 1 day of log
  retention — enough for this project's ingest rate, but tight
  on retention. The paid Logs tier starts at ~$0.10/GB ingested
  + retention fees; at this project's volume that's cents per
  month. A Datadog trial (14 days) gets you full product access
  to experiment. The **Pro tier** of the core platform starts at
  $15/host/month and up; for this project a single host is
  unnecessary — the serverless-function volume rides under the
  Vercel integration's log-forwarder pricing rather than the
  host-count pricing.
- **Monitors:** industrial-grade — log-based, metric-based,
  anomaly detection, multi-condition, dependent monitors
  (escalate only if X is still failing after 10 min).
- **Dashboards:** composable widgets, share links, template
  variables. Overkill for four monitors but useful to learn.
- **Delivery:** first-class integrations with OpsGenie,
  PagerDuty, Slack, email, webhooks, and Datadog's own mobile
  app (push notifications out of the box).
- **What you learn:** Datadog itself (widely used at $WORK-scale),
  its monitor DSL, log pipelines and facets, SLO modeling. High
  transfer value for dev/SRE roles.
- **Effort to use:** real. Install the Vercel integration, either
  alongside Axiom or instead of it; port the CRON.md APL queries
  to Datadog Logs Query syntax; build monitors in the Datadog UI
  (no first-class "monitors-as-code" story unless you layer in
  Terraform — doable, not beginner-friendly).

### Tradeoff in one line

Axiom is already wired and free. Datadog teaches you more. Neither
is wrong; which one is right depends on whether you value the
learning dividend enough to do the migration work.

### Recommended approach

Two sub-options worth considering; either works:

1. **Dual-ship logs for a week.** Install the Datadog Vercel
   integration alongside the existing Axiom one. Both free tiers
   handle the volume. Build the four monitors in Datadog, leave
   Axiom wired as the "familiar tool" fallback. After a week of
   real data, decide whether Datadog has earned the spot or
   whether Axiom's simpler model is a better fit, then uninstall
   the loser.
2. **Go Datadog outright.** Install Datadog, uninstall Axiom in
   the same commit (or a follow-up), rewrite the CRON.md APL
   snippets as Datadog Logs Query. No transition period. More
   rip-the-bandaid, less safety net.

Option 1 is low-risk and matches the "experiment to learn"
motivation. Option 2 is cleaner operationally but commits harder
before the learnings are in.

Whichever option, **the log event taxonomy above is agnostic** —
the JSON shape is the contract, the query language reads it
either way.

## Paging layer (how alerts reach a phone)

The monitoring layer emits a webhook (or calls a first-class
integration); the paging layer is whatever catches that webhook
and buzzes the operator. These are separable choices — most
monitoring tools can fan out to most paging tools.

Five heavyweight candidates treated as peers, plus three lighter
alternatives for the "record" of what was considered.

### Heavyweight options (peers)

#### OpsGenie (Atlassian) — CLOSED TO NEW CUSTOMERS

> Kept for the comparison it provides, not as an option. Atlassian ended
> new OpsGenie sales in June 2025 with end of support announced for April
> 2027, so nothing here can be signed up for. Everything the survey says
> about paging-first products still reads true of its peers — which is why
> the section stays — but treat every availability and pricing claim in
> this whole survey as needing a re-check before it is acted on: it was
> written at one moment, and at least two products in it have since
> retired (see also Grafana Cloud OnCall, closed to new customers March
> 2025 and end-of-life March 2026).

Paging-first. Incident management is the whole product.

- **What it does:** alert routing, on-call schedules, escalation
  policies (page A → if unacked in 5 min, page B), deduplication,
  acknowledgement tracking, incident timelines, status pages.
- **How alerts arrive:** native iOS / Android app (push
  notifications, including "override silent mode" for critical),
  SMS, voice call, email. Mobile app is the primary channel.
- **Cost:** free tier covers up to 5 users, unlimited alerts,
  mobile push + email. SMS and voice are capped monthly; adequate
  for side-project volume. Paid tiers add escalation rules and
  schedules.
- **Integration with monitoring layer:** Datadog → OpsGenie is
  first-class; Axiom → OpsGenie via webhook (one hop less polished
  but works).
- **Transfer value:** paging workflow specialist — rotation design,
  escalation, acknowledgement hygiene. High if $WORK has or will
  have an on-call rotation.
- **Fit for this use case:** purpose-built for exactly this. Free
  tier is generous, app's "emergency override DND" is what you
  want for "Jina credit is gone"-class alerts.

#### PagerDuty

The original — and still the most common — paging platform in
production SRE shops.

- **What it does:** same feature shape as OpsGenie (rotations,
  escalations, acknowledgements, incident timelines, status
  pages) with a longer track record, broader integration catalog,
  and more mature tooling around post-mortems and SLO tracking.
- **How alerts arrive:** native iOS / Android app with push, SMS,
  voice call (in select regions), email. Voice escalation is
  polished.
- **Cost:** free "Developer" tier covers 5 users with unlimited
  integrations for individual / side-project use. Professional
  starts at ~$21/user/month (annual) and adds SSO, advanced
  schedules, deeper analytics.
- **Integration with monitoring layer:** first-class Datadog
  integration; Axiom via webhook. Most major vendors ship a
  PagerDuty integration before any other paging tool because of
  market share.
- **Transfer value:** highest of the paging-first options —
  PagerDuty is the lingua franca of on-call rotations across the
  industry. Patterns learned here apply almost anywhere.
- **Fit for this use case:** equivalent to OpsGenie in raw
  capability; pick one over the other based on which ecosystem
  you want to learn or which your workplace uses. Free tier fits
  solo-operator use cleanly.

#### Datadog (same tool as monitoring layer)

If Datadog is already chosen for monitors, its built-in
notification targets include a mobile app with push notifications
that rivals OpsGenie / PagerDuty for the single-operator case.

- **What it does:** monitor → Datadog mobile app push → phone.
  Also SMS (paid tier), email, Slack, PagerDuty / OpsGenie as
  first-class integrations. Datadog does *not* natively do
  on-call rotations or escalation policies — for that you bolt on
  OpsGenie / PagerDuty / incident.io.
- **Cost:** push notifications to the Datadog mobile app are
  included in any subscription, free tier upwards. SMS and voice
  are paid features.
- **Transfer value:** overlaps with the monitoring-layer learning
  above. Less paging-workflow depth than OpsGenie / PagerDuty;
  more unified tooling if Datadog is already in the stack.
- **Fit for this use case:** works well as a single-tool stack.
  Less incident-workflow polish than OpsGenie / PagerDuty, more
  than enough for solo operator + four monitors.

#### Better Stack

Newer, opinionated "logs + uptime + incidents" platform that
bundles the monitoring and paging layers together with a clean UI
and aggressive free tier.

- **What it does:** log ingest and search, uptime / heartbeat
  monitors, incident management with on-call schedules and
  escalation, and status pages — all in one product. Incident
  workflow is lighter than OpsGenie / PagerDuty but covers the
  essentials.
- **How alerts arrive:** native iOS / Android app with push, SMS,
  phone call, email, Slack.
- **Cost:** generous free tier (3 monitors, 3 GB/mo log ingest, a
  small number of incidents/users). Paid plans start around
  $29/mo and scale per seat / ingest / monitor. Competitive with
  Datadog + OpsGenie combined at small scale.
- **Integration with monitoring layer:** if used as the monitoring
  layer too, no integration needed — it's one tool. If used only
  for paging, supports webhook-in and has first-class adapters
  for Datadog, Prometheus, Grafana.
- **Transfer value:** medium. Growing adoption, opinionated UX
  worth seeing, but less mainstream than PagerDuty / Datadog.
  Good exposure to "one-tool" observability thinking.
- **Fit for this use case:** tempting if you want to replace both
  Axiom and OpsGenie with a single, cheaper tool. Less depth per
  feature than the specialists.

#### incident.io

Incident-response-first rather than paging-first. On-call is a
recent addition; the core value prop is the incident *lifecycle*
(declare → coordinate → post-mortem → retrospective).

- **What it does:** incident declaration, Slack-centric incident
  channels with bot workflows, severity levels, timelines,
  post-mortem templates, status pages. The on-call side handles
  schedules and escalation but is newer and less feature-dense
  than OpsGenie / PagerDuty.
- **How alerts arrive:** mobile app push, SMS, phone, email — via
  the on-call product.
- **Cost:** free tier covers small teams; paid tiers start around
  $20/responder/month for on-call, more for the full incident
  platform.
- **Integration with monitoring layer:** supports webhook-in and
  integrations with Datadog / Grafana / similar. Pairs naturally
  with a monitoring tool upstream.
- **Transfer value:** medium-high. Growing adoption in
  tech-forward companies; the "incident lifecycle as a product"
  approach is a useful contrast to pure-paging tools. **Caveat:**
  the Slack-centric workflow is core to the value prop, and this
  operator doesn't use Slack — which blunts most of what
  incident.io is distinctive for.
- **Fit for this use case:** OK as a paging tool, but the bulk of
  its value is in the post-page incident response workflow that
  a solo operator with no Slack doesn't really exercise.
  Documented here for the "record of what was considered," not as
  a strong candidate.

### Picking between the heavyweights

Paging is the operator's stated primary goal. Decision guide:

> **OpsGenie is not on this list**, though the survey above still
> describes it: it is closed to new customers, so "pick" is not a thing
> anyone can do with it. Its entry stays for the comparison; this guide
> is instructions, and instructions that name an unavailable product
> waste a reader's time at exactly the moment they are acting.

- **Pick PagerDuty** if you want the most broadly transferable
  paging-workflow learning (it's the industry default), and are
  OK with the paid-tier ceiling once you outgrow the Developer
  tier.
- **Pick Datadog** if you want the whole stack in one tool and
  paging is "good enough, not deep." Simpler operationally; less
  paging-specific depth.
- **Pick Better Stack** if you want a cheaper, newer
  one-tool-for-everything alternative to a monitoring-plus-paging pair
  and are willing to accept less depth per feature.
- **Pick incident.io** only if you plan to grow into full
  incident-lifecycle workflows and are OK working in Slack. Weak
  match for the current single-operator, no-Slack setup.
- **Pick two** — e.g. Datadog for monitors + a paging specialist
  for paging — if you want to exercise the real-world separation
  between the observability platform and the incident manager. Most
  "chainsaw-like" layout and the closest match to what a production
  SRE team runs.

### Lighter alternatives (documented for the record, not the primary pitch)

- **ntfy.sh.** Free, open-source, POST a message to a topic, phone
  gets pushed. iOS / Android / web apps. Topics are public by
  default — pick an unguessable name, or pay $5/mo for
  authenticated topics, or self-host. No on-call rotation, no
  escalation, no acknowledgement — just push. Great for the
  "I want a notification" layer; not a paging tool.
- **Twilio SMS.** Send SMS via Twilio's Messages API. Needs an
  account, a phone number (~$1/mo US), and ~$0.008/SMS US
  (~$0.07 international). Would be wired as a tiny
  `/api/notify-sms` serverless proxy so we don't expose the
  Twilio credentials to the monitoring tool. Works universally
  (any phone receives SMS), but no read-receipt, no
  acknowledgement, and no escalation. Viable secondary channel
  under a paging tool; weak as the primary layer.
- **Email.** What the GCP budget alerts already use. Zero setup,
  universal, but latency + attention model is worst-in-class —
  email is where alerts go to be ignored. Fine as a fallback
  when the primary channel fails; insufficient as the only
  channel for "wake me up"-grade alerts.

### What doesn't fit

- **Slack / Discord.** Operator doesn't use Slack; Discord would
  work (via webhook) but doesn't match the "wake me up"
  requirement — Discord pings are easy to miss. This is also why
  incident.io is a weaker match than its capabilities suggest —
  its core workflow assumes a Slack workspace.

### Recommended stack (paging-first)

Given paging is the stated primary goal:

- **Monitors:** either Axiom (current, free) or Datadog (learning
  dividend). Both route cleanly to any of the paging heavyweights.
- **Paging:** a paging-first specialist on its free tier, mobile app
  push as the primary delivery, email as a secondary route for
  non-critical alerts. PagerDuty is the one this survey compared that is
  still open to signups. Confirm availability and free-tier terms before
  committing — see Phase 3, and note that this survey has already
  outlived two of the products in it.
  **Datadog's own push is a one-tool alternative only once Datadog hosts
  the monitors** — its notification targets fire from Datadog monitors,
  so with the monitors still in Axiom it is not reachable and there is no
  route to the phone. Choosing it means doing Phase 4 first, which is a
  bigger decision than picking a pager.
- **Optional:** Twilio-SMS backchannel via a serverless proxy if
  the chosen paging tool's free SMS cap becomes a constraint. Not
  needed to start.

## Phased implementation

Ship in order; each phase leaves the tree in a shippable state and
is independently revertable.

### Phase 1 — log instrumentation (shipped)

Shipped:
- `summary-outcome` JSON log line in `api/summary.ts`, emitted on
  every return path (cache hit, generate, rate-limited, all error
  branches).
- `comments-summary-outcome` equivalent in
  `api/comments-summary.ts`.
- **Token telemetry** captured at the same time: Gemini prompt /
  output / total counts (from `response.usageMetadata`) on every
  generated summary, Jina token count (from the reader envelope's
  `usage.tokens`) on URL-post generations. Closes the "we can't
  tell where spend is actually going" gap — previously tracked
  only on the cron path, not user-driven requests.
- **Length metric** (`chars`) on cached + generated outcomes;
  satisfies half of the `IMPLEMENTATION_PLAN.md` "summary length
  metric + cap" open item — the cap half is deferred until the
  logs reveal the real-world distribution.
- Tests assert shape via `console.log` spies on representative
  paths (cache hit, generate with full token metadata, a
  rate-limited request, a validation-error request, and the
  Jina-credit-exhausted path which still fires the existing
  `summary-jina-payment-required` alert alongside the new
  outcome line).

Still to do in later phases: Axiom monitors keying off these
lines (Phase 2), paging-provider integration (Phase 3), and
optionally Datadog migration (Phase 4).

### Phase 1.5 — in-app analytics dashboard (shipped)

Sits between Phase 1 (logs) and Phase 2 (monitors): an
operator-facing rollup on `/admin` over the same Phase 1 log
lines, so the operator can see "is the cache hit rate cratering?"
or "is `story_unreachable` suddenly the top failure reason?"
without opening Axiom. Doesn't replace monitors — Phase 2 still
needs to fire when nobody's looking — but it makes the alert
conditions concrete *before* you've built the monitors, which is
useful for picking thresholds that aren't pulled out of thin air.

Shipped:
- `GET /api/admin-stats` with the same HN-round-trip auth gate as
  `/api/admin`. Issues five APL queries against
  `https://api.axiom.co/v1/datasets/_apl?format=tabular` in
  parallel, each with a 5 s hard timeout, and degrades any single
  failed card to `{ ok: false, reason }` so the rest of the
  dashboard still paints.
- Five cards on `/admin`: cache-hit ratio (1 h), token spend
  (24 h), top failure reasons (24 h), rate-limited count (1 h),
  warm-cron last-run summary (6 h). All key off the Phase 1 log
  lines unchanged — no new instrumentation needed.
- Configured via `AXIOM_API_TOKEN` (Query → CREATE on the dataset)
  and `AXIOM_DATASET` env vars; both unset → the section renders
  a "not configured" hint and skips the queries. Token value is
  never returned to the client (per `AGENTS.md` rule 12).
- See `SPEC.md` § *Operator analytics dashboard* for the rendered
  contract; see `INSTALL.md` § *Getting an Axiom API token* for
  the token-provisioning walkthrough.

Cost: Axiom's free Vercel-integration tier covers the query API.
Five small aggregation queries per `/admin` page load, a few page
loads per day = effectively $0/month. Reliability: Axiom is now
a runtime dep of the analytics section (only). Per-card timeout
caps worst-case page latency at 5 s.

### Phase 2 — monitors (Axiom first)

- Build the four monitors in Axiom against the Phase 1 log lines.
- Starting thresholds per § "What we want to know" — re-tune once a
  week of baseline data is in.
- Delivery: email first (free, zero setup), so we can see the
  monitors fire before the paging tool is wired.

**Definition of done:** each monitor fires at least once against
synthetic traffic (manually triggered); email arrives. No phone
push yet. **"Synthetic" here means matching records against the
UNCHANGED production query** — inject events shaped like the real log
lines and let each monitor's own thresholds and filters decide whether
they fire. This phase is the only step that tests those predicates, so
retargeting a query at something benign — which Phase 3 allows as a
delivery-only fallback — would sign this phase off with a malformed
threshold, project filter or time window still in place. And the
Jina-credit monitor cannot be fired by causing the real condition and
must not be: the app has no fault-injection path, so the only way to
produce that line for real is exhausting the shared production key
(`TODO.md` says **don't**). Inject its record like the others.

**Injecting a record — provision this before starting the phase, since
the gate above depends on it.** Post events into the Axiom dataset
through its ingest API, shaped like the Phase 1 log lines the monitor
queries. **Shaped like the ingested event, not like the log line** —
those are different things, and getting it wrong means a correct event
body that fires nothing. The Vercel integration wraps each stdout line
in an envelope and adds the fields every query filters on
(`['vercel.projectName']`, `['vercel.source'] == "lambda"`, the log
line itself under `message` — `CRON.md` § *APL gotchas* has the three
and why they are bracket-quoted); direct ingestion bypasses the
integration, so the payload has to reproduce them itself. Copy the
shape from a real row in the dataset rather than reconstructing it. That needs an **ingest-scoped token, which is a second
credential**: the existing `AXIOM_API_TOKEN` is Query → CREATE, read by
`/api/admin-stats` behind the HN-verified admin gate (`INSTALL.md`
§ *Getting an Axiom API token*), and widening a dashboard-read token to
write into the dataset is the wrong direction. Two consequences worth
planning for rather than discovering:
- **The synthetic records land in the same dataset as production logs**,
  so they show up in every query that reads those lines — `CRON.md`'s
  outcome histograms and the `/admin` cards included. **Tag them** with a
  field, and **add the exclusion in the same change** — a tag nothing
  filters on excludes nothing. **Scope it to the analytics and
  cost-reporting queries only**: `CRON.md`'s outcome histograms, the
  `/admin` cards, anything a spend figure is later derived from. The four
  **monitor predicates must keep seeing these events**, since matching
  them is the entire point of injecting one — excluding the tag there
  would make the injected record ineligible and leave Phase 2 with no way
  to fire a monitor at all. Otherwise a verification run quietly becomes
  a data point in the cost analysis the breaker weights are derived
  from.
- **Cost and reliability (rule 11):** effectively **$0**, and here is the
  threshold it is measured against rather than a pointer at one. Axiom's
  free **Personal plan advertises 500 GB/month of ingest**, with the paid
  **Axiom Cloud tier at a $25/month platform fee** for 1 TB
  ([axiom.co/pricing](https://axiom.co/pricing), as advertised September
  2026 — re-check before relying on it). A phase's worth of injected
  records is a few dozen events, kilobytes: **nine orders of magnitude**
  below that allowance. So the exact figure cannot change the answer, and
  a per-request ingest rate limit cannot bind on a handful of manual
  posts — that gap is the finding, not the number. No user-facing latency
  either, since nothing on a request path touches it, and dataset quota
  and retention consumption is negligible at this volume. If ingest is
  unavailable the only consequence is that this verification is blocked;
  nothing in production depends on it. (What *could* move the tier is the
  log volume the Vercel integration already ships — a separate,
  pre-existing line, not something this procedure adds to.)

### Phase 3 — paging (vendor NOT yet chosen)

> **This phase names no vendor, deliberately.** OpsGenie — which every step
> below used to hard-code — is no longer available to new customers:
> Atlassian ended new sales in June 2025, with end of support announced for
> April 2027. An earlier revision of this note suggested replacements off
> the top of its head and named a second retired product among them
> (Grafana Cloud OnCall, itself closed to new customers in March 2025 and
> end-of-life in March 2026). That is the failure mode this block now
> avoids: **a candidate list written without checking is worse than no
> list**, because each name reads as vetted.
>
> So the first step of this phase is a *check*, not a signup. Confirm
> current availability and free-tier terms directly with a provider before
> committing to it, and record its cost and reliability (AGENTS.md rule 11)
> as part of choosing. Nothing about the monitor wiring depends on which
> one: every step below is written provider-neutral and stands as-is once a
> name is filled in.

- **Choose a paging provider.** The requirements below are simply the later
  steps of this phase read backwards, **on the tier actually being chosen** —
  a capability behind a paid plan is not a capability if the plan is the free
  one. Check them before the account exists, because each is something an
  operator would otherwise discover after wiring everything up. If a step
  below ever changes, change this list with it.
  - **Reachable from Axiom** — an inbound webhook, or a first-class Axiom
    integration. Monitors live in Axiom after Phase 2 and the next step
    wires Axiom to the provider, so a provider that cannot be reached from
    it has no route to the phone at all. Anything that only receives alerts
    from a platform hosting its own monitors is out unless Phase 4 is pulled
    forward first, which is a separate decision with its own cost.
  - **Can override Do Not Disturb, and can be configured to do it per
    priority.** Two of the four monitors are P1 precisely so they wake
    someone; a provider whose push is an ordinary notification silently fails
    the one case the phase exists for, and fails it at 3 a.m. rather than in
    testing. But a provider offering only a *global* critical-alert toggle
    fails just as surely in the other direction, and it passes a check that
    asks only "can it override DND": the next step routes two monitors as P1
    and two as P3, and the definition of done requires the P3 to arrive
    **without** buzzing — so one switch for everything means either the two
    low-priority monitors wake you or the two urgent ones don't. Check that
    the override is settable per priority (or per rule) on the tier being
    chosen, not that the capability exists somewhere in the product.
  - **Exposes acknowledgement state**, since the definition of done requires
    it to be observable — without it there is no way to tell a page that was
    seen from one that was slept through.
  - **A Datadog integration is an input, not a veto**: Phase 4's cost turns
    on it — a provider Datadog can only reach through a generic webhook makes
    that migration re-wire and re-verify delivery rather than leave it alone.
    Phase 4 is optional, so this informs the choice rather than deciding it.

  Note its cost/reliability here either way, then create the account +
  install its mobile app.
- Wire Axiom webhook → the provider's integration endpoint for the four
  monitors.
- Configure alert priorities: Jina credit exhaustion + cache-hit
  collapse = P1 (DND override); Gemini failure + 429 burst = P3
  (push, no DND override).
- **Grant the provider's app the OS permission its override needs** —
  iOS Critical Alerts, or an Android channel allowed to bypass Do Not
  Disturb. Choosing a tier that *supports* override does not turn it on,
  and the difference is invisible until the night it matters.
- Silence the monitors' email delivery once provider push is
  confirmed working, to avoid double-paging.

**Definition of done:** a provider is chosen and its **cost and
reliability** both recorded — the selection step asks for both and this
gate kept only the half with a number on it. Reliability here means its
rate limits, what happens when either hop fails (Axiom → provider, and
provider → phone), and **what still pages when the provider is down**,
since a paging dependency with no answer to that is a single point of
failure for every alert routed through it. Then: email is silenced; the
provider's acknowledgement state is observable; and **all four monitors
are fired synthetically, one at a time, with the phone actually in Do
Not Disturb** — the two P1s (Jina credit exhaustion, cache-hit collapse)
each buzzing within ~60 s, the two P3s (Gemini failure, 429 burst) each
**arriving without buzzing**.

Four triggers, not two, and each stated positively — every clause here
replaces a version that a broken system satisfied:
- **Per monitor, not per priority.** Two monitors share each priority,
  so "one P1 and one P3" signs the phase off while the other two may
  never have been routed to the phone at all. Phase 2 proved each
  monitor's *email* delivery; the provider action configured here is a
  different wire, and only firing each one exercises it.
- **With DND on.** Testing a P1 with DND off proves the push works and
  leaves the override — the only reason P1 exists — unexercised.
- **Arriving, not merely silent.** "The P3 doesn't buzz" is satisfied
  just as well by a P3 that never arrives, which is exactly what a
  disconnected monitor looks like. Confirm each in the provider's
  delivery log, or in the notification shade once DND lifts.
- **Synthetically means a matching EVENT, not a recreated fault.** One
  of the four is Jina credit exhaustion, and the only thing that emits
  its line today is Jina actually returning 402/429 (`api/summary.ts`,
  the `payment_required` branch) — which against the production key
  means breaking summaries for real readers, with no recovery but the
  quota window, and `TODO.md` says **don't**. Read literally against
  that, "all four monitors" makes this phase either impossible or
  destructive, so the requirement above needs this clause to stand at
  all. Fire the *monitor*, not the fault — by the same record injection
  Phase 2 already set up (its definition of done covers the ingest
  credential, the tagging, and the cost note; don't restate them here).
  Failing that, point the monitor's query at a benign event that does
  occur, fire it, and restore the query afterward. Either exercises the
  wire this phase is about: monitor → Axiom webhook → provider → phone.
  **Retargeting is a fallback for this
  phase only** — Phase 2 has already proved each monitor's real query
  against its own thresholds, and doing it there instead would leave
  those untested, which is the one thing Phase 2 exists for.
- **Say what that leaves unproven**, rather than reading the phase as
  end-to-end. That the handler emits the line when Jina really does
  return 402 is a *separate* open item, blocked on a throwaway
  credential or a test-only injection point (`TODO.md`). This phase
  proves delivery; nothing in it proves detection of the real fault,
  and the two are worth keeping apart because only one of them is
  cheap.

### Phase 4 (optional) — migrate to Datadog

Only if the operator decides the learning dividend is worth it.
Rewrite APL queries as Datadog Logs Query, install Datadog Vercel
integration, either dual-ship or cut Axiom cleanly. Monitors get
rebuilt in Datadog's UI. **Whether the paging layer survives untouched
depends on the provider Phase 3 picked** — a first-class Datadog
integration means re-pointing the monitors and nothing else, while a
generic-webhook provider means rebuilding delivery and re-running the
synthetic trigger to prove the phone still buzzes. Phase 3 records
which one it is, so this is a known cost by the time anyone gets here
rather than a discovery mid-migration.

### Phase 5 (optional) — automated Jina wallet check

Schedule a daily cron that pulls the Jina wallet balance (same probe
as `/admin`) and emits a `jina-wallet-low` log line when below a
threshold. Axiom / Datadog monitor on that line, same paging path.
Low-priority backstop to the
`summary-jina-payment-required`-on-first-failure path that already
exists.

## Runbook stubs

One entry per monitor. Expand each as we encounter them in real
life; for now these are just "where to look first."

- **Cache-hit-rate collapse.**
  1. Check `/admin` for warm-summaries cron health.
  2. Grep Axiom for `warm-run` in the last hour; confirm ticks
     are firing.
  3. If the cron is dead: check Vercel Cron dashboard + `CRON.md`
     § "Verifying".
  4. If the cron is alive but `warm-story` outcomes are mostly
     `skipped_unreachable`: Jina is flaky (see next runbook).
  5. Temporarily harmless — the feature fails open to live
     Gemini — but unmitigated it eats budget fast.

- **Jina credit exhausted
  (`summary-jina-payment-required`).**
  1. Check `/admin` wallet balance.
  2. If zero: top up (see `INSTALL.md` § Jina). The feature is
     returning `summary_budget_exhausted` to users until credit
     is restored; the UI renders "Summaries are temporarily
     unavailable."
  3. If non-zero but still firing: Jina may be rate-limiting our
     account (not wallet-exhausted). Wait 10 min, re-check.
  4. Silence the monitor for 1h to avoid storming while resolving.

- **Gemini failure rate (> 5% over 15 min).**
  1. Check Gemini status page (Google Cloud → AI / Generative
     Language API).
  2. If Google is down: nothing to do beyond silence the monitor
     for the outage window; the feature fails to
     `summarization_failed` and the UI renders a retry button.
  3. If Google is up: examine recent `summary-outcome` lines for
     `reason` clustering. If many `source_captcha`, that's a
     Jina-upstream problem, not Gemini — re-route to the Jina
     runbook.

- **Rate-limit 429 burst (> 50/h).**
  1. Examine `summary-outcome` lines with `outcome=rate_limited`
     — is the traffic spread across many IPs (successful
     throttling) or concentrated (single attacker / friendly
     crawler)?
  2. Single IP: consider a temporary lower `SUMMARY_RATE_LIMIT_BURST`
     env var via Vercel dashboard, no code deploy needed.
  3. Many IPs (genuinely popular story or link): raise the
     limit if spend is fine, or accept the 429s if the feature
     is holding up.
  4. Check GCP billing on the same morning to confirm the
     rate limit is actually bounding spend.

## Open decisions

Things left for the operator to pick before Phase 2:

- **Axiom vs Datadog for monitors** — see § Monitoring layer.
  Doesn't block Phase 1.
- **Paging priority taxonomy** — the P1/P3 split in Phase 3 is
  a starting guess; adjust based on how annoying 3 AM buzzes
  actually are.
- **Runbook storage** — keep in this file, or split per-alert
  runbooks into `runbooks/` as they grow? Not a concern until
  each runbook is more than a handful of bullets.
