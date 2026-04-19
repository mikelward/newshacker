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

  const fetchItem = deps.fetchItem ?? defaultFetchItem;

  const items = await Promise.all(
    ids.map(async (id) => {
      try {
        return thinForFeed(await fetchItem(id, request.signal));
      } catch {
        return null;
      }
    }),
  );

  return new Response(JSON.stringify(items), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Short browser TTL, longer shared TTL at the Vercel edge. The
      // stale-while-revalidate window lets the edge serve a cached
      // batch instantly while refreshing in the background.
      'cache-control':
        'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
    },
  });
}

async function defaultFetchItem(
  id: number,
  signal?: AbortSignal,
): Promise<HNItem | null> {
  const res = await fetch(HN_ITEM_URL(id), { signal });
  if (!res.ok) return null;
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
