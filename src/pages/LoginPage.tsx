import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { LoginForm } from '../components/LoginForm';
import './LoginPage.css';

interface LocationState {
  from?: string;
}

export function LoginPage() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const state = location.state as LocationState | null;
  const from = state?.from ?? '/top';

  // Never render the login form to an already-authenticated user. Using
  // a Navigate instead of an effect avoids a render flash of the form.
  if (auth.isAuthenticated) {
    return <Navigate to={from} replace />;
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
      <LoginForm
        classPrefix="login-page"
        onSuccess={() => navigate(from, { replace: true })}
      />
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
