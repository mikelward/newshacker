import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AVATAR_PREFS_CHANGE_EVENT,
  AVATAR_PREFS_STORAGE_KEY,
  DEFAULT_AVATAR_PREFS,
  avatarImageUrl,
  clearStoredAvatarPrefs,
  getStoredAvatarPrefs,
  gravatarHashFromEmail,
  isValidGithubUsername,
  isValidGravatarEmail,
  setStoredAvatarPrefs,
} from './avatarPrefs';

describe('isValidGithubUsername', () => {
  it.each([
    'alice',
    'Alice',
    'al1ce',
    'a',
    'a-b',
    'some-one-else',
    'abcdefghijabcdefghijabcdefghijabcdefghi', // 39 chars
  ])('accepts %s', (name) => {
    expect(isValidGithubUsername(name)).toBe(true);
  });

  it.each([
    '',
    '-alice',
    'alice-',
    'al--ice',
    'has_underscore',
    'has space',
    'has.dot',
    'abcdefghijabcdefghijabcdefghijabcdefghij', // 40 chars
  ])('rejects %s', (name) => {
    expect(isValidGithubUsername(name)).toBe(false);
  });
});

describe('isValidGravatarEmail', () => {
  it('accepts a typical email', () => {
    expect(isValidGravatarEmail('alice@example.com')).toBe(true);
  });

  it('rejects obvious garbage', () => {
    expect(isValidGravatarEmail('')).toBe(false);
    expect(isValidGravatarEmail('alice')).toBe(false);
    expect(isValidGravatarEmail('alice@')).toBe(false);
    expect(isValidGravatarEmail('@example.com')).toBe(false);
    expect(isValidGravatarEmail('alice@example')).toBe(false);
    expect(isValidGravatarEmail('a b@example.com')).toBe(false);
  });

  it('rejects emails longer than RFC 5321 limit', () => {
    const tooLong = 'a'.repeat(250) + '@e.co';
    expect(tooLong.length).toBeGreaterThan(254);
    expect(isValidGravatarEmail(tooLong)).toBe(false);
  });
});

describe('avatar prefs storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns defaults when nothing is stored', () => {
    expect(getStoredAvatarPrefs()).toEqual(DEFAULT_AVATAR_PREFS);
  });

  it('saves and loads a github override', () => {
    setStoredAvatarPrefs({ source: 'github', githubUsername: 'alice-real' });
    expect(getStoredAvatarPrefs()).toEqual({
      source: 'github',
      githubUsername: 'alice-real',
    });
  });

  it('saves and loads a gravatar prefs with hash', () => {
    setStoredAvatarPrefs({
      source: 'gravatar',
      gravatarEmail: 'alice@example.com',
      gravatarHash: 'a'.repeat(64),
    });
    expect(getStoredAvatarPrefs()).toEqual({
      source: 'gravatar',
      gravatarEmail: 'alice@example.com',
      gravatarHash: 'a'.repeat(64),
    });
  });

  it('drops invalid optional fields on load', () => {
    window.localStorage.setItem(
      AVATAR_PREFS_STORAGE_KEY,
      JSON.stringify({
        source: 'github',
        githubUsername: 'has space',
        gravatarEmail: 'not-an-email',
        gravatarHash: 'nothex',
      }),
    );
    expect(getStoredAvatarPrefs()).toEqual({ source: 'github' });
  });

  it('falls back to defaults when JSON is malformed', () => {
    window.localStorage.setItem(AVATAR_PREFS_STORAGE_KEY, '{not json');
    expect(getStoredAvatarPrefs()).toEqual(DEFAULT_AVATAR_PREFS);
  });

  it('falls back to defaults when shape is wrong', () => {
    window.localStorage.setItem(AVATAR_PREFS_STORAGE_KEY, '42');
    expect(getStoredAvatarPrefs()).toEqual(DEFAULT_AVATAR_PREFS);
  });

  it('coerces an unknown source to the default', () => {
    window.localStorage.setItem(
      AVATAR_PREFS_STORAGE_KEY,
      JSON.stringify({ source: 'linkedin' }),
    );
    expect(getStoredAvatarPrefs()).toEqual({ source: 'github' });
  });

  it('dispatches a change event on save', () => {
    const listener = vi.fn();
    window.addEventListener(AVATAR_PREFS_CHANGE_EVENT, listener);
    setStoredAvatarPrefs({ source: 'none' });
    window.removeEventListener(AVATAR_PREFS_CHANGE_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clears prefs and dispatches an event', () => {
    setStoredAvatarPrefs({ source: 'none' });
    const listener = vi.fn();
    window.addEventListener(AVATAR_PREFS_CHANGE_EVENT, listener);
    clearStoredAvatarPrefs();
    window.removeEventListener(AVATAR_PREFS_CHANGE_EVENT, listener);
    expect(getStoredAvatarPrefs()).toEqual(DEFAULT_AVATAR_PREFS);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('avatarImageUrl', () => {
  it('returns null for source = none', () => {
    expect(avatarImageUrl({ source: 'none' }, 'alice')).toBeNull();
  });

  it('builds a github URL from the HN username by default', () => {
    expect(avatarImageUrl({ source: 'github' }, 'alice')).toBe(
      'https://github.com/alice.png?size=64',
    );
  });

  it('prefers an explicit github override over the HN username', () => {
    expect(
      avatarImageUrl(
        { source: 'github', githubUsername: 'alice-real' },
        'alice',
      ),
    ).toBe('https://github.com/alice-real.png?size=64');
  });

  it('returns null when the HN username is not a valid github handle and no override exists', () => {
    expect(avatarImageUrl({ source: 'github' }, 'has_underscore')).toBeNull();
  });

  it('returns null when logged out and no override is set', () => {
    expect(avatarImageUrl({ source: 'github' }, null)).toBeNull();
  });

  it('builds a gravatar URL from a hash', () => {
    const hash = 'a'.repeat(64);
    expect(
      avatarImageUrl({ source: 'gravatar', gravatarHash: hash }, 'alice'),
    ).toBe(`https://gravatar.com/avatar/${hash}?s=64&d=404`);
  });

  it('returns null for gravatar without a hash', () => {
    expect(avatarImageUrl({ source: 'gravatar' }, 'alice')).toBeNull();
  });

  it('respects a custom size', () => {
    expect(avatarImageUrl({ source: 'github' }, 'alice', 128)).toBe(
      'https://github.com/alice.png?size=128',
    );
  });
});

describe('gravatarHashFromEmail', () => {
  it('produces a 64-char lowercase hex string', async () => {
    const hash = await gravatarHashFromEmail('alice@example.com');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('normalizes case and surrounding whitespace', async () => {
    const a = await gravatarHashFromEmail('Alice@Example.com');
    const b = await gravatarHashFromEmail('  alice@example.com  ');
    expect(a).toBe(b);
  });

  it('produces different hashes for different emails', async () => {
    const a = await gravatarHashFromEmail('alice@example.com');
    const b = await gravatarHashFromEmail('bob@example.com');
    expect(a).not.toBe(b);
  });
});
