import { afterEach, describe, expect, it } from 'vitest';
import { measureStickyInset } from './stickyInset';

// Regression for the Codex review on PR #299: with the list toolbar
// sticky-pinned just below the header, the sweep IntersectionObserver's
// rootMargin must subtract *both* heights — not the header's alone —
// or rows partially hidden behind the toolbar still count as "fully
// visible" and get swept without the reader seeing them.

function makeStickyEl(className: string, bottom: number): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () =>
      ({
        top: bottom - 48,
        right: 0,
        bottom,
        left: 0,
        width: 0,
        height: 48,
        x: 0,
        y: bottom - 48,
        toJSON() {
          return {};
        },
      }) as DOMRect,
    configurable: true,
  });
  document.body.appendChild(el);
  return el;
}

describe('measureStickyInset', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns 0 when neither sticky element is in the DOM', () => {
    expect(measureStickyInset()).toBe(0);
  });

  it('returns the header bottom when only the header is mounted', () => {
    makeStickyEl('app-header', 56);
    expect(measureStickyInset()).toBe(56);
  });

  it('returns the toolbar bottom when both are stacked sticky', () => {
    makeStickyEl('app-header', 56);
    makeStickyEl('list-toolbar', 104);
    expect(measureStickyInset()).toBe(104);
  });

  it('takes the max bottom regardless of DOM order', () => {
    // If the toolbar were measured before the header for some reason,
    // the result must still reflect whichever sticky strip sits
    // lower in the viewport.
    makeStickyEl('list-toolbar', 104);
    makeStickyEl('app-header', 56);
    expect(measureStickyInset()).toBe(104);
  });

  it('ceils a sub-pixel bottom', () => {
    makeStickyEl('app-header', 56.4);
    makeStickyEl('list-toolbar', 104.2);
    expect(measureStickyInset()).toBe(105);
  });

  it('clamps a negative bottom (scrolled-off element) to 0', () => {
    makeStickyEl('app-header', -10);
    expect(measureStickyInset()).toBe(0);
  });
});
