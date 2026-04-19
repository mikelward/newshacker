import { Link } from 'react-router-dom';
import './AboutPage.css';

export function AboutPage() {
  return (
    <article className="about-page">
      <h1 className="about-page__title">About newshacker</h1>
      <p>
        newshacker is a mobile-friendly reader for{' '}
        <a
          href="https://news.ycombinator.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          Hacker News
        </a>
        .
      </p>

      <h2 className="about-page__heading">Unofficial client</h2>
      <p>
        newshacker is an independent project. It is{' '}
        <strong>not affiliated with, endorsed by, or sponsored by</strong>{' '}
        Y Combinator or the operators of Hacker News. The name &ldquo;Hacker
        News&rdquo; and the Y Combinator logo are trademarks of their
        respective owners and are used here only to describe the source of
        the content.
      </p>

      <h2 className="about-page__heading">Where the content comes from</h2>
      <p>
        Stories, comments, and user profiles are fetched directly from the
        public{' '}
        <a
          href="https://github.com/HackerNews/API"
          target="_blank"
          rel="noopener noreferrer"
        >
          Hacker News API
        </a>{' '}
        hosted on Firebase. All posts and comments are the work of their
        respective authors on Hacker News and remain their property.
        newshacker does not host, moderate, or edit this content.
      </p>

      <h2 className="about-page__heading">What newshacker stores</h2>
      <p>
        newshacker keeps a small amount of data on your device (in
        <code> localStorage</code>) to remember which stories you&rsquo;ve
        opened or ignored so they can be hidden or surfaced in the Library.
        This data stays in your browser &mdash; it is not sent to any
        server operated by newshacker.
      </p>

      <h2 className="about-page__heading">Reporting content</h2>
      <p>
        newshacker cannot remove or edit posts or comments. To flag
        something, please report it on{' '}
        <a
          href="https://news.ycombinator.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          news.ycombinator.com
        </a>
        .
      </p>

      <p className="about-page__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}
