import { createContext, useContext } from 'react';

export interface OpenLoginDialogOptions {
  // Short, action-specific heading replacement, e.g. "Sign in to upvote".
  // Defaults to "Sign in to Hacker News".
  reason?: string;
}

export interface LoginDialogContextValue {
  openLoginDialog: (opts?: OpenLoginDialogOptions) => void;
}

// Default no-op so callers (notably useVote) work in tests that don't
// mount the LoginDialogProvider. Same pattern as ToastContext.
export const LoginDialogContext = createContext<LoginDialogContextValue>({
  openLoginDialog: () => {},
});

export function useLoginDialog(): LoginDialogContextValue {
  return useContext(LoginDialogContext);
}
