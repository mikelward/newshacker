// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { feedEndpoint, feedLabel, isFeed, FEEDS } from './feeds';

describe('feeds', () => {
  it('isFeed narrows known values and rejects unknown', () => {
    expect(isFeed('top')).toBe(true);
    expect(isFeed('nonsense')).toBe(false);
  });

  it('maps each feed to an endpoint path', () => {
    for (const f of FEEDS) {
      expect(feedEndpoint(f)).toMatch(/stories$/);
    }
  });

  it('has a human label for each feed', () => {
    for (const f of FEEDS) {
      expect(feedLabel(f)).toMatch(/^[A-Z]/);
    }
  });
});
