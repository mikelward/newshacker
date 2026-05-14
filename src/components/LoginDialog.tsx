import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  LoginDialogContext,
  type LoginDialogContextValue,
  type OpenLoginDialogOptions,
} from '../hooks/useLoginDialog';
import { LoginForm } from './LoginForm';
import './LoginDialog.css';

interface DialogState {
  open: boolean;
  reason?: string;
}

export function LoginDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>({ open: false });
  // Caller-supplied focus restoration: stash whatever was focused when
  // the dialog opens, then re-focus it on close. Without this, a
  // keyboard user who taps a vote button, signs in, and closes the
  // dialog ends up with focus on <body>. Note: the provider
  // deliberately does NOT subscribe to useAuth — that would mount a
  // /api/me query on every page that has the provider in the tree,
  // costing a network round trip on routes that never need auth
  // (Offline, Debug, etc.). Callers (useVote, etc.) check auth
  // themselves before calling openLoginDialog.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setState({ open: false });
  }, []);

  const openLoginDialog = useCallback((opts?: OpenLoginDialogOptions) => {
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    setState({ open: true, reason: opts?.reason });
  }, []);

  // Escape-to-close + focus restore once the dialog is closed.
  useEffect(() => {
    if (!state.open) {
      const prev = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (prev && typeof prev.focus === 'function') {
        // Defer focus restoration to the next frame so it lands after
        // React has unmounted the dialog DOM — otherwise a focus on
        // an input inside the dialog wins the focus race.
        const id = window.requestAnimationFrame(() => prev.focus());
        return () => window.cancelAnimationFrame(id);
      }
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.open, close]);

  const value = useMemo<LoginDialogContextValue>(
    () => ({ openLoginDialog }),
    [openLoginDialog],
  );

  return (
    <LoginDialogContext.Provider value={value}>
      {children}
      {state.open ? (
        <LoginDialogPanel reason={state.reason} onClose={close} />
      ) : null}
    </LoginDialogContext.Provider>
  );
}

interface PanelProps {
  reason?: string;
  onClose: () => void;
}

function LoginDialogPanel({ reason, onClose }: PanelProps) {
  const headingId = useId();
  const heading = reason ?? 'Sign in to Hacker News';

  return (
    <div className="login-dialog" role="presentation">
      <button
        type="button"
        className="login-dialog__scrim"
        aria-label="Close sign-in dialog"
        data-testid="login-dialog-scrim"
        onClick={onClose}
      />
      <div
        className="login-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid="login-dialog"
      >
        <button
          type="button"
          className="login-dialog__close"
          aria-label="Close sign-in dialog"
          data-testid="login-dialog-close"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
        <h2 id={headingId} className="login-dialog__heading">
          {heading}
        </h2>
        <p className="login-dialog__intro">
          newshacker uses your existing news.ycombinator.com account.
          Your credentials are sent to Hacker News through our server
          and are never stored.
        </p>
        <LoginForm
          classPrefix="login-dialog"
          autoFocusUsername
          onSuccess={onClose}
        />
        <p className="login-dialog__disclosure">
          No Hacker News account?{' '}
          <a
            href="https://news.ycombinator.com/login"
            target="_blank"
            rel="noreferrer noopener"
          >
            Create one on HN
          </a>
          .
        </p>
      </div>
    </div>
  );
}
