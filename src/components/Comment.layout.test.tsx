import { afterEach, describe, expect, it } from 'vitest';

async function loadCommentCss(): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, 'Comment.css'), 'utf8');
}

// Match `<selector> { … }` where the selector is immediately followed
// by optional whitespace and the opening brace — so `.comment` does
// NOT match `.comment__header` / `.comment--loading` /
// `.comment.is-expanded` (each has a non-whitespace char right after
// the selector).
function extractRule(css: string, selector: string): string | null {
  const escaped = selector.replace(/\./g, '\\.');
  const re = new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{[^}]*\\}`, 's');
  return css.match(re)?.[0] ?? null;
}

describe('<Comment> nested layout CSS invariants', () => {
  // Regression guard for the "nested comments stack extra gutter per
  // level" bug, and its asymmetric fix:
  //
  //   - LEFT: nested comments SHOULD keep inheriting the parent's
  //     left --comment-gutter padding. The stacked left indent is
  //     the visual cue for reply depth; removing it flattens the
  //     hierarchy.
  //   - RIGHT: nested comments should NOT stack additional
  //     right-padding per nesting level. Without a negative right
  //     margin on .comment__children, each level of nesting would
  //     shrink the reading column by another gutter on the right,
  //     which has nothing to do with depth.
  //
  // The fix is `.comment__children { margin-right: calc(-1 *
  // var(--comment-gutter)); margin-left: 0; }` (via shorthand or
  // longhand — either is fine). The tests below pin the semantic
  // invariant, not the exact serialization — equivalent refactors
  // (longhand vs. 4-value shorthand, multiplier-order swaps) pass.

  afterEach(() => {
    // Clean up any <style> / <ol> the getComputedStyle test appended.
    document.head
      .querySelectorAll('style[data-test-inject]')
      .forEach((n) => n.remove());
    document.body
      .querySelectorAll('[data-test-inject]')
      .forEach((n) => n.remove());
  });

  it('.comment horizontal padding is driven by --comment-gutter', async () => {
    const css = await loadCommentCss();
    const rule = extractRule(css, '.comment');
    expect(rule).not.toBeNull();
    // Either the padding shorthand or padding-left/right longhand
    // must reference the shared token — bare `12px` literals would
    // let .comment and .comment__children drift apart, which is the
    // exact failure mode this test guards against.
    expect(rule!).toMatch(
      /padding(?:-left|-right)?[^;]*var\(--comment-gutter\)/,
    );
  });

  it('.comment__children negates --comment-gutter on the right only, not the left', async () => {
    const css = await loadCommentCss();

    // Inject :root tokens + the real .comment__children rule into
    // the DOM and read the resolved margins. This tolerates any form
    // of the rule (shorthand, longhand, either multiplier order) —
    // the outcome is what matters.
    const style = document.createElement('style');
    style.setAttribute('data-test-inject', '');
    style.textContent = `
      :root {
        --comment-gutter: 12px;
        --comment-stack-gap: 4px;
      }
      ${css}
    `;
    document.head.appendChild(style);

    const el = document.createElement('ol');
    el.setAttribute('data-test-inject', '');
    el.className = 'comment__children';
    document.body.appendChild(el);

    const computed = window.getComputedStyle(el);
    // margin-right must negate the 12px gutter. happy-dom doesn't
    // evaluate calc(), so we accept both the resolved literal
    // (-12px, what a real browser reports) and the unresolved
    // expression forms (`calc(12px * -1)`, `calc(-1 * 12px)`, or
    // `-12px` if the author pre-negated). Any of them satisfies the
    // invariant.
    expect(computed.marginRight).toMatch(/^(?:-12px|calc\([^)]*-1[^)]*\))$/);
    // Left margin must NOT be negative — the left indent is the
    // intentional cue for reply depth and stays inside the parent's
    // padding.
    expect(computed.marginLeft).toBe('0px');
  });
});
