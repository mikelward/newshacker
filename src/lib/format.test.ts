// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  extractDomain,
  formatDisplayDomain,
  formatCommentVelocity,
  formatStoryMetaTail,
  formatTimeAgo,
  formatVelocity,
  isHotStory,
  isSafeHttpUrl,
  pluralize,
} from './format';

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

describe('isSafeHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isSafeHttpUrl('http://example.com/x')).toBe(true);
    expect(isSafeHttpUrl('https://example.com/x')).toBe(true);
  });

  it('rejects javascript: and data: schemes', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(
      false,
    );
    expect(isSafeHttpUrl('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects missing, relative, or malformed urls', () => {
    expect(isSafeHttpUrl(undefined)).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl('/relative/path')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
});

describe('formatDisplayDomain', () => {
  it('returns empty string for missing or invalid url', () => {
    expect(formatDisplayDomain(undefined)).toBe('');
    expect(formatDisplayDomain('not a url')).toBe('');
  });

  it('strips leading www.', () => {
    expect(formatDisplayDomain('https://www.example.com/path')).toBe(
      'example.com',
    );
  });

  it('always trims leading subdomains to the registrable domain', () => {
    expect(formatDisplayDomain('https://blog.example.com/x')).toBe(
      'example.com',
    );
    expect(formatDisplayDomain('https://sport.bbc.co.uk/x')).toBe(
      'bbc.co.uk',
    );
  });

  it('drops leading subdomains on long hostnames', () => {
    expect(
      formatDisplayDomain('https://fingfx.thomsonreuters.com/foo'),
    ).toBe('thomsonreuters.com');
  });

  it('preserves nested ccTLDs when trimming subdomains', () => {
    expect(
      formatDisplayDomain('https://news.entertainment.9news.com.au/x'),
    ).toBe('9news.com.au');
    expect(formatDisplayDomain('https://a.b.asahi.co.jp/x')).toBe(
      'asahi.co.jp',
    );
  });

  it('does not trim a nested-ccTLD hostname that is already minimal', () => {
    expect(formatDisplayDomain('https://9news.com.au/story')).toBe(
      '9news.com.au',
    );
  });

  it('preserves user subdomains on compound effective TLDs like github.io', () => {
    // jasoneckert.github.io is the owner — trimming to github.io would
    // lose the author identity, so it must stay intact.
    expect(
      formatDisplayDomain('https://jasoneckert.github.io/project'),
    ).toBe('jasoneckert.github.io');
  });

  it('ellipsizes when the registrable domain is itself too long', () => {
    const long = 'https://some-really-long-publishing-company.com/x';
    const out = formatDisplayDomain(long, 22);
    expect(out.length).toBeLessThanOrEqual(22);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('some-really-long-publ')).toBe(true);
  });

  it('ellipsizes the registrable domain itself when it exceeds maxLength', () => {
    expect(formatDisplayDomain('https://blog.example.com/x', 5)).toBe(
      'exam…',
    );
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

describe('formatStoryMetaTail', () => {
  const now = new Date('2026-04-18T12:00:00Z');
  const nowS = Math.floor(now.getTime() / 1000);

  it('formats age, points, and comments joined by " · "', () => {
    expect(
      formatStoryMetaTail(
        { time: nowS - 60 * 60 * 3, score: 42, descendants: 7 },
        now,
      ),
    ).toBe('3h · 42 points · 7 comments');
  });

  it('uses singular forms for 1 point and 1 comment', () => {
    expect(
      formatStoryMetaTail({ time: nowS - 60, score: 1, descendants: 1 }, now),
    ).toBe('1m · 1 point · 1 comment');
  });

  it('treats missing score and descendants as 0', () => {
    expect(
      formatStoryMetaTail({ time: nowS - 60 * 60 * 24 }, now),
    ).toBe('1d · 0 points · 0 comments');
  });

  it('omits the age segment when time is missing', () => {
    expect(formatStoryMetaTail({ score: 5, descendants: 2 }, now)).toBe(
      '5 points · 2 comments',
    );
  });

  it('formats the comments segment as "n/m comments" when newCommentCount is > 0', () => {
    expect(
      formatStoryMetaTail(
        { time: nowS - 60 * 60, score: 10, descendants: 8, newCommentCount: 3 },
        now,
      ),
    ).toBe('1h · 10 points · 3/8 comments');
  });

  it('pluralizes the n/m comments segment based on the total count', () => {
    expect(
      formatStoryMetaTail(
        { time: nowS - 60 * 60, score: 10, descendants: 1, newCommentCount: 1 },
        now,
      ),
    ).toBe('1h · 10 points · 1/1 comment');
  });

  it('falls back to the plain comments segment when newCommentCount is 0 or missing', () => {
    expect(
      formatStoryMetaTail(
        { time: nowS - 60 * 60, score: 10, descendants: 8, newCommentCount: 0 },
        now,
      ),
    ).toBe('1h · 10 points · 8 comments');
    expect(
      formatStoryMetaTail(
        { time: nowS - 60 * 60, score: 10, descendants: 8 },
        now,
      ),
    ).toBe('1h · 10 points · 8 comments');
  });

  it('attaches the velocity to the points segment AND comment velocity to the comments segment when showVelocity is set', () => {
    // Inline parentheticals, not separate dot-segments, to keep the
    // meta line short on narrow phones. 50 points / 2 h → 25/h;
    // 10 comments / 2 h → 5/h.
    expect(
      formatStoryMetaTail(
        { time: nowS - 60 * 60 * 2, score: 50, descendants: 10 },
        now,
        { showVelocity: true },
      ),
    ).toBe('2h · 50 points (25/h) · 10 comments (5/h)');
  });

  it('omits the comment-velocity suffix when descendants is 0', () => {
    // No comments → no `(0/h)` noise on the comments segment.
    // Points-velocity still renders.
    expect(
      formatStoryMetaTail(
        { time: nowS - 60 * 60 * 2, score: 50, descendants: 0 },
        now,
        { showVelocity: true },
      ),
    ).toBe('2h · 50 points (25/h) · 0 comments');
  });

  it('omits the velocity segment when showVelocity is false (default)', () => {
    expect(
      formatStoryMetaTail(
        { time: nowS - 60 * 60 * 2, score: 50, descendants: 10 },
        now,
      ),
    ).toBe('2h · 50 points · 10 comments');
  });

  it('omits the velocity segment when age is sub-minute (no signal yet)', () => {
    expect(
      formatStoryMetaTail(
        { time: nowS - 30, score: 50, descendants: 10 },
        now,
        { showVelocity: true },
      ),
    ).toBe('just now · 50 points · 10 comments');
  });
});

describe('formatCommentVelocity', () => {
  const now = new Date('2026-04-18T12:00:00Z');
  const nowS = Math.floor(now.getTime() / 1000);

  it('returns null when descendants is missing or zero', () => {
    expect(formatCommentVelocity({ time: nowS - 3600 }, now)).toBeNull();
    expect(
      formatCommentVelocity({ time: nowS - 3600, descendants: 0 }, now),
    ).toBeNull();
  });

  it('returns null when age is sub-minute', () => {
    expect(
      formatCommentVelocity({ time: nowS - 30, descendants: 50 }, now),
    ).toBeNull();
  });

  it('rounds to integer comments-per-hour', () => {
    // 20 comments at 4 h → 5/h.
    expect(
      formatCommentVelocity({ time: nowS - 4 * 3600, descendants: 20 }, now),
    ).toBe('5/h');
    // 100 comments at 30 min → 200/h.
    expect(
      formatCommentVelocity({ time: nowS - 1800, descendants: 100 }, now),
    ).toBe('200/h');
  });
});

describe('formatVelocity', () => {
  const now = new Date('2026-04-18T12:00:00Z');
  const nowS = Math.floor(now.getTime() / 1000);

  it('returns null when time is missing', () => {
    expect(formatVelocity({ score: 100 }, now)).toBeNull();
  });

  it('returns null when score is missing or zero', () => {
    expect(formatVelocity({ time: nowS - 3600 }, now)).toBeNull();
    expect(formatVelocity({ time: nowS - 3600, score: 0 }, now)).toBeNull();
  });

  it('returns null when age is sub-minute', () => {
    expect(formatVelocity({ time: nowS - 30, score: 50 }, now)).toBeNull();
  });

  it('rounds to integer points-per-hour for steady stories', () => {
    // 50 points at 2 h → 25/h.
    expect(formatVelocity({ time: nowS - 7200, score: 50 }, now)).toBe('25/h');
    // 4 points at 30 min → 8/h (rounded from 8.0).
    expect(formatVelocity({ time: nowS - 1800, score: 4 }, now)).toBe('8/h');
    // 100 points at 5 h → 20/h.
    expect(formatVelocity({ time: nowS - 5 * 3600, score: 100 }, now)).toBe(
      '20/h',
    );
  });
});

describe('isHotStory', () => {
  const now = new Date('2026-04-18T12:00:00Z');
  const nowS = Math.floor(now.getTime() / 1000);

  it('is hot for fast risers: velocity >= 15/h and descendants >= 10', () => {
    // 50 points in 1h = 50/h velocity, with 25 comments.
    expect(
      isHotStory(
        { score: 50, descendants: 25, time: nowS - 60 * 60 },
        now,
      ),
    ).toBe(true);
    // 100 points in 4h = 25/h velocity, with 30 comments — slower
    // climb but still over the velocity floor.
    expect(
      isHotStory(
        { score: 100, descendants: 30, time: nowS - 60 * 60 * 4 },
        now,
      ),
    ).toBe(true);
    // Boundary: 30 points in 2h = exactly 15/h, descendants exactly
    // 10 — `>=` matches this row.
    expect(
      isHotStory(
        { score: 30, descendants: 10, time: nowS - 60 * 60 * 2 },
        now,
      ),
    ).toBe(true);
  });

  it('is hot for big stories: score >= 200 and descendants >= 100, regardless of age', () => {
    // Score and comment thresholds met — the velocity may have cooled
    // but the total engagement still stands out.
    expect(
      isHotStory(
        { score: 250, descendants: 150, time: nowS - 60 * 60 * 20 },
        now,
      ),
    ).toBe(true);
    // No `time` at all — the big-story branch doesn't need it.
    expect(isHotStory({ score: 500, descendants: 300 }, now)).toBe(true);
    // Boundary: score exactly 200, descendants exactly 100 — `>=`
    // matches this row even with cooled velocity (200 / 20 h = 10/h).
    expect(
      isHotStory(
        { score: 200, descendants: 100, time: nowS - 60 * 60 * 20 },
        now,
      ),
    ).toBe(true);
  });

  it('is not hot when velocity is below 15/h and the big-story branch misses', () => {
    // 28 points in 2h = 14/h — under the velocity floor.
    expect(
      isHotStory(
        { score: 28, descendants: 20, time: nowS - 60 * 60 * 2 },
        now,
      ),
    ).toBe(false);
    // 199 points in 20h = ~10/h, descendants 80: velocity below the
    // floor and the big-story branch wants score >= 200 AND
    // descendants >= 100, neither met.
    expect(
      isHotStory(
        { score: 199, descendants: 80, time: nowS - 60 * 60 * 20 },
        now,
      ),
    ).toBe(false);
  });

  it('is not hot when descendants is below 10, even at very high velocity', () => {
    // The descendants gate keeps score-spike submits with little
    // discussion from lighting up as hot.
    expect(
      isHotStory(
        { score: 100, descendants: 9, time: nowS - 60 * 60 },
        now,
      ),
    ).toBe(false);
    expect(
      isHotStory({ score: 100, time: nowS - 60 * 60 }, now),
    ).toBe(false);
  });

  it('big-story branch needs both gates met', () => {
    // Score == 250 but descendants == 99: fails the big-story branch
    // (descendants gate). The velocity branch's descendants gate is
    // satisfied (99 >= 10), but the velocity (250 / 20 h = 12.5/h) is
    // under the 15/h floor.
    expect(
      isHotStory(
        { score: 250, descendants: 99, time: nowS - 60 * 60 * 20 },
        now,
      ),
    ).toBe(false);
    // Descendants == 150 but score == 199: fails the big-story branch
    // (score gate). Velocity 199 / 20 h ≈ 10/h, under the 15/h floor.
    expect(
      isHotStory(
        { score: 199, descendants: 150, time: nowS - 60 * 60 * 20 },
        now,
      ),
    ).toBe(false);
  });

  it('treats missing score as 0', () => {
    expect(
      isHotStory({ descendants: 50, time: nowS - 60 }, now),
    ).toBe(false);
  });

  it('is not hot when time is missing and the big-story branch misses', () => {
    expect(isHotStory({ score: 150, descendants: 80 }, now)).toBe(false);
  });

  it('is not hot when time is in the future and the big-story branch misses', () => {
    expect(
      isHotStory(
        { score: 100, descendants: 50, time: nowS + 60 },
        now,
      ),
    ).toBe(false);
  });
});
