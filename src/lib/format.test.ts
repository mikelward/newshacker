// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  extractDomain,
  formatDisplayDomain,
  formatStoryMetaTail,
  formatTimeAgo,
  isHotStory,
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
});

describe('isHotStory', () => {
  const now = new Date('2026-04-18T12:00:00Z');
  const nowS = Math.floor(now.getTime() / 1000);

  it('is hot when the score is >= 100 regardless of age', () => {
    expect(isHotStory({ score: 100, time: nowS - 60 * 60 * 12 }, now)).toBe(true);
    expect(isHotStory({ score: 412, time: nowS - 60 * 60 * 20 }, now)).toBe(true);
  });

  it('is hot for fast risers: score >= 40 and age < 2h', () => {
    expect(isHotStory({ score: 40, time: nowS - 60 * 30 }, now)).toBe(true);
    expect(isHotStory({ score: 85, time: nowS - 60 * 60 }, now)).toBe(true);
  });

  it('is not hot for moderate scores once the 2h window has passed', () => {
    expect(isHotStory({ score: 85, time: nowS - 60 * 60 * 3 }, now)).toBe(false);
    expect(isHotStory({ score: 40, time: nowS - 60 * 60 * 2 }, now)).toBe(false);
  });

  it('is not hot for low scores even when very recent', () => {
    expect(isHotStory({ score: 39, time: nowS - 60 }, now)).toBe(false);
    expect(isHotStory({ score: 5, time: nowS - 10 }, now)).toBe(false);
  });

  it('treats missing score as 0', () => {
    expect(isHotStory({ time: nowS - 60 }, now)).toBe(false);
  });

  it('is not hot when the time is missing and the score is under the any-age threshold', () => {
    expect(isHotStory({ score: 80 }, now)).toBe(false);
  });

  it('still flags score >= 100 even without a time', () => {
    expect(isHotStory({ score: 150 }, now)).toBe(true);
  });
});
