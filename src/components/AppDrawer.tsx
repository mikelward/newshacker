import { Fragment, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FEEDS, feedLabel } from '../lib/feeds';
import { getStoryIds } from '../lib/hn';
import { useTheme } from '../hooks/useTheme';
import { useChrome } from '../hooks/useChrome';
import { useFontSize } from '../hooks/useFontSize';
import { useHomeFeed } from '../hooks/useHomeFeed';
import { HOME_FEED_OPTIONS } from '../lib/homeFeed';
import { ChromeIcon, ThemeIcon } from './appearanceIcons';
import {
  CHROME_OPTIONS,
  FONT_SIZE_OPTIONS,
  THEME_OPTIONS,
} from './appearanceOptions';
import { TooltipButton } from './TooltipButton';
import './AppDrawer.css';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AppDrawer({ open, onClose }: Props) {
  const location = useLocation();
  const lastLocationRef = useRef(location.key);
  const { theme, setTheme } = useTheme();
  const { chrome, setChrome } = useChrome();
  const { fontSize, setFontSize } = useFontSize();
  const { homeFeed, setHomeFeed } = useHomeFeed();
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
        <TooltipButton
          type="button"
          className="app-drawer__close"
          data-testid="drawer-close"
          tooltip="Close menu"
          aria-label="Close menu"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </TooltipButton>
        {/* Home picker sits at the top because it's the highest-
            frequency setting (governs what `/` renders on every
            cold load) and it's a one-tap toggle, so the drawer
            opens onto the most-likely tap target. The full feed
            list lives near the bottom — those links are still
            reachable but they're the secondary navigation path
            (most readers stay on `/`). */}
        <div className="app-drawer__section-title">Home</div>
        <div
          className="app-drawer__segmented"
          role="radiogroup"
          aria-label="Home feed"
        >
          {HOME_FEED_OPTIONS.map((opt) => (
            <TooltipButton
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={homeFeed === opt.value}
              tooltip={`Home shows ${opt.label}`}
              aria-label={`Home shows ${opt.label}`}
              className="app-drawer__segmented-btn app-drawer__segmented-btn--text"
              data-active={homeFeed === opt.value || undefined}
              onClick={() => setHomeFeed(opt.value)}
            >
              {opt.label}
            </TooltipButton>
          ))}
        </div>
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
            <Link to="/offline" className="app-drawer__link">
              Offline
            </Link>
          </li>
          <li>
            <Link to="/done" className="app-drawer__link">
              Done
            </Link>
          </li>
          <li>
            <Link to="/opened" className="app-drawer__link">
              Opened
            </Link>
          </li>
          <li>
            <Link to="/hidden" className="app-drawer__link">
              Hidden
            </Link>
          </li>
        </ul>
        <div className="app-drawer__section-title">Theme</div>
        <div
          className="app-drawer__segmented"
          role="radiogroup"
          aria-label="Mode"
        >
          {THEME_OPTIONS.map((opt) => (
            <TooltipButton
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={theme === opt.value}
              tooltip={opt.label}
              aria-label={opt.label}
              className="app-drawer__segmented-btn"
              data-active={theme === opt.value || undefined}
              onClick={() => setTheme(opt.value)}
            >
              <ThemeIcon path={opt.path} />
            </TooltipButton>
          ))}
        </div>
        <div
          className="app-drawer__segmented"
          role="radiogroup"
          aria-label="Theme"
        >
          {CHROME_OPTIONS.map((opt) => (
            <TooltipButton
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={chrome === opt.value}
              tooltip={opt.label}
              aria-label={opt.label}
              className="app-drawer__segmented-btn"
              data-active={chrome === opt.value || undefined}
              onClick={() => setChrome(opt.value)}
            >
              <ChromeIcon variant={opt.value} />
            </TooltipButton>
          ))}
        </div>
        <div className="app-drawer__section-title">Text size</div>
        <div
          className="app-drawer__segmented"
          role="radiogroup"
          aria-label="Text size"
        >
          {FONT_SIZE_OPTIONS.map((opt) => (
            <TooltipButton
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={fontSize === opt.value}
              tooltip={opt.label}
              aria-label={opt.label}
              className="app-drawer__segmented-btn"
              data-active={fontSize === opt.value || undefined}
              onClick={() => setFontSize(opt.value)}
            >
              <span
                className="app-drawer__size-glyph"
                style={{ fontSize: opt.glyph }}
                aria-hidden="true"
              >
                A
              </span>
            </TooltipButton>
          ))}
        </div>

        <div className="app-drawer__section-title">Feeds</div>
        <ul className="app-drawer__list">
          {FEEDS.map((f) => (
            <Fragment key={f}>
              <li>
                <Link to={`/${f}`} className="app-drawer__link">
                  {feedLabel(f)}
                </Link>
              </li>
              {/* `/hot` slots in right after Top so it sits next
                  to the closest-related feed — see SPEC.md *Story
                  feeds → /hot*. Rendered as an explicit entry
                  rather than a member of the FEEDS array because
                  it isn't backed by a single Firebase id-list
                  endpoint (it merges /top and /new) and the
                  `feedEndpoint`, `isFeed`, and `<Route path="/:feed">`
                  callers all key off FEEDS. */}
              {f === 'top' ? (
                <li>
                  <Link to="/hot" className="app-drawer__link">
                    Hot
                  </Link>
                </li>
              ) : null}
            </Fragment>
          ))}
        </ul>
        <div className="app-drawer__section-title">App</div>
        <ul className="app-drawer__list">
          <li>
            <Link to="/settings" className="app-drawer__link">
              Settings
            </Link>
          </li>
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
          <li>
            <Link to="/debug" className="app-drawer__link">
              Debug
            </Link>
          </li>
        </ul>
      </nav>
    </div>
  );
}
