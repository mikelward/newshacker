import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersistentValue } from './persistentValue';

const KEY = 'newshacker:test:pref';
const EVENT = 'newshacker:test:prefChanged';
type Pref = 'a' | 'b' | 'c';

function make(overrides = {}) {
  return createPersistentValue<Pref>({
    storageKey: KEY,
    changeEvent: EVENT,
    defaultValue: 'a',
    parse: (raw) => (['a', 'b', 'c'].includes(raw) ? (raw as Pref) : undefined),
    detailKey: 'value',
    ...overrides,
  });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('createPersistentValue', () => {
  it('returns the default when unset, corrupt, or invalid', () => {
    const s = make();
    expect(s.get()).toBe('a'); // unset
    window.localStorage.setItem(KEY, 'zzz'); // invalid
    expect(s.get()).toBe('a');
  });

  it('round-trips a non-default value', () => {
    const s = make();
    s.set('b');
    expect(window.localStorage.getItem(KEY)).toBe('b');
    expect(s.get()).toBe('b');
  });

  it('clears the key when the value is the default (clearOnDefault)', () => {
    const s = make();
    s.set('b');
    s.set('a'); // back to default → key removed, not written
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(s.get()).toBe('a');
  });

  it('persists the default when clearOnDefault is false', () => {
    const s = make({ clearOnDefault: false });
    s.set('a');
    expect(window.localStorage.getItem(KEY)).toBe('a');
  });

  it('fires the change event carrying the value under detailKey', () => {
    const s = make({ detailKey: 'mode' });
    const seen: unknown[] = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(EVENT, handler);
    s.set('c');
    expect(seen).toEqual([{ mode: 'c' }]);
    window.removeEventListener(EVENT, handler);
  });

  it('runs onApply on set and again on cross-tab sync (idempotent)', () => {
    const onApply = vi.fn();
    const s = make({ onApply });
    s.set('b'); // applied once on set
    expect(onApply).toHaveBeenLastCalledWith('b');

    const unsub = s.subscribe(() => {});
    onApply.mockClear();
    // Simulate another tab's write + storage event: subscribe handler re-applies.
    window.localStorage.setItem(KEY, 'c');
    window.dispatchEvent(new StorageEvent('storage'));
    expect(onApply).toHaveBeenCalledWith('c');
    unsub();
  });

  it('subscribe notifies on the change event and stops after unsubscribe', () => {
    const s = make();
    const onChange = vi.fn();
    const unsub = s.subscribe(onChange);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { value: 'b' } }));
    expect(onChange).toHaveBeenCalledTimes(1);
    unsub();
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { value: 'c' } }));
    expect(onChange).toHaveBeenCalledTimes(1); // no more after unsubscribe
  });

  it('uses serialize when provided', () => {
    const s = createPersistentValue<{ n: number }>({
      storageKey: KEY,
      changeEvent: EVENT,
      defaultValue: { n: 0 },
      parse: (raw) => {
        try {
          return JSON.parse(raw) as { n: number };
        } catch {
          return undefined;
        }
      },
      serialize: (v) => JSON.stringify(v),
      clearOnDefault: false,
      detailKey: 'value',
    });
    s.set({ n: 5 });
    expect(window.localStorage.getItem(KEY)).toBe('{"n":5}');
    expect(s.get()).toEqual({ n: 5 });
  });
});
