import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FEEDS, feedLabel } from '../lib/feeds';
import { useTheme } from '../hooks/useTheme';
import type { Theme } from '../lib/theme';
import './AppDrawer.css';

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AppDrawer({ open, onClose }: Props) {
  const location = useLocation();
  const lastLocationRef = useRef(location.key);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

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
            <Link to="/saved" className="app-drawer__link">
              Saved
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
              className="app-drawer__segmented-btn"
              data-active={theme === opt.value || undefined}
              onClick={() => setTheme(opt.value)}
            >
              {opt.label}
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
