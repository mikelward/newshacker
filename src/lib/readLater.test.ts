import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_READ_LATER,
  READ_LATER_OPTIONS,
  READ_LATER_STORAGE_KEY,
  readLaterStore,
  readLaterTarget,
} from './readLater';

describe('readLaterTarget', () => {
  it('returns null when the pref is None', () => {
    expect(readLaterTarget('none', 'https://example.com/x', 'T')).toBeNull();
  });

  it('builds the Instapaper target with an encoded url and title', () => {
    const target = readLaterTarget(
      'instapaper',
      'https://example.com/a b?x=1&y=2',
      'Hello & Goodbye',
    );
    expect(target).toEqual({
      service: 'instapaper',
      label: 'Save to Instapaper',
      href:
        'https://www.instapaper.com/hello2' +
        '?url=https%3A%2F%2Fexample.com%2Fa%20b%3Fx%3D1%26y%3D2' +
        '&title=Hello%20%26%20Goodbye',
    });
  });

  it('omits the Instapaper title param when there is no title', () => {
    expect(readLaterTarget('instapaper', 'https://example.com/x')?.href).toBe(
      'https://www.instapaper.com/hello2?url=https%3A%2F%2Fexample.com%2Fx',
    );
  });

  it('trims a whitespace-only title to nothing (no title param)', () => {
    expect(
      readLaterTarget('instapaper', 'https://example.com/x', '   ')?.href,
    ).toBe('https://www.instapaper.com/hello2?url=https%3A%2F%2Fexample.com%2Fx');
  });

  it('builds the Readwise Reader target (no title param)', () => {
    const target = readLaterTarget('readwise', 'https://example.com/x', 'Some');
    expect(target).toEqual({
      service: 'readwise',
      label: 'Save to Readwise Reader',
      href: 'https://wise.readwise.io/save?url=https%3A%2F%2Fexample.com%2Fx',
    });
  });

  it('builds the Raindrop target (app.raindrop.io/add save dialog, with title)', () => {
    const target = readLaterTarget('raindrop', 'https://example.com/x', 'Hi');
    expect(target).toEqual({
      service: 'raindrop',
      label: 'Save to Raindrop',
      href: 'https://app.raindrop.io/add?link=https%3A%2F%2Fexample.com%2Fx&title=Hi',
    });
  });

  it('omits the Raindrop title param when there is no title', () => {
    expect(readLaterTarget('raindrop', 'https://example.com/x')?.href).toBe(
      'https://app.raindrop.io/add?link=https%3A%2F%2Fexample.com%2Fx',
    );
  });

  it('allows plain http URLs too', () => {
    expect(
      readLaterTarget('instapaper', 'http://example.com/x')?.href,
    ).toContain('url=http%3A%2F%2Fexample.com%2Fx');
  });

  it('returns null for a non-http(s) URL even when a service is selected', () => {
    for (const bad of [
      'javascript:alert(1)',
      'mailto:a@b.com',
      '/relative/path',
      'not a url',
    ]) {
      expect(readLaterTarget('instapaper', bad, 'T')).toBeNull();
    }
  });

  it('returns null for a missing URL', () => {
    for (const empty of [null, undefined, '']) {
      expect(readLaterTarget('readwise', empty, 'T')).toBeNull();
    }
  });
});

describe('READ_LATER_OPTIONS', () => {
  it('lists None first, then each service by bare name', () => {
    expect(READ_LATER_OPTIONS).toEqual([
      { value: 'none', label: 'None' },
      { value: 'instapaper', label: 'Instapaper' },
      { value: 'readwise', label: 'Readwise Reader' },
      { value: 'raindrop', label: 'Raindrop' },
    ]);
  });
});

describe('readLaterStore', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('defaults to None', () => {
    expect(readLaterStore.get()).toBe(DEFAULT_READ_LATER);
    expect(DEFAULT_READ_LATER).toBe('none');
  });

  it('persists a chosen service and clears the key when set back to None', () => {
    readLaterStore.set('readwise');
    expect(window.localStorage.getItem(READ_LATER_STORAGE_KEY)).toBe('readwise');
    expect(readLaterStore.get()).toBe('readwise');

    readLaterStore.set('none');
    // clearOnDefault removes the key so the baseline (None) represents it.
    expect(window.localStorage.getItem(READ_LATER_STORAGE_KEY)).toBeNull();
    expect(readLaterStore.get()).toBe('none');
  });

  it('falls back to None on a corrupt stored value', () => {
    window.localStorage.setItem(READ_LATER_STORAGE_KEY, 'pocket');
    expect(readLaterStore.get()).toBe('none');
  });
});
