import './BackToTopButton.css';

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960,
// fill-based path that takes `color` via currentColor.
function VerticalAlignTopIcon() {
  return (
    <svg
      className="back-to-top-btn__icon"
      viewBox="0 -960 960 960"
      fill="currentColor"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M240-760v-80h480v80H240Zm200 640v-446L336-462l-56-58 200-200 200 200-56 58-104-104v446h-80Z" />
    </svg>
  );
}

function scrollToTop() {
  // Browsers that support prefers-reduced-motion fall back to an instant
  // scroll when the user has opted out of smooth animations.
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function BackToTopButton() {
  return (
    <div className="back-to-top">
      <button
        type="button"
        className="back-to-top-btn"
        data-testid="back-to-top"
        onClick={scrollToTop}
      >
        <VerticalAlignTopIcon />
        <span>Back to top</span>
      </button>
    </div>
  );
}
