import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useReadLaterService } from './useReadLaterService';

describe('useReadLaterService', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('defaults to None and persists a chosen service reactively', () => {
    const { result } = renderHook(() => useReadLaterService());
    expect(result.current.readLaterService).toBe('none');

    act(() => result.current.setReadLaterService('raindrop'));
    expect(result.current.readLaterService).toBe('raindrop');
    expect(window.localStorage.getItem('newshacker:readLaterService')).toBe(
      'raindrop',
    );

    act(() => result.current.setReadLaterService('none'));
    expect(result.current.readLaterService).toBe('none');
    expect(
      window.localStorage.getItem('newshacker:readLaterService'),
    ).toBeNull();
  });
});
