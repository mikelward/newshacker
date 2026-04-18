import { useQuery } from '@tanstack/react-query';
import { getItem, type HNItem } from '../lib/hn';

export interface CommentNode {
  item: HNItem;
  children: CommentNode[];
}

const CONCURRENCY = 6;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function loadTree(id: number, signal?: AbortSignal): Promise<CommentNode | null> {
  const item = await getItem(id, signal);
  if (!item) return null;
  if (item.deleted || item.dead) {
    return { item, children: [] };
  }
  const kids = item.kids ?? [];
  if (kids.length === 0) {
    return { item, children: [] };
  }
  const children = await mapWithConcurrency(kids, CONCURRENCY, (kid) =>
    loadTree(kid, signal),
  );
  return {
    item,
    children: children.filter((c): c is CommentNode => c !== null),
  };
}

export function useItemTree(id: number) {
  return useQuery({
    queryKey: ['itemTree', id],
    queryFn: ({ signal }) => loadTree(id, signal),
    enabled: Number.isFinite(id),
  });
}

export { loadTree as _loadTreeForTests };
