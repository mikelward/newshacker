import { describe, expect, it } from 'vitest';
import { hasSelfPostBody } from './selfPostBody';

describe('hasSelfPostBody', () => {
  it('returns false for undefined / empty', () => {
    expect(hasSelfPostBody(undefined)).toBe(false);
    expect(hasSelfPostBody('')).toBe(false);
  });

  it('returns false for bodies that strip down to whitespace', () => {
    // These all mirror the server-side no_article cases.
    expect(hasSelfPostBody('<p> </p>')).toBe(false);
    expect(hasSelfPostBody('<p>   </p>')).toBe(false);
    expect(hasSelfPostBody('   ')).toBe(false);
    expect(hasSelfPostBody('&nbsp;&nbsp;')).toBe(false);
    expect(hasSelfPostBody('<p>&nbsp;</p>')).toBe(false);
  });

  it('returns true for bodies with any visible text', () => {
    expect(hasSelfPostBody('<p>Hello.</p>')).toBe(true);
    expect(hasSelfPostBody('Plain body')).toBe(true);
    // Entity-only non-whitespace characters still count — the server
    // would successfully summarize these.
    expect(hasSelfPostBody('<p>a&nbsp;b</p>')).toBe(true);
  });
});
