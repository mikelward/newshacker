import { NavLink } from 'react-router-dom';
import { FEEDS, feedLabel } from '../lib/feeds';
import './BottomNav.css';

export function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Feeds">
      {FEEDS.map((f) => (
        <NavLink
          key={f}
          to={`/${f}`}
          className={({ isActive }) =>
            `bottom-nav__link${isActive ? ' is-active' : ''}`
          }
        >
          {feedLabel(f)}
        </NavLink>
      ))}
    </nav>
  );
}
