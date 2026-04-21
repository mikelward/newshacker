import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LoginError, useAuth } from '../hooks/useAuth';
import './LoginPage.css';

interface LocationState {
  from?: string;
}

export function LoginPage() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = location.state as LocationState | null;
  const from = state?.from ?? '/top';

  // Never render the login form to an already-authenticated user. Using
  // a Navigate instead of an effect avoids a render flash of the form.
  if (auth.isAuthenticated) {
    return <Navigate to={from} replace />;
  }

  const canSubmit = !submitting && username.trim().length > 0 && password.length > 0;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await auth.login(username.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof LoginError) {
        setError(err.message);
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      // Clear the password on failure so the user doesn't re-submit the
      // same wrong one by accident — matches HN's own login behavior.
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="login-page" aria-labelledby="login-page-heading">
      <h1 id="login-page-heading" className="login-page__heading">
        Sign in to Hacker News
      </h1>
      <p className="login-page__intro">
        newshacker uses your existing news.ycombinator.com account. Your
        credentials are sent to Hacker News through our server and are
        never stored.
      </p>
      <form className="login-page__form" onSubmit={onSubmit} noValidate>
        <label className="login-page__label">
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
            data-testid="login-username"
          />
        </label>
        <label className="login-page__label">
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
          <p className="login-page__error" role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className="login-page__submit"
          disabled={!canSubmit}
          data-testid="login-submit"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="login-page__disclosure">
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
    </section>
  );
}
