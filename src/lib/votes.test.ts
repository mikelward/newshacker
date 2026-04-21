import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _storageKeyForTests,
  addVotedId,
  clearVotedIds,
  getVotedIds,
  removeVotedId,
  VOTES_CHANGE_EVENT,
} from './votes';

describe('votes store', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('starts empty', () => {
    expect(getVotedIds('alice')).toEqual(new Set());
  });

  it('round-trips added ids', () => {
    addVotedId('alice', 1);
    addVotedId('alice', 2);
    expect(getVotedIds('alice')).toEqual(new Set([1, 2]));
  });

  it('deduplicates on add', () => {
    addVotedId('alice', 1);
    addVotedId('alice', 1);
    expect(getVotedIds('alice')).toEqual(new Set([1]));
  });

  it('removes ids', () => {
    addVotedId('alice', 1);
    addVotedId('alice', 2);
    removeVotedId('alice', 1);
    expect(getVotedIds('alice')).toEqual(new Set([2]));
  });

  it('namespaces by username', () => {
    addVotedId('alice', 1);
    addVotedId('bob', 2);
    expect(getVotedIds('alice')).toEqual(new Set([1]));
    expect(getVotedIds('bob')).toEqual(new Set([2]));
    expect(_storageKeyForTests('alice')).not.toBe(_storageKeyForTests('bob'));
  });

  it('clear wipes the store for that user', () => {
    addVotedId('alice', 1);
    addVotedId('bob', 2);
    clearVotedIds('alice');
    expect(getVotedIds('alice')).toEqual(new Set());
    expect(getVotedIds('bob')).toEqual(new Set([2]));
  });

  it('returns empty set for a blank username', () => {
    // Defensive: we never want a write with an empty username since
    // that would pollute the prefix.
    addVotedId('', 1);
    expect(getVotedIds('')).toEqual(new Set());
  });

  it('dispatches VOTES_CHANGE_EVENT on write', () => {
    let fired = 0;
    const handler = () => {
      fired += 1;
    };
    window.addEventListener(VOTES_CHANGE_EVENT, handler);
    try {
      addVotedId('alice', 1);
      removeVotedId('alice', 1);
      expect(fired).toBe(2);
    } finally {
      window.removeEventListener(VOTES_CHANGE_EVENT, handler);
    }
  });

  it('ignores malformed stored values', () => {
    window.localStorage.setItem(_storageKeyForTests('alice'), 'not json');
    expect(getVotedIds('alice')).toEqual(new Set());
    window.localStorage.setItem(
      _storageKeyForTests('alice'),
      JSON.stringify(['nope', 1, -2, 3.5, 4]),
    );
    expect(getVotedIds('alice')).toEqual(new Set([1, 4]));
  });
});
