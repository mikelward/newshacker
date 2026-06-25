import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStickyFooterInset } from './useStickyFooterInset';

function footerAt(top: number): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, bottom: top + 40, height: 40 }) as DOMRect,
  });
  return el;
}

describe('useStickyFooterInset', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      value: 800,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      value: 768,
      configurable: true,
    });
  });

  it('returns 0 when there is no element', () => {
    const { result } = renderHook(() => useStickyFooterInset(null));
    expect(result.current).toBe(0);
  });

  it('measures the intrusion as soon as the footer element is provided (late mount)', () => {
    const { result, rerender } = renderHook(
      ({ el }: { el: HTMLDivElement | null }) => useStickyFooterInset(el),
      { initialProps: { el: null as HTMLDivElement | null } },
    );
    // Cold load: skeleton renders, footer not mounted yet → no inset.
    expect(result.current).toBe(0);

    // Footer mounts stuck at the foot (top = innerHeight - height).
    rerender({ el: footerAt(760) });
    expect(result.current).toBe(40); // 800 - 760

    // Footer unmounts → inset drops back to 0 immediately.
    rerender({ el: null });
    expect(result.current).toBe(0);
  });

  it('clamps to 0 when the footer is still below the fold (not yet stuck)', () => {
    const { result } = renderHook(() => useStickyFooterInset(footerAt(900)));
    expect(result.current).toBe(0); // top past the viewport bottom
  });
});
