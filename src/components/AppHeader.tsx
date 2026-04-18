import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FEEDS, feedLabel } from '../lib/feeds';
import { AppDrawer } from './AppDrawer';
import './AppHeader.css';

export function AppHeader() {
  const params = useParams();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <header className="app-header" role="banner">
        <div className="app-header__home-row">
          <button
            type="button"
            className="app-header__menu-btn"
            aria-label="Open menu"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <span aria-hidden="true" className="app-header__menu-icon">
              ☰
            </span>
          </button>
          <Link
            to="/top"
            className="app-header__home"
            aria-label="Newshacker home"
          >
            <span className="app-header__brand" aria-hidden="true">
              N
            </span>
            <span className="app-header__title">Newshacker</span>
          </Link>
        </div>
        <nav className="app-header__tabs" aria-label="Feeds">
          {FEEDS.map((f) => (
            <Link
              key={f}
              to={`/${f}`}
              className={`app-header__tab${
                params.feed === f ? ' is-active' : ''
              }`}
            >
              {feedLabel(f)}
            </Link>
          ))}
        </nav>
      </header>
      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
