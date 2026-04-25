import { Fragment, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FEEDS, feedLabel } from '../lib/feeds';
import { getStoryIds } from '../lib/hn';
import { useTheme } from '../hooks/useTheme';
import { useChrome } from '../hooks/useChrome';
import type { Theme } from '../lib/theme';
import type { Chrome } from '../lib/chrome';
import { TooltipButton } from './TooltipButton';
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
  'M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q14 0 27.5 1t26.5 3q-41 29-65.5 75.5T444-660q0 90 63 153t153 63q55 0 101-24.5t75-65.5q2 13 3 26.5t1 27.5q0 150-105 255T480-120Z';
const SYSTEM_PATH =
  'M80-120v-80h240v-80H160q-33 0-56.5-23.5T80-360v-400q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v400q0 33-23.5 56.5T800-280H640v80h240v80H80Zm80-240h640v-400H160v400Zm0 0v-400 400Z';

const THEME_OPTIONS: Array<{ value: Theme; label: string; path: string }> = [
  { value: 'light', label: 'Light', path: LIGHT_PATH },
  { value: 'dark', label: 'Dark', path: DARK_PATH },
  { value: 'system', label: 'System', path: SYSTEM_PATH },
];

// App-bar style icon — a small schematic of the bar showing how much
// orange the chrome carries. The mark and the optional wordmark line
// are painted in brand orange (`--nh-orange`) because the icon acts
// as a color *swatch*. `classic` draws the full orange bar with a
// white outlined disc; `mono` and `duo` use a neutral outline bar
// (`currentColor` so the outline inherits the button's text color
// and stays legible against the highlighted active-button surface).
// Only `duo` paints the wordmark line in orange — that single-pixel
// delta is what distinguishes it from `mono`.
function ChromeIcon({ variant }: { variant: Chrome }) {
  const isClassic = variant === 'classic';
  const barFill = isClassic ? 'var(--nh-orange)' : 'none';
  const barStroke = isClassic ? 'var(--nh-orange)' : 'currentColor';
  // Classic's real in-header mark is a transparent disc with a white
  // ring outline (the orange bar shows through), so the picker icon
  // mirrors that — `fill='none'` + white stroke. Mono and Duo both
  // use a filled orange disc.
  const discFill = isClassic ? 'none' : 'var(--nh-orange)';
  const discStroke = isClassic ? '#ffffff' : 'none';
  const discStrokeWidth = isClassic ? 0.75 : 0;
  return (
    <svg
      viewBox="0 0 40 16"
      width="34"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="0.75"
        y="0.75"
        width="38.5"
        height="14.5"
        rx="3"
        fill={barFill}
        stroke={barStroke}
        strokeWidth="1.5"
      />
      <circle
        cx="7"
        cy="8"
        r="3"
        fill={discFill}
        stroke={discStroke}
        strokeWidth={discStrokeWidth}
      />
      {variant === 'duo' ? (
        <rect
          x="12"
          y="6.25"
          width="20"
          height="3.5"
          rx="1"
          fill="var(--nh-orange)"
        />
      ) : null}
    </svg>
  );
}

const CHROME_OPTIONS: Array<{ value: Chrome; label: string }> = [
  { value: 'mono', label: 'Mono' },
  { value: 'duo', label: 'Duo' },
  { value: 'classic', label: 'Classic' },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AppDrawer({ open, onClose }: Props) {
  const location = useLocation();
  const lastLocationRef = useRef(location.key);
  const { theme, setTheme } = useTheme();
  const { chrome, setChrome } = useChrome();
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
