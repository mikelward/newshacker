import { useId } from 'react';
import { Link } from 'react-router-dom';
import { ConnectedApps } from '../components/ConnectedApps';
import { HotRuleEditor } from '../components/ListToolbar';
import { ChromeIcon, ThemeIcon } from '../components/appearanceIcons';
import {
  CHROME_OPTIONS,
  FONT_SIZE_OPTIONS,
  THEME_OPTIONS,
} from '../components/appearanceOptions';
import { TooltipButton } from '../components/TooltipButton';
import { useTheme } from '../hooks/useTheme';
import { useChrome } from '../hooks/useChrome';
import { useFontSize } from '../hooks/useFontSize';
import { useHomeFeed } from '../hooks/useHomeFeed';
import {
  useHideOnScroll,
  useStickyBottomBar,
} from '../hooks/useFeedSettings';
import { HOME_FEED_OPTIONS } from '../lib/homeFeed';
import './SettingsPage.css';

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { chrome, setChrome } = useChrome();
  const { fontSize, setFontSize } = useFontSize();
  const { homeFeed, setHomeFeed } = useHomeFeed();
  const { hideOnScroll, setHideOnScroll } = useHideOnScroll();
  const { stickyBottomBar, setStickyBottomBar } = useStickyBottomBar();
  const hotPanelId = useId();

  return (
    <article className="settings-page">
      <h1 className="settings-page__title">Settings</h1>
      <p className="settings-page__intro">
        Every setting is per-device and stored in your browser. The appearance
        controls are also in the menu (☰) for quick access.
      </p>

      <section className="settings-page__section">
        <h2 className="settings-page__heading">Appearance</h2>

        <div className="settings-page__field-label" id="settings-mode-label">
          Mode
        </div>
        <div
          className="settings-page__segmented"
          role="radiogroup"
          aria-labelledby="settings-mode-label"
        >
          {THEME_OPTIONS.map((opt) => (
            <TooltipButton
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={theme === opt.value}
              tooltip={opt.label}
              aria-label={opt.label}
              className="settings-page__segmented-btn"
              data-active={theme === opt.value || undefined}
              onClick={() => setTheme(opt.value)}
            >
              <ThemeIcon path={opt.path} />
            </TooltipButton>
          ))}
        </div>

        <div className="settings-page__field-label" id="settings-appbar-label">
          App bar
        </div>
        <div
          className="settings-page__segmented"
          role="radiogroup"
          aria-labelledby="settings-appbar-label"
        >
          {CHROME_OPTIONS.map((opt) => (
            <TooltipButton
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={chrome === opt.value}
              tooltip={opt.label}
              aria-label={opt.label}
              className="settings-page__segmented-btn"
              data-active={chrome === opt.value || undefined}
              onClick={() => setChrome(opt.value)}
            >
              <ChromeIcon variant={opt.value} />
            </TooltipButton>
          ))}
        </div>

        <div className="settings-page__field-label" id="settings-textsize-label">
          Text size
        </div>
        <div
          className="settings-page__segmented"
          role="radiogroup"
          aria-labelledby="settings-textsize-label"
        >
          {FONT_SIZE_OPTIONS.map((opt) => (
            <TooltipButton
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={fontSize === opt.value}
              tooltip={opt.label}
              aria-label={opt.label}
              className="settings-page__segmented-btn"
              data-active={fontSize === opt.value || undefined}
              onClick={() => setFontSize(opt.value)}
            >
              <span
                className="settings-page__size-glyph"
                style={{ fontSize: opt.glyph }}
                aria-hidden="true"
              >
                A
              </span>
            </TooltipButton>
          ))}
        </div>
      </section>

      <section className="settings-page__section">
        <h2 className="settings-page__heading">Reading</h2>

        <div className="settings-page__field-label" id="settings-home-label">
          Home feed
        </div>
        <div
          className="settings-page__segmented"
          role="radiogroup"
          aria-labelledby="settings-home-label"
        >
          {HOME_FEED_OPTIONS.map((opt) => (
            <TooltipButton
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={homeFeed === opt.value}
              tooltip={`Home shows ${opt.label}`}
              aria-label={`Home shows ${opt.label}`}
              className="settings-page__segmented-btn settings-page__segmented-btn--text"
              data-active={homeFeed === opt.value || undefined}
              onClick={() => setHomeFeed(opt.value)}
            >
              {opt.label}
            </TooltipButton>
          ))}
        </div>

        <label className="settings-page__toggle">
          <input
            type="checkbox"
            className="settings-page__toggle-input"
            checked={hideOnScroll}
            onChange={(e) => setHideOnScroll(e.target.checked)}
          />
          <span className="settings-page__toggle-text">
            <span className="settings-page__toggle-title">
              Hide stories as you scroll past
            </span>
            <span className="settings-page__toggle-desc">
              Unpinned stories are dismissed once you scroll them off the top.
              Pin a story to keep it.
            </span>
          </span>
        </label>
        <label className="settings-page__toggle">
          <input
            type="checkbox"
            className="settings-page__toggle-input"
            checked={stickyBottomBar}
            onChange={(e) => setStickyBottomBar(e.target.checked)}
          />
          <span className="settings-page__toggle-text">
            <span className="settings-page__toggle-title">
              Sticky bottom toolbar
            </span>
            <span className="settings-page__toggle-desc">
              Keep the Back to top / More / Undo / Sweep bar pinned to the
              bottom of the screen instead of at the end of the list.
            </span>
          </span>
        </label>
      </section>

      <section className="settings-page__section">
        <h2 className="settings-page__heading">Hot rule</h2>
        <p className="settings-page__section-desc">
          Tune which stories qualify for the Hot view. A story shows if it
          clears either enabled rule. The same controls appear in the toolbar
          on <code>/hot</code>.
        </p>
        <HotRuleEditor panelId={hotPanelId} />
      </section>

      <ConnectedApps />

      <section className="settings-page__section">
        <h2 className="settings-page__heading">More</h2>
        <ul className="settings-page__links">
          <li>
            <Link to="/help">Help</Link>
          </li>
          <li>
            <Link to="/about">About</Link>
          </li>
          <li>
            <Link to="/debug">Debug</Link>
          </li>
        </ul>
      </section>

      <p className="settings-page__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}
