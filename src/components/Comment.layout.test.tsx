import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Comment } from './Comment';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock } from '../test/mockFetch';
import type { HNItem } from '../lib/hn';

function commentFixture(id: number, overrides: Partial<HNItem> = {}): HNItem {
  return {
    id,
    type: 'comment',
    by: 'alice',
    text: `body ${id}`,
    time: 1_700_000_000,
    kids: [],
    ...overrides,
  };
}

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

describe('<Comment> collapsed-body clamp CSS invariants', () => {
  // Regression guard: a collapsed comment's preview must stay bounded
  // even when the body is a block-level `<pre>`/`<code>` block.
  // `-webkit-line-clamp` only clamps inline line boxes, so without an
  // explicit height cap a code-block comment dumps its entire contents
  // into the "3-line" preview. The fix pins a `max-height` on the
  // clamped body so block content is bounded like text content.
  it('.comment__body--clamped caps height in addition to line-clamp', async () => {
    const css = await loadCommentCss();
    const rule = extractRule(css, '.comment__body--clamped');
    expect(rule).not.toBeNull();
    // Keep the inline-text line clamp …
    expect(rule!).toMatch(/-webkit-line-clamp:\s*3/);
    expect(rule!).toMatch(/overflow:\s*hidden/);
    // … but also bound the overall preview height so block-level
    // children (pre/code) can't overflow it.
    expect(rule!).toMatch(/max-height:/);
  });

  it('drops the inter-paragraph gap inside the clamped preview', async () => {
    // With the height cap in place, the 8px bottom margin between
    // paragraphs would eat into the 3-line budget and clip plain-text
    // comments to ~2 lines. The collapsed preview resets that gap so
    // the cap maps to three actual content lines.
    const css = await loadCommentCss();
    const rule = extractRule(css, '.comment__body--clamped p');
    expect(rule).not.toBeNull();
    expect(rule!).toMatch(/margin-bottom:\s*0/);

    // `.comment__body--clamped p` and `.comment__body p` have equal
    // specificity (one class + one element each), so the reset only
    // wins if it's declared AFTER the base rule. Pin that source order
    // — otherwise the 8px gap silently comes back.
    const clampedAt = css.search(/\.comment__body--clamped p\s*\{/);
    const baseAt = css.search(/(?:^|[\s}])\.comment__body p\s*\{/);
    expect(clampedAt).toBeGreaterThan(-1);
    expect(baseAt).toBeGreaterThan(-1);
    expect(clampedAt).toBeGreaterThan(baseAt);
  });
});

describe('<Comment> footer row order', () => {
  // Regression guard for the bottom-row layout: .comment__meta on
  // the left (flex:1, ellipsis), then the optional toolbar on the
  // right (expanded only), then the expand/collapse toggle pinned
  // to the far right. Meta + actions sit on the same row, with the
  // four icons stacked together in the right-hand corner. The toggle
  // stays at the bottom of .comment so when the comment expands and
  // the body un-clamps + children render below, the button visually
  // moves down with the growing card.
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('collapsed: footer is [meta, toggle] in that order, no toolbar', async () => {
    installHNFetchMock({ items: { 8100: commentFixture(8100) } });
    const { container } = renderWithProviders(<Comment id={8100} />);

    await waitFor(() => {
      expect(screen.getByText('body 8100')).toBeInTheDocument();
    });

    const footer = container.querySelector('.comment__footer');
    expect(footer).not.toBeNull();
    expect(footer!.querySelector('.comment__toolbar')).toBeNull();

    const childrenOrder = Array.from(footer!.children).map(
      (el) => el.className,
    );
    expect(childrenOrder).toEqual(['comment__meta', 'comment__toggle']);
  });

  it('expanded: footer is [meta, toolbar, toggle] in that order', async () => {
    installHNFetchMock({ items: { 8101: commentFixture(8101) } });
    const { container } = renderWithProviders(<Comment id={8101} />);

    await waitFor(() => {
      expect(screen.getByText('body 8101')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /expand comment/i }));

    await waitFor(() => {
      expect(screen.getByTestId('comment-upvote')).toBeInTheDocument();
    });

    const footer = container.querySelector('.comment__footer');
    expect(footer).not.toBeNull();
    const childrenOrder = Array.from(footer!.children).map(
      (el) => el.className,
    );
    expect(childrenOrder).toEqual([
      'comment__meta',
      'comment__toolbar',
      'comment__toggle',
    ]);

    // Inside the toolbar, the actions stay in upvote → downvote → reply
    // order so the user's mental model matches the thread action bar.
    const toolbarTestids = Array.from(
      footer!.querySelectorAll('.comment__toolbar [data-testid]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(toolbarTestids).toEqual([
      'comment-upvote',
      'comment-downvote',
      'comment-reply',
    ]);
  });

  it('omits the leading " · " separator when the comment has no author', async () => {
    // Edge case: HNItem.by is optional. The meta-suffix carries a
    // leading " · " that's only correct when an author link sits
    // directly to its left; without an author the suffix would
    // render as an orphaned " · 4m · 2 replies", which used to ship.
    installHNFetchMock({
      items: {
        8200: commentFixture(8200, { by: undefined, kids: [8201, 8202] }),
        8201: commentFixture(8201),
        8202: commentFixture(8202),
      },
    });
    const { container } = renderWithProviders(<Comment id={8200} />);

    await waitFor(() => {
      expect(screen.getByText('body 8200')).toBeInTheDocument();
    });

    const meta = container.querySelector('.comment__meta');
    expect(meta).not.toBeNull();
    // No author link rendered.
    expect(meta!.querySelector('.comment__author')).toBeNull();
    // The visible meta text must NOT start with " · ".
    expect(meta!.textContent ?? '').not.toMatch(/^ · /);
    // It still carries the age/replies content.
    expect(meta!.textContent ?? '').toMatch(/2 replies/);
  });
});
