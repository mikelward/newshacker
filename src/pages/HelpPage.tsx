import { Link } from 'react-router-dom';
import './AboutPage.css';

export function HelpPage() {
  return (
    <article className="about-page">
      <h1 className="about-page__title">Help</h1>

      <h2 className="about-page__heading">Starring stories</h2>
      <p>
        Star a story to keep it in your reading list. Use it as a
        to-read list: star the ones you want to read, then sweep the rest.
      </p>
      <ul>
        <li>
          Tap the <strong>☆ star</strong> on the right of any row to
          star it. Tap again to unstar.
        </li>
        <li>
          <strong>Swipe a story left</strong> for the same toggle.
        </li>
      </ul>
      <p>
        Starred stories live in <Link to="/saved">Saved</Link> in the
        menu. They stay on your device until you unstar them.
      </p>

      <h2 className="about-page__heading">Dismissing stories</h2>
      <p>
        Dismissing hides a story you don&rsquo;t want to see in your feeds:
      </p>
      <ul>
        <li>
          <strong>Swipe a story right</strong> in any feed to dismiss it.
        </li>
        <li>
          Tap the <strong>sweep</strong> icon in the top bar to dismiss
          every unstarred story on screen at once.
        </li>
      </ul>

      <h2 className="about-page__heading">Peeking at dismissed stories</h2>
      <p>
        Tap the <strong>eye</strong> in the top bar to toggle dismissed
        stories on and off. When they&rsquo;re shown, they appear
        muted inline; tapping one opens the thread and un-dismisses it.
        Dismissed stories also live in <Link to="/ignored">Ignored</Link>,
        and dismissals expire after seven days.
      </p>

      <h2 className="about-page__heading">Starring vs. dismissing</h2>
      <p>
        <strong>Star</strong> keeps a story in your list.{' '}
        <strong>Dismiss</strong> hides a story from the feed. You can
        star and dismiss the same story — it stays on your starred
        list even though it&rsquo;s gone from the feed.
      </p>

      <p className="about-page__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}
