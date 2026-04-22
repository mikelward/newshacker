// Reads the self-hosted summary-layout telemetry from Upstash Redis and
// prints a joint distribution of (kind, card_w tier, delta_h) plus a
// recommended new value for the three Thread.tsx skeleton-reservation
// constants. Vercel Web Analytics only exposes marginal per-property
// breakdowns, which isn't enough to tune per-tier; this script aggregates
// the counts from `/api/telemetry`.
//
// Usage:
//   npm run analyze:telemetry
//
// Environment:
//   UPSTASH_REDIS_REST_URL   (or KV_REST_API_URL)
//   UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN)
//
// `npm run analyze:telemetry` is invoked with `node --env-file-if-exists=.env.local`
// so credentials pulled via `vercel env pull .env.local` are picked up
// automatically. You can also run the script directly and export the
// variables yourself.

import { pathToFileURL } from 'node:url';
import { Redis } from '@upstash/redis';

const COUNTS_KEY = 'newshacker:summary_layout:counts';
const FIELD_DELIM = '|';

// Matches the constants-in-flight that this report is designed to help
// re-tune. Kept inline (not imported from Thread.tsx) so the script is
// fully decoupled from the React build — it's a plain Node script and
// Vite/JSX resolution shouldn't apply.
const CURRENT_CONSTANTS = {
  ARTICLE_SUMMARY_EXPECTED_CHARS: 230,
  INSIGHT_EXPECTED_CHARS: 75,
  EXPECTED_INSIGHT_COUNT: 5,
};

// Card-width tier split. card_w arrives already bucketed to multiples of
// 20 (see bucket20 in src/lib/analytics.ts). A single phone/tablet split
// is coarse but matches the two real-world sizing regimes from the spec.
const TABLET_MIN_CARD_W = 520;

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for the unit test). Keep side-effect-free.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse a single Redis hash field produced by api/telemetry.ts fieldFor().
 * Returns null for malformed fields so a single bad row doesn't abort the
 * whole aggregation — old telemetry with a different shape should be
 * skipped, not crash the report.
 *
 * @param {string} field
 * @param {number} count
 * @returns {null | {
 *   kind: 'article' | 'comments',
 *   cardW: number,
 *   summaryChars: number,
 *   reservedH: number,
 *   renderedH: number,
 *   deltaH: number,
 *   insightCount: number | null,
 *   count: number,
 * }}
 */
export function parseField(field, count) {
  if (typeof field !== 'string') return null;
  const parts = field.split(FIELD_DELIM);
  if (parts.length !== 7) return null;
  const [kind, cardW, summaryChars, reservedH, renderedH, deltaH, insight] =
    parts;
  if (kind !== 'article' && kind !== 'comments') return null;
  const nums = [cardW, summaryChars, reservedH, renderedH, deltaH].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const insightCount = insight === '' ? null : Number(insight);
  if (insightCount !== null && !Number.isFinite(insightCount)) return null;
  if (!Number.isFinite(count) || count <= 0) return null;
  return {
    kind,
    cardW: nums[0],
    summaryChars: nums[1],
    reservedH: nums[2],
    renderedH: nums[3],
    deltaH: nums[4],
    insightCount,
    count,
  };
}

/** @param {number} cardW */
export function tierFor(cardW) {
  return cardW >= TABLET_MIN_CARD_W ? 'tablet+' : 'phone';
}

/**
 * Weighted quantile. `samples` is an array of { value, weight }; `q` ∈ [0,1].
 * Uses the CDF-crossing definition (smallest value whose cumulative weight
 * reaches q × total), which matches how a histogram-bucket counter is
 * naturally interpreted.
 *
 * @param {Array<{ value: number, weight: number }>} samples
 * @param {number} q
 * @returns {number | null}
 */
export function weightedQuantile(samples, q) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return null;
  const target = q * total;
  let acc = 0;
  for (const s of sorted) {
    acc += s.weight;
    if (acc >= target) return s.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * @param {ReturnType<typeof parseField>[]} records
 */
export function aggregate(records) {
  const cells = new Map();
  for (const r of records) {
    if (!r) continue;
    const tier = tierFor(r.cardW);
    const key = `${r.kind}|${tier}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        kind: r.kind,
        tier,
        count: 0,
        deltaH: [],
        summaryChars: [],
        insightCount: [],
      };
      cells.set(key, cell);
    }
    cell.count += r.count;
    cell.deltaH.push({ value: r.deltaH, weight: r.count });
    cell.summaryChars.push({ value: r.summaryChars, weight: r.count });
    if (r.insightCount !== null) {
      cell.insightCount.push({ value: r.insightCount, weight: r.count });
    }
  }
  return [...cells.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.tier < b.tier ? -1 : 1;
  });
}

/**
 * Recommend new Thread.tsx constants based on the overall distribution.
 * Tier-invariant by design: the constants are global, so we aggregate
 * across tiers. Heuristic:
 *   - ARTICLE_SUMMARY_EXPECTED_CHARS ← p90 summary_chars for kind=article
 *   - EXPECTED_INSIGHT_COUNT         ← p90 insight_count for kind=comments
 *   - INSIGHT_EXPECTED_CHARS         ← p90 (summary_chars / insight_count)
 *     for kind=comments, rounded to the nearest 5
 *
 * Reserving for the p90 means ~90% of cards render with no downward
 * reflow, which is the skeleton's job. A higher percentile would waste
 * vertical space on most loads.
 *
 * @param {ReturnType<typeof parseField>[]} records
 */
export function recommend(records) {
  const articleChars = [];
  const commentsInsightCounts = [];
  const commentsCharsPerInsight = [];
  for (const r of records) {
    if (!r) continue;
    if (r.kind === 'article') {
      articleChars.push({ value: r.summaryChars, weight: r.count });
    } else if (r.kind === 'comments') {
      if (r.insightCount && r.insightCount > 0) {
        commentsInsightCounts.push({
          value: r.insightCount,
          weight: r.count,
        });
        commentsCharsPerInsight.push({
          value: r.summaryChars / r.insightCount,
          weight: r.count,
        });
      }
    }
  }
  const articleP90 = weightedQuantile(articleChars, 0.9);
  const insightCountP90 = weightedQuantile(commentsInsightCounts, 0.9);
  const insightCharsP90 = weightedQuantile(commentsCharsPerInsight, 0.9);
  return {
    ARTICLE_SUMMARY_EXPECTED_CHARS:
      articleP90 !== null ? roundTo(articleP90, 5) : null,
    INSIGHT_EXPECTED_CHARS:
      insightCharsP90 !== null ? roundTo(insightCharsP90, 5) : null,
    EXPECTED_INSIGHT_COUNT:
      insightCountP90 !== null ? Math.round(insightCountP90) : null,
  };
}

/** @param {number} v @param {number} step */
function roundTo(v, step) {
  return Math.round(v / step) * step;
}

/**
 * @param {ReturnType<typeof aggregate>} cells
 * @param {ReturnType<typeof recommend>} rec
 */
export function format(cells, rec) {
  const totalEvents = cells.reduce((s, c) => s + c.count, 0);
  const lines = [];
  lines.push('');
  lines.push(`Summary-layout telemetry — ${totalEvents} events`);
  lines.push('─'.repeat(52));
  if (cells.length === 0) {
    lines.push('(no data yet)');
    return lines.join('\n');
  }
  for (const c of cells) {
    lines.push('');
    lines.push(
      `${c.kind.toUpperCase()} · ${c.tier} · ${c.count} events`.trim(),
    );
    const dp50 = weightedQuantile(c.deltaH, 0.5);
    const dp90 = weightedQuantile(c.deltaH, 0.9);
    const cp50 = weightedQuantile(c.summaryChars, 0.5);
    const cp90 = weightedQuantile(c.summaryChars, 0.9);
    lines.push(
      `  delta_h        p50=${fmt(dp50)}  p90=${fmt(dp90)}   (target: near 0)`,
    );
    lines.push(
      `  summary_chars  p50=${fmt(cp50)}  p90=${fmt(cp90)}`,
    );
    if (c.insightCount.length > 0) {
      const ip50 = weightedQuantile(c.insightCount, 0.5);
      const ip90 = weightedQuantile(c.insightCount, 0.9);
      lines.push(
        `  insight_count  p50=${fmt(ip50)}  p90=${fmt(ip90)}`,
      );
    }
  }
  lines.push('');
  lines.push('Recommended Thread.tsx constants');
  lines.push('─'.repeat(52));
  for (const [name, cur] of Object.entries(CURRENT_CONSTANTS)) {
    const next = rec[name];
    const arrow =
      next === null || next === undefined
        ? '(insufficient data)'
        : next === cur
          ? `unchanged (${cur})`
          : `${cur} → ${next}`;
    lines.push(`  ${name.padEnd(34)} ${arrow}`);
  }
  lines.push('');
  return lines.join('\n');
}

function fmt(v) {
  if (v === null || v === undefined) return '—';
  return String(v);
}

// ────────────────────────────────────────────────────────────────────────────
// CLI entry (IO boundary — everything above is pure).
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.error(
      'Missing Upstash credentials. Set UPSTASH_REDIS_REST_URL and\n' +
        'UPSTASH_REDIS_REST_TOKEN (or the KV_REST_API_* equivalents).\n' +
        'Quickest path: `vercel env pull .env.local` from the project root.',
    );
    process.exit(2);
  }
  const redis = new Redis({ url, token });
  /** @type {Record<string, string | number>} */
  const hash = (await redis.hgetall(COUNTS_KEY)) ?? {};
  const records = Object.entries(hash)
    .map(([field, raw]) => parseField(field, Number(raw)))
    .filter((r) => r !== null);
  const cells = aggregate(records);
  const rec = recommend(records);
  console.log(format(cells, rec));
}

// Run only when invoked directly as a script, not when imported by the
// test harness. pathToFileURL normalizes Windows backslash paths to the
// same `file:///C:/...` shape that import.meta.url uses.
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
