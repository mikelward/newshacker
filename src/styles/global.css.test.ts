// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT_SIZE, FONT_SIZES } from '../lib/fontSize';

const css = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

describe('the text-size ladder', () => {
  it('gives every rung but the default its own token override', () => {
    // The bug this exists for is silent: a rung with no rule here falls back to
    // the 16px baseline while the stepper cheerfully reports the size it thinks
    // it set, and a test that only asserts the `data-font-size` attribute
    // cannot see the difference. So the expectation is derived from
    // `FONT_SIZES` rather than written out beside it.
    const declared = [
      ...css.matchAll(/:root\[data-font-size='(\d+)'\]\s*\{([^}]*)\}/g),
    ];
    expect(declared.map(([, size]) => size)).toEqual(
      FONT_SIZES.filter((size) => size !== DEFAULT_FONT_SIZE),
    );
    for (const [, size, body] of declared) {
      expect(body).toMatch(new RegExp(`--nh-font-size:\\s*${size}px`));
    }
  });

  it('leaves the default to the bare :root block', () => {
    // 16px owns the baseline and carries no attribute, so a rule for it would
    // be dead weight that the two sides could drift apart on.
    expect(css).not.toContain(`:root[data-font-size='${DEFAULT_FONT_SIZE}']`);
    expect(css).toMatch(/--nh-font-size:\s*16px/);
  });
});
