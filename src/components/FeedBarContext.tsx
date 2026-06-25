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

/** Options for {@link FeedBarContextValue.recordHide}. */
export interface RecordHideOptions {
  /** When set and equal to the key that produced the current undo batch, the
   * new ids are appended to that batch instead of replacing it — so a stream of
   * auto-dismiss-on-scroll hides (one stable key per burst) restores as a single
   * Undo. A keyless call (swipe / Sweep) always replaces the batch and clears
   * the key, so an intervening manual dismissal can't be folded into a later
   * scroll burst. */
  batchKey?: string | number;
}

export interface FeedBarContextValue {
  sweep: Handler | null;
  sweepCount: number;
  setSweep: (handler: Handler | null, count: number) => void;

  canUndo: boolean;
  recordHide: (ids: readonly number[], options?: RecordHideOptions) => void;
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
  // matching the "undo the last sweep or last swipe" behaviour. A burst of
  // auto-dismiss-on-scroll hides sharing a batchKey accumulates into this one
  // batch so a single Undo restores the whole burst.
  const [lastHidden, setLastHidden] = useState<readonly number[]>([]);
  // Identity of the action that produced `lastHidden`; only a matching key may
  // extend it (see RecordHideOptions). null = no extendable batch.
  const lastHiddenKeyRef = useRef<string | number | null>(null);

  const setSweep = useCallback(
    (handler: Handler | null, count: number) => {
      setSweepState((prev) => {
        if (prev.handler === handler && prev.count === count) return prev;
        return { handler, count };
      });
    },
    [],
  );

  const recordHide = useCallback(
    (ids: readonly number[], options?: RecordHideOptions) => {
      if (ids.length === 0) return;
      const batchKey = options?.batchKey;
      const extend = batchKey != null && batchKey === lastHiddenKeyRef.current;
      lastHiddenKeyRef.current = batchKey ?? null;
      setLastHidden((prev) => {
        if (extend && prev.length > 0) {
          const seen = new Set(prev);
          return [...prev, ...ids.filter((id) => !seen.has(id))];
        }
        return Array.from(ids);
      });
    },
    [],
  );

  const undo = useCallback(() => {
    if (lastHidden.length === 0) return;
    for (const id of lastHidden) removeHiddenId(id);
    lastHiddenKeyRef.current = null;
    setLastHidden([]);
  }, [lastHidden]);

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
