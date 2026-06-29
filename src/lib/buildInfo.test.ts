import { describe, it, expect } from 'vitest';
import { summarizeBuildAge } from './buildInfo';

describe('summarizeBuildAge', () => {
  const now = new Date('2026-01-08T00:00:00.000Z');

  it('summarizes the build age relative to now', () => {
    expect(summarizeBuildAge('2026-01-01T00:00:00.000Z', now)).toBe(
      'Built 7d ago',
    );
  });

  it('clamps a future commit time to "just now"', () => {
    expect(summarizeBuildAge('2026-02-01T00:00:00.000Z', now)).toBe(
      'Built just now ago',
    );
  });

  it('falls back when the commit time is empty', () => {
    expect(summarizeBuildAge('', now)).toBe('Build info unavailable');
  });

  it('falls back when the commit time is unparseable', () => {
    expect(summarizeBuildAge('not-a-date', now)).toBe('Build info unavailable');
  });
});
