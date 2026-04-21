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

export interface FeedBarContextValue {
  sweep: Handler | null;
  sweepCount: number;
  setSweep: (handler: Handler | null, count: number) => void;

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
      canUndo: lastHidden.length > 0,
      recordHide,
      undo,
    }),
    [
      sweepState.handler,
      sweepState.count,
      setSweep,
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
