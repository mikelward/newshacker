# Cache strategy report — newshacker warm-summaries

**Window:** 2026-04-28 → 2026-04-29 (last 24h, except change-rate by age band which is 7d)
**Source:** Axiom `warm-story` / `warm-run` lines on the `vercel` dataset, scoped to `['vercel.projectName'] == "newshacker"` and `['vercel.source'] == "lambda"`
**Branch:** `claude/cache-strategy-metrics-Ol61l`

## TL;DR

The article cron is **~$19/month** (Jina + Gemini, ballpark prices) and **roughly half is recoverable**. Three classes of waste, ranked:

1. **60% of article "changed" outcomes are noise** — sub-100-byte oscillation from dynamic page elements (timestamps, ad slots, related-articles widgets). Triggers a Gemini regen each time. **~$5/mo Gemini wasted.** Fix: `WARM_MIN_DELTA_BYTES` env knob + new `skipped_minor_delta` outcome.
2. **62% of Jina spend is on `unchanged` outcomes** — calls that fetched a full article body just to confirm "still the same". 8M Jina tokens/day. **~$3-5/mo Jina wasted.** Fix: conditional GET against the publisher *before* Jina (Jina is the fetcher, so it can't honor `If-None-Match` itself), plus direct-fetch for top hosts.
3. **One publisher (`github.com`) is 17% of all Jina spend** — 900 calls/week, ~17K tokens each, mostly READMEs/blog posts that don't change. **~$1.30/mo Jina wasted.** Fix: direct-fetch path via `raw.githubusercontent.com` / `cheerio`; bypass Jina entirely for github URLs.

Plus two structural observations:

- **Article track dominates Gemini spend by 12.7×** over comments (5.0M vs 0.4M prompt tokens/day). Any cut on the article side moves the needle.
- **Comments track is healthy** — 96-99% real-change rate in the 0-16h bands, with a mild drop to 89.6% at 16-32h as threads wind down. Don't touch; comments accumulate kids continuously, so the high `changed` rate is real growth, not noise.
- **The article-track interval ladder is currently uninformative** — change rate is flat at 33-45% across hours 0-24 because noise floods every bucket. Once #1 lands, `WARM_STABLE_CHECK_INTERVAL_SECONDS` becomes meaningful and we can extend it past 6h.

## Plan (priority-ordered)

In effort-to-impact order. Combined upper-bound savings ≈ **$9-10/month on a $19/month base** — roughly halves article-cron cost.

| # | Fix                                                  | Saves                        | Effort          | Notes                                                     |
|---|------------------------------------------------------|------------------------------|-----------------|-----------------------------------------------------------|
| 1 | `WARM_MIN_DELTA_BYTES` article-track delta guard     | ~$5/mo Gemini                | small           | Already designed; details below                           |
| 2 | Direct-fetch path for `github.com`                   | ~$1.30/mo Jina + lower regen | small-medium    | One host, simple HTML, `raw.githubusercontent.com` shortcut |
| 3 | Conditional GET against publisher before Jina        | ~$2-3/mo Jina                | medium          | Persist etag/last-modified on `SummaryRecord`             |
| 4 | Lower `WARM_MAX_STORY_AGE_SECONDS` to 12h            | 5-10% across both            | trivial         | Wait until #1 to re-read the age curve                    |
| 5 | Direct-fetch for next 5-10 hosts (nature, openai, …) | diminishing                  | medium per host | Only worth it if traffic stays here                       |
| — | (Don't touch the comments track)                     | —                            | —               | Healthy at 96-99% real-change rate; see Finding 2         |

Findings 1-7 below provide the supporting data; Finding 5 surfaces the joined cost view that justifies the dollar figures, and the *Architectural fact* section explains the conditional-GET shape for fix #3.

## Finding 1 — Article track: 60% of "changed" events are noise

Article `changed` events bucketed by `deltaBytes` (24h, n=410):

```
noise (<100 B)         ████████████████████████████  246   60% ← almost certainly fake
ambiguous (100-1000 B) ███████████                    94   23%
real edit (≥1 KB)      ████████                       70   17%
```

Spot-checking same-storyId sequences confirms this — examples from the 24h sample:

| storyId   | contentBytes sequence (first ~10 ticks)                          | Read                  |
|-----------|------------------------------------------------------------------|-----------------------|
| 47894312  | 461 / 461 / 461 / 461 / 525 / 461 / 461 …                       | 64 B flip             |
| 47924813  | 20610 ×11, 22593, 20610 ×4, 20945 ×4                             | two-state oscillation |
| 47933257  | 20007 / 19877 / 19974 / 19905 / 20002 / …                        | ~150 B churn          |
| 47939320  | 69324 / 70348 / 69748 / 70349 / 71063 / 71062 / 70462 ↔ 71062 ×4 | two-state, ~1 KB      |
| 47942492  | 56222 → 49024 → 47941 → 46522                                    | real shrink           |

Each "changed" outcome triggers a Gemini regeneration. At 60% noise, **~246 of the 410 article regenerations per day are wasted**.

## Finding 2 — Comments track is real growth, not noise

Comments change rate by age band (7d, only `changed`+`unchanged` rows):

```
0-1h    ████████████████████████  96.6%   (56/58)
1-2h    █████████████████████████ 99.2%  (130/131)
2-4h    █████████████████████████ 98.0%  (239/244)
4-8h    ████████████████████████  96.8%  (239/247)
8-16h   ████████████████████████  96.2%  (179/186)
16-32h  ██████████████████████    89.6%   (60/67)
```

96–99% of comments checks legitimately produce new content because threads accumulate kids continuously. The slight drop at 16-32h (89.6%) is consistent with threads naturally winding down. **No noise problem; the hash signal is honest.** Don't apply the article-track fix to this side.

(The 24h histogram had `comments unchanged = 1` — that's not because the dedupe is broken, it's because comment threads simply don't sit stable for 5 minutes.)

## Finding 3 — Article track dominates spend

Cron-only Gemini token usage, last 24h:

```
                 prompt       output
article    5,042,316  ████████████████████████████  16,561  ████████████████
comments     398,202  ██                            14,722  ██████████████
                  ──                                    ──
ratio       12.7×                                    1.1×
```

Article is **12.7× more expensive on prompt tokens** (Jina-fed page bodies are bulky; comment summaries are short). Output tokens are nearly equal because both produce short summaries. So any cut on the article track lands on the side that actually moves the cost needle.

## Finding 4 — The age-bucket curve is currently uninformative

Article change rate by hour (7d, from earlier query):

```
0h    ███████████████████████████    28.2%
1h    ████████████████████████████████████  36.4%
2h    ████████████████████████████████████  36.6%
3h    █████████████████████████████████     33.8%
6h    ████████████████████████████████████████   41.3%
12h   █████████████████████████████████████████████  44.9%
18h   ███████████████████████████████████████████    43.4%
24h+  ████████████████████ 33%  (low n)
```

The change rate is **flat at ~33-45% from hour 0 through hour 24**. There's no decay, so the "after 6h, check less often" logic governed by `WARM_STABLE_CHECK_INTERVAL_SECONDS` and `WARM_STABLE_THRESHOLD_SECONDS` has nothing to bite into — articles look like they "change" forever because the noise is always present. **Once Finding 1 is fixed, this curve will start to taper and the interval ladder becomes meaningful**; tuning intervals before then would just miss real edits without saving spend.

## Recommendation

**Single-knob fix on the article track only:**

1. Add env-tunable `WARM_MIN_DELTA_BYTES` (default 256).
2. Between the hash mismatch and the Gemini call, if `existing.contentBytes` is present and `|new − old| < threshold`, log a new outcome `skipped_minor_delta` (carrying `deltaBytes`, `contentBytes`) and refresh `lastCheckedAt` only — leave `articleHash`, `contentBytes`, `lastChangedAt`, `summary` intact so deltas accumulate against the last *real* regeneration. Cumulative drift will eventually trip the threshold even if individual ticks don't.
3. Add `skipped_minor_delta` to the run-log tally and to the `/admin` outcome card.
4. Leave the comments track alone.

**What we'd expect to see in 24-48h:**

- Article `changed` count: −60% (~410 → ~165/day at 100B threshold; less at 256B because 100-256B band is small).
- New `skipped_minor_delta` outcome takes the displaced volume.
- Article cron-only Gemini prompt tokens: −50% to −60% (~5.0M → ~2.0-2.5M/day).
- The hourly change-rate curve actually starts to taper past 6-12h, at which point we can revisit `WARM_STABLE_CHECK_INTERVAL_SECONDS`.

**Cost framing** (production model is `gemini-2.5-flash-lite`; ballpark $0.075/M input + $0.30/M output — confirm against current Google AI pricing): article cron currently ~$0.38/day = ~$11.50/month. Fix saves ~$7/month. Small in absolute terms, but >50% of cron Gemini spend is genuinely waste, and the same dataset-driven approach can be reused as traffic and feed coverage scale.

**Threshold choice (256 B default):**

- Catches all <100B noise (246 events/day, 60%).
- Catches part of the 100-1000B ambiguous band (~25-40 events) which spot-checks suggest is mostly two-state oscillation.
- Misses the ~70 real edits ≥1KB.
- Misses small typo-fix real edits <256B — accepted trade-off; those don't materially change a one-sentence summary.

If after a week the noise floor is still high, follow up with either (a) lower the threshold to 128, (b) move to a percentage threshold (e.g. `max(256B, 1% of contentBytes)`), or (c) the more invasive fix of stripping volatile DOM blocks before hashing.

## What to ship

- `api/warm-summaries.ts`: knob in `readKnobs()`, new `CheckOutcome` member, the threshold check between hash mismatch and Gemini call, run-log tally entry.
- `api/warm-summaries.test.ts`: regression test for the new branch (existing record, hash differs, |delta| < threshold → no Gemini call, `skipped_minor_delta` logged, `lastCheckedAt` refreshed, `articleHash`/`contentBytes`/`lastChangedAt` preserved). And the inverse: |delta| ≥ threshold → Gemini called, `changed` logged.
- `api/admin-stats.ts`: include `skipped_minor_delta` in the outcome histogram.
- `CRON.md`: document the new knob and outcome; add an APL snippet for the new bucket; add a note that `WARM_STABLE_CHECK_INTERVAL_SECONDS` will become tunable once 48h of post-deploy data is available.
- `SPEC.md`: not touched — cron internals aren't documented there.

## Finding 5 — Per-outcome joined cost view (Jina + Gemini)

`warm-story` lines carry both `tokens` (Jina) and `geminiPromptTokens`/`geminiOutputTokens` per record, so a single query gives the joined view per outcome (24h, article track):

| outcome     | events | Jina tokens | Gemini prompt | Gemini out | Jina $   | Gemini $ | Total $    |
|-------------|-------:|------------:|--------------:|-----------:|---------:|---------:|-----------:|
| changed     |    410 |   3,948,189 |     4,239,021 |     13,674 |  $0.079  |  $0.322  | **$0.401** |
| unchanged   |    700 |   8,035,211 |             0 |          0 |  $0.161  |     $0   |   $0.161   |
| first_seen  |     89 |     695,833 |       805,260 |      2,942 |  $0.014  |  $0.061  |   $0.075   |
| error       |     29 |     250,054 |             0 |          0 |  $0.005  |     $0   |   $0.005   |
| skipped_*   |  7,322 |           0 |             0 |          0 |     $0   |     $0   |     $0     |
| **Daily**   |        |  **12.93M** |     **5.04M** |  **16.6K** | **$0.259** | **$0.383** | **$0.642** |

**~$19/month combined article-cron cost** at ballpark prices (Jina $0.02/M; production model is `gemini-2.5-flash-lite`, illustrative rate $0.075/M input + $0.30/M output — confirm against current Google AI pricing).

Two surprises in the joined view:

1. **`unchanged` calls cost more per event in Jina (11,479 tok) than `changed` calls (9,630 tok).** Stable articles tend to be longer-form pieces; ephemeral news that gets edited is shorter. So recovering Jina from `unchanged` polls is *more* than a flat per-call rate suggests.
2. **`changed` outcomes are 4× more expensive per event than `unchanged` ($0.001 vs $0.0002)** because Gemini regen dominates the bill. Confirms Finding 1's `WARM_MIN_DELTA_BYTES` fix lands where the per-event cost actually is.

## Finding 6 — Noise costs the same to fetch as a real edit

`changed` rows split by `deltaBytes` bucket × Jina + Gemini cost (24h):

| bucket                  | events | Jina/event | Gemini/event | Jina $  | Gemini $ |
|-------------------------|-------:|-----------:|-------------:|--------:|---------:|
| noise (<100 B)          |    246 |      9,481 |        9,526 | $0.047  |  $0.176  |
| ambiguous (100-1000 B)  |     94 |     11,347 |       13,213 | $0.021  |  $0.093  |
| real edit (≥1 KB)       |     70 |      7,846 |        9,338 | $0.011  |  $0.049  |

**Per-event Jina cost is essentially flat across buckets (9.5K vs 7.8K tok)** because we always fetch the full article body — the `deltaBytes` is the difference in *body size*, not the size of what we fetched. So:

- `WARM_MIN_DELTA_BYTES` saves Gemini on noise (~$0.18/day = $5.30/mo).
- It leaves $0.047/day = $1.40/mo of Jina spend on noise unrecovered.
- The Jina-side gap can only be closed with conditional GET (or our own ETag/Last-Modified fingerprint we own) — the body bytes still have to come down to *know* it's noise.

## Finding 7 — One host (`github.com`) is 17% of all Jina spend

7-day top 20 publishers by Jina tokens:

```
github.com               ██████████████████████████████████████████████████  15,239,034   (900 calls, ~17K tok each) ← outlier
www.nature.com           ██████                                               1,964,283   (21 calls, 94K each — long-form)
openai.com               ████                                                 1,253,368   (205 calls)
www.bbc.com              ████                                                 1,124,035   (155 calls)
keepandroidopen.org      ███                                                    936,046   (18 calls, 52K each)
oilprice.com             ███                                                    843,328   (34 calls)
gtfobins.org             ██                                                     695,157   (19 calls)
github.blog              ██                                                     683,890   (94 calls)
fffff.at                 ██                                                     666,994   (49 calls)
www.sentinelone.com      ██                                                     630,261   (33 calls)
blog.apnic.net           ██                                                     628,661   (15 calls)
eblong.com               ██                                                     619,440   (16 calls)
www.bloomberg.com        ██                                                     607,675   (126 calls, 5K each — paywalled stub)
www.theguardian.com      ██                                                     606,839   (51 calls)
www.quantamagazine.org   ██                                                     539,289   (60 calls)
eclecticlight.co         ██                                                     472,995   (45 calls)
techcrunch.com           ██                                                     453,315   (82 calls)
simonomi.dev             █                                                      426,900   (20 calls)
arkaung.github.io        █                                                      403,769   (29 calls)
www.os2museum.com        █                                                      399,131   (26 calls)
                                                                              ──────────
                                                                              28,233,629   ≈ 32% of 7d Jina spend
```

Total expected 7d Jina spend ≈ 12.93M × 7 ≈ 90M tokens. Top 20 hosts ≈ 32% of that — long tail dominates. But **`github.com` alone is 17%** (900 calls/week, ~17K tok each). github URLs (READMEs, blog posts, gists, code files) almost never change after submission; most of those calls are confirming "still the same".

This is the single most actionable line item. The fix doesn't even need conditional GET — github raw HTTP fetches are free and reliable, and `raw.githubusercontent.com` serves READMEs as plain text (zero parsing). Direct-fetch + `cheerio` for `github.com` URLs cuts ~17% of all Jina tokens at small implementation cost.

## Architectural fact (changes the conditional-GET shape)

`r.jina.ai` is the fetcher — it returns canonicalized markdown of the upstream URL, not the upstream HTTP response. Jina won't honor an `If-None-Match` we send to it for the upstream URL. So conditional GET has to happen **on our side, against the publisher, before Jina**:

```
old:  cron → Jina → publisher                   (always pays Jina)
new:  cron → publisher (HEAD or If-None-Match)
        ├─ 304 → log skipped_not_modified, no Jina, no Gemini
        └─ 200 → Jina → hash → Gemini if changed
```

Adds one HTTP round-trip (free on Vercel, typically <500 ms) per article check. Effectiveness depends on publisher hit rate; realistically 30-50% of `unchanged` outcomes return 304, so **$1.50-$2.50/month** Jina recovered.

## Caveats

- **Comments noise unchecked.** The deeper noise analyses were filtered to `track == "article"`. We don't have an equivalent same-storyId oscillation check for comments. The relevant signal would be `insightCount` over time per storyId — worth running before assuming comments are noise-free, although `unchanged = 1/24h` and 96–99% change rates across age bands are consistent with the "real growth" story.
- **Single 24h window for noise histogram.** A weekday-vs-weekend split, or a 7d aggregate, would tighten the 60% number. Order-of-magnitude is robust.
- **Threshold experiment, not proof.** 256B is a conservative starting point. Watch the new outcome in `/admin` and adjust based on a week of real data.
- **Pricing assumptions are ballpark.** Jina taken at $0.02/M tokens (paid tier midpoint); production Gemini model is `gemini-2.5-flash-lite` (per `api/warm-summaries.ts` and `api/summary.ts`), priced here at $0.075/M input + $0.30/M output as an illustrative figure — confirm against current Google AI pricing for that exact model since flash-lite rates have shifted over time. If we're on Jina free tier, the dollar figures collapse — only the rate-limit budget matters, and the `summary-jina-payment-required` event count becomes the relevant signal instead. Confirm against the `/admin` Jina wallet probe before sizing trade-offs.
- **Counts vary by ±1-5 events between Axiom queries** within the same 24h window — query 1 saw 413 article `changed` events; query 2 (the deltaBytes histogram, ran a few minutes later) saw 410; the joined cost view (Finding 5) ran later still and also saw 410. These are real new events landing between queries, not data inconsistency. The report uses the latest sample (n=410, 246/94/70) consistently throughout, but spot-checks against the original 413 baseline are noted in the chat history.
- **Conditional-GET hit rate is unmeasured.** The 30-50% estimate is a guess until we instrument it. If the rate ends up under ~20%, the persistence schema bump isn't worth the complexity and direct-fetch for the top hosts becomes a better second move.
