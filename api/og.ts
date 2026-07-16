// Open Graph / Twitter Card HTML for /item/:id, served to social media
// crawlers so pasted links get a real preview (story title and article
// age).
//
// SPAs can't satisfy crawlers from client JS — facebookexternalhit,
// Slackbot, iMessage's previewer, etc. don't execute JavaScript. The
// rewrite in vercel.json detects bot user-agents on /item/:id and
// routes them here; real browsers still get /index.html and the SPA.
//
// Falls back to a generic site preview if the id is missing, malformed,
// or the upstream item fetch fails — better a default card than a 500
// that breaks the preview entirely.
//
// Per AGENTS.md § "Vercel api/ gotchas", helpers are inlined rather
// than imported from outside api/.

const HN_API_BASE = 'https://hacker-news.firebaseio.com/v0';
// Static brand image — the 256×256 PWA icon. We pair it with
// twitter:card="summary" so platforms render the smaller-thumbnail
// layout instead of letterboxing a square into a wide hero slot.
// We deliberately use the 256px icon, not the 512px one: WhatsApp
// ignores twitter:card and sizes its preview from the image's pixels,
// so a 512² square trips its "hero banner" threshold and fills a giant
// box. A sub-300px image drops WhatsApp to its compact left-thumbnail
// card, which matches what the summary card gives everyone else. 256
// (rather than a smaller icon) stays at/above Facebook's documented
// 200×200 og:image minimum, so Messenger/Facebook don't reject or omit
// the thumbnail, while still sitting under WhatsApp's ~300px threshold.
// Dynamic story-title-on-cream renders were prototyped with @vercel/og
// but pulled — Vercel's Edge bundler doesn't ship the module for
// non-Next.js Vite projects ("unsupported modules"). Can revisit with a
// build-time prerender or a different Edge config later.
// TODO: consider fetching the linked article's own og:image (its hero
// image) for link-type stories and using that here, falling back to this
// brand icon for self-posts / articles with no usable image. Adds an
// external fetch per crawler hit (crawler-only, ~$0/mo per rule 11) and
// new failure modes, so it's a follow-up, not part of this change.
const OG_IMAGE_PATH = '/icon-256.png';

interface HNItem {
  id?: number;
  type?: string;
  by?: string;
  title?: string;
  url?: string;
  time?: number;
  score?: number;
  descendants?: number;
  dead?: boolean;
  deleted?: boolean;
}

export interface OgDeps {
  fetchItem?: (id: number) => Promise<HNItem | null>;
  // Override "now" for deterministic age formatting in tests.
  now?: () => number;
}

// Inlined twin of `formatTimeAgo` in src/lib/format.ts. Per AGENTS.md
// § "Vercel api/ gotchas", helpers can't be imported across api/ and
// src/, so the duplication is deliberate. Output uses the same short
// suffixes ("2h", "3d") with a trailing " ago" so the OG description
// reads naturally in a chat-preview snippet.
export function formatTimeAgo(unixSeconds: number, nowMs: number): string {
  const nowS = Math.floor(nowMs / 1000);
  let diff = nowS - unixSeconds;
  if (diff < 0) diff = 0;
  const MIN = 60;
  const HR = 60 * MIN;
  const DAY = 24 * HR;
  const MO = 30 * DAY;
  const YR = 365 * DAY;
  if (diff < MIN) return 'just now';
  if (diff < HR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HR)}h ago`;
  if (diff < MO) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < YR) return `${Math.floor(diff / MO)}mo ago`;
  return `${Math.floor(diff / YR)}y ago`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface RenderArgs {
  title: string;
  description: string;
  image: string;
  url: string;
  ogType: 'website' | 'article';
}

function renderHtml(args: RenderArgs): string {
  const t = escapeHtml(args.title);
  const d = escapeHtml(args.description);
  const i = escapeHtml(args.image);
  const u = escapeHtml(args.url);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${t}</title>
<meta name="description" content="${d}" />
<meta property="og:type" content="${args.ogType}" />
<meta property="og:site_name" content="newshacker" />
<meta property="og:title" content="${t}" />
<meta property="og:description" content="${d}" />
<meta property="og:image" content="${i}" />
<meta property="og:image:width" content="256" />
<meta property="og:image:height" content="256" />
<meta property="og:url" content="${u}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${t}" />
<meta name="twitter:description" content="${d}" />
<meta name="twitter:image" content="${i}" />
<link rel="canonical" href="${u}" />
<meta http-equiv="refresh" content="0; url=${u}" />
</head>
<body>
<p>Redirecting to <a href="${u}">${u}</a>…</p>
</body>
</html>`;
}

function defaultHtml(origin: string, canonical: string): string {
  return renderHtml({
    title: 'newshacker — a reader for Hacker News',
    description: 'A mobile-friendly, unofficial reader for Hacker News.',
    image: `${origin}${OG_IMAGE_PATH}`,
    url: canonical,
    ogType: 'website',
  });
}

export function buildItemDescription(item: HNItem, nowMs: number): string {
  if (typeof item.time !== 'number') {
    return 'Discuss on newshacker, a reader for Hacker News.';
  }
  return formatTimeAgo(item.time, nowMs);
}

function itemHtml(item: HNItem, origin: string, nowMs: number): string {
  const title = item.title?.trim() || 'Hacker News story';
  return renderHtml({
    title,
    description: buildItemDescription(item, nowMs),
    image: `${origin}${OG_IMAGE_PATH}`,
    url: `${origin}/item/${item.id}`,
    ogType: 'article',
  });
}

function getOrigin(request: Request): string {
  // Prefer the canonical public URL from Vercel's forwarding headers;
  // fall back to the request URL's origin in tests/dev where those
  // headers aren't set.
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (host) return `${proto}://${host}`;
  return new URL(request.url).origin;
}

export async function handleOgRequest(
  request: Request,
  deps: OgDeps = {},
): Promise<Response> {
  const url = new URL(request.url);
  const origin = getOrigin(request);
  const idRaw = url.searchParams.get('id');

  if (!idRaw || !/^\d+$/.test(idRaw)) {
    return htmlResponse(defaultHtml(origin, `${origin}/`), 300);
  }
  const id = Number(idRaw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return htmlResponse(defaultHtml(origin, `${origin}/`), 300);
  }

  const fetchItem = deps.fetchItem ?? defaultFetchItem;
  const nowMs = deps.now ? deps.now() : Date.now();
  let item: HNItem | null;
  try {
    item = await fetchItem(id);
  } catch {
    item = null;
  }

  if (!item || item.dead || item.deleted || !item.title) {
    // Keep a short cache here so a temporarily-failed fetch doesn't
    // poison the edge for a day.
    return htmlResponse(
      defaultHtml(origin, `${origin}/item/${id}`),
      60,
    );
  }

  return htmlResponse(itemHtml(item, origin, nowMs), 3600);
}

function htmlResponse(body: string, maxAge: number): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=86400`,
    },
  });
}

async function defaultFetchItem(id: number): Promise<HNItem | null> {
  const res = await fetch(`${HN_API_BASE}/item/${id}.json`);
  if (!res.ok) return null;
  return (await res.json()) as HNItem | null;
}

export async function GET(request: Request): Promise<Response> {
  return handleOgRequest(request);
}
