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

export async function getItems(
  ids: number[],
  signal?: AbortSignal,
): Promise<Array<HNItem | null>> {
  return Promise.all(ids.map((id) => getItem(id, signal)));
}
