import {
  createContext,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type Handler = () => void;

export interface FeedBarContextValue {
  sweep: Handler | null;
  sweepCount: number;
  setSweep: (handler: Handler | null, count: number) => void;

  showDismissed: boolean;
  toggleShowDismissed: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const FeedBarContext = createContext<FeedBarContextValue | null>(null);

export function FeedBarProvider({ children }: { children: ReactNode }) {
  const [sweepState, setSweepState] = useState<{
    handler: Handler | null;
    count: number;
  }>({ handler: null, count: 0 });

  const [showDismissed, setShowDismissed] = useState(false);

  const setSweep = useCallback(
    (handler: Handler | null, count: number) => {
      setSweepState((prev) => {
        if (prev.handler === handler && prev.count === count) return prev;
        return { handler, count };
      });
    },
    [],
  );

  const toggleShowDismissed = useCallback(() => {
    setShowDismissed((v) => !v);
  }, []);

  const value = useMemo<FeedBarContextValue>(
    () => ({
      sweep: sweepState.handler,
      sweepCount: sweepState.count,
      setSweep,
      showDismissed,
      toggleShowDismissed,
    }),
    [
      sweepState.handler,
      sweepState.count,
      setSweep,
      showDismissed,
      toggleShowDismissed,
    ],
  );

  return (
    <FeedBarContext.Provider value={value}>
      {children}
    </FeedBarContext.Provider>
  );
}
