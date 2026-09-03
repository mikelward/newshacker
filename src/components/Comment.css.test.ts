// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./Comment.css', import.meta.url), 'utf8');

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

/** The declarations of the first rule matching `selector` in the given scope. */
function rule(selector: string, { pointerOnly = false } = {}): string {
  // Comments are stripped: these rules carry long ones between declarations,
  // and a `(?:^|;)` anchor would otherwise never reach the property after one.
  const scope = (pointerOnly ? scopes().pointer : scopes().base).replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const escaped = selector.replace(/[.]/g, '\\$&');
  const match = scope.match(
    new RegExp(`(?:^|[,{}\\n])[^{}]*${escaped}[^{}]*\\{([^{}]*)\\}`),
  );
  return match?.[1] ?? '';
}

describe('comment footer sizing', () => {
  it('keeps the 44px touch floor on the footer icons', () => {
    // SPEC: 44×44 is the project floor on touch and is never traded away —
    // not for density, not for rhythm.
    for (const sel of ['.comment__toolbar-button', '.comment__toggle']) {
      expect(rule(sel)).toMatch(/min-height:\s*44px/);
      expect(rule(sel)).toMatch(/min-width:\s*44px/);
    }
  });

  it('pins the footer icons to the documented 36px under a precise pointer', () => {
    // Same size and same gate as the thread action bar (SPEC *Thread action
    // bar*): pointer type, not viewport width. The footer's height is set by
    // these buttons rather than by the meta text inside them, so this is what
    // decides how much space sits under the last line of a comment.
    //
    // An explicit width/height, asserted separately from the floor, because
    // the first attempt set `min-height` alone and passed while the buttons
    // rendered at 38px: their glyphs are 22px and 8px of padding each side
    // makes an intrinsic 38, which a floor can raise but never shrink.
    const pointer = rule('.comment__toolbar-button', { pointerOnly: true });
    expect(pointer).toMatch(/(?:^|;)\s*width:\s*36px/);
    expect(pointer).toMatch(/(?:^|;)\s*height:\s*36px/);
    expect(pointer).toMatch(/min-height:\s*36px/);
  });

  it('sizes the glyph to the content box the padding leaves', () => {
    // 36px border-box minus 8px each side is a 20px content box. Without this
    // the global `svg { max-width: 100% }` squeezes a 22px glyph's width to 20
    // and leaves its height at 22 — the distortion `.thread__action--icon`
    // documents.
    const glyph = rule('.comment__toolbar-button svg', { pointerOnly: true });
    expect(glyph).toMatch(/width:\s*20px/);
    expect(glyph).toMatch(/height:\s*20px/);

    const button = rule('.comment__toolbar-button', { pointerOnly: true });
    const pad = Number(button.match(/padding:\s*(\d+)px/)?.[1]);
    const size = Number(button.match(/(?:^|;)\s*width:\s*(\d+)px/)?.[1]);
    const icon = Number(glyph.match(/width:\s*(\d+)px/)?.[1]);
    expect(icon + 2 * pad).toBe(size);
  });

});
