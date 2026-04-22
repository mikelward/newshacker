// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  parseCookieHeader,
  usernameFromSessionValue,
} from './session';

describe('parseCookieHeader', () => {
  it('returns an empty map for null/undefined/empty input', () => {
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  it('URL-decodes values', () => {
    expect(parseCookieHeader('hn_session=alice%26hash')).toEqual({
      hn_session: 'alice&hash',
    });
  });

  it('parses multi-cookie headers', () => {
    const cookies = parseCookieHeader('a=1; b=2; hn_session=alice%26hash');
    expect(cookies).toEqual({ a: '1', b: '2', hn_session: 'alice&hash' });
  });

  it('skips malformed entries without a name or `=`', () => {
    expect(parseCookieHeader('=value; noequals; a=1')).toEqual({ a: '1' });
  });
});

describe('usernameFromSessionValue', () => {
  it('returns the username portion before `&`', () => {
    expect(usernameFromSessionValue('alice&hash')).toBe('alice');
  });

  it('returns null for empty, missing, or invalid usernames', () => {
    expect(usernameFromSessionValue('')).toBeNull();
    expect(usernameFromSessionValue(undefined)).toBeNull();
    expect(usernameFromSessionValue(null)).toBeNull();
    expect(usernameFromSessionValue('a&x')).toBeNull(); // too short
    expect(usernameFromSessionValue('bad name&x')).toBeNull(); // space
  });

  it('accepts a bare username with no `&` separator', () => {
    expect(usernameFromSessionValue('alice')).toBe('alice');
  });
});
