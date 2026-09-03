// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  new URL('./TextSizeControl.css', import.meta.url),
  'utf8',
);

/** The declarations inside one rule, by selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('TextSizeControl.css', () => {
  it('centers the readout in the row and baselines only the pair inside it', () => {
    // jsdom does no layout, so the rule that decides this is what gets pinned.
    // Asking one flex line for both alignments leaves the pair riding the top
    // of the row — baseline-aligned flex items are placed flush to the
    // cross-start edge — while the steppers beside it are centered, and
    // drifting further as the glyph grows. Two nested boxes is the fix.
    expect(rule('.text-size__value')).toMatch(/align-items:\s*center/);
    expect(rule('.text-size__readout')).toMatch(/align-items:\s*baseline/);
  });

  it('leaves the steppers centered too, so all three agree', () => {
    expect(rule('.text-size__step')).toMatch(/align-items:\s*center/);
  });

  it('holds the steppers at the tap floor', () => {
    // Golden rule 5's floor. Fixed rather than flex-grown, so the readout takes
    // the remaining space and stays centered as its glyph changes width.
    expect(rule('.text-size__step')).toMatch(/min-height:\s*var\(--tap-min\)/);
    expect(rule('.text-size__step')).toMatch(/min-width:\s*var\(--tap-min\)/);
  });
});
