import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Thread } from './Thread';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

// Regression guard for the bug where the bottom thread action bar
// wrapped the ⋮ button onto a second row on ordinary phones (a Pixel
// 10 at 412px, for one) while the top bar fit everything on one row.
// The earlier fix used a `@media (max-width: 480px)` rule that forced
// the stretch slot to `flex-basis: 100%`, which made *both* bars take
// two rows on every common phone — not what we want. This file pins
// down the actual invariant: at every realistic phone width, the
// entire thread action bar fits on a single row. We rely on the
// stretch slot's `flex: 1; min-width: 0` + `.thread__action-label`'s
// `text-overflow: ellipsis` to absorb the width pressure.

// ---- CSS-layer constants. Keep in sync with Thread.css. ----
const ICON_BUTTON_WIDTH = 56; // .thread__action--icon width
const STRETCH_MIN_WIDTH = 0; // flex: 1; min-width: 0 → shrinks to 0
const GAP = 12; // .thread__actions gap
const HEADER_PADDING_X = 16; // .thread__header / .thread__footer padding

// Simulates CSS `flex-wrap: wrap` with `gap`. Returns the number of
// rows required to fit the items in the container.
function simulateFlexWrap(
  containerWidth: number,
  itemMinWidths: number[],
  gap: number,
): number {
  let rows = 1;
  let rowWidth = 0;
  for (const w of itemMinWidths) {
    const next = rowWidth === 0 ? w : rowWidth + gap + w;
    if (next > containerWidth) {
      rows += 1;
      rowWidth = w;
    } else {
      rowWidth = next;
    }
  }
  return rows;
}

// Logical model of the thread action bar: one stretch slot (min-width 0)
// plus N fixed-width icon buttons. Top bar on self-posts has no stretch
// slot (Read article is hidden).
function simulateActionBarRows(
  viewportWidth: number,
  iconButtonCount: number,
  hasStretchSlot: boolean,
): number {
  const available = viewportWidth - HEADER_PADDING_X * 2;
  const items: number[] = [];
  if (hasStretchSlot) items.push(STRETCH_MIN_WIDTH);
  for (let i = 0; i < iconButtonCount; i += 1) items.push(ICON_BUTTON_WIDTH);
  return simulateFlexWrap(available, items, GAP);
}

// Real-device-ish viewport matrix. iPhone SE 1st gen at 320px is the
// narrowest; Pixel 10 at 412px is the specific device the regression
// came from; the rest cover common phones / folding phones / iPads in
// split view. No browser zoom cases (those are user-opt-in and can
// accept wrapping).
const PHONE_VIEWPORTS = [320, 360, 375, 390, 412, 414, 430];
const TABLET_VIEWPORTS = [480, 500, 600, 768, 1024];
const ALL_VIEWPORTS = [...PHONE_VIEWPORTS, ...TABLET_VIEWPORTS];

describe('<Thread> action bar row count across viewports (logical model)', () => {
  // Logged-in, URL-backed story: stretch slot + 4 icon buttons (Upvote,
  // Pin, Done, More). This is the worst case — logged-out drops one
  // icon button, making the bar narrower, which can only help.
  const iconCount = 4;

  for (const w of ALL_VIEWPORTS) {
    it(`fits on a single row at ${w}px viewport (with Upvote, logged in)`, () => {
      expect(simulateActionBarRows(w, iconCount, true)).toBe(1);
    });
  }

  it('fits on a single row at every tested viewport when logged out (no Upvote)', () => {
    const loggedOutIconCount = 3; // Pin, Done, More
    for (const w of ALL_VIEWPORTS) {
      expect(simulateActionBarRows(w, loggedOutIconCount, true)).toBe(1);
    }
  });

  it('fits on a single row on self-posts (no stretch slot on the top bar)', () => {
    // Self-posts: top bar has no Read article → just the icon buttons.
    for (const w of ALL_VIEWPORTS) {
      expect(simulateActionBarRows(w, iconCount, false)).toBe(1);
    }
  });

  // A stretch slot with min-width 0 cannot by itself push the bar to a
  // second row: only the fixed-width icon buttons force a wrap. Pin
  // that down so a future change to the stretch slot's min-width
  // doesn't silently re-introduce the Pixel-10 bug.
  it('the stretch slot contributes zero min-width pressure', () => {
    for (const w of ALL_VIEWPORTS) {
      const withStretch = simulateActionBarRows(w, iconCount, true);
      const withoutStretch = simulateActionBarRows(w, iconCount, false);
      expect(withStretch).toBe(withoutStretch);
    }
  });
});

describe('<Thread> action bar structural parity (rendered)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('bottom bar mirrors the top bar: same stretch slot, same icon buttons in the same order', async () => {
    installHNFetchMock({
      items: {
        9100: makeStory(9100, { title: 'Parity', url: 'https://example.com/9100' }),
      },
    });

    renderWithProviders(<Thread id={9100} />, { route: '/item/9100' });
    await screen.findByText('Parity');

    const topStretch = screen.getByTestId('thread-read-article');
    const bottomStretch = screen.getByTestId('thread-back-to-top-bottom');
    expect(topStretch.className).toContain('thread__action--primary');
    expect(bottomStretch.className).toContain('thread__action--stretch');

    // Icon buttons are the same in both bars, in the same order.
    expect(screen.getByTestId('thread-pin')).toBeInTheDocument();
    expect(screen.getByTestId('thread-pin-bottom')).toBeInTheDocument();
    expect(screen.getByTestId('thread-done')).toBeInTheDocument();
    expect(screen.getByTestId('thread-done-bottom')).toBeInTheDocument();
    expect(screen.getByTestId('thread-more')).toBeInTheDocument();
    expect(screen.getByTestId('thread-more-bottom')).toBeInTheDocument();
  });

  it('Back to top has a visible label that ellipsis-truncates under pressure', async () => {
    installHNFetchMock({
      items: {
        9110: makeStory(9110, { title: 'WithLabel', url: 'https://example.com/9110' }),
      },
    });

    renderWithProviders(<Thread id={9110} />, { route: '/item/9110' });
    await screen.findByText('WithLabel');

    const backToTop = screen.getByTestId('thread-back-to-top-bottom');
    // The label IS rendered (so sighted users see "Back to top" when
    // there's room for it), and wears the `.thread__action-label` class
    // that carries `overflow: hidden; text-overflow: ellipsis;
    // white-space: nowrap` — that's what absorbs width pressure on
    // narrow phones without forcing the icon row onto a second row.
    const label = backToTop.querySelector('.thread__action-label');
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe('Back to top');
  });

  it('both bars contain the same number of tap targets', async () => {
    installHNFetchMock({
      items: {
        9120: makeStory(9120, {
          title: 'EqualCount',
          url: 'https://example.com/9120',
        }),
      },
    });

    renderWithProviders(<Thread id={9120} />, { route: '/item/9120' });
    await screen.findByText('EqualCount');

    const header = document.querySelector('.thread__header');
    const footer = document.querySelector('.thread__footer');
    expect(header).not.toBeNull();
    expect(footer).not.toBeNull();
    const topActions = header!.querySelectorAll('.thread__action');
    const bottomActions = footer!.querySelectorAll('.thread__action');
    expect(bottomActions.length).toBe(topActions.length);
  });
});

describe('<Thread> action bar CSS invariants', () => {
  // The Pixel 10 regression came from a `@media (max-width: 480px) {
  // .thread__action--primary { flex-basis: 100%; } }` rule. If that
  // ever comes back, the bar takes two rows on every common phone
  // instead of relying on label ellipsis to fit on one row. This
  // pins it down via a raw-CSS check: no `flex-basis: 100%` on the
  // thread action classes.
  it('does not force a row-wrap via flex-basis: 100% on --primary or --stretch', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, 'Thread.css'), 'utf8');
    expect(css).not.toMatch(
      /\.thread__action--(?:primary|stretch)[^{]*\{[^}]*flex-basis:\s*100%/s,
    );
    // Also guard the @media-scoped variant explicitly.
    expect(css).not.toMatch(
      /@media[^{]*\{\s*\.thread__action--(?:primary|stretch)\s*\{[^}]*flex-basis:\s*100%/s,
    );
  });
});
