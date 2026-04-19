import { useContext } from 'react';
import {
  FeedBarContext,
  type FeedBarContextValue,
} from '../components/FeedBarContext';

const noop = () => {};

// Returns a no-op context when used outside a provider so components
// can render in isolation (e.g. unit tests that mount just one piece).
export function useFeedBar(): FeedBarContextValue {
  const ctx = useContext(FeedBarContext);
  if (ctx) return ctx;
  return {
    sweep: null,
    sweepCount: 0,
    setSweep: noop,
    canUndo: false,
    recordDismiss: noop,
    undo: noop,
  };
}
