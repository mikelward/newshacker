import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FEEDS, feedLabel } from '../lib/feeds';
import { getStoryIds } from '../lib/hn';
import { useTheme } from '../hooks/useTheme';
import type { Theme } from '../lib/theme';
import './AppDrawer.css';

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960,
// fill-based paths that take `color` via currentColor.
const MS_VIEWBOX = '0 -960 960 960';

function ThemeIcon({ path }: { path: string }) {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}

const LIGHT_PATH =
  'M480-360q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Zm0 80q-83 0-141.5-58.5T280-480q0-83 58.5-141.5T480-680q83 0 141.5 58.5T680-480q0 83-58.5 141.5T480-280ZM200-440H40v-80h160v80Zm720 0H760v-80h160v80ZM440-760v-160h80v160h-80Zm0 720v-160h80v160h-80ZM256-650l-101-97 57-59 96 100-52 56Zm492 496-97-101 53-55 101 97-57 59Zm-98-550 97-101 59 57-100 96-56-52ZM154-212l101-97 55 53-97 101-59-57Zm326-268Z';
const DARK_PATH =
  'M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q14 0 27.5 1t26.5 3q-41 29-65.5 75.5T444-660q0 90 63 153t153 63q55 0 101-24.5t75-65.5q2 13 3 26.5t1 27.5q0 150-105 255T480-120Zm0-80q104 0 182-66.5T754-436q-21 5-41.5 8t-42.5 3q-123 0-209.5-86.5T374-721q0-20 3-40t8-42q-103 26-169 104t-66 179q0 116 82 198t198 82Zm-10-270Z';
const SYSTEM_PATH =
  'M80-120v-80h240v-80H160q-33 0-56.5-23.5T80-360v-400q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v400q0 33-23.5 56.5T800-280H640v80h240v80H80Zm80-240h640v-400H160v400Zm0 0v-400 400Z';

const THEME_OPTIONS: Array<{ value: Theme; label: string; path: string }> = [
  { value: 'light', label: 'Light', path: LIGHT_PATH },
  { value: 'dark', label: 'Dark', path: DARK_PATH },
  { value: 'system', label: 'System', path: SYSTEM_PATH },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AppDrawer({ open, onClose }: Props) {
  const location = useLocation();
  const lastLocationRef = useRef(location.key);
  const { theme, setTheme } = useTheme();
  const client = useQueryClient();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // When the user opens the drawer, warm up the id list for every feed
  // so a tap on Top / New / Ask / … renders instantly. The id lists are
  // small (one request each) and the drawer open is a strong signal
  // that a feed switch is imminent.
  useEffect(() => {
    if (!open) return;
    for (const feed of FEEDS) {
      client.prefetchQuery({
        queryKey: ['storyIds', feed],
        queryFn: ({ signal }) => getStoryIds(feed, signal),
      });
    }
  }, [open, client]);

  useEffect(() => {
    if (open && location.key !== lastLocationRef.current) {
      onClose();
    }
    lastLocationRef.current = location.key;
  }, [open, location.key, onClose]);

  if (!open) return null;

  return (
    <div className="app-drawer" role="presentation">
      <button
        type="button"
        className="app-drawer__scrim"
        aria-label="Close menu"
        onClick={onClose}
      />
      <nav
        className="app-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <button
          type="button"
          className="app-drawer__close"
          data-testid="drawer-close"
          aria-label="Close menu"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
        <div className="app-drawer__section-title">Feeds</div>
        <ul className="app-drawer__list">
          {FEEDS.map((f) => (
            <li key={f}>
              <Link to={`/${f}`} className="app-drawer__link">
                {feedLabel(f)}
              </Link>
            </li>
          ))}
        </ul>
        <div className="app-drawer__section-title">Library</div>
        <ul className="app-drawer__list">
          <li>
            <Link to="/favorites" className="app-drawer__link">
              Favorites
            </Link>
          </li>
          <li>
            <Link to="/pinned" className="app-drawer__link">
              Pinned
            </Link>
          </li>
          <li>
            <Link to="/opened" className="app-drawer__link">
              Opened
            </Link>
          </li>
          <li>
            <Link to="/ignored" className="app-drawer__link">
              Ignored
            </Link>
          </li>
        </ul>
        <div className="app-drawer__section-title" id="app-drawer-theme-label">
          Theme
        </div>
        <div
          className="app-drawer__segmented"
          role="radiogroup"
          aria-labelledby="app-drawer-theme-label"
        >
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={theme === opt.value}
              aria-label={opt.label}
              className="app-drawer__segmented-btn"
              data-active={theme === opt.value || undefined}
              onClick={() => setTheme(opt.value)}
            >
              <ThemeIcon path={opt.path} />
            </button>
          ))}
        </div>
        <div className="app-drawer__section-title">App</div>
        <ul className="app-drawer__list">
          <li>
            <Link to="/help" className="app-drawer__link">
              Help
            </Link>
          </li>
          <li>
            <Link to="/about" className="app-drawer__link">
              About
            </Link>
          </li>
        </ul>
      </nav>
    </div>
  );
}
