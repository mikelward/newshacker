// Option lists for the appearance pickers (mode / app-bar / text size), shared
// by the drawer and the Settings page so the two stay in lockstep. Pure data —
// the matching icons live in `appearanceIcons.tsx`.
import type { Theme } from '../lib/theme';
import type { Chrome } from '../lib/chrome';
import { type FontSize, FONT_SIZE_LABELS } from '../lib/fontSize';

// Material Symbols Outlined paths (Apache 2.0, Google), drawn by `ThemeIcon`.
const LIGHT_PATH =
  'M480-360q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Zm0 80q-83 0-141.5-58.5T280-480q0-83 58.5-141.5T480-680q83 0 141.5 58.5T680-480q0 83-58.5 141.5T480-280ZM200-440H40v-80h160v80Zm720 0H760v-80h160v80ZM440-760v-160h80v160h-80Zm0 720v-160h80v160h-80ZM256-650l-101-97 57-59 96 100-52 56Zm492 496-97-101 53-55 101 97-57 59Zm-98-550 97-101 59 57-100 96-56-52ZM154-212l101-97 55 53-97 101-59-57Zm326-268Z';
const DARK_PATH =
  'M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q14 0 27.5 1t26.5 3q-41 29-65.5 75.5T444-660q0 90 63 153t153 63q55 0 101-24.5t75-65.5q2 13 3 26.5t1 27.5q0 150-105 255T480-120Z';
const SYSTEM_PATH =
  'M80-120v-80h240v-80H160q-33 0-56.5-23.5T80-360v-400q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v400q0 33-23.5 56.5T800-280H640v80h240v80H80Zm80-240h640v-400H160v400Zm0 0v-400 400Z';

export const THEME_OPTIONS: Array<{ value: Theme; label: string; path: string }> =
  [
    { value: 'light', label: 'Light', path: LIGHT_PATH },
    { value: 'dark', label: 'Dark', path: DARK_PATH },
    { value: 'system', label: 'System', path: SYSTEM_PATH },
  ];

export const CHROME_OPTIONS: Array<{ value: Chrome; label: string }> = [
  { value: 'mono', label: 'Mono' },
  { value: 'duo', label: 'Duo' },
  { value: 'classic', label: 'Classic' },
];

// The text-size picker renders each option as a capital "A" whose glyph size
// hints the scale (small / medium / large). The accessible name comes from the
// label, not the glyph.
export const FONT_SIZE_OPTIONS: Array<{
  value: FontSize;
  label: string;
  glyph: number;
}> = [
  { value: 'small', label: FONT_SIZE_LABELS.small, glyph: 14 },
  { value: 'medium', label: FONT_SIZE_LABELS.medium, glyph: 18 },
  { value: 'large', label: FONT_SIZE_LABELS.large, glyph: 22 },
];
