// Estimates how many wrapped lines a given character count will occupy at a
// given content-box width, so skeletons can reserve roughly the right amount
// of vertical space. The goal is to minimize layout shift when real content
// replaces the skeleton — an imperfect estimate paired with CSS scroll
// anchoring is enough to keep the user's reading position stable.
//
// We measure an average character width with a one-shot canvas call per font
// string, rather than hard-coding a ratio. That way the estimate adapts to
// whatever system font the browser actually picked from `--font-system`.

const FALLBACK_AVG_CHAR_PX = 7.5;

// Sampled from english-prose frequency; lowercase-heavy on purpose because
// English text is ~70% lowercase letters.
const SAMPLE_STRING =
  'the quick brown fox jumps over the lazy dog 0123456789 ,. ';

const charWidthCache = new Map<string, number>();

export function measureAvgCharWidth(font: string): number {
  const cached = charWidthCache.get(font);
  if (cached !== undefined) return cached;

  if (typeof document === 'undefined') return FALLBACK_AVG_CHAR_PX;
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
  } catch {
    return FALLBACK_AVG_CHAR_PX;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return FALLBACK_AVG_CHAR_PX;
  ctx.font = font;
  const width = ctx.measureText(SAMPLE_STRING).width;
  if (!Number.isFinite(width) || width <= 0) return FALLBACK_AVG_CHAR_PX;
  const perChar = width / SAMPLE_STRING.length;
  charWidthCache.set(font, perChar);
  return perChar;
}

// Real prose can't pack chars at the theoretical maximum because word-wrap
// leaves some trailing space on most lines. Measured empirically against
// Gemini summaries at mobile widths: theoretical 48 chars/line corresponds
// to ~43 chars/line once word boundaries are respected (~10% slack). Apply
// the same efficiency factor here so estimates match what the browser
// actually renders. Over-estimating line count is fine — overflow-anchor
// absorbs shrinkage — but under-estimating causes the visible jumps we
// saw when the skeleton reserved fewer lines than the final text needed.
const WORD_WRAP_EFFICIENCY = 0.9;

export function estimateWrappedLines(
  chars: number,
  contentWidthPx: number,
  font: string,
): number {
  if (chars <= 0 || contentWidthPx <= 0) return 1;
  const avgCharPx = measureAvgCharWidth(font);
  if (avgCharPx <= 0) return 1;
  const rawCharsPerLine = contentWidthPx / avgCharPx;
  const effectiveCharsPerLine = Math.max(
    1,
    Math.floor(rawCharsPerLine * WORD_WRAP_EFFICIENCY),
  );
  return Math.max(1, Math.ceil(chars / effectiveCharsPerLine));
}

export function __clearCharWidthCacheForTests(): void {
  charWidthCache.clear();
}
