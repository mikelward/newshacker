import { feedEndpoint, type Feed } from './feeds';
import { trackedFetch, type TrackedFetchOptions } from './networkStatus';

export const HN_API_BASE = 'https://hacker-news.firebaseio.com/v0';

export type ItemType = 'story' | 'comment' | 'job' | 'poll' | 'pollopt';

export interface HNItem {
  id: number;
  type?: ItemType;
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  kids?: number[];
  parent?: number;
  dead?: boolean;
  deleted?: boolean;
}

export interface HNUser {
  id: string;
  created: number;
  karma: number;
  about?: string;
  submitted?: number[];
}

async function getJson<T>(
  url: string,
  signal?: AbortSignal,
  opts?: TrackedFetchOptions,
): Promise<T> {
  const res = await trackedFetch(url, { signal }, opts);
  if (!res.ok) {
    throw new Error(`HN API ${res.status}: ${url}`);
  }
  return (await res.json()) as T;
}

// Feed id lists and items are the core data plane — the content without which
// the app is empty. Those reads get the connectivity tracker's read cap +
// hedged liveness probe, and a 5xx there flips the app to 'down'. User
// profiles are deliberately NOT core: a failing /v0/user read should surface
// as an error on the profile view, not flip the global pill and pause every
// query while feeds and items are healthy.
export function getStoryIds(feed: Feed, signal?: AbortSignal): Promise<number[]> {
  return getJson<number[]>(`${HN_API_BASE}/${feedEndpoint(feed)}.json`, signal, {
    coreRead: true,
  });
}

export async function getItem(id: number, signal?: AbortSignal): Promise<HNItem | null> {
  const data = await getJson<HNItem | null>(`${HN_API_BASE}/item/${id}.json`, signal, {
    coreRead: true,
  });
  return data;
}

export function getUser(id: string, signal?: AbortSignal): Promise<HNUser | null> {
  return getJson<HNUser | null>(`${HN_API_BASE}/user/${encodeURIComponent(id)}.json`, signal);
}

// Keep in sync with api/items.ts MAX_IDS. Anything larger gets chunked
// into multiple proxy calls so we stay inside the per-request cap and
// benefit from the shared edge cache.
export const ITEMS_BATCH_SIZE = 30;

export interface GetItemsOptions {
  // 'full' keeps the `kids` array so comment-prefetch can still render
  // "N replies" indicators offline even when the replies themselves
  // aren't cached. Feed rendering uses the default (thinned) response
  // to keep payloads small.
  fields?: 'feed' | 'full';
}

export async function getItems(
  ids: number[],
  signal?: AbortSignal,
  options: GetItemsOptions = {},
): Promise<Array<HNItem | null>> {
  if (ids.length === 0) return [];
  if (ids.length <= ITEMS_BATCH_SIZE) {
    return fetchItemsBatch(ids, signal, options);
  }
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += ITEMS_BATCH_SIZE) {
    chunks.push(ids.slice(i, i + ITEMS_BATCH_SIZE));
  }
  const pages = await Promise.all(
    chunks.map((chunk) => fetchItemsBatch(chunk, signal, options)),
  );
  return pages.flat();
}

async function fetchItemsBatch(
  ids: number[],
  signal?: AbortSignal,
  options: GetItemsOptions = {},
): Promise<Array<HNItem | null>> {
  const qs = new URLSearchParams({ ids: ids.join(',') });
  if (options.fields === 'full') qs.set('fields', 'full');
  const res = await trackedFetch(
    `/api/items?${qs.toString()}`,
    { signal },
    // Core data plane, same as getJson: cap + hedge + 5xx→down.
    { coreRead: true },
  );
  if (!res.ok) {
    throw new Error(`items API ${res.status}`);
  }
  return (await res.json()) as Array<HNItem | null>;
}
