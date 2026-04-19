import { Link } from 'react-router-dom';
import './AboutPage.css';

export function HelpPage() {
  return (
    <article className="about-page">
      <h1 className="about-page__title">Help</h1>

      <h2 className="about-page__heading">Pinning stories</h2>
      <p>
        Pin a story to keep it in your reading list. Use it as a
        to-read list: pin the ones you want to read, then sweep the rest.
      </p>
      <ul>
        <li>
          Tap the <strong>📌 pin</strong> on the right of any row to
          pin it. Tap again to unpin.
        </li>
        <li>
          <strong>Swipe a story left</strong> for the same toggle.
        </li>
      </ul>
      <p>
        Pinned stories live in <Link to="/pinned">Pinned</Link> in the
        menu. They stay on your device until you unpin them.
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
          every unpinned story on screen at once.
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

      <h2 className="about-page__heading">Reading comments</h2>
      <p>
        Open a thread and every comment starts <strong>collapsed</strong>
        {' '}— you see the author, age, reply count, and the first three
        lines of the body.
      </p>
      <ul>
        <li>
          <strong>Tap a comment</strong> to expand it. The full body
          appears, and its direct replies show up below as their own
          three-line previews. Tap any of those to drill in.
        </li>
        <li>
          Tap the comment again to collapse it back.
        </li>
        <li>
          Tapping the <strong>author name</strong> opens their profile.
          Tapping a link inside a comment opens the link — neither one
          toggles the comment.
        </li>
        <li>
          Expanded comments pick up a muted{' '}
          <strong>Reply on HN ↗</strong> link at the bottom. Newshacker
          doesn&rsquo;t submit comments itself, so that link hands you
          off to Hacker News to write the reply there.
        </li>
      </ul>

      <h2 className="about-page__heading">Pinning vs. dismissing</h2>
      <p>
        <strong>Pin</strong> keeps a story in your list.{' '}
        <strong>Dismiss</strong> hides a story from the feed. You can
        pin and dismiss the same story — it stays on your pinned list
        even though it&rsquo;s gone from the feed.
      </p>

      <p className="about-page__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}
