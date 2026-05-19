import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDocumentTitle } from './useDocumentTitle';

describe('useDocumentTitle', () => {
  const originalTitle = document.title;

  beforeEach(() => {
    document.title = 'newshacker — a reader for Hacker News';
  });

  afterEach(() => {
    document.title = originalTitle;
  });

  it('sets document.title to the given string while mounted', () => {
    renderHook(() => useDocumentTitle('A great story - newshacker'));
    expect(document.title).toBe('A great story - newshacker');
  });

  it('restores the previous title on unmount', () => {
    document.title = 'previous';
    const { unmount } = renderHook(() => useDocumentTitle('new title'));
    expect(document.title).toBe('new title');
    unmount();
    expect(document.title).toBe('previous');
  });

  it('leaves the title alone when called with null or undefined', () => {
    document.title = 'unchanged';
    renderHook(() => useDocumentTitle(null));
    expect(document.title).toBe('unchanged');
    renderHook(() => useDocumentTitle(undefined));
    expect(document.title).toBe('unchanged');
  });

  it('treats an empty string the same as null (so a loading flash never lands)', () => {
    document.title = 'unchanged';
    renderHook(() => useDocumentTitle(''));
    expect(document.title).toBe('unchanged');
  });

  it('updates the title when the input changes', () => {
    const { rerender } = renderHook(
      ({ t }: { t: string }) => useDocumentTitle(t),
      { initialProps: { t: 'first' } },
    );
    expect(document.title).toBe('first');
    rerender({ t: 'second' });
    expect(document.title).toBe('second');
  });

  it('restores the title that was current at mount, not at first render', () => {
    document.title = 'baseline';
    const { rerender, unmount } = renderHook(
      ({ t }: { t: string }) => useDocumentTitle(t),
      { initialProps: { t: 'first' } },
    );
    rerender({ t: 'second' });
    rerender({ t: 'third' });
    unmount();
    expect(document.title).toBe('baseline');
  });
});
