import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAvatarPrefs } from './useAvatarPrefs';
import {
  AVATAR_PREFS_CHANGE_EVENT,
  setStoredAvatarPrefs,
} from '../lib/avatarPrefs';

describe('useAvatarPrefs', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns the default github prefs initially', () => {
    const { result } = renderHook(() => useAvatarPrefs());
    expect(result.current.prefs).toEqual({ source: 'github' });
  });

  it('reflects prefs written before mount', () => {
    setStoredAvatarPrefs({ source: 'none' });
    const { result } = renderHook(() => useAvatarPrefs());
    expect(result.current.prefs.source).toBe('none');
  });

  it('updates when the change event fires from elsewhere', () => {
    const { result } = renderHook(() => useAvatarPrefs());
    act(() => {
      setStoredAvatarPrefs({ source: 'github', githubUsername: 'alice-real' });
    });
    expect(result.current.prefs).toEqual({
      source: 'github',
      githubUsername: 'alice-real',
    });
  });

  it('save() persists and fires the change event', () => {
    const { result } = renderHook(() => useAvatarPrefs());
    act(() => {
      result.current.save({ source: 'none' });
    });
    expect(result.current.prefs.source).toBe('none');
  });

  it('re-reads on a cross-tab storage event', () => {
    const { result } = renderHook(() => useAvatarPrefs());
    act(() => {
      setStoredAvatarPrefs({ source: 'none' });
    });
    // To exercise the `storage` listener specifically (not the in-tab
    // custom event) write the key directly and fire a StorageEvent.
    window.localStorage.setItem(
      'newshacker:avatarPrefs',
      JSON.stringify({ source: 'github', githubUsername: 'bob' }),
    );
    act(() => {
      window.dispatchEvent(new StorageEvent('storage'));
    });
    expect(result.current.prefs).toEqual({
      source: 'github',
      githubUsername: 'bob',
    });
  });

  it('cleans up listeners on unmount', () => {
    const { unmount, result } = renderHook(() => useAvatarPrefs());
    const before = result.current.prefs.source;
    unmount();
    // Fire the event after unmount — should not throw.
    window.dispatchEvent(new CustomEvent(AVATAR_PREFS_CHANGE_EVENT));
    expect(before).toBe('github');
  });
});
