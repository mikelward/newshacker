// Icons for the appearance pickers, shared by the drawer and the Settings page.
// Components only (the option data lives in `appearanceOptions.ts`).
import type { Chrome } from '../lib/chrome';

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960,
// fill-based paths that take `color` via currentColor.
const MS_VIEWBOX = '0 -960 960 960';

export function ThemeIcon({ path }: { path: string }) {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}

// App-bar style icon — a small schematic of the bar showing how much
// orange the chrome carries. The mark and the optional wordmark line
// are painted in brand orange (`--nh-orange`) because the icon acts
// as a color *swatch*. `classic` draws the full orange bar with a
// white outlined disc; `mono` and `duo` use a neutral outline bar
// (`currentColor` so the outline inherits the button's text color
// and stays legible against the highlighted active-button surface).
// Only `duo` paints the wordmark line in orange — that single-pixel
// delta is what distinguishes it from `mono`.
export function ChromeIcon({ variant }: { variant: Chrome }) {
  const isClassic = variant === 'classic';
  const barFill = isClassic ? 'var(--nh-orange)' : 'none';
  const barStroke = isClassic ? 'var(--nh-orange)' : 'currentColor';
  // Classic's real in-header mark is a transparent disc with a white
  // ring outline (the orange bar shows through), so the picker icon
  // mirrors that — `fill='none'` + white stroke. Mono and Duo both
  // use a filled orange disc.
  const discFill = isClassic ? 'none' : 'var(--nh-orange)';
  const discStroke = isClassic ? '#ffffff' : 'none';
  const discStrokeWidth = isClassic ? 0.75 : 0;
  return (
    <svg
      viewBox="0 0 40 16"
      width="34"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="0.75"
        y="0.75"
        width="38.5"
        height="14.5"
        rx="3"
        fill={barFill}
        stroke={barStroke}
        strokeWidth="1.5"
      />
      <circle
        cx="7"
        cy="8"
        r="3"
        fill={discFill}
        stroke={discStroke}
        strokeWidth={discStrokeWidth}
      />
      {variant === 'duo' ? (
        <rect
          x="12"
          y="6.25"
          width="20"
          height="3.5"
          rx="1"
          fill="var(--nh-orange)"
        />
      ) : null}
    </svg>
  );
}
