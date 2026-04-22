# Cron operator playbook

This is the runbook for `/api/warm-summaries` — the Vercel cron that
keeps the article + comments summary cache warm for the top 30 HN
stories, and emits the change-analytics log stream used to tune the
backoff knobs.

For **why** the cron exists and how it's structured, see `SPEC.md` §
"Scheduled warming and change analytics". This doc is narrowly about
**how to run it in production**: enabling, verifying, tuning,
troubleshooting, and shutting down.

## What the cron does in one paragraph

Every 5 minutes (per `vercel.json`), Vercel hits
`/api/warm-summaries?feed=top&n=30`. The handler fetches HN
`topstories`, takes the first 30 ids with `score > 1` and not
dead/deleted, and for each runs two tracks in parallel: an **article
track** (Jina Reader → SHA-256 hash → compare to stored `articleHash`
→ regenerate via Gemini only on change) and a **comments track** (top
20 top-level kids → build transcript → SHA-256 hash → compare to
stored `transcriptHash` → regenerate insights only on change). Both
tracks write a structured JSON log line per story; a per-run summary
logs counts. Records live 30 days in Upstash and are owned by the
cron; user-facing `/api/summary` and `/api/comments-summary` trust
whatever is in the cache.

## Prerequisites

1. **Vercel Pro tier.** Sub-daily cron schedules (our `*/5 * * * *`)
   require Pro. Hobby allows only daily schedules.
2. **Upstash Redis / Vercel Storage Marketplace Redis** provisioned
   and linked to the project.
3. **Gemini API key** (Google AI Studio).
4. **Jina Reader API key.** This is a **hard dependency** — the raw-
   HTML fallback was removed (see TODO.md § "Article-fetch
   fallback"). Without a Jina key, the article track logs
   `skipped_unreachable` on every story and `/api/summary` returns
   503 `not_configured`.

## Required environment variables

Set these in **Vercel → Project → Settings → Environment Variables**,
scoped to **Production** (and **Preview** if you want PR previews to
also warm the cache). Redeploy after any change.

| Name | What it's for |
|---|---|
| `CRON_SECRET` | Shared secret Vercel Cron sends in the `Authorization: Bearer <secret>` header when firing the job. **You have to set this yourself** — Vercel does not auto-generate it. Without it set (and scoped to the environment the cron is firing in), every scheduled invocation will hit the handler with no `Authorization` header and our fail-closed check returns 403 silently. Any long random string works; `openssl rand -hex 32` is fine. |
| `GOOGLE_API_KEY` | Gemini 2.5 Flash-Lite. Used by both user-facing summary endpoints and the cron. |
| `JINA_API_KEY` | Jina Reader. Required — no fallback. |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` *or* `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Upstash credentials. Either pair works. Vercel Storage Marketplace auto-injects the `KV_REST_*` pair; a direct Upstash project uses `UPSTASH_REDIS_REST_*`. |

## Optional knobs (all env-tunable)

All defaults match `SPEC.md` § "Tiered backoff". Leave them alone
until you have a week of real `warm-story` logs to base a tweak on.

| Name | Default | Applies to | Effect |
|---|---|---|---|
| `WARM_REFRESH_CHECK_INTERVAL_SECONDS` | `1800` (30 min) | Both tracks | Re-check cadence while content is "fresh". |
| `WARM_STABLE_CHECK_INTERVAL_SECONDS` | `7200` (2 h) | Both tracks | Re-check cadence once content has been unchanged ≥ `WARM_STABLE_THRESHOLD_SECONDS`. |
| `WARM_STABLE_THRESHOLD_SECONDS` | `21600` (6 h) | Both tracks | How long unchanged before switching to the stable interval. |
| `WARM_MAX_STORY_AGE_SECONDS` | `172800` (48 h) | Both tracks | Stop re-checking past this story age. Upstash record still serves reads until 30-day TTL. |
| `WARM_TOP_N` | `30` | Both tracks | How many feed ids to process per tick when `?n=` isn't in the URL. |
| `WARM_YOUNG_STORY_AGE_SECONDS` | `7200` (2 h) | Comments only | Threshold vs HN `story.time` for "young" classification. |
| `WARM_YOUNG_STORY_REFRESH_INTERVAL_SECONDS` | `600` (10 min) | Comments only | Aggressive re-check cadence while the story is young (threads grow fast). |
| `WARM_COMMENTS_MIN_KIDS` | `5` | Comments only | Minimum usable top-level comments before the cron creates a `first_seen` record. Avoids caching 2-comment thin threads. |

## Enabling the cron

The cron is declared in `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/warm-summaries?feed=top&n=30", "schedule": "*/5 * * * *" }
  ]
}
```

There is no dashboard toggle — on deploy, Vercel reads the `crons`
field and registers the schedule. The Settings → Cron Jobs page is a
read-only listing.

Steps for a fresh project:

1. **Set `CRON_SECRET`** in **Vercel → Project → Settings →
   Environment Variables**. Any long random string works; a common
   choice is `openssl rand -hex 32`. Scope it to **Production** (and
   **Preview** too if you want preview deploys to also warm the
   cache). Save the value locally — Vercel's UI won't let you read
   it back later.
2. **Set the other required env vars** from the table above
   (`GOOGLE_API_KEY`, `JINA_API_KEY`, Upstash credentials).
3. **Deploy to production** — env var changes don't apply to
   existing deployments, and the `crons` entry is only registered
   by a fresh build.
4. **Verify** in **Vercel → Project → Settings → Cron Jobs**: you
   should see `/api/warm-summaries?feed=top&n=30` with its next run
   time. First scheduled invocation lands within 5 minutes.

If `CRON_SECRET` is left unset at step 1, Vercel Cron still fires
but without an `Authorization` header, and our fail-closed check
returns 403 on every tick. The symptom is "the cron runs but
nothing gets warmed" — see Troubleshooting below.

## Verifying it works

### Manual trigger

```bash
# Use the same CRON_SECRET value you set in Vercel. Vercel's UI
# doesn't let you read it back, so this is the value you saved
# locally at enablement time.
curl -i -X GET \
  -H "Authorization: Bearer $CRON_SECRET" \
  "https://newshacker.app/api/warm-summaries?feed=top&n=3"
```

Expected response (truncated):

```
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
cache-control: private, no-store

{"ok":true,"feed":"top","storyCount":3,"processed":6,"outcomes":{
  "article":{...},"comments":{...}}}
```

`n=3` keeps the manual test cheap. `?n=30` runs the full tick.

### Scheduled run

Wait ≤5 min after deploy, then look at **Vercel → Logs → Functions**
and filter to `/api/warm-summaries`. Each run writes:

- **One `warm-run` line** at the end: the per-tick summary.
- **Two `warm-story` lines per story processed**: one for each track.

Minimum-viable health check: does a `warm-run` line land every 5 min,
and is its `processed` > 0? If yes, the cron is alive.

### Useful `jq` queries

For quick spot-checks against the last 24 h of Vercel function logs
before they age out. Copy the logs down (CLI: `vercel logs production
--since 1h | grep warm-story > warm.jsonl`) and poke around:

```bash
# Outcome histogram per track
jq -r 'select(.type=="warm-story") | [.track, .outcome] | @tsv' warm.jsonl \
  | sort | uniq -c | sort -rn

# Change rate by content age (articles)
jq -r 'select(.type=="warm-story" and .track=="article" and (.outcome=="unchanged" or .outcome=="changed"))
       | [(.ageMinutes//0 | tonumber / 60 | floor), .outcome] | @tsv' warm.jsonl \
  | sort | uniq -c

# Per-run duration and throughput
jq -r 'select(.type=="warm-run") | [.durationMs, .processed, .storyCount] | @tsv' warm.jsonl
```

### Useful APL queries (Axiom)

For longer-window analysis (up to the Axiom retention tier) once the
**Axiom Vercel integration** is wired up. See
[axiom.co/docs/apps/vercel](https://axiom.co/docs/apps/vercel) for
install steps. Two setup gotchas worth spelling out:

- **The integration ships logs from *every* Vercel project it has
  access to by default.** If you've added it at the team level or
  have other projects, every query must filter to `newshacker` or
  you'll be reading someone else's logs. The templates below all
  include the filter.
- **Vercel emits three distinct log sources.** Build logs
  (`vercel.source == "build"`), static/edge cache logs (`"static"`),
  and function runtime logs (`"lambda"`). Cron output lives only in
  `"lambda"` logs. The filter below gates on that.
- **APL nested-field syntax.** The ingested schema has dotted field
  names like `vercel.source` and `vercel.projectName`. Because the
  dataset itself is also called `vercel`, bare `vercel.source`
  confuses the parser; use the bracket-and-quote form:
  `['vercel.source']`. Learned the hard way.

Paste any of these into the Axiom query console:

```apl
// Outcome histogram per track, last 24 h. The equivalent of the first
// jq query above.
['vercel']
| where _time > ago(24h)
| where ['vercel.projectName'] == "newshacker"
| where ['vercel.source'] == "lambda"
| where message contains "warm-story"
| extend e = parse_json(message)
| summarize count() by track=tostring(e.track), outcome=tostring(e.outcome)
| sort by track asc, count_ desc
```

```apl
// Change rate by article age bucket (hours). Tells you whether
// articles past N hours settle down — if the changed/total ratio
// plummets past 4-6 h, WARM_STABLE_CHECK_INTERVAL_SECONDS can push
// out further.
['vercel']
| where _time > ago(7d)
| where ['vercel.projectName'] == "newshacker"
| where ['vercel.source'] == "lambda"
| where message contains "warm-story"
| extend e = parse_json(message)
| where tostring(e.track) == "article"
| where tostring(e.outcome) in ("changed", "unchanged")
| extend ageHours = bin(todouble(e.ageMinutes) / 60, 1)
| summarize
    changed = countif(tostring(e.outcome) == "changed"),
    unchanged = countif(tostring(e.outcome) == "unchanged"),
    total = count()
  by ageHours
| extend changeRate = round(todouble(changed) / todouble(total), 3)
| sort by ageHours asc
```

```apl
// Inspect article-"changed" rows to check for Jina rendering noise.
// Two successive rows for the same storyId with contentBytes delta
// under ~100 almost certainly indicate a dynamic element in the
// article body (timestamp, ad slot, related-items widget) flipping
// the hash without a real edit. Real edits are usually multi-KB.
['vercel']
| where _time > ago(24h)
| where ['vercel.projectName'] == "newshacker"
| where ['vercel.source'] == "lambda"
| where message contains "warm-story"
| extend e = parse_json(message)
| where tostring(e.track) == "article" and tostring(e.outcome) == "changed"
| project
    _time,
    storyId = toint(e.storyId),
    ageMinutes = todouble(e.ageMinutes),
    stableForMinutes = todouble(e.stableForMinutes),
    contentBytes = toint(e.contentBytes)
| sort by storyId asc, _time asc
```

```apl
// Per-run summary: how long is each tick taking and how much did it
// do? durationMs approaching 50 000 means we're hitting the
// WALL_CLOCK_BUDGET_MS guard; expect trailing stories to log
// skipped_budget.
['vercel']
| where _time > ago(24h)
| where ['vercel.projectName'] == "newshacker"
| where ['vercel.source'] == "lambda"
| where message contains "warm-run"
| extend e = parse_json(message)
| project
    _time,
    durationMs = toint(e.durationMs),
    storyCount = toint(e.storyCount),
    processed = toint(e.processed)
| sort by _time desc
```

```apl
// Young-story comments: is the 10-min aggressive interval actually
// buying us extra `changed` events in the first 2 h after HN
// submission? If young-window changed rate isn't materially higher
// than older-window changed rate, drop WARM_YOUNG_STORY_REFRESH_
// INTERVAL_SECONDS back to 30 min and let the default fresh interval
// handle everything.
['vercel']
| where _time > ago(7d)
| where ['vercel.projectName'] == "newshacker"
| where ['vercel.source'] == "lambda"
| where message contains "warm-story"
| extend e = parse_json(message)
| where tostring(e.track) == "comments"
| where tostring(e.outcome) in ("changed", "unchanged")
| extend isYoung = iff(todouble(e.ageMinutes) < 120, "young", "older")
| summarize
    changed = countif(tostring(e.outcome) == "changed"),
    unchanged = countif(tostring(e.outcome) == "unchanged"),
    total = count()
  by isYoung
| extend changeRate = round(todouble(changed) / todouble(total), 3)
```

Save any of these as **Starred queries** in Axiom (star icon on a
run) so you can re-run them with one click instead of re-pasting.
The `warm-summaries` analytics dashboard sketched in TODO.md §
"Warm-summaries analytics surface" would wrap these into one chart
view; the queries above are the building blocks.

## Tuning the knobs

After a week of `warm-story` logs, look for:

- **Article track — "changed" rate per age bucket.** If articles
  almost never change past 4–6 h (`stableFor` is long and
  `summaryChanged` stays false), push `WARM_STABLE_CHECK_INTERVAL_SECONDS`
  up from 2 h → 4 h. If the stable threshold catches things too
  slowly (you see recent `changed` with `stableFor < 6 h`), lower
  `WARM_STABLE_THRESHOLD_SECONDS`.
- **Comments track — young-story churn.** If `changed` is rare even
  on stories in their first 2 h, the 10-min young interval is
  over-eager; push `WARM_YOUNG_STORY_REFRESH_INTERVAL_SECONDS` up.
  If old stories still show churn, `WARM_STABLE_CHECK_INTERVAL_SECONDS`
  can stay where it is for comments while articles back off further.
- **Max story age.** If the count of `skipped_age` outcomes at
  48 h is high and the `changed` count in the 24–48 h band is
  trivial, drop `WARM_MAX_STORY_AGE_SECONDS` to 24 h to save cycles.
- **Min-kids gate.** If `skipped_low_volume` dominates young-story
  logs but most of those threads later grew past 5 and we missed
  the first-bucket data, drop `WARM_COMMENTS_MIN_KIDS` to 3. If
  we keep regenerating 5-comment threads that immediately look
  different 20 min later, raise it to 8.

## Disabling / emergency kill switch

In priority order:

1. **Remove the `crons` entry from `vercel.json` and redeploy.** The
   cleanest stop. Vercel stops scheduling it. User-facing summaries
   still work — they just won't have cron-maintained freshness.
2. **Set `WARM_TOP_N=1` in Vercel and redeploy.** Shrinks the cron
   to processing a single story per tick. Gets you ~97% cost
   reduction without a code change, for a cooling-off period while
   you diagnose. (The handler doesn't currently accept `WARM_TOP_N=0`
   — it falls back to the default on invalid values.)
3. **Unset `JINA_API_KEY` in Vercel and redeploy.** Article track
   goes silent (every tick logs `skipped_unreachable`). Comments
   track continues. Use if Jina-specific billing is the problem.
4. **Unset `GOOGLE_API_KEY`.** Stops all Gemini spend. Both tracks
   become effectively read-only — they log their backoff decisions
   and hash-checks but never regenerate. Nuclear option if Gemini
   billing is the problem.

All four are reversible — put the env var / `crons` entry back and
redeploy.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No `warm-run` lines in logs | Cron not firing. | Check Pro tier, `vercel.json` has `crons` entry, deployment succeeded, Cron Jobs dashboard lists it. |
| Cron Jobs dashboard shows invocations but every one is a 403 | `CRON_SECRET` not set in the project env, or set only for a different environment (e.g. Production ticked but the cron is hitting a Preview deployment). Vercel fires with no `Authorization` header and the handler fail-closed returns 403. | Set `CRON_SECRET` in **Settings → Environment Variables**, scope it to the environment the cron fires in, redeploy so the env change takes effect. |
| Manual `curl` with the secret works but scheduled runs 403 | The `CRON_SECRET` value in the Vercel env doesn't match what you typed locally (env var drift, or the project was redeployed without the var saved). | In the Vercel UI, re-save `CRON_SECRET` with a known value and redeploy. Vercel can't show you the existing value, so "just check what's set" isn't an option — overwrite and re-record. |
| 503 `{"error":"Store not configured","reason":"no_store"}` | Upstash env vars unset or typo. | Check both `KV_REST_API_URL` / `KV_REST_API_TOKEN` pair (or `UPSTASH_REDIS_REST_URL` / `..._TOKEN` pair) are set for the environment serving the cron. |
| Every article-track story logs `skipped_unreachable` | `JINA_API_KEY` missing or invalid. | Re-run the Jina sanity-check from INSTALL.md. Note: `skipped_unreachable` is also the right outcome if Jina is genuinely down — check their status page before assuming a config issue. |
| Gemini spend climbing faster than expected | Articles or comments churning more than forecast, or a publisher's page has rotating content Jina can't strip (e.g., an always-changing timestamp in the body). | Grep `warm-story` lines for the high-churn `storyId`s — `contentBytes` barely moving across "changed" rows is the timestamp-rotation signature. If it's a single publisher domain, file it to the article-fetch-fallback allowlist TODO. |
| `warm-run.durationMs` close to 50 s | Hitting the wall-clock budget. Stories queued at the tail log `skipped_budget`. | Transient Jina / HN slowness usually. If persistent, lower `WARM_TOP_N` to 20 or investigate specific slow stories in the per-story logs. |
| `warm-run` count of `skipped_interval` >> `unchanged` + `changed` | Normal — means the backoff is doing its job; stories in their refresh window don't need work. Not a problem. | None. This is the steady state. |

## Cost sanity check

At defaults with 5-min cadence:

- **Vercel invocations:** 288 per day. Well inside Pro's limits.
- **HN Firebase:** ≤8,640 top-story fetches/day + comments child-fetches. Free, no rate limits.
- **Jina Reader:** ~1,500–3,000/day realistic, ~45–90k/month. At a planning figure of ~5,000 tokens per Reader call that's ~7.5–15M tokens/day, so the one-time 10M-token free grant per key (does not refresh daily or monthly) drains in **roughly a day or two** of steady cron traffic, not weeks. After that you top up (~$0.02/M tokens, ~$5–10/month for ongoing use at this volume) or rotate the key. The handler returns 503 `summary_budget_exhausted` and the cron logs `skipped_payment_required` between top-ups; see `SPEC.md` § "Scheduled warming and change analytics" for the full cost breakdown.
- **Gemini:** ~$3–5/month realistic, ~$15/month worst case.
- **Upstash:** Two keys per story. Well inside the free tier.

See `SPEC.md` § "Scheduled warming and change analytics" for the full
cost breakdown and new failure modes.

## See also

- `SPEC.md` § "Scheduled warming and change analytics" — architecture & rationale.
- `INSTALL.md` — env vars, API key setup.
- `TODO.md` — follow-ups: analytics surface, article-fetch fallback allowlist, Jina retry, multi-region replication, cron jitter.
- `AGENTS.md` § "Vercel api/ gotchas" — why the cron handler duplicates helpers instead of sharing.
