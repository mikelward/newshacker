import { useCallback, useEffect, useState } from 'react';
import {
  HIDE_ON_SCROLL_CHANGE_EVENT,
  STICKY_BOTTOM_BAR_CHANGE_EVENT,
  getStoredHideOnScroll,
  getStoredStickyBottomBar,
  setStoredHideOnScroll,
  setStoredStickyBottomBar,
} from '../lib/feedSettings';

// Subscribes to a per-device feed flag. Re-reads on the flag's custom change
// event (same-tab) and on `storage` (cross-tab), mirroring useTheme.
function useFeedFlag(
  read: () => boolean,
  write: (enabled: boolean) => void,
  changeEvent: string,
): [boolean, (enabled: boolean) => void] {
  const [value, setValue] = useState<boolean>(read);

  useEffect(() => {
    const sync = () => setValue(read());
    window.addEventListener(changeEvent, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(changeEvent, sync);
      window.removeEventListener('storage', sync);
    };
  }, [read, changeEvent]);

  const set = useCallback((enabled: boolean) => write(enabled), [write]);
  return [value, set];
}

/** Whether unpinned stories auto-dismiss as they scroll off the top. */
export function useHideOnScroll(): {
  hideOnScroll: boolean;
  setHideOnScroll: (enabled: boolean) => void;
} {
  const [hideOnScroll, setHideOnScroll] = useFeedFlag(
    getStoredHideOnScroll,
    setStoredHideOnScroll,
    HIDE_ON_SCROLL_CHANGE_EVENT,
  );
  return { hideOnScroll, setHideOnScroll };
}

/** Whether the bottom action bar is pinned to the viewport foot (vs. flowing at
 * the end of the list). */
export function useStickyBottomBar(): {
  stickyBottomBar: boolean;
  setStickyBottomBar: (enabled: boolean) => void;
} {
  const [stickyBottomBar, setStickyBottomBar] = useFeedFlag(
    getStoredStickyBottomBar,
    setStoredStickyBottomBar,
    STICKY_BOTTOM_BAR_CHANGE_EVENT,
  );
  return { stickyBottomBar, setStickyBottomBar };
}
