import { useState, type FormEvent } from 'react';
import { LoginError, useAuth } from '../hooks/useAuth';

interface Props {
  // Called after the login POST resolves to a valid session. Hosts use
  // it to dismiss themselves (dialog closes; page redirects).
  onSuccess?: () => void;
  // Class prefix so the page and dialog wrappers can theme the form
  // without duplicating the markup. `login-page` on the route,
  // `login-dialog` inside the modal — both define matching CSS rules.
  classPrefix: 'login-page' | 'login-dialog';
  // Optional autoFocus on the username input. The dialog opts in so a
  // keyboard user can start typing as soon as it appears; the page
  // doesn't, because routing into /login from a focused link would
  // steal focus mid-navigation.
  autoFocusUsername?: boolean;
}

export function LoginForm({ onSuccess, classPrefix, autoFocusUsername }: Props) {
  const auth = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    !submitting && username.trim().length > 0 && password.length > 0;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await auth.login(username.trim(), password);
      onSuccess?.();
    } catch (err) {
      if (err instanceof LoginError) {
        setError(err.message);
      } else {
        setError(
          'Could not reach the server. Check your connection and try again.',
        );
      }
      // Clear the password on failure so the user doesn't re-submit the
      // same wrong one by accident — matches HN's own login behavior.
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={`${classPrefix}__form`} onSubmit={onSubmit} noValidate>
      <label className={`${classPrefix}__label`}>
        <span>Username</span>
        <input
          type="text"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={submitting}
          autoFocus={autoFocusUsername}
          data-testid="login-username"
        />
      </label>
      <label className={`${classPrefix}__label`}>
        <span>Password</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          data-testid="login-password"
        />
      </label>
      {error ? (
        <p
          className={`${classPrefix}__error`}
          role="alert"
          data-testid="login-error"
        >
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        className={`${classPrefix}__submit`}
        disabled={!canSubmit}
        data-testid="login-submit"
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
