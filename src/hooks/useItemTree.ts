import { useQuery } from '@tanstack/react-query';
import { getItem, type HNItem } from '../lib/hn';

export interface ItemRoot {
  item: HNItem;
  kidIds: number[];
}

async function loadRoot(id: number, signal?: AbortSignal): Promise<ItemRoot | null> {
  const item = await getItem(id, signal);
  if (!item) return null;
  const kidIds = item.deleted || item.dead ? [] : (item.kids ?? []);
  return { item, kidIds };
}

export function useItemTree(id: number) {
  return useQuery({
    queryKey: ['itemRoot', id],
    queryFn: ({ signal }) => loadRoot(id, signal),
    enabled: Number.isFinite(id),
  });
}

export function useCommentItem(id: number) {
  return useQuery({
    queryKey: ['comment', id],
    queryFn: ({ signal }) => getItem(id, signal),
    enabled: Number.isFinite(id),
    staleTime: 60_000,
  });
}

export { loadRoot as _loadRootForTests };
