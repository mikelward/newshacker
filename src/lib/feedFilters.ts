const STORAGE_KEY = 'newshacker:feedFilters';
export const FEED_FILTERS_CHANGE_EVENT = 'newshacker:feedFiltersChanged';

export interface FeedFilters {
  /** Show only stories the reader has never opened (article or thread). */
  unreadOnly: boolean;
  /** Show only stories flagged as hot by `isHotStory`. */
  hotOnly: boolean;
}

const DEFAULT: FeedFilters = { unreadOnly: false, hotOnly: false };

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function parse(raw: string | null): FeedFilters {
  if (!raw) return { ...DEFAULT };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT };
  const obj = parsed as Record<string, unknown>;
  return {
    unreadOnly: obj.unreadOnly === true,
    hotOnly: obj.hotOnly === true,
  };
}

export function getFeedFilters(): FeedFilters {
  if (!hasWindow()) return { ...DEFAULT };
  try {
    return parse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT };
  }
}

export function setFeedFilters(
  updater: FeedFilters | ((prev: FeedFilters) => FeedFilters),
): void {
  if (!hasWindow()) return;
  const prev = getFeedFilters();
  const next = typeof updater === 'function' ? updater(prev) : updater;
  if (next.unreadOnly === prev.unreadOnly && next.hotOnly === prev.hotOnly) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // quota or privacy-mode failures are non-fatal — the toggle simply
    // won't persist across reloads.
  }
  window.dispatchEvent(new CustomEvent(FEED_FILTERS_CHANGE_EVENT));
}

export function clearFeedFilters(): void {
  setFeedFilters({ ...DEFAULT });
}
