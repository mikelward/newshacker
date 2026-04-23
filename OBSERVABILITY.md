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
  - `summary-jina-payment-required` — `api/summary.ts`, fires when
    Jina returns 402 or 429 on an article fetch.
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
  fetch. Fields: `{ type, storyId, articleUrl }`. This is the only
  log line that a monitor can key directly off of today; everything
  else is inferred from Vercel's request-level logs.
- **`warm-story`** — `api/warm-summaries.ts`, one line per id processed
  by the cron. See `CRON.md` § "Useful APL queries (Axiom)" for the
  full schema; the outcome field (`unchanged` / `changed` /
  `skipped_*` / `error`) is the primary cron-health signal.
- **`warm-run`** — `api/warm-summaries.ts`, one line per cron tick
  with the roll-up counts. Schema in `CRON.md`.

### Planned

Two new event types to ship before we can build the monitors:

- **`summary-outcome`** — one line per `/api/summary` request, emitted
  just before the response is returned. Planned shape:
  ```json
  {
    "type": "summary-outcome",
    "endpoint": "summary",
    "outcome": "cached" | "generated" | "rate_limited" | "error",
    "reason": "<matching SummaryErrorReason, when outcome != cached>",
    "storyId": 1234
  }
  ```
  `outcome` is the minimal axis we need for all four alert
  conditions: cache-hit ratio (cached / total), error rate
  (error / total, broken down by `reason`), and 429 burst count
  (rate_limited over time). Keep the field set this tight —
  richer fields are easy to add later but hard to remove once
  monitors depend on them.
- **`comments-summary-outcome`** — same shape, with
  `endpoint: "comments-summary"`. Emitted from
  `api/comments-summary.ts` in the same PR.

### Deliberately not logged

- **Client IP / normalized IP bucket.** The rate-limit path has
  access to the normalized `/64`-or-IPv4 key but the log line must
  not include it. An IP address in a log line is PII under most
  data-protection regimes, and we don't need it for any of the
  four alert conditions. If a future condition genuinely needs
  per-IP aggregation, revisit with a hashing scheme so the log
  line carries an opaque bucket id, not the address.
- **Article URL / title / body text.** Not needed for alerts;
  leaking user-visible content into logs is gratuitous.
- **Gemini / Jina raw request or response bodies.** Same reasoning;
  also expensive in log volume.

The `summary-jina-payment-required` line does carry
`articleUrl` — keep it, because the operator genuinely needs it to
triage which publisher tripped a CAPTCHA, and Jina's upstream URL
isn't user-identifying in the same way an IP is.

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

#### OpsGenie (Atlassian)

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

- **Pick OpsGenie** if you want a paging-first specialist with a
  generous free tier and a mature feature set, and your workplace
  uses the Atlassian stack.
- **Pick PagerDuty** if you want the most broadly transferable
  paging-workflow learning (it's the industry default), and are
  OK with the paid-tier ceiling once you outgrow the Developer
  tier.
- **Pick Datadog** if you want the whole stack in one tool and
  paging is "good enough, not deep." Simpler operationally; less
  paging-specific depth.
- **Pick Better Stack** if you want a cheaper, newer
  one-tool-for-everything alternative to Datadog+OpsGenie and are
  willing to accept less depth per feature.
- **Pick incident.io** only if you plan to grow into full
  incident-lifecycle workflows and are OK working in Slack. Weak
  match for the current single-operator, no-Slack setup.
- **Pick two** — e.g. Datadog for monitors + OpsGenie (or
  PagerDuty) for paging — if you want to exercise the real-world
  separation between the observability platform and the incident
  manager. Most "chainsaw-like" layout and the closest match to
  what a production SRE team runs.

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
- **Paging:** OpsGenie or PagerDuty on the free tier, mobile app
  push as the primary delivery. Pick between them based on which
  ecosystem you want learning-transfer from; they're otherwise
  peers for this use case. Email as a secondary route for
  non-critical alerts.
- **Optional:** Twilio-SMS backchannel via a serverless proxy if
  the chosen paging tool's free SMS cap becomes a constraint. Not
  needed to start.

## Phased implementation

Ship in order; each phase leaves the tree in a shippable state and
is independently revertable.

### Phase 1 — log instrumentation (prereq)

- Add `summary-outcome` JSON log line to `api/summary.ts` (every
  return path, inside both the cache-hit and the generate branches
  and every error exit).
- Add `comments-summary-outcome` equivalent in
  `api/comments-summary.ts`.
- Tests assert the shape of each log line via a captured
  `console.log` spy; nothing is asserted about downstream tooling,
  because the taxonomy is the contract and the tooling is
  swappable.
- No monitoring or paging work in this phase — log lines alone.
  Ship to prod, let them flow into Axiom for a few days so there's
  baseline data before we build monitors on top.

**Definition of done:** log lines visible in Axiom; unit tests
green; SPEC.md entry under "Scheduled warming and change analytics"
gains a short "summary request outcomes" subsection pointing at the
new event names.

### Phase 2 — monitors (Axiom first)

- Build the four monitors in Axiom against the Phase 1 log lines.
- Starting thresholds per § "What we want to know" — re-tune once a
  week of baseline data is in.
- Delivery: email first (free, zero setup), so we can see the
  monitors fire before the paging tool is wired.

**Definition of done:** each monitor fires at least once against
synthetic traffic (manually triggered); email arrives. No phone
push yet.

### Phase 3 — paging (OpsGenie)

- Create OpsGenie free account + mobile app install.
- Wire Axiom webhook → OpsGenie integration endpoint for the four
  monitors. (First-class Datadog integration is a Phase 4 choice
  if we migrate.)
- Configure alert priorities: Jina credit exhaustion + cache-hit
  collapse = P1 (DND override); Gemini failure + 429 burst = P3
  (push, no DND override).
- Silence the monitors' email delivery once OpsGenie push is
  confirmed working, to avoid double-paging.

**Definition of done:** synthetic trigger → phone buzzes within
~60 s. Email is silenced. OpsGenie acknowledgement state is
observable.

### Phase 4 (optional) — migrate to Datadog

Only if the operator decides the learning dividend is worth it.
Rewrite APL queries as Datadog Logs Query, install Datadog Vercel
integration, either dual-ship or cut Axiom cleanly. Monitors get
rebuilt in Datadog's UI; OpsGenie integration is first-class so
the paging layer is unchanged.

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
- **OpsGenie priority taxonomy** — the P1/P3 split in Phase 3 is
  a starting guess; adjust based on how annoying 3 AM buzzes
  actually are.
- **Runbook storage** — keep in this file, or split per-alert
  runbooks into `runbooks/` as they grow? Not a concern until
  each runbook is more than a handful of bullets.
