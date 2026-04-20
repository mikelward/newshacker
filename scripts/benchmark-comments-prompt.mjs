// Benchmark the comments-summary prompt change.
//
// Hits Gemini directly (bypassing our Vercel function / edge cache /
// per-instance memory cache) for a handful of HN story IDs, using both
// the OLD prompt (3–5 insights, 25-word cap) and the NEW prompt (up to 5,
// 15-word cap) back-to-back. Reports per-variant latency distribution
// (p50/p95), char-length distribution, and prints the insights side by
// side so you can eyeball quality.
//
//   GOOGLE_API_KEY=... node scripts/benchmark-comments-prompt.mjs
//
// Optionally pass story IDs on the command line; otherwise a default set
// (drawn from recent tablet measurements) is used.

import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-2.5-flash-lite';
const TOP_LEVEL_SAMPLE_SIZE = 20;
const MAX_COMMENT_CHARS = 2000;
const HN_ITEM_URL = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

const DEFAULT_STORY_IDS = [
  47834565,
  47838178,
  47831621,
  47836730,
  47833247,
  47834184,
  47834195,
  47835928,
  47837611,
  47822066,
];

function buildOldPrompt(title, transcript) {
  const header = title ? `Article title: ${title}\n\n` : '';
  return (
    `${header}Below are the top comments from a Hacker News discussion. ` +
    `Extract 3 to 5 of the most useful insights from the conversation — points ` +
    `of agreement, notable dissents, corrections, or interesting additions.\n\n` +
    `Return one insight per line, each a short sentence under 25 words. ` +
    `Do not include usernames, quotes, numbering, bullet markers, or markdown.\n\n` +
    `--- BEGIN COMMENTS ---\n${transcript}\n--- END COMMENTS ---`
  );
}

function buildNewPrompt(title, transcript) {
  const header = title ? `Article title: ${title}\n\n` : '';
  return (
    `${header}Below are the top comments from a Hacker News discussion. ` +
    `Extract up to 5 of the most useful insights from the conversation — points ` +
    `of agreement, notable dissents, corrections, or interesting additions. ` +
    `Only include genuinely useful points. If the discussion is thin, ` +
    `return fewer insights rather than padding with filler.\n\n` +
    `Return one insight per line, each a single short sentence under 15 words. ` +
    `Do not include usernames, quotes, numbering, bullet markers, or markdown.\n\n` +
    `--- BEGIN COMMENTS ---\n${transcript}\n--- END COMMENTS ---`
  );
}

function buildClaimPrompt(title, transcript) {
  const header = title ? `Article title: ${title}\n\n` : '';
  return (
    `${header}Below are the top comments from a Hacker News discussion. ` +
    `Extract up to 5 of the most useful insights from the conversation — points ` +
    `of agreement, notable dissents, corrections, or interesting additions. ` +
    `Combine related points into a single insight rather than listing them ` +
    `separately. Each insight must state a specific claim or observation, ` +
    `not just name the topic. Only include genuinely useful points; if the ` +
    `discussion is thin, return fewer insights rather than padding with ` +
    `filler. Return no more than 5 insights — do not exceed 5.\n\n` +
    `Return one insight per line, each a single short sentence under 15 words. ` +
    `Do not include usernames, quotes, numbering, bullet markers, or markdown.\n\n` +
    `--- BEGIN COMMENTS ---\n${transcript}\n--- END COMMENTS ---`
  );
}

function buildTweakPrompt(title, transcript) {
  const header = title ? `Article title: ${title}\n\n` : '';
  return (
    `${header}Below are the top comments from a Hacker News discussion. ` +
    `Extract up to 5 of the most useful insights from the conversation — points ` +
    `of agreement, notable dissents, corrections, or interesting additions. ` +
    `Combine related points into a single insight rather than listing them ` +
    `separately. Only include genuinely useful points; if the discussion is ` +
    `thin, return fewer insights rather than padding with filler. Return no ` +
    `more than 5 insights — do not exceed 5.\n\n` +
    `Each insight must state a specific claim about the subject matter. ` +
    `State it directly, as an assertion — not a meta-description of what the ` +
    `article or commenters are doing. Do not use phrases like "the article ` +
    `suggests", "is framed as", "commenters think", "the manifesto ` +
    `reflects", or "the comment highlights". Make the claim itself.\n\n` +
    `State each insight in the strongest form actually argued in the ` +
    `comments, not a diluted or hedged version. If commenters disagreed, ` +
    `the strongest version of each side is a valid insight.\n\n` +
    `Return one insight per line, each a single short sentence under 15 words. ` +
    `Do not include usernames, quotes, numbering, bullet markers, or markdown.\n\n` +
    `--- BEGIN COMMENTS ---\n${transcript}\n--- END COMMENTS ---`
  );
}

function buildHopePrompt(title, transcript) {
  const header = title ? `Article title: ${title}\n\n` : '';
  return (
    `${header}Below are the top comments from a Hacker News discussion. ` +
    `Extract up to 5 of the most useful insights from the conversation — points ` +
    `of agreement, notable dissents, corrections, or interesting additions. ` +
    `Combine related points into a single insight rather than listing them ` +
    `separately. Only include genuinely useful points; if the discussion is ` +
    `thin, return fewer insights rather than padding with filler — returning ` +
    `3 or 4 is fine and preferable to inventing a fifth. Return no more than ` +
    `5 insights — do not exceed 5.\n\n` +
    `Each insight must state a specific claim about the subject matter. ` +
    `State it directly, as an assertion — not a meta-description of what the ` +
    `article or commenters are doing. Do not use phrases like "the article ` +
    `suggests", "is framed as", "commenters think", "the manifesto ` +
    `reflects", or "the comment highlights". Make the claim itself.\n\n` +
    `State each insight in the strongest form actually argued in the ` +
    `comments, not a diluted or hedged version. If commenters disagreed, ` +
    `the strongest version of each side is a valid insight.\n\n` +
    `When there are two equivalent ways to say something, prefer the ` +
    `simpler and more direct one: "is" over "functions as", "part of" over ` +
    `"a component of", "uses" over "utilizes", "helps" over "facilitates". ` +
    `Keep technical terms only where they are the precise word.\n\n` +
    `Return one insight per line, each a single short sentence under 15 words. ` +
    `Do not include usernames, quotes, numbering, bullet markers, or markdown.\n\n` +
    `--- BEGIN COMMENTS ---\n${transcript}\n--- END COMMENTS ---`
  );
}

function buildSimplePrompt(title, transcript) {
  const header = title ? `Article title: ${title}\n\n` : '';
  return (
    `${header}Below are the top comments from a Hacker News discussion. ` +
    `Extract up to 5 of the most useful insights from the conversation — points ` +
    `of agreement, notable dissents, corrections, or interesting additions. ` +
    `Combine related points into a single insight rather than listing them ` +
    `separately. Only include genuinely useful points; if the discussion is ` +
    `thin, return fewer insights rather than padding with filler — returning ` +
    `3 or 4 is fine and preferable to inventing a fifth. Return no more than ` +
    `5 insights — do not exceed 5.\n\n` +
    `Each insight must state a specific claim about the subject matter. ` +
    `State it directly, as an assertion — not a meta-description of what the ` +
    `article or commenters are doing. Do not use phrases like "the article ` +
    `suggests", "is framed as", "commenters think", "the manifesto ` +
    `reflects", or "the comment highlights". Make the claim itself.\n\n` +
    `State each insight in the strongest form actually argued in the ` +
    `comments, not a diluted or hedged version. If commenters disagreed, ` +
    `the strongest version of each side is a valid insight.\n\n` +
    `Phrase things simply and directly, but keep domain terminology and ` +
    `precision. Prefer "is" over "functions as", "part of" over "a ` +
    `component of", "uses" over "utilizes".\n\n` +
    `Return one insight per line, each a single short sentence under 15 words. ` +
    `Do not include usernames, quotes, numbering, bullet markers, or markdown.\n\n` +
    `--- BEGIN COMMENTS ---\n${transcript}\n--- END COMMENTS ---`
  );
}

function htmlToPlainText(input) {
  if (!input) return '';
  return input
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchItem(id) {
  const res = await fetch(HN_ITEM_URL(id));
  if (!res.ok) return null;
  return await res.json();
}

async function buildTranscript(storyId) {
  const story = await fetchItem(storyId);
  if (!story || story.deleted || story.dead) {
    throw new Error(`Story ${storyId} not available`);
  }
  const kidIds = (story.kids ?? []).slice(0, TOP_LEVEL_SAMPLE_SIZE);
  if (kidIds.length === 0) {
    throw new Error(`Story ${storyId} has no comments`);
  }
  const raw = await Promise.all(kidIds.map((id) => fetchItem(id)));
  const usable = raw.filter(
    (c) => c && !c.deleted && !c.dead && typeof c.text === 'string',
  );
  const transcript = usable
    .map((c, i) => {
      const body = htmlToPlainText(c.text).slice(0, MAX_COMMENT_CHARS);
      return `[#${i + 1} by ${c.by ?? 'anon'}]\n${body}`;
    })
    .join('\n\n');
  return { title: story.title, transcript, commentCount: usable.length };
}

function parseInsights(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini returns 503 / UNAVAILABLE / RESOURCE_EXHAUSTED / 429 when demand
// spikes. Retry a handful of times with exponential backoff so a hot
// period doesn't wreck a whole benchmark run.
function isRetryableError(err) {
  const msg = String(err?.message ?? err);
  return (
    msg.includes('UNAVAILABLE') ||
    msg.includes('503') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('429')
  );
}

async function runVariant(client, label, buildPrompt, title, transcript) {
  const prompt = buildPrompt(title, transcript);
  const t0 = performance.now();
  let response;
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await client.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: { thinkingConfig: { thinkingBudget: 0 } },
      });
      break;
    } catch (err) {
      if (attempt >= 4 || !isRetryableError(err)) throw err;
      process.stdout.write(`(${label} retry ${attempt + 1}) `);
      await sleep(delay);
      delay *= 2;
    }
  }
  const t1 = performance.now();
  const text = (response.text ?? '').trim();
  const insights = parseInsights(text);
  return {
    label,
    latencyMs: Math.round(t1 - t0),
    insights,
    charsPerInsight: insights.map((s) => s.length),
    wordsPerInsight: insights.map((s) => s.split(/\s+/).filter(Boolean).length),
  };
}

// Small gap between successive Gemini calls within a story to stay under
// the free-tier QPS ceiling when the model is under demand.
const INTER_CALL_DELAY_MS = 200;

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

function summarize(label, runs) {
  const latencies = runs.map((r) => r.latencyMs);
  const allChars = runs.flatMap((r) => r.charsPerInsight);
  const allWords = runs.flatMap((r) => r.wordsPerInsight);
  const counts = runs.map((r) => r.insights.length);
  const p = (n) => percentile(latencies, n);
  console.log(`\n=== ${label} ===`);
  console.log(
    `latency ms:  p50=${p(50)}  p75=${p(75)}  p95=${p(95)}  max=${Math.max(...latencies)}`,
  );
  console.log(
    `insight count: min=${Math.min(...counts)}  max=${Math.max(...counts)}  mean=${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)}`,
  );
  if (allChars.length > 0) {
    console.log(
      `chars/insight: min=${Math.min(...allChars)}  p50=${percentile(allChars, 50)}  p95=${percentile(allChars, 95)}  max=${Math.max(...allChars)}`,
    );
    console.log(
      `words/insight: min=${Math.min(...allWords)}  p50=${percentile(allWords, 50)}  p95=${percentile(allWords, 95)}  max=${Math.max(...allWords)}`,
    );
  }
}

async function main() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error(
      'Set GOOGLE_API_KEY in your env before running.\n' +
        '  GOOGLE_API_KEY=... node scripts/benchmark-comments-prompt.mjs [storyId...]',
    );
    process.exit(1);
  }
  const storyIds = process.argv.slice(2).length
    ? process.argv.slice(2).map((s) => Number(s))
    : DEFAULT_STORY_IDS;

  const client = new GoogleGenAI({ apiKey });
  const oldRuns = [];
  const newRuns = [];
  const claimRuns = [];
  const tweakRuns = [];
  const hopeRuns = [];
  const simpleRuns = [];

  for (const id of storyIds) {
    process.stdout.write(`story ${id} ... `);
    let transcript;
    try {
      transcript = await buildTranscript(id);
    } catch (err) {
      console.log(`skipped (${err.message})`);
      continue;
    }
    try {
      const oldRun = await runVariant(
        client,
        'old',
        buildOldPrompt,
        transcript.title,
        transcript.transcript,
      );
      await sleep(INTER_CALL_DELAY_MS);
      const newRun = await runVariant(
        client,
        'new',
        buildNewPrompt,
        transcript.title,
        transcript.transcript,
      );
      await sleep(INTER_CALL_DELAY_MS);
      const claimRun = await runVariant(
        client,
        'claim',
        buildClaimPrompt,
        transcript.title,
        transcript.transcript,
      );
      await sleep(INTER_CALL_DELAY_MS);
      const tweakRun = await runVariant(
        client,
        'tweak',
        buildTweakPrompt,
        transcript.title,
        transcript.transcript,
      );
      await sleep(INTER_CALL_DELAY_MS);
      const hopeRun = await runVariant(
        client,
        'hope',
        buildHopePrompt,
        transcript.title,
        transcript.transcript,
      );
      await sleep(INTER_CALL_DELAY_MS);
      const simpleRun = await runVariant(
        client,
        'simple',
        buildSimplePrompt,
        transcript.title,
        transcript.transcript,
      );
      oldRuns.push(oldRun);
      newRuns.push(newRun);
      claimRuns.push(claimRun);
      tweakRuns.push(tweakRun);
      hopeRuns.push(hopeRun);
      simpleRuns.push(simpleRun);
      console.log(
        `old=${oldRun.latencyMs}ms/${oldRun.insights.length}` +
          ` new=${newRun.latencyMs}ms/${newRun.insights.length}` +
          ` claim=${claimRun.latencyMs}ms/${claimRun.insights.length}` +
          ` tweak=${tweakRun.latencyMs}ms/${tweakRun.insights.length}` +
          ` hope=${hopeRun.latencyMs}ms/${hopeRun.insights.length}` +
          ` simple=${simpleRun.latencyMs}ms/${simpleRun.insights.length}`,
      );
      console.log(`  title: ${transcript.title}`);
      const max = Math.max(
        oldRun.insights.length,
        newRun.insights.length,
        claimRun.insights.length,
        tweakRun.insights.length,
        hopeRun.insights.length,
        simpleRun.insights.length,
      );
      for (let i = 0; i < max; i++) {
        const o = oldRun.insights[i] ?? '(—)';
        const n = newRun.insights[i] ?? '(—)';
        const c = claimRun.insights[i] ?? '(—)';
        const t = tweakRun.insights[i] ?? '(—)';
        const h = hopeRun.insights[i] ?? '(—)';
        const s = simpleRun.insights[i] ?? '(—)';
        console.log(`  old   [${i}]: ${o}`);
        console.log(`  new   [${i}]: ${n}`);
        console.log(`  claim [${i}]: ${c}`);
        console.log(`  tweak [${i}]: ${t}`);
        console.log(`  hope  [${i}]: ${h}`);
        console.log(`  simple[${i}]: ${s}`);
      }
    } catch (err) {
      console.log(`error (${err.message})`);
    }
  }

  summarize('OLD prompt (3–5 × 25 words)', oldRuns);
  summarize('NEW prompt (up to 5 × 15 words)', newRuns);
  summarize('CLAIM prompt (≤5 × 15 words, combine, claim not topic)', claimRuns);
  summarize(
    'TWEAK prompt (CLAIM + anti-meta + strongest-form)',
    tweakRuns,
  );
  summarize(
    'HOPE prompt (TWEAK + simpler-when-equivalent + fewer-is-fine)',
    hopeRuns,
  );
  summarize(
    'SIMPLE prompt (HOPE with trimmed simple-and-direct rule)',
    simpleRuns,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
