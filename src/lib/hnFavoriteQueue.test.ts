import { beforeEach, describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  clearQueue,
  drop,
  enqueue,
  HN_FAVORITE_QUEUE_CHANGE_EVENT,
  listQueue,
  markFailure,
  MAX_ATTEMPTS,
  peekReady,
  _storageKeyForTests,
} from './hnFavoriteQueue';

const U = 'alice';

beforeEach(() => {
  window.localStorage.clear();
});

describe('backoffDelayMs', () => {
  it('starts at 2s and doubles', () => {
    expect(backoffDelayMs(1)).toBe(2_000);
    expect(backoffDelayMs(2)).toBe(4_000);
    expect(backoffDelayMs(3)).toBe(8_000);
    expect(backoffDelayMs(4)).toBe(16_000);
    expect(backoffDelayMs(5)).toBe(32_000);
  });

  it('caps at 5 minutes', () => {
    expect(backoffDelayMs(10)).toBe(5 * 60 * 1000);
    expect(backoffDelayMs(100)).toBe(5 * 60 * 1000);
  });
});

describe('enqueue', () => {
  it('adds a new entry when the queue is empty', () => {
    enqueue(U, 'favorite', 42, 1_000);
    expect(listQueue(U)).toEqual([
      {
        id: 42,
        action: 'favorite',
        at: 1_000,
        attempts: 0,
        nextAttemptAt: 1_000,
      },
    ]);
  });

  it('preserves insertion order for distinct ids', () => {
    enqueue(U, 'favorite', 1, 1_000);
    enqueue(U, 'unfavorite', 2, 1_001);
    enqueue(U, 'favorite', 3, 1_002);
    expect(listQueue(U).map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('is a no-op when enqueueing a duplicate of a pending action', () => {
    enqueue(U, 'favorite', 1, 1_000);
    enqueue(U, 'favorite', 1, 2_000); // same action
    const list = listQueue(U);
    expect(list).toHaveLength(1);
    // attempts/nextAttemptAt must not be reset by a duplicate enqueue.
    expect(list[0].at).toBe(1_000);
    expect(list[0].nextAttemptAt).toBe(1_000);
  });

  it('drops both when enqueueing the canceling action (favorite→unfavorite)', () => {
    enqueue(U, 'favorite', 1, 1_000);
    enqueue(U, 'unfavorite', 1, 2_000);
    expect(listQueue(U)).toEqual([]);
  });

  it('drops both in the other direction (unfavorite→favorite)', () => {
    enqueue(U, 'unfavorite', 7, 1_000);
    enqueue(U, 'favorite', 7, 2_000);
    expect(listQueue(U)).toEqual([]);
  });

  it('persists under a per-user storage key', () => {
    enqueue(U, 'favorite', 1, 1_000);
    expect(
      window.localStorage.getItem(_storageKeyForTests(U)),
    ).not.toBeNull();
    // Different user's queue is independent.
    expect(listQueue('bob')).toEqual([]);
  });

  it('fires the change event on mutation', () => {
    const events: Event[] = [];
    const h = (e: Event) => events.push(e);
    window.addEventListener(HN_FAVORITE_QUEUE_CHANGE_EVENT, h);
    enqueue(U, 'favorite', 1, 1_000);
    expect(events).toHaveLength(1);
    window.removeEventListener(HN_FAVORITE_QUEUE_CHANGE_EVENT, h);
  });
});

describe('peekReady', () => {
  it('returns entries whose nextAttemptAt has passed', () => {
    enqueue(U, 'favorite', 1, 1_000);
    enqueue(U, 'favorite', 2, 1_100);
    markFailure(U, 2, 'boom', 1_200); // pushes 2's nextAttemptAt to 1200+2000
    expect(peekReady(U, 1_500).map((e) => e.id)).toEqual([1]);
    expect(peekReady(U, 999_999).map((e) => e.id)).toEqual([1, 2]);
  });
});

describe('markFailure', () => {
  it('increments attempts and applies backoff', () => {
    enqueue(U, 'favorite', 1, 1_000);
    const ok = markFailure(U, 1, 'network', 1_000);
    expect(ok).toBe(true);
    const [entry] = listQueue(U);
    expect(entry.attempts).toBe(1);
    expect(entry.nextAttemptAt).toBe(1_000 + backoffDelayMs(1));
    expect(entry.lastError).toBe('network');
  });

  it('drops the entry after MAX_ATTEMPTS', () => {
    enqueue(U, 'favorite', 1, 0);
    let now = 0;
    let attempts = 0;
    let survived = true;
    while (survived && attempts < MAX_ATTEMPTS + 2) {
      survived = markFailure(U, 1, 'boom', now);
      now += 10 * 60 * 1000;
      attempts++;
    }
    expect(survived).toBe(false);
    expect(listQueue(U)).toEqual([]);
    // Total failure attempts should equal MAX_ATTEMPTS (last one drops).
    expect(attempts).toBe(MAX_ATTEMPTS);
  });

  it('returns false and is a no-op when the id is not in the queue', () => {
    expect(markFailure(U, 999, 'whatever', 1_000)).toBe(false);
    expect(listQueue(U)).toEqual([]);
  });
});

describe('drop', () => {
  it('removes the entry for the id', () => {
    enqueue(U, 'favorite', 1, 1_000);
    enqueue(U, 'favorite', 2, 1_001);
    drop(U, 1);
    expect(listQueue(U).map((e) => e.id)).toEqual([2]);
  });

  it('is a no-op on a missing id', () => {
    enqueue(U, 'favorite', 1, 1_000);
    drop(U, 999);
    expect(listQueue(U)).toHaveLength(1);
  });
});

describe('clearQueue', () => {
  it('removes all entries', () => {
    enqueue(U, 'favorite', 1, 1_000);
    enqueue(U, 'favorite', 2, 1_001);
    clearQueue(U);
    expect(listQueue(U)).toEqual([]);
  });
});

describe('storage resilience', () => {
  it('recovers from corrupted JSON', () => {
    window.localStorage.setItem(_storageKeyForTests(U), 'not json');
    expect(listQueue(U)).toEqual([]);
    enqueue(U, 'favorite', 1, 1_000);
    expect(listQueue(U)).toHaveLength(1);
  });

  it('ignores malformed entries', () => {
    window.localStorage.setItem(
      _storageKeyForTests(U),
      JSON.stringify([
        { id: 1 }, // missing fields
        {
          id: 2,
          action: 'favorite',
          at: 1,
          attempts: 0,
          nextAttemptAt: 0,
        },
        { id: 'abc', action: 'favorite', at: 0, attempts: 0, nextAttemptAt: 0 },
      ]),
    );
    expect(listQueue(U).map((e) => e.id)).toEqual([2]);
  });
});
