import { Link } from 'react-router-dom';
import './AboutPage.css';

export function HelpPage() {
  return (
    <article className="about-page">
      <h1 className="about-page__title">Help</h1>

      <h2 className="about-page__heading">Saving stories</h2>
      <p>
        Save a story to read it later or keep it around for reference:
      </p>
      <ul>
        <li>
          <strong>Swipe a story left</strong> in any feed to save it.
        </li>
        <li>
          Open the story page and tap <strong>Save</strong>. Tap again to
          unsave.
        </li>
      </ul>
      <p>
        Saved stories live in{' '}
        <Link to="/saved">Saved</Link> in the menu. From there you can tap{' '}
        <strong>Unsave</strong> on any row to remove it. Saved stories stay
        on your device and are kept until you unsave them.
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
          Scrolling past a story without opening it also dismisses it, so
          your feeds only show things you haven&rsquo;t considered yet.
        </li>
      </ul>
      <p>
        Dismissed stories appear under{' '}
        <Link to="/ignored">Ignored</Link> in the menu, where you can tap{' '}
        <strong>Un-ignore</strong> to bring one back. Dismissals expire
        after seven days.
      </p>

      <h2 className="about-page__heading">Saving vs. dismissing</h2>
      <p>
        <strong>Save</strong> keeps a story for later &mdash; it also still
        shows in the feed. <strong>Dismiss</strong> hides a story from the
        feed. You can do both to save something and clear it from the feed
        at the same time.
      </p>

      <p className="about-page__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}
