// Batch HN item proxy.
//
// Firebase's HN API is one-HTTP-request-per-item. This handler takes a
// comma-separated list of ids, fans out to Firebase in parallel, and
// returns a single JSON array — saving the client 30 round-trips per
// page. Vercel's edge cache is shared across users, so for popular
// feeds (notably `top`, where the same ~30 ids are hot for most
// visitors) repeat requests are served from the edge without touching
// Firebase at all.

const HN_ITEM_URL = (id: number) =>
  `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

// Matches src/hooks/useStoryList.ts PAGE_SIZE. Anything above this is
// almost certainly a malformed request.
const MAX_IDS = 30;

export interface HNItem {
  id?: number;
  type?: string;
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  dead?: boolean;
  deleted?: boolean;
  kids?: number[];
}

// Only fields the feed row actually renders. Dropping `kids` alone
// usually cuts the payload by 30-50% for high-engagement stories.
function thinForFeed(item: HNItem | null): HNItem | null {
  if (!item) return null;
  const { id, type, by, time, title, url, text, score, descendants, dead, deleted } = item;
  return { id, type, by, time, title, url, text, score, descendants, dead, deleted };
}

// Comment-prefetch callers need `kids` so the offline UI can still tell a
// user "this comment has 3 replies" even when those replies haven't been
// individually cached yet. Request it via ?fields=full.
function isFullFields(raw: string | null): boolean {
  return raw === 'full';
}

export function parseIds(raw: string | null): number[] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_IDS) return null;
  const seen = new Set<number>();
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    if (seen.has(n)) continue;
    seen.add(n);
    nums.push(n);
  }
  return nums;
}

export interface ItemsDeps {
  // Lets tests stub out the Firebase fetch without mocking global fetch.
  fetchItem?: (id: number, signal?: AbortSignal) => Promise<HNItem | null>;
}

export async function handleItemsRequest(
  request: Request,
  deps: ItemsDeps = {},
): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const ids = parseIds(searchParams.get('ids'));
  if (!ids) {
    return json({ error: 'Invalid ids parameter' }, 400);
  }
  const full = isFullFields(searchParams.get('fields'));

  const fetchItem = deps.fetchItem ?? defaultFetchItem;

  // A failed upstream fetch still yields a null entry (the client falls
  // back to a per-item Firebase fetch), but it must not be cached: this
  // response carries a shared s-maxage at the Vercel edge, so caching a
  // batch with failure-nulls would serve "empty" comments to every user
  // for up to s-maxage + stale-while-revalidate after a transient
  // Firebase hiccup. Genuine Firebase nulls (deleted/unknown ids) are
  // stable and stay cacheable.
  let failedCount = 0;
  const items = await Promise.all(
    ids.map(async (id) => {
      try {
        const item = await fetchItem(id, request.signal);
        return full ? item : thinForFeed(item);
      } catch {
        failedCount++;
        return null;
      }
    }),
  );
  const upstreamFailed = failedCount > 0;

  // Every id failed upstream: Firebase is unreachable/erroring behind us and
  // the batch carries no data at all. Say so with a 5xx instead of a 200 of
  // failure-nulls — the client's connectivity tracker treats a core-read 5xx
  // as "backend down" (pausing the query layer, showing the Down pill), and a
  // 200 here would hide the outage as an empty-but-online feed. A partial
  // failure keeps the degraded 200 + no-store above: some rows are usable and
  // one flaky item must not flip the whole app.
  if (upstreamFailed && failedCount === ids.length) {
    return new Response(
      JSON.stringify({ error: 'All upstream item fetches failed' }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  }

  return new Response(JSON.stringify(items), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Short browser TTL, longer shared TTL at the Vercel edge. The
      // stale-while-revalidate window lets the edge serve a cached
      // batch instantly while refreshing in the background.
      'cache-control': upstreamFailed
        ? 'no-store'
        : 'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
    },
  });
}

async function defaultFetchItem(
  id: number,
  signal?: AbortSignal,
): Promise<HNItem | null> {
  const res = await fetch(HN_ITEM_URL(id), { signal });
  // Throw (rather than return null) so the handler can tell "Firebase
  // says this id doesn't exist" apart from "Firebase errored" — only
  // the former is safe to cache at the shared edge.
  if (!res.ok) throw new Error(`HN API ${res.status} for item ${id}`);
  return (await res.json()) as HNItem | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function GET(request: Request): Promise<Response> {
  return handleItemsRequest(request);
}
