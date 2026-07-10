import './States.css';

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="state state--error" role="alert" data-testid="error-state">
      <p className="state__message">{message}</p>
      {onRetry ? (
        <button type="button" className="retry-btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

interface EmptyStateProps {
  message: string;
}

export function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="state state--empty" data-testid="empty-state">
      <p className="state__message">{message}</p>
    </div>
  );
}

interface LoadingStateProps {
  /** The label announced to assistive tech (and shown on screen when
   * {@link LoadingStateProps.showLabel} is set). */
  label?: string;
  /** Render the label as visible on-screen text beside the spinner, rather than
   * only exposing it to assistive tech. Use this where the wait should read as
   * "Loading…" instead of a bare spinner. */
  showLabel?: boolean;
}

export function LoadingState({
  label = 'Loading…',
  showLabel = false,
}: LoadingStateProps) {
  return (
    <div
      className="state state--loading"
      role="status"
      aria-live="polite"
      data-testid="loading-state"
    >
      <span className="state__spinner" aria-hidden="true" />
      {showLabel ? (
        <span className="state__loading-label">{label}</span>
      ) : (
        <span className="state__sr-only">{label}</span>
      )}
    </div>
  );
}
