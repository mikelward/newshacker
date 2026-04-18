import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  ToastContext,
  type ToastContextValue,
  type ToastOptions,
} from '../hooks/useToast';
import './Toast.css';

const DEFAULT_DURATION_MS = 4000;

interface ActiveToast extends ToastOptions {
  key: number;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const keyRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current != null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const dismiss = useCallback(() => {
    clearTimer();
    setToast(null);
  }, [clearTimer]);

  const showToast = useCallback(
    (opts: ToastOptions) => {
      clearTimer();
      setToast((prev) => {
        const sameGroup =
          prev != null &&
          opts.groupKey != null &&
          prev.groupKey === opts.groupKey;
        const key = sameGroup ? prev.key : ++keyRef.current;
        return { ...opts, key };
      });
      const duration = opts.durationMs ?? DEFAULT_DURATION_MS;
      timeoutRef.current = window.setTimeout(() => {
        setToast(null);
        timeoutRef.current = null;
      }, duration);
    },
    [clearTimer],
  );

  const value = useMemo<ToastContextValue>(
    () => ({ showToast }),
    [showToast],
  );

  const handleAction = () => {
    if (toast?.onAction) toast.onAction();
    dismiss();
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="toast-host"
        aria-live="polite"
        role="status"
        data-testid="toast-host"
      >
        {toast ? (
          <div className="toast" key={toast.key}>
            <span className="toast__message">{toast.message}</span>
            {toast.actionLabel ? (
              <button
                type="button"
                className="toast__action"
                onClick={handleAction}
              >
                {toast.actionLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}
