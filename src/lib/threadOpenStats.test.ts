// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetThreadOpenStatsForTests,
  claimBootOpen,
  getThreadOpenRecords,
  noteThreadOpen,
} from './threadOpenStats';

describe('threadOpenStats', () => {
  beforeEach(() => {
    _resetThreadOpenStatsForTests();
  });

  it('records opens newest first', () => {
    noteThreadOpen({ id: 1, waitedMs: 10, rootCached: true });
    noteThreadOpen({ id: 2, waitedMs: 1840, rootCached: false });
    expect(getThreadOpenRecords().map((r) => r.id)).toEqual([2, 1]);
  });

  it('keeps only the five most recent opens', () => {
    for (let i = 1; i <= 7; i++) {
      noteThreadOpen({ id: i, waitedMs: i, rootCached: false });
    }
    expect(getThreadOpenRecords().map((r) => r.id)).toEqual([7, 6, 5, 4, 3]);
  });

  it('grants the boot-open claim once, and only for the initial route thread', () => {
    _resetThreadOpenStatsForTests(42);
    // Another thread never claims it, and doesn't consume it either.
    expect(claimBootOpen(7)).toBe(false);
    expect(claimBootOpen(42)).toBe(true);
    // Single-use: a later in-app return to the same story isn't a boot.
    expect(claimBootOpen(42)).toBe(false);
  });

  it('never grants the boot-open claim when the page did not load on a thread', () => {
    _resetThreadOpenStatsForTests(null);
    expect(claimBootOpen(1)).toBe(false);
  });
});
