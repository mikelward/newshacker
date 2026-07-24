import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntryStore, isEntry } from './entryStore';

const KEY = 'newshacker:test:entries';
const EVENT = 'newshacker:test:entriesChanged';

function make(overrides: Partial<Parameters<typeof createEntryStore>[0]> = {}) {
  return createEntryStore({ storageKey: KEY, changeEvent: EVENT, ...overrides });
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createEntryStore', () => {
  it('round-trips add → getIds/getEntries and excludes tombstones', () => {
    const s = make();
    s.addId(1, 100);
    s.addId(2, 200);
    expect([...s.getIds()].sort()).toEqual([1, 2]);
    expect(s.getEntries()).toEqual([
      { id: 1, at: 100 },
      { id: 2, at: 200 },
    ]);

    s.removeId(1, 300);
    expect([...s.getIds()]).toEqual([2]); // live ids only
    // getAllEntries exposes the tombstone for the sync layer.
    expect(s.getAllEntries()).toContainEqual({ id: 1, at: 300, deleted: true });
  });

  it('removeId writes a tombstone even for an absent id, but no-ops if already tombstoned', () => {
    const s = make();
    const fired = vi.fn();
    window.addEventListener(EVENT, fired);

    s.removeId(9, 100); // absent → still tombstoned (cross-device resurrect-guard)
    expect(s.getAllEntries()).toEqual([{ id: 9, at: 100, deleted: true }]);
    expect(fired).toHaveBeenCalledTimes(1);

    s.removeId(9, 200); // already a tombstone → no write, no event, `at` unchanged
    expect(s.getAllEntries()).toEqual([{ id: 9, at: 100, deleted: true }]);
    expect(fired).toHaveBeenCalledTimes(1);

    window.removeEventListener(EVENT, fired);
  });

  it('removeIds tombstones a batch in one write, preserving existing tombstones', () => {
    const s = make();
    const fired = vi.fn();
    s.replaceEntries([
      { id: 1, at: 100 },
      { id: 2, at: 100 },
      { id: 3, at: 50, deleted: true },
      { id: 4, at: 100 },
    ]);
    window.addEventListener(EVENT, fired);

    s.removeIds([1, 2, 3], 900);

    expect(fired).toHaveBeenCalledTimes(1); // one write for the whole batch
    const all = s.getAllEntries().sort((a, b) => a.id - b.id);
    expect(all).toEqual([
      { id: 4, at: 100 },
      { id: 1, at: 900, deleted: true },
      { id: 2, at: 900, deleted: true },
      { id: 3, at: 50, deleted: true }, // untouched `at`
    ].sort((a, b) => a.id - b.id));
    window.removeEventListener(EVENT, fired);
  });

  it('removeIds is a no-op for an empty batch', () => {
    const s = make();
    const fired = vi.fn();
    s.addId(1, 100);
    window.addEventListener(EVENT, fired);
    s.removeIds([]);
    expect(fired).not.toHaveBeenCalled();
    expect([...s.getIds()]).toEqual([1]);
    window.removeEventListener(EVENT, fired);
  });

  // Regression: forgetAll used to be a bare `writeRaw([])`, which looked right
  // locally but left the sync layer nothing to merge against — cloudSync's next
  // pull merged the server's still-live entries into an empty local list and the
  // whole list came back, silently undoing the user's "Forget all".
  it('forgetAll tombstones every live id instead of wiping the list', () => {
    const s = make();
    s.addId(1, 100);
    s.addId(2, 200);
    s.removeId(3, 150); // pre-existing tombstone

    s.forgetAll(900);

    expect([...s.getIds()]).toEqual([]);
    const all = s.getAllEntries().sort((a, b) => a.id - b.id);
    expect(all).toEqual([
      { id: 1, at: 900, deleted: true },
      { id: 2, at: 900, deleted: true },
      { id: 3, at: 150, deleted: true },
    ]);
  });

  it('forgetAll does not write when nothing is live', () => {
    const s = make();
    const fired = vi.fn();
    s.removeId(7, 100);
    window.addEventListener(EVENT, fired);
    s.forgetAll(900);
    expect(fired).not.toHaveBeenCalled();
    expect(s.getAllEntries()).toEqual([{ id: 7, at: 100, deleted: true }]);
    window.removeEventListener(EVENT, fired);
  });

  // Regression (clock skew): `at` is wall-clock Date.now() from whichever device
  // wrote the entry, so an entry synced from a device running ahead can sit in
  // this device's future. Both mergeEntries implementations accept only a
  // STRICTLY newer entry, so a tombstone stamped at our `now` would lose the
  // merge and the id would come back.
  describe('tombstones out-date the live entry they replace', () => {
    const NOW = 1_000;
    const FUTURE = NOW + 60_000; // entry from a device whose clock runs ahead

    it('removeId stamps past a future-dated live entry', () => {
      const s = make();
      s.replaceEntries([{ id: 1, at: FUTURE }]);
      s.removeId(1, NOW);
      expect(s.getAllEntries()).toEqual([
        { id: 1, at: FUTURE + 1, deleted: true },
      ]);
    });

    it('removeIds stamps past each future-dated live entry independently', () => {
      const s = make();
      s.replaceEntries([
        { id: 1, at: FUTURE },
        { id: 2, at: NOW - 500 }, // normal, in the past
      ]);
      s.removeIds([1, 2], NOW);
      const all = s.getAllEntries().sort((a, b) => a.id - b.id);
      expect(all).toEqual([
        { id: 1, at: FUTURE + 1, deleted: true },
        // Untouched by id 1's bump — a past-dated entry still tombstones at `now`.
        { id: 2, at: NOW, deleted: true },
      ]);
    });

    it('forgetAll survives a merge against the future-dated server copy', () => {
      const s = make();
      s.replaceEntries([{ id: 1, at: FUTURE }]);
      s.forgetAll(NOW);
      // Replay the exact merge rule both cloudSync.ts and api/sync.ts use:
      // incoming wins only when strictly newer.
      const local = s.getAllEntries()[0];
      const server = { id: 1, at: FUTURE };
      expect(server.at > local.at).toBe(false); // tombstone holds
      expect([...s.getIds()]).toEqual([]);
    });
  });

  it('clearIds stays the hard wipe (tombstones included)', () => {
    const s = make();
    s.addId(1, 100);
    s.removeId(2, 100);
    s.clearIds();
    expect(s.getAllEntries()).toEqual([]);
  });

  it('fires the change event on every write', () => {
    const s = make();
    const fired = vi.fn();
    window.addEventListener(EVENT, fired);
    s.addId(1);
    s.clearIds();
    s.replaceEntries([{ id: 5, at: 1 }]);
    expect(fired).toHaveBeenCalledTimes(3);
    window.removeEventListener(EVENT, fired);
  });

  it('prunes entries (additive AND tombstones) older than ttlMs at read time', () => {
    const ttlMs = 1000;
    const s = make({ ttlMs });
    const now = 10_000;
    // Seed directly: one fresh additive, one stale additive, one stale tombstone.
    s.replaceEntries([
      { id: 1, at: now - 500 }, // fresh
      { id: 2, at: now - 2000 }, // stale additive → pruned
      { id: 3, at: now - 3000, deleted: true }, // stale tombstone → pruned
    ]);
    expect(s.getAllEntries(now)).toEqual([{ id: 1, at: now - 500 }]);
    expect([...s.getIds(now)]).toEqual([1]);
  });

  it('keeps everything forever when ttlMs is unset', () => {
    const s = make();
    const ancient = 1;
    s.replaceEntries([{ id: 1, at: ancient }]);
    expect([...s.getIds(Date.now())]).toEqual([1]);
  });

  it('one-shot renames a legacy key into the store key', () => {
    const LEGACY = 'newshacker:test:legacy';
    window.localStorage.setItem(LEGACY, JSON.stringify([{ id: 7, at: 42 }]));
    const s = make({ legacyKey: LEGACY });

    expect(s.getEntries()).toEqual([{ id: 7, at: 42 }]); // adopted
    expect(window.localStorage.getItem(LEGACY)).toBeNull(); // legacy cleared
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });

  it('does not clobber an existing store with the legacy key', () => {
    const LEGACY = 'newshacker:test:legacy';
    window.localStorage.setItem(KEY, JSON.stringify([{ id: 1, at: 1 }]));
    window.localStorage.setItem(LEGACY, JSON.stringify([{ id: 9, at: 9 }]));
    const s = make({ legacyKey: LEGACY });
    expect(s.getEntries()).toEqual([{ id: 1, at: 1 }]); // existing wins, legacy ignored
  });

  it('runs beforeRead on every read, with the read `now`', () => {
    const beforeRead = vi.fn();
    const s = make({ beforeRead });
    s.getIds(123);
    s.getEntries(456);
    expect(beforeRead).toHaveBeenCalledTimes(2);
    expect(beforeRead).toHaveBeenNthCalledWith(1, 123);
    expect(beforeRead).toHaveBeenNthCalledWith(2, 456);
  });

  it('returns [] for a corrupted or non-array payload', () => {
    const s = make();
    window.localStorage.setItem(KEY, '{not json');
    expect(s.getAllEntries()).toEqual([]);
    window.localStorage.setItem(KEY, JSON.stringify({ not: 'an array' }));
    expect(s.getAllEntries()).toEqual([]);
    // Mixed valid/invalid items: only valid entries survive.
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ id: 1, at: 1 }, { id: 'x', at: 2 }, null, { at: 3 }]),
    );
    expect(s.getAllEntries()).toEqual([{ id: 1, at: 1 }]);
  });

  it('isEntry validates shape (id/at numbers, deleted only true)', () => {
    expect(isEntry({ id: 1, at: 2 })).toBe(true);
    expect(isEntry({ id: 1, at: 2, deleted: true })).toBe(true);
    expect(isEntry({ id: 1, at: 2, deleted: false })).toBe(false);
    expect(isEntry({ id: '1', at: 2 })).toBe(false);
    expect(isEntry({ id: 1 })).toBe(false);
    expect(isEntry(null)).toBe(false);
  });
});
