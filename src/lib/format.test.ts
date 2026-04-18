import { describe, it, expect } from 'vitest';
import { extractDomain, formatTimeAgo, pluralize } from './format';

describe('extractDomain', () => {
  it('returns hostname without www', () => {
    expect(extractDomain('https://www.example.com/path')).toBe('example.com');
  });

  it('handles subdomains', () => {
    expect(extractDomain('https://blog.example.com/foo')).toBe('blog.example.com');
  });

  it('returns empty string for missing or invalid url', () => {
    expect(extractDomain(undefined)).toBe('');
    expect(extractDomain('not a url')).toBe('');
  });
});

describe('formatTimeAgo', () => {
  const now = new Date('2026-04-18T12:00:00Z');
  const nowS = Math.floor(now.getTime() / 1000);

  it('returns "just now" for < 1 minute', () => {
    expect(formatTimeAgo(nowS - 30, now)).toBe('just now');
  });

  it('returns minutes for < 1 hour', () => {
    expect(formatTimeAgo(nowS - 60 * 5, now)).toBe('5m');
  });

  it('returns hours for < 1 day', () => {
    expect(formatTimeAgo(nowS - 60 * 60 * 3, now)).toBe('3h');
  });

  it('returns days for < ~1 month', () => {
    expect(formatTimeAgo(nowS - 60 * 60 * 24 * 4, now)).toBe('4d');
  });

  it('returns months', () => {
    expect(formatTimeAgo(nowS - 60 * 60 * 24 * 60, now)).toBe('2mo');
  });

  it('returns years', () => {
    expect(formatTimeAgo(nowS - 60 * 60 * 24 * 400, now)).toBe('1y');
  });

  it('clamps future times to "just now"', () => {
    expect(formatTimeAgo(nowS + 60, now)).toBe('just now');
  });
});

describe('pluralize', () => {
  it('returns singular for 1', () => {
    expect(pluralize(1, 'point')).toBe('point');
  });
  it('returns plural form otherwise', () => {
    expect(pluralize(0, 'point')).toBe('points');
    expect(pluralize(2, 'point')).toBe('points');
  });
});
