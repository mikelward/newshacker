import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../hooks/useAuth';
import { getUser } from '../lib/hn';
import { TooltipButton } from './TooltipButton';
import { UserAvatar } from './UserAvatar';
import './HeaderAccountMenu.css';

// Always-visible auth control in the top-right. Two display states:
//   1. Logged out — anonymous silhouette avatar; tap navigates to /login.
//   2. Logged in — colored initial avatar; tap opens a dropdown with
//      the username, karma, a link to /user/:username, and Log out.
//
// We deliberately don't render a spinner or skeleton while /api/me is
// loading — the logged-out silhouette is the safe default. A
// returning user's cached session rehydrates synchronously from the
// React Query persister, so there's no flash for typical sessions.

export function HeaderAccountMenu() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Karma is only fetched when the menu is open — opening it is the
  // explicit signal that the reader cares about their profile info.
  // Sticks in React Query cache via the ['user', username] key so
  // navigating to /user/:username is cache-hot.
  const userQuery = useQuery({
    queryKey: ['user', auth.user?.username ?? ''],
    queryFn: ({ signal }) =>
      auth.user ? getUser(auth.user.username, signal) : Promise.resolve(null),
    enabled: open && !!auth.user?.username,
    staleTime: 60 * 60 * 1000,
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Close the menu on route change — we don't want a stale menu hanging
  // over a brand-new page.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const onButtonClick = useCallback(() => {
    if (!auth.user) {
      // Remember where the user was so we can send them back after login.
      navigate('/login', { state: { from: location.pathname } });
      return;
    }
    setOpen((v) => !v);
  }, [auth.user, navigate, location.pathname]);

  const onLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await auth.logout();
      setOpen(false);
    } finally {
      setLoggingOut(false);
    }
  }, [auth, loggingOut]);

  const user = auth.user;
  const ariaLabel = user ? `Account menu for ${user.username}` : 'Sign in';
  const tooltip = user ? user.username : 'Sign in';

  return (
    <div className="header-account" ref={wrapperRef}>
      <TooltipButton
        type="button"
        className="header-account__btn"
        data-testid="header-account-btn"
        tooltip={tooltip}
        aria-label={ariaLabel}
        aria-haspopup={user ? 'menu' : undefined}
        aria-expanded={user ? open : undefined}
        onClick={onButtonClick}
      >
        <UserAvatar username={user?.username} />
      </TooltipButton>
      {user && open ? (
        <div
          className="header-account__menu"
          role="menu"
          data-testid="header-account-menu"
        >
          <div className="header-account__menu-header">
            <span className="header-account__menu-name">{user.username}</span>
            {typeof userQuery.data?.karma === 'number' ? (
              <span
                className="header-account__menu-meta"
                data-testid="header-account-karma"
              >
                {userQuery.data.karma.toLocaleString()} karma
              </span>
            ) : null}
          </div>
          <Link
            to={`/user/${user.username}`}
            role="menuitem"
            className="header-account__menu-item"
            data-testid="header-account-profile"
            onClick={() => setOpen(false)}
          >
            View profile
          </Link>
          <button
            type="button"
            role="menuitem"
            className="header-account__menu-item"
            data-testid="header-account-logout"
            onClick={onLogout}
            disabled={loggingOut}
          >
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
