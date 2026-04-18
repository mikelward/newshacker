import { Link, useLocation, useParams } from 'react-router-dom';
import { FEEDS, feedLabel, isFeed } from '../lib/feeds';
import './AppHeader.css';

function currentTitle(pathname: string, params: Record<string, string | undefined>): string {
  if (pathname.startsWith('/item/')) return 'Thread';
  if (pathname.startsWith('/user/')) return 'User';
  const feed = params.feed;
  if (feed && isFeed(feed)) return feedLabel(feed);
  return 'Newshacker';
}

export function AppHeader() {
  const location = useLocation();
  const params = useParams();
  const title = currentTitle(location.pathname, params);

  return (
    <header className="app-header" role="banner">
      <Link to="/top" className="app-header__home" aria-label="Newshacker home">
        <span className="app-header__brand" aria-hidden="true">
          N
        </span>
        <span className="app-header__title">Newshacker</span>
      </Link>
      <span className="app-header__feed" aria-live="polite">
        {title}
      </span>
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
