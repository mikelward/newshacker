import { Link, useParams } from 'react-router-dom';
import { FEEDS, feedLabel } from '../lib/feeds';
import './AppHeader.css';

export function AppHeader() {
  const params = useParams();

  return (
    <header className="app-header" role="banner">
      <Link to="/top" className="app-header__home" aria-label="Newshacker home">
        <span className="app-header__brand" aria-hidden="true">
          N
        </span>
        <span className="app-header__title">Newshacker</span>
      </Link>
      <nav className="app-header__tabs" aria-label="Feeds">
        {FEEDS.map((f) => (
          <Link
            key={f}
            to={`/${f}`}
            className={`app-header__tab${params.feed === f ? ' is-active' : ''}`}
          >
            {feedLabel(f)}
          </Link>
        ))}
      </nav>
    </header>
  );
}
