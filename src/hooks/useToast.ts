import { createContext, useContext } from 'react';

export interface ToastOptions {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
  // Toasts sharing a groupKey replace each other in place without
  // restarting the entry animation. Used for batched updates (e.g.
  // a growing "Dismissed N · Undo" while the user keeps dismissing).
  groupKey?: string;
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
