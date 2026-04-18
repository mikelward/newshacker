import { createContext, useContext } from 'react';

export interface ToastOptions {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
}

export interface ToastContextValue {
  showToast: (opts: ToastOptions) => void;
}

// Default no-op so callers work without a provider (useful in tests that
// don't need to assert on toast output).
export const ToastContext = createContext<ToastContextValue>({
  showToast: () => {},
});

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
