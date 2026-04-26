import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TooltipButton } from './TooltipButton';
import {
  dismissHomePromo,
  isHomePromoDismissed,
} from '../lib/homePromo';
import './HomePromoCard.css';

// One-row promo banner pointing readers at `/hot` from the default
// home view. Renders only on `/` when the home feed is `top`; sits
// edge-to-edge above the story list so its width matches the rows
// below. A single tap on the card body navigates to `/hot`; the
// right-aligned dismiss button is the second (and final) tap zone,
// per the SPEC's "fewer, larger tap targets" rule. Once dismissed
// the flag is persisted to localStorage and the card never
// re-renders for that browser.

// Material Symbols Outlined — Apache 2.0, Google. Plain "close" glyph,
// rendered transparent so the icon reads as a single character rather
// than a bordered chip.
function CloseIcon() {
  return (
    <svg
      className="home-promo__icon"
      viewBox="0 -960 960 960"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"
      />
    </svg>
  );
}

export function HomePromoCard() {
  // Initialize from storage so a reader who dismissed the card on a
  // previous visit never sees it flash on mount.
  const [dismissed, setDismissed] = useState<boolean>(() =>
    isHomePromoDismissed(),
  );

  if (dismissed) return null;

  const onDismiss = () => {
    dismissHomePromo();
    setDismissed(true);
  };

  return (
    <aside className="home-promo" aria-label="Hot view promo">
      <Link
        to="/hot"
        className="home-promo__link"
        data-testid="home-promo-link"
      >
        Try the Hot view with your own rules
      </Link>
      <TooltipButton
        type="button"
        tooltip="Dismiss"
        aria-label="Dismiss"
        className="home-promo__dismiss"
        onClick={onDismiss}
        data-testid="home-promo-dismiss"
      >
        <CloseIcon />
      </TooltipButton>
    </aside>
  );
}
