import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AppDrawer } from './AppDrawer';
import './AppHeader.css';

export function AppHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <header className="app-header" role="banner">
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
      </header>
      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
