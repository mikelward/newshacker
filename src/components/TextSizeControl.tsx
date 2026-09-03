import { useFontSize } from '../hooks/useFontSize';
import { FONT_SIZES, FONT_SIZE_LABELS, type FontSize } from '../lib/fontSize';
import { TooltipButton } from './TooltipButton';
import './TextSizeControl.css';

// The readout renders the current size as a capital "A" at roughly that size,
// so the control demonstrates what it is setting rather than only naming it.
// Capped well short of the 44px tap floor's own height: past this the readout
// would set the row's height and make the picker the tallest thing in the
// drawer, and the top rungs differ by too little to read as a ramp anyway.
const MAX_GLYPH_PX = 30;

function glyphSize(size: FontSize): number {
  return Math.min(Number(size), MAX_GLYPH_PX);
}

/**
 * Text-size stepper: smaller / current / larger.
 *
 * It replaced a segmented row of one button per rung, which stopped working as
 * the ladder grew past three sizes. Thirteen rungs is a lot of tap targets for
 * one setting, they no longer divide into the drawer's segmented row, and the
 * "A" glyphs that gave that row its ramp are capped by the button height — so
 * the top rungs would all have rendered at the same size and said nothing.
 *
 * A stepper costs random access: reaching the far end is several taps rather
 * than one. The pinch gesture is the fast path now, which is what makes that
 * trade affordable, and the stepper is the same shape as the gesture — step up,
 * step down — rather than a second, different mental model for the same ladder.
 * It also stops caring how long the ladder is, so adding a rung later is a
 * one-line change with no layout consequence.
 *
 * `onClick` stops propagation so using it inside the drawer (whose panel closes
 * on click) doesn't dismiss the drawer.
 */
export function TextSizeControl({ className }: { className?: string }) {
  const { fontSize, setFontSize } = useFontSize();
  const index = FONT_SIZES.indexOf(fontSize);
  // A stored value that somehow isn't on the ladder shouldn't make the control
  // inert: treat it as the middle so both directions still work.
  const at = index === -1 ? Math.floor(FONT_SIZES.length / 2) : index;
  const atSmallest = at === 0;
  const atLargest = at === FONT_SIZES.length - 1;

  const step = (delta: number) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    const next = FONT_SIZES[at + delta];
    if (next) setFontSize(next);
  };

  return (
    <div
      className={'text-size' + (className ? ` ${className}` : '')}
      role="group"
      aria-label="Text size"
    >
      <TooltipButton
        type="button"
        tooltip="Smaller"
        aria-label="Smaller text"
        className="text-size__step"
        aria-disabled={atSmallest || undefined}
        onClick={step(-1)}
      >
        <span aria-hidden="true">−</span>
      </TooltipButton>
      {/* The size is the control's value, so it is announced on change rather
          than only on focus — a stepper whose readout is silent leaves a
          screen-reader user stepping blind. */}
      <span className="text-size__value" aria-live="polite">
        <span className="text-size__readout">
          <span
            className="text-size__glyph"
            style={{ fontSize: glyphSize(fontSize) }}
            aria-hidden="true"
          >
            A
          </span>
          <span className="text-size__px">{FONT_SIZE_LABELS[fontSize]}</span>
        </span>
      </span>
      <TooltipButton
        type="button"
        tooltip="Larger"
        aria-label="Larger text"
        className="text-size__step"
        aria-disabled={atLargest || undefined}
        onClick={step(1)}
      >
        <span aria-hidden="true">+</span>
      </TooltipButton>
    </div>
  );
}
