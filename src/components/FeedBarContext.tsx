import {
  createContext,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { removeDismissedId } from '../lib/dismissedStories';

type Handler = () => void;

export interface FeedBarContextValue {
  sweep: Handler | null;
  sweepCount: number;
  setSweep: (handler: Handler | null, count: number) => void;

  canUndo: boolean;
  recordDismiss: (ids: readonly number[]) => void;
  undo: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const FeedBarContext = createContext<FeedBarContextValue | null>(null);

export function FeedBarProvider({ children }: { children: ReactNode }) {
  const [sweepState, setSweepState] = useState<{
    handler: Handler | null;
    count: number;
  }>({ handler: null, count: 0 });

  // Only the most recent dismiss action is undoable — one level of undo,
  // matching the "undo the last sweep or last swipe" behaviour.
  const [lastDismissed, setLastDismissed] = useState<readonly number[]>([]);
  const lastDismissedRef = useRef<readonly number[]>([]);
  lastDismissedRef.current = lastDismissed;

  const setSweep = useCallback(
    (handler: Handler | null, count: number) => {
      setSweepState((prev) => {
        if (prev.handler === handler && prev.count === count) return prev;
        return { handler, count };
      });
    },
    [],
  );

  const recordDismiss = useCallback((ids: readonly number[]) => {
    if (ids.length === 0) return;
    setLastDismissed(Array.from(ids));
  }, []);

  const undo = useCallback(() => {
    const ids = lastDismissedRef.current;
    if (ids.length === 0) return;
    for (const id of ids) removeDismissedId(id);
    setLastDismissed([]);
  }, []);

  const value = useMemo<FeedBarContextValue>(
    () => ({
      sweep: sweepState.handler,
      sweepCount: sweepState.count,
      setSweep,
      canUndo: lastDismissed.length > 0,
      recordDismiss,
      undo,
    }),
    [
      sweepState.handler,
      sweepState.count,
      setSweep,
      lastDismissed,
      recordDismiss,
      undo,
    ],
  );

  return (
    <FeedBarContext.Provider value={value}>
      {children}
    </FeedBarContext.Provider>
  );
}
