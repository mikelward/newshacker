import { feedEndpoint, type Feed } from './feeds';

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

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`HN API ${res.status}: ${url}`);
  }
  return (await res.json()) as T;
}

export function getStoryIds(feed: Feed, signal?: AbortSignal): Promise<number[]> {
  return getJson<number[]>(`${HN_API_BASE}/${feedEndpoint(feed)}.json`, signal);
}

export async function getItem(id: number, signal?: AbortSignal): Promise<HNItem | null> {
  const data = await getJson<HNItem | null>(`${HN_API_BASE}/item/${id}.json`, signal);
  return data;
}

export function getUser(id: string, signal?: AbortSignal): Promise<HNUser | null> {
  return getJson<HNUser | null>(`${HN_API_BASE}/user/${encodeURIComponent(id)}.json`, signal);
}

// Keep in sync with api/items.ts MAX_IDS. Anything larger gets chunked
// into multiple proxy calls so we stay inside the per-request cap and
// benefit from the shared edge cache.
export const ITEMS_BATCH_SIZE = 30;

export async function getItems(
  ids: number[],
  signal?: AbortSignal,
): Promise<Array<HNItem | null>> {
  if (ids.length === 0) return [];
  if (ids.length <= ITEMS_BATCH_SIZE) {
    return fetchItemsBatch(ids, signal);
  }
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += ITEMS_BATCH_SIZE) {
    chunks.push(ids.slice(i, i + ITEMS_BATCH_SIZE));
  }
  const pages = await Promise.all(
    chunks.map((chunk) => fetchItemsBatch(chunk, signal)),
  );
  return pages.flat();
}

async function fetchItemsBatch(
  ids: number[],
  signal?: AbortSignal,
): Promise<Array<HNItem | null>> {
  const res = await fetch(`/api/items?ids=${ids.join(',')}`, { signal });
  if (!res.ok) {
    throw new Error(`items API ${res.status}`);
  }
  return (await res.json()) as Array<HNItem | null>;
}
