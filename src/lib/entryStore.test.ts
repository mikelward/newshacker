import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntryStore, isEntry } from './entryStore';
import {
  resetStorageHealthForTest,
  subscribeStorageFailure,
} from './storageHealth';

const KEY = 'newshacker:test:entries';
const EVENT = 'newshacker:test:entriesChanged';

function make(overrides: Partial<Parameters<typeof createEntryStore>[0]> = {}) {
  return createEntryStore({ storageKey: KEY, changeEvent: EVENT, ...overrides });
}

/** Storage that reads normally but refuses every write — an exhausted quota, or
 * private mode. `Storage.prototype` is not the seam here (the environment's
 * localStorage does not inherit its methods), so stub the global, as
 * AppUpdateWatcher's tests do. */
function refuseWrites(alsoRefuseReads = false): () => void {
  const real = window.localStorage;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => {
      if (alsoRefuseReads) throw new DOMException('denied', 'SecurityError');
      return real.getItem(k);
    },
    setItem: () => {
      throw new DOMException('quota', 'QuotaExceededError');
    },
    removeItem: (k: string) => real.removeItem(k),
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    get length() {
      return real.length;
    },
  } as Storage);
  return () => vi.unstubAllGlobals();
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

  it('keeps a pin storage refused, instead of losing it', () => {
    // Quota exhausted, or private mode. The swallow this replaces made the pin
    // vanish the instant it was made — reads come straight back off localStorage
    // — with nothing on screen to say why.
    const s = make();
    s.addId(1, 1000);
    const restore = refuseWrites();
    s.addId(2, 2000);
    expect([...s.getIds(2000)]).toEqual([1, 2]);
    // Storage still holds only the first; the held payload is what reads see.
    expect(window.localStorage.getItem(KEY)).toBe(
      JSON.stringify([{ id: 1, at: 1000 }]),
    );
    restore();
  });

  it('installs the held payload before firing the change event', () => {
    // Subscribers re-read synchronously from inside the event, so a payload
    // assigned afterwards is invisible to them and the row never re-renders.
    const s = make();
    const seen: number[][] = [];
    const handler = () => seen.push([...s.getIds(2000)]);
    window.addEventListener(EVENT, handler);
    const restore = refuseWrites();
    s.addId(7, 2000);
    window.removeEventListener(EVENT, handler);
    restore();
    expect(seen).toEqual([[7]]);
  });

  it('retries the refused write on the next one, and drops the held payload', () => {
    // There is no timer: the retry is the next pin, unpin or sync merge.
    const s = make();
    const restore = refuseWrites();
    s.addId(1, 1000);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    restore();
    s.addId(2, 2000);
    expect(window.localStorage.getItem(KEY)).toBe(
      JSON.stringify([
        { id: 1, at: 1000 },
        { id: 2, at: 2000 },
      ]),
    );
    expect([...s.getIds(2000)]).toEqual([1, 2]);
  });

  it('replays the queued pin onto what another tab wrote', () => {
    // The other tab never saw the pin made while storage was refusing, and this
    // session never saw what that tab wrote. Nothing has to be reconciled: the
    // pin is replayed onto whatever the key holds when it is next readable.
    const s = make();
    const restore = refuseWrites();
    s.addId(1, 1000);
    expect([...s.getIds(1000)]).toEqual([1]);
    restore();

    window.localStorage.setItem(KEY, JSON.stringify([{ id: 9, at: 3000 }]));
    expect([...s.getIds(3000)]).toEqual([9, 1]);
    // And the replay persists, so the next reader doesn't depend on this session.
    expect(window.localStorage.getItem(KEY)).toBe(
      JSON.stringify([
        { id: 9, at: 3000 },
        { id: 1, at: 1000 },
      ]),
    );
  });

  it('replays the queued pin onto a list an unreadable read was hiding', () => {
    // Blocked-cookies storage: the read that ran when the pin was made returned
    // nothing. Holding the resulting LIST would overwrite entry 1, which this
    // session never got to see; holding the pin itself simply applies it to
    // whatever turns out to be there.
    const s = make();
    s.addId(1, 1000);
    const restore = refuseWrites(true);
    s.addId(2, 2000);
    restore();

    expect([...s.getIds(2000)]).toEqual([1, 2]);
    s.addId(3, 3000);
    expect([...s.getIds(3000)]).toEqual([1, 2, 3]);
  });

  it('lets a removal made during an outage beat the entry it replaced', () => {
    // The tombstone is stamped past the live entry (see `tombstoneAt`), so the
    // merge resolves the id the way the sync merge would rather than reviving it.
    const s = make();
    s.addId(1, 1000);
    const restore = refuseWrites(true);
    s.removeId(1, 2000);
    restore();

    expect([...s.getIds(2000)]).toEqual([]);
  });

  it('keeps an outage removal against a future-dated entry it never saw', () => {
    // `removeId` stamps a tombstone past the live entry it replaces, because a
    // synced entry can carry a clock-ahead `at`. With reads blocked it cannot
    // see that entry, so the tombstone lands at a local `now` the merge would
    // otherwise rank below it — reviving the item the user just unpinned.
    const s = make();
    window.localStorage.setItem(KEY, JSON.stringify([{ id: 1, at: 5000 }]));
    const restore = refuseWrites(true);
    s.removeId(1, 2000);
    restore();

    expect([...s.getIds(6000)]).toEqual([]);
  });

  it('does not re-stamp a tombstone it merely inherited', () => {
    // A held payload written with reads WORKING is a copy of the stored list
    // with an edit on top, so its tombstones include old ones. Re-stamping one
    // of those would delete a re-pin another tab made since.
    const s = make();
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ id: 1, at: 1000, deleted: true }]),
    );
    const restore = refuseWrites();
    s.addId(2, 2000);
    restore();

    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 1, at: 5000 },
        { id: 9, at: 5000 },
      ]),
    );
    expect([...s.getIds(6000)].sort((a, b) => a - b)).toEqual([1, 2, 9]);
  });

  it('keeps the pin when an unreadable baseline turns out to be empty', () => {
    // Same outage, nothing stored underneath: holding clobbers nothing, so the
    // pin made while storage was unreachable survives and is written out by the
    // next attempt.
    const s = make();
    const restore = refuseWrites(true);
    s.addId(2, 2000);
    restore();

    expect([...s.getIds(2000)]).toEqual([2]);
    s.addId(3, 3000);
    expect(window.localStorage.getItem(KEY)).toBe(
      JSON.stringify([
        { id: 2, at: 2000 },
        { id: 3, at: 3000 },
      ]),
    );
  });

  it('does not re-stamp a tombstone a sync snapshot supplied', () => {
    // `replaceEntries` writes the server's merged snapshot wholesale, and with
    // reads blocked that snapshot is held as if it were local intent. Its
    // tombstones are the server's, though: an older one there can legitimately
    // lose to a newer local re-pin, which is the entry sitting unreadable on
    // disk. Re-stamping it would delete that re-pin.
    const s = make();
    window.localStorage.setItem(KEY, JSON.stringify([{ id: 1, at: 5000 }]));
    const restore = refuseWrites(true);
    // cloudSync reads local state first (the read fails, so the write that
    // follows is held blind) and then writes the merged snapshot wholesale.
    expect(s.getAllEntries(2000)).toEqual([]);
    s.replaceEntries([{ id: 1, at: 2000, deleted: true }]);
    restore();

    expect([...s.getIds(6000)]).toEqual([1]);
  });

  it('drops removal intent for an id that is live again', () => {
    // remove → re-add → a sync snapshot, all while storage is unreadable. The
    // marker that says "this device removed id 1" is stale by the third write,
    // and left in place it re-stamps the snapshot's tombstone over the re-pin
    // waiting on disk.
    const s = make();
    window.localStorage.setItem(KEY, JSON.stringify([{ id: 1, at: 5000 }]));
    const restore = refuseWrites(true);
    s.removeId(1, 1000);
    s.addId(1, 2000);
    s.replaceEntries([{ id: 1, at: 1500, deleted: true }]);
    restore();

    expect([...s.getIds(6000)]).toEqual([1]);
  });

  it('merges a write that landed between the read and the refused setItem', () => {
    // The baseline has to be the one the payload was written OVER. Sampled
    // after the failure instead, it is whatever another tab wrote in that
    // window — recorded as the baseline, their write is masked behind ours and
    // lost on the next successful write.
    const s = make();
    const real = window.localStorage;
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => real.getItem(k),
      setItem: () => {
        real.setItem(KEY, JSON.stringify([{ id: 9, at: 3000 }]));
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: (k: string) => real.removeItem(k),
      clear: () => real.clear(),
      key: (i: number) => real.key(i),
      get length() {
        return real.length;
      },
    } as Storage);
    s.addId(1, 1000);
    vi.unstubAllGlobals();

    expect([...s.getIds(3000)].sort((a, b) => a - b)).toEqual([1, 9]);
  });

  it('says so when it replaces a payload it could not parse', () => {
    // The merge persists its result, so this is the last moment anything knows
    // the stored payload was corrupt.
    const s = make();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const restore = refuseWrites();
    s.addId(1, 1000);
    restore();

    window.localStorage.setItem(KEY, '{not json');
    expect([...s.getIds(1000)]).toEqual([1]);
    expect(
      debug.mock.calls.some(
        ([message]) => typeof message === 'string' && message.includes('not JSON'),
      ),
    ).toBe(true);
    debug.mockRestore();
  });

  it('re-pins past a future-dated tombstone it could not see', () => {
    // The mirror of the removal case: a tombstone synced from a clock-ahead
    // device sits on disk unreadable, and a pin stamped at local `now` would
    // lose the next sync merge to it. The stamp is computed when the pin is
    // replayed, against the entry it is actually replacing.
    const s = make();
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ id: 1, at: 5000, deleted: true }]),
    );
    const restore = refuseWrites(true);
    s.addId(1, 2000);
    restore();

    expect([...s.getIds(6000)]).toEqual([1]);
    expect(s.getAllEntries(6000)).toEqual([{ id: 1, at: 5001 }]);
  });

  it('keeps a removal through a cloud pull that happens mid-outage', () => {
    // cloudSync reads this store while storage is unreadable, so its merge sees
    // the tombstone stamped against nothing and the server's newer live entry
    // wins. The snapshot it writes back is therefore NOT authoritative over the
    // disk it never saw — it folds in, and the removal replays on top of it.
    const s = make();
    window.localStorage.setItem(KEY, JSON.stringify([{ id: 1, at: 5000 }]));
    const restore = refuseWrites(true);
    s.removeId(1, 2000);
    s.replaceEntries([{ id: 1, at: 5000 }]);
    restore();

    expect([...s.getIds(6000)]).toEqual([]);
    expect(s.getAllEntries(6000)).toEqual([
      { id: 1, at: 5001, deleted: true },
    ]);
  });

  it('replays a run of operations in order once storage takes a write', () => {
    const s = make();
    const restore = refuseWrites();
    s.addId(1, 1000);
    s.addId(2, 2000);
    s.removeId(1, 3000);
    expect([...s.getIds(3000)]).toEqual([2]);
    restore();

    s.addId(3, 4000);
    expect([...s.getIds(4000)]).toEqual([2, 3]);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual([
      { id: 2, at: 2000 },
      { id: 1, at: 3000, deleted: true },
      { id: 3, at: 4000 },
    ]);
  });

  it('does not advance a pin\'s timestamp on every replay', () => {
    // The queue replays on every read and every write. If the add re-stamped
    // each time, `at` would creep — and a moving timestamp reads to cloudSync as
    // a fresh local change, so it would push, echo the snapshot back, and push
    // again for as long as the outage lasted.
    const s = make();
    const restore = refuseWrites(true);
    s.addId(1, 1000);
    s.replaceEntries([{ id: 1, at: 1000 }]); // the sync echo
    const first = s.getAllEntries(2000);
    const second = s.getAllEntries(3000);
    restore();

    expect(first).toEqual([{ id: 1, at: 1000 }]);
    expect(second).toEqual(first);
    expect(s.getAllEntries(4000)).toEqual(first);
  });

  it('does not advance a toggled id\'s timestamp on every replay', () => {
    // Each operation is idempotent on its own, and a run of them still is not:
    // unpin-then-re-pin composes to "tombstone one tick past what is there, then
    // live one tick past THAT", so every replay would advance `at` by two —
    // exactly the creep the single-pin case above guards against, and with the
    // same cost (push, echo, push, for the length of the outage). What the user
    // did to this id LAST is the whole of their intent for it, so the queue
    // carries only that.
    const s = make();
    const restore = refuseWrites(true);
    s.removeId(1, 1000);
    s.addId(1, 2000);
    const first = s.getAllEntries(3000);
    s.replaceEntries(first); // the sync echo
    const second = s.getAllEntries(4000);
    s.replaceEntries(second); // and the next one
    const third = s.getAllEntries(5000);
    restore();

    expect(first).toEqual([{ id: 1, at: 2000 }]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect([...s.getIds(6000)]).toEqual([1]);
  });

  it('folds a queued snapshot into a write that landed after it', () => {
    // The snapshot was whole as of the list it was built from, and it is queued
    // precisely because it did not land. Another tab writing before it replays
    // is just another writer, so it merges rather than replacing.
    const s = make();
    window.localStorage.setItem(KEY, JSON.stringify([{ id: 1, at: 1000 }]));
    const restore = refuseWrites();
    s.replaceEntries([
      { id: 1, at: 1000 },
      { id: 2, at: 2000 },
    ]);
    restore();

    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 1, at: 1000 },
        { id: 3, at: 3000 },
      ]),
    );
    expect([...s.getIds(4000)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('keeps a batched hide past a future-dated tombstone it could not see', () => {
    // Sweep hides many rows at once. Built as a list and handed over wholesale,
    // the batch would fold in on recovery and lose to a tombstone synced from a
    // clock-ahead device; as an operation it is stamped past that tombstone when
    // it replays, exactly as a single add is.
    const s = make();
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 1, at: 5000, deleted: true },
        { id: 2, at: 100 },
      ]),
    );
    const restore = refuseWrites(true);
    s.addIds([1, 2], 2000);
    restore();

    expect([...s.getIds(6000)].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(s.getAllEntries(6000)).toEqual([
      { id: 1, at: 5001 },
      { id: 2, at: 2000 },
    ]);
  });

  it('expires a queued entry once its TTL passes', () => {
    // A hide queued through an outage longer than the hidden store's TTL must
    // still expire: replaying it forever would keep the story hidden, and the
    // first read after recovery would write that expired entry back.
    const s = make({ ttlMs: 1000 });
    const restore = refuseWrites(true);
    s.addId(1, 1000);
    expect([...s.getIds(1500)]).toEqual([1]);
    expect([...s.getIds(2500)]).toEqual([]);
    restore();

    expect([...s.getIds(2500)]).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual([]);
  });

  it('does not write over a list it could not read', () => {
    // Reads failing while writes work is odd but not impossible (a wrapper, a
    // transient failure). The list assembled then is the queue alone, so writing
    // it would replace what is really stored with a fragment.
    const s = make();
    window.localStorage.setItem(KEY, JSON.stringify([{ id: 9, at: 3000 }]));
    const real = window.localStorage;
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: (k: string, v: string) => real.setItem(k, v),
      removeItem: (k: string) => real.removeItem(k),
      clear: () => real.clear(),
      key: (i: number) => real.key(i),
      get length() {
        return real.length;
      },
    } as Storage);
    s.addId(1, 1000);
    expect(JSON.parse(real.getItem(KEY) ?? 'null')).toEqual([
      { id: 9, at: 3000 },
    ]);
    vi.unstubAllGlobals();

    // And the queued pin lands once a read succeeds.
    expect([...s.getIds(4000)].sort((a, b) => a - b)).toEqual([1, 9]);
  });

  it('does not promote a snapshot assembled blind when reads recover first', () => {
    // cloudSync reads local state, merges, and writes back. If storage recovers
    // between those two steps, the write's own read succeeds — but the list it
    // is carrying was still assembled blind, so it must not subsume the
    // operations queued before it.
    const s = make();
    window.localStorage.setItem(KEY, JSON.stringify([{ id: 1, at: 5000 }]));
    const blind = refuseWrites(true);
    s.removeId(1, 2000);
    blind();

    const writesRefused = refuseWrites(); // reads work again, writes still don't
    s.replaceEntries([{ id: 1, at: 5000 }]);
    writesRefused();

    expect([...s.getIds(6000)]).toEqual([]);
  });

  it('dates a queued removal past an older tombstone it could not see', () => {
    // Recovery reveals a tombstone for the same id, older than the unpin — a
    // concurrent tab's, or one from a device whose clock runs behind. Inherited
    // as it stands, the user's own removal has no date on disk at all, and a
    // live entry synced from between the two beats it and brings the item back.
    // (An id the caller could SEE was already tombstoned is a different case:
    // `removeId` / `removeIds` skip it, since this device has no news about it.)
    const s = make();
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ id: 1, at: 1000, deleted: true }]),
    );
    const restore = refuseWrites(true);
    s.removeId(1, 3000);
    restore();

    const [tombstone] = s.getAllEntries(4000);
    expect(tombstone).toEqual({ id: 1, at: 3000, deleted: true });
    // Both merge sides take an incoming entry only when it is strictly newer,
    // so a re-pin synced from between the two now loses, as the user's later
    // unpin should. At the inherited 1000 it would win.
    expect(tombstone.at > 2000).toBe(true);
  });

  it('keeps a queued removal when a blind snapshot writes after recovery', () => {
    // Same provenance as the case above, but storage recovers far enough to
    // take the write: `replaceEntries` then persists a list assembled while
    // reads were failing. Composed on top of the queue it would replace the
    // replayed tombstone and clear it, so the unpin would be lost with the
    // write reporting success.
    const s = make();
    window.localStorage.setItem(KEY, JSON.stringify([{ id: 1, at: 5000 }]));
    const blind = refuseWrites(true);
    s.removeId(1, 2000);
    blind();

    s.replaceEntries([{ id: 1, at: 5000 }]); // the server's live entry, merged blind

    expect([...s.getIds(6000)]).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual([
      { id: 1, at: 5001, deleted: true },
    ]);
  });

  it('reports a blocked read too, not just a refused write', async () => {
    // A private window that refuses storage outright throws on `getItem`, and
    // the store then never attempts a write at all — it does not overwrite a
    // list it could not read. Reporting only refused writes left exactly the
    // user the "storage blocked" message is for hearing nothing.
    resetStorageHealthForTest();
    const heard = vi.fn();
    const stop = subscribeStorageFailure(heard);
    const s = make();
    const restore = refuseWrites(true);
    s.getIds(1000);
    restore();
    await Promise.resolve(); // delivery is deferred off the read (storageHealth)
    stop();

    expect(heard).toHaveBeenCalledWith('denied');
  });

  it('reports a refused write so the user can be told', async () => {
    // The change is held and replayed, so nothing is lost while the tab is
    // open — but it will not survive a reload, and that is the user's to know
    // (StorageFailureWatcher turns this into a toast).
    resetStorageHealthForTest();
    const heard = vi.fn();
    const stop = subscribeStorageFailure(heard);
    const s = make();
    const restore = refuseWrites();
    s.addId(1, 1000);
    restore();
    await Promise.resolve();
    stop();

    expect(heard).toHaveBeenCalledWith('quota');
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
