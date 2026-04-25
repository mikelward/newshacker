export const HOME_FEED_STORAGE_KEY = 'newshacker:homeFeed';
export const HOME_FEED_CHANGE_EVENT = 'newshacker:homeFeedChanged';

// What `/` renders. The URL itself is fixed — see SPEC.md *Story
// feeds → /hot* — only the rendered feed varies. `top` is the
// shipping default; `hot` promotes the heavily-filtered Top ∪ New
// view to the home slot. Deep links like `/top` and `/hot` stay
// explicit routes for shareability.
export type HomeFeed = 'top' | 'hot';

const HOME_FEEDS: readonly HomeFeed[] = ['top', 'hot'];

export const DEFAULT_HOME_FEED: HomeFeed = 'top';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isHomeFeed(value: unknown): value is HomeFeed {
  return (
    typeof value === 'string' &&
    (HOME_FEEDS as readonly string[]).includes(value)
  );
}

export function getStoredHomeFeed(): HomeFeed {
  if (!hasWindow()) return DEFAULT_HOME_FEED;
  try {
    const raw = window.localStorage.getItem(HOME_FEED_STORAGE_KEY);
    return isHomeFeed(raw) ? raw : DEFAULT_HOME_FEED;
  } catch {
    return DEFAULT_HOME_FEED;
  }
}

export function setStoredHomeFeed(feed: HomeFeed): void {
  if (!hasWindow()) return;
  try {
    if (feed === DEFAULT_HOME_FEED) {
      window.localStorage.removeItem(HOME_FEED_STORAGE_KEY);
    } else {
      window.localStorage.setItem(HOME_FEED_STORAGE_KEY, feed);
    }
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(
    new CustomEvent(HOME_FEED_CHANGE_EVENT, { detail: { feed } }),
  );
}
