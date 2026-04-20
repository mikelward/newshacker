import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __clearCharWidthCacheForTests,
  estimateWrappedLines,
  measureAvgCharWidth,
} from './skeletonSize';

// jsdom does not implement HTMLCanvasElement.getContext, so we stub it to a
// minimal 2D context whose measureText scales linearly with the font size
// declared in the font string. This lets us exercise the real code path
// instead of always hitting the fallback, and silences jsdom's
// "Not implemented: HTMLCanvasElement.prototype.getContext" warnings.
function stubCanvasContext(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function getContext(this: HTMLCanvasElement) {
      const state = { font: '16px sans-serif' };
      const ctx = {
        set font(value: string) {
          state.font = value;
        },
        get font() {
          return state.font;
        },
        measureText(text: string) {
          const match = /(\d+(?:\.\d+)?)px/.exec(state.font);
          const size = match ? Number(match[1]) : 16;
          // ~0.5 em per character is a plausible prose-ish average.
          return { width: text.length * size * 0.5 };
        },
      };
      return ctx as unknown as CanvasRenderingContext2D;
    },
  );
}

beforeEach(() => {
  stubCanvasContext();
});

afterEach(() => {
  __clearCharWidthCacheForTests();
  vi.restoreAllMocks();
});

const FONT = '15px system-ui, sans-serif';

describe('measureAvgCharWidth', () => {
  it('returns a plausible per-character width in pixels', () => {
    const px = measureAvgCharWidth(FONT);
    expect(px).toBeGreaterThan(0);
    expect(px).toBeLessThan(20);
  });

  it('memoizes per-font string', () => {
    const first = measureAvgCharWidth(FONT);
    // Second call should hit the cache even if getContext would now return null.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const second = measureAvgCharWidth(FONT);
    expect(second).toBe(first);
  });

  it('scales with font size', () => {
    const small = measureAvgCharWidth('10px sans-serif');
    const large = measureAvgCharWidth('30px sans-serif');
    expect(large).toBeGreaterThan(small);
  });

  it('falls back to a sane default when getContext is unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const px = measureAvgCharWidth('unreachable-font');
    expect(px).toBeGreaterThan(0);
    expect(px).toBeLessThan(20);
  });
});

describe('estimateWrappedLines', () => {
  it('returns 1 for empty or zero-width input', () => {
    expect(estimateWrappedLines(0, 300, FONT)).toBe(1);
    expect(estimateWrappedLines(150, 0, FONT)).toBe(1);
    expect(estimateWrappedLines(-10, 300, FONT)).toBe(1);
  });

  it('produces more lines as content width shrinks', () => {
    const wide = estimateWrappedLines(300, 800, FONT);
    const narrow = estimateWrappedLines(300, 200, FONT);
    expect(narrow).toBeGreaterThan(wide);
  });

  it('produces more lines as character count grows', () => {
    const short = estimateWrappedLines(60, 320, FONT);
    const long = estimateWrappedLines(600, 320, FONT);
    expect(long).toBeGreaterThan(short);
  });

  it('clamps to at least one line for very short text', () => {
    expect(estimateWrappedLines(1, 320, FONT)).toBe(1);
  });

  it('applies a word-wrap efficiency factor so estimates bias toward more lines', () => {
    // With the stubbed 0.5 em/char measurement, 15px font → 7.5 px/char.
    // Raw chars/line at 300px width: 300 / 7.5 = 40. A 40-char string
    // would pack in exactly one line theoretically, but real word-wrap
    // can't do that — the efficiency factor must push this to 2 lines.
    expect(estimateWrappedLines(40, 300, FONT)).toBeGreaterThanOrEqual(2);
  });
});
