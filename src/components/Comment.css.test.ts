import { describe, it, expect } from 'vitest';

// Source-level invariants on Comment.css. happy-dom doesn't evaluate
// real layout (no getBoundingClientRect measurement), so any layout
// guarantee that we'd otherwise verify by rendering and measuring
// has to be pinned at the CSS source instead. The cost is a little
// extra brittleness on file reorder; the win is catching the silent
// drift that would re-enter if a refactor changed one of two paired
// values without changing the other.
//
// Mirrors src/styles/desktopWidth.test.tsx: regex-based, no postcss
// import, so the test doesn't pull in a transitive Vite dep.

async function readCss(relPath: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, relPath), 'utf8');
}

// Find the first rule block whose selector matches `selector` exactly.
// Anchors with \b after the escaped selector so `.comment` doesn't
// accidentally match `.comment__children` or `.comment.is-expanded` —
// neither `t` nor `_`/`.` are non-word transitions in the longer
// selectors so the boundary fails against them but matches before
// whitespace + `{`. Returns the full `selector { … }` text or '' if
// no such rule exists.
function ruleBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\b\\s*\\{[^}]*\\}`);
  const m = css.match(re);
  return m ? m[0] : '';
}

describe('Comment.css horizontal-padding invariant', () => {
  it('.comment padding-right and .comment__children margin-right are paired through --comment-x-pad', async () => {
    // Nested comments are supposed to indent on the LEFT (parent's
    // padding-left) but stay flush on the RIGHT — the parent's own
    // padding-right has to be canceled by the children list's
    // negative margin-right. If the two values drift apart, every
    // nesting level eats another card-padding worth off the right
    // edge silently. This test pins both halves to the same token.
    const css = await readCss('./Comment.css');

    // ruleBlock appends \b internally so `.comment` doesn't match
    // `.comment__children` or `.comment.is-expanded`.
    const commentBlock = ruleBlock(css, '.comment');
    const childrenBlock = ruleBlock(css, '.comment__children');

    expect(commentBlock, '.comment rule not found in Comment.css').toBeTruthy();
    expect(
      childrenBlock,
      '.comment__children rule not found in Comment.css',
    ).toBeTruthy();

    // .comment must use var(--comment-x-pad) somewhere in its padding
    // declaration. (The right-side value in the shorthand; matched
    // anywhere in the declaration so the test isn't shorthand-position
    // sensitive.)
    expect(
      commentBlock,
      '.comment padding must reference var(--comment-x-pad)',
    ).toMatch(/padding[^;]*var\(\s*--comment-x-pad\s*\)/);

    // .comment__children must negate that same token on its right
    // margin: calc(-1 * var(--comment-x-pad)). Whitespace-tolerant.
    expect(
      childrenBlock,
      '.comment__children must use calc(-1 * var(--comment-x-pad)) on its margin',
    ).toMatch(
      /margin[^;]*calc\(\s*-1\s*\*\s*var\(\s*--comment-x-pad\s*\)\s*\)/,
    );
  });

  it('--comment-x-pad is defined in global.css', async () => {
    // The token has to live in :root so both files resolve it the
    // same way; defining it inline in Comment.css would technically
    // work but split the source of truth. Match any non-empty value
    // (px, rem, calc(), etc.) — we care that the property exists,
    // not what unit it's in.
    const global = await readCss('../styles/global.css');
    expect(global).toMatch(/--comment-x-pad\s*:\s*[^;]+\s*;/);
  });
});
