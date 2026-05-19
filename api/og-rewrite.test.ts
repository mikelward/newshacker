// @vitest-environment node
//
// Locks down the user-agent regex that vercel.json uses to decide
// whether a /item/:id request goes to /api/og (for crawlers) or to
// /index.html (the SPA, for real users). The regex is in JSON, not in
// code we can unit-test directly, so this test re-reads the file and
// runs the pattern against a corpus of representative UAs — known
// link-preview crawlers (must match) and known in-app / desktop
// browsers (must NOT match).
//
// The WhatsApp case is the headline: WhatsApp's preview crawler UA
// starts with `WhatsApp/2.x.x` (no Mozilla prefix), but the WhatsApp
// Android in-app browser is `Mozilla/5.0 ... WhatsApp/...`. A naive
// substring match on `whatsapp` catches both — which traps real
// users in a meta-refresh loop between /api/og and /item/:id. The
// regex therefore anchors WhatsApp at the start of the value (which
// Vercel's `has.value` matches against the whole header string).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

interface VercelHas {
  type: string;
  key?: string;
  value?: string;
}
interface VercelRewrite {
  source: string;
  destination: string;
  has?: VercelHas[];
}
interface VercelJson {
  rewrites: VercelRewrite[];
}

function loadOgUaRegex(): RegExp {
  const config = JSON.parse(
    readFileSync(join(ROOT, 'vercel.json'), 'utf8'),
  ) as VercelJson;
  const rule = config.rewrites.find((r) => r.destination.startsWith('/api/og'));
  if (!rule) throw new Error('No /api/og rewrite rule found in vercel.json');
  const ua = rule.has?.find(
    (h) => h.type === 'header' && h.key === 'user-agent',
  );
  if (!ua?.value) throw new Error('No user-agent has-condition on /api/og rule');
  // Vercel matches `has.value` against the whole header string
  // (anchored). Mirror that here so the JS regex behaves the same way
  // as production. The regex also opens with `(?i)` for case-insensitive
  // matching under Vercel's Go-based regex engine; JavaScript doesn't
  // support inline flags, so strip the prefix and apply the `i` flag
  // via `new RegExp(..., 'i')` instead.
  const pattern = ua.value.startsWith('(?i)') ? ua.value.slice(4) : ua.value;
  return new RegExp(`^(?:${pattern})$`, 'i');
}

const RE = loadOgUaRegex();

const CRAWLERS_THAT_MUST_MATCH: ReadonlyArray<[label: string, ua: string]> = [
  // Headline case: WhatsApp's preview crawler starts with `WhatsApp/`.
  ['WhatsApp preview crawler (Android)', 'WhatsApp/2.21.12.21 A'],
  ['WhatsApp preview crawler (iOS)', 'WhatsApp/2.21.11.16 i'],
  ['Facebook external hit', 'facebookexternalhit/1.1'],
  [
    'Facebook external hit + Facebot + Twitterbot combined',
    'facebookexternalhit/1.1 Facebot Twitterbot/1.0',
  ],
  ['Twitterbot', 'Twitterbot/1.0'],
  ['Slackbot link expanding', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
  ['Discord embed bot', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'],
  ['Telegram bot', 'TelegramBot (like TwitterBot)'],
  ['LinkedIn bot', 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)'],
  ['Skype URI preview', 'SkypeUriPreview Preview/0.5'],
  ['Embedly', 'Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)'],
  ['Applebot', 'Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)'],
  ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
  ['Bingbot', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
  ['Yandex', 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)'],
  ['Baiduspider', 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)'],
];

const REAL_BROWSERS_THAT_MUST_NOT_MATCH: ReadonlyArray<[label: string, ua: string]> = [
  // Headline case: real WhatsApp user opening a link from a chat
  // bubble. The in-app browser carries `WhatsApp/` in the middle of
  // the UA, NOT at the start.
  [
    'WhatsApp in-app browser (Android)',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 WhatsApp/2.23.10.16/Android/13',
  ],
  [
    'WhatsApp in-app browser (iOS)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 [WhatsApp/2.23.10.71/iOS/17.0]',
  ],
  [
    'iOS Safari',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ],
  [
    'Android Chrome',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  ],
  [
    'Desktop Chrome (macOS)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ],
  [
    'Desktop Firefox',
    'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
  ],
  // Tokens we deliberately omit from the regex because they appear in
  // in-app browsers as well as preview crawlers — these should NOT
  // match, even though a naive substring would catch them.
  [
    'Mastodon mobile app (random Tusky build)',
    'Mozilla/5.0 (Linux; Android 13) Tusky/22.0 Mastodon',
  ],
  [
    'Pinterest in-app browser',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Pinterest/12.0',
  ],
];

describe('vercel.json /api/og rewrite UA regex', () => {
  for (const [label, ua] of CRAWLERS_THAT_MUST_MATCH) {
    it(`matches ${label}`, () => {
      expect(RE.test(ua), `expected match: ${ua}`).toBe(true);
    });
  }

  for (const [label, ua] of REAL_BROWSERS_THAT_MUST_NOT_MATCH) {
    it(`does NOT match ${label}`, () => {
      expect(RE.test(ua), `unexpected match: ${ua}`).toBe(false);
    });
  }

  it('only loads from a /api/og rule (regression: catches accidental removal)', () => {
    // If somebody removes the rule entirely, loadOgUaRegex() throws at
    // module load — but the corpus tests would never run, so make the
    // presence of the rule an explicit assertion too.
    expect(RE).toBeInstanceOf(RegExp);
  });
});
