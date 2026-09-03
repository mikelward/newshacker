// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./Comment.css', import.meta.url), 'utf8');

const ICONS = ['.comment__toolbar-button', '.comment__toggle'] as const;

/** Every `@media (hover: hover)` block, and everything outside all of them —
 * so a base rule is never read out of a media query, or the other way round. */
function scopes(): { base: string; pointer: string } {
  let base = '';
  let pointer = '';
  const re = /@media \(hover: hover\)\s*\{/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    base += css.slice(cursor, m.index);
    // Walk braces from the block's opening one to find its matching close.
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    pointer += css.slice(start, i - 1);
    cursor = i;
    re.lastIndex = i;
  }
  base += css.slice(cursor);
  return { base, pointer };
}

/** The declarations of EVERY rule in the scope whose selector list names
 * `selector` exactly — joined, since that union is what the cascade applies.
 * Matching the whole selector rather than a substring is what keeps
 * `.comment__toggle` from also collecting `.comment__toggle svg`, and reading
 * every rule rather than the first is what keeps a shared `a, b { … }` block
 * from being invisible to a lookup for `a`. */
function declarations(selector: string, { pointerOnly = false } = {}): string {
  // Comments are stripped: these rules carry long ones between declarations,
  // and a `(?:^|;)` anchor would otherwise never reach the property after one.
  const scope = (pointerOnly ? scopes().pointer : scopes().base).replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const found: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope))) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) found.push(m[2]);
  }
  return found.join(';');
}

const px = (declarations: string, property: string): number =>
  Number(
    declarations.match(new RegExp(`(?:^|;)\\s*${property}:\\s*(-?\\d+)px`))?.[1],
  );

describe('comment footer sizing', () => {
  it('paints a 36px band on every device', () => {
    // The band's height is what sets the card's vertical rhythm — it comes
    // from these buttons, not from the 13px meta text sitting inside them.
    for (const sel of ICONS) {
      const base = declarations(sel);
      expect(base, `no base rule found for ${sel}`).not.toBe('');
      expect(px(base, 'height')).toBe(36);
      expect(px(base, 'min-height')).toBe(36);
    }
  });

  it('still gives touch a 44px target, as hit area rather than paint', () => {
    // SPEC's floor is about the target, not the ink (maintainer, 2026-09-03:
    // "the intention was hit area"). So the paint may shrink as long as a
    // pseudo-element puts the difference back — and this asserts the SUM,
    // which is the only form that can't be satisfied by either half alone.
    for (const sel of ICONS) {
      const base = declarations(sel);
      const hit = declarations(`${sel}::after`);
      expect(hit, `no touch hit area found for ${sel}`).not.toBe('');
      expect(hit).toMatch(/position:\s*absolute/);

      const grown = -px(hit, 'inset');
      expect(px(base, 'height') + 2 * grown).toBe(44);
      // The other axis never shrank, so the paint still carries it.
      expect(px(base, 'min-width')).toBe(44);
    }
  });

  it('drops the expansion under a precise pointer', () => {
    // A cursor is precise, so there the target is the paint — and leaving the
    // expansion in would swallow hover 4px outside the button.
    for (const sel of ICONS) {
      expect(declarations(`${sel}::after`, { pointerOnly: true })).toMatch(
        /content:\s*none/,
      );
      const pointer = declarations(sel, { pointerOnly: true });
      expect(pointer, `no pointer rule found for ${sel}`).not.toBe('');
      expect(px(pointer, 'width')).toBe(36);
      expect(px(pointer, 'min-width')).toBe(36);
    }
  });

  it('sizes the glyph to the content box the padding leaves', () => {
    // Without this the global `svg { max-width: 100% }` squeezes a 22px
    // glyph's width to 20 and leaves its height at 22 — the distortion
    // `.thread__action--icon` documents. Derived rather than restated, so the
    // three numbers can't drift apart.
    for (const sel of ICONS) {
      const glyph = declarations(`${sel} svg`);
      expect(glyph, `no glyph rule found for ${sel}`).not.toBe('');
      expect(px(glyph, 'width')).toBe(20);
      expect(px(glyph, 'height')).toBe(20);

      const base = declarations(sel);
      const padBlock = Number(base.match(/padding:\s*(\d+)px/)?.[1]);
      expect(px(glyph, 'height') + 2 * padBlock).toBe(px(base, 'height'));
    }
  });
});
