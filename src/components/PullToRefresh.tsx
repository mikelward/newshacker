import { useMemo, type ReactNode } from 'react';
import {
  PULL_TO_REFRESH_TRIGGER_PX,
  usePullToRefresh,
} from '../hooks/usePullToRefresh';
import './PullToRefresh.css';

interface Props {
  onRefresh: () => void | Promise<unknown>;
  children: ReactNode;
  // Opt out on environments (desktop, jsdom tests that don't care) where
  // the gesture would be noise. The handlers short-circuit; nothing
  // renders differently.
  enabled?: boolean;
}

export function PullToRefresh({ onRefresh, children, enabled = true }: Props) {
  const { phase, pull, progress, handlers } = usePullToRefresh({
    onRefresh,
    enabled,
  });

  const surfaceStyle = useMemo(() => {
    if (phase === 'idle') return undefined;
    const transform = `translate3d(0, ${pull}px, 0)`;
    // During an active drag we don't transition — the surface must
    // follow the finger 1:1. Only snap-back and release animations use
    // a transition.
    const transition =
      phase === 'pulling'
        ? 'none'
        : 'transform 200ms ease-out';
    return { transform, transition };
  }, [phase, pull]);

  const armed = progress >= 1;
  const spinning = phase === 'refreshing';
  const indicatorLabel = spinning
    ? 'Refreshing'
    : armed
      ? 'Release to refresh'
      : 'Pull to refresh';

  return (
    <div
      className="ptr"
      data-phase={phase}
      data-testid="pull-to-refresh"
      {...handlers}
    >
      <div className="ptr__surface" style={surfaceStyle}>
        <div
          className="ptr__indicator"
          aria-live="polite"
          role="status"
          data-armed={armed ? 'true' : 'false'}
          data-spinning={spinning ? 'true' : 'false'}
        >
          <span className="ptr__spinner" />
          <span className="visually-hidden">{indicatorLabel}</span>
        </div>
        <div className="ptr__content">{children}</div>
      </div>
    </div>
  );
}

export { PULL_TO_REFRESH_TRIGGER_PX };
