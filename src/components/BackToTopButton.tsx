import { TooltipButton } from './TooltipButton';
import './BackToTopButton.css';

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960,
// fill-based path that takes `color` via currentColor.
function VerticalAlignTopIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="back-to-top-btn__icon"
      viewBox="0 -960 960 960"
      fill="currentColor"
      width={size}
      height={size}
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

interface Props {
  // Feed footers render Back to top as a 56×56 icon-only square so the
  // sibling More button — which stretches to fill the middle — sits
  // visually centered between two same-sized squares (Back to top on
  // the left, Hide unpinned on the right). Library footers leave the
  // labeled default in place because Back to top is the bar's only
  // button there and a full-width labeled target reads better than a
  // small icon stranded on the left edge.
  iconOnly?: boolean;
}

export function BackToTopButton({ iconOnly = false }: Props = {}) {
  if (iconOnly) {
    return (
      <TooltipButton
        type="button"
        className="back-to-top-btn back-to-top-btn--icon"
        data-testid="back-to-top"
        onClick={scrollToTop}
        tooltip="Back to top"
        aria-label="Back to top"
      >
        <VerticalAlignTopIcon size={24} />
      </TooltipButton>
    );
  }
  return (
    <button
      type="button"
      className="back-to-top-btn"
      data-testid="back-to-top"
      onClick={scrollToTop}
    >
      <VerticalAlignTopIcon />
      <span>Back to top</span>
    </button>
  );
}
