import {
  createContext,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { removeHiddenId } from '../lib/hiddenStories';

type Handler = () => void;
type RefreshHandler = () => void | Promise<unknown>;

export interface FeedBarContextValue {
  sweep: Handler | null;
  sweepCount: number;
  setSweep: (handler: Handler | null, count: number) => void;

  // The current feed's refresh hook, registered by StoryList. Wiring
  // it through context (vs. a prop drill into AppHeader) lets the
  // header own a Refresh button without having to know which feed is
  // on screen. `null` on non-feed pages so the header can disable its
  // Refresh button.
  refresh: RefreshHandler | null;
  setRefresh: (handler: RefreshHandler | null) => void;

  canUndo: boolean;
  recordHide: (ids: readonly number[]) => void;
  undo: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const FeedBarContext = createContext<FeedBarContextValue | null>(null);

export function FeedBarProvider({ children }: { children: ReactNode }) {
  const [sweepState, setSweepState] = useState<{
    handler: Handler | null;
    count: number;
  }>({ handler: null, count: 0 });
  const [refreshHandler, setRefreshHandler] = useState<RefreshHandler | null>(
    null,
  );

  // Only the most recent hide action is undoable — one level of undo,
  // matching the "undo the last sweep or last swipe" behaviour.
  const [lastHidden, setLastHidden] = useState<readonly number[]>([]);
  const lastHiddenRef = useRef<readonly number[]>([]);
  lastHiddenRef.current = lastHidden;

  const setSweep = useCallback(
    (handler: Handler | null, count: number) => {
      setSweepState((prev) => {
        if (prev.handler === handler && prev.count === count) return prev;
        return { handler, count };
      });
    },
    [],
  );

  const setRefresh = useCallback((handler: RefreshHandler | null) => {
    // Wrap in a function setter — useState would otherwise invoke the
    // handler and store its return value.
    setRefreshHandler(() => handler);
  }, []);

  const recordHide = useCallback((ids: readonly number[]) => {
    if (ids.length === 0) return;
    setLastHidden(Array.from(ids));
  }, []);

  const undo = useCallback(() => {
    const ids = lastHiddenRef.current;
    if (ids.length === 0) return;
    for (const id of ids) removeHiddenId(id);
    setLastHidden([]);
  }, []);

  const value = useMemo<FeedBarContextValue>(
    () => ({
      sweep: sweepState.handler,
      sweepCount: sweepState.count,
      setSweep,
      refresh: refreshHandler,
      setRefresh,
      canUndo: lastHidden.length > 0,
      recordHide,
      undo,
    }),
    [
      sweepState.handler,
      sweepState.count,
      setSweep,
      refreshHandler,
      setRefresh,
      lastHidden,
      recordHide,
      undo,
    ],
  );

  return (
    <FeedBarContext.Provider value={value}>
      {children}
    </FeedBarContext.Provider>
  );
}
