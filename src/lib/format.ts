export function extractDomain(url: string | undefined): string {
  if (!url) return '';
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// HN's Firebase API echoes whatever URL the submitter posted. In the
// very unlikely case that a non-http(s) scheme leaks through
// (`javascript:`, `data:`, `vbscript:`…), inlining that URL into an
// `href` would let a tap execute script on our origin. Narrow the
// allowlist to `http:` and `https:` and render the title / Read-article
// link as plain text otherwise. Relative and malformed URLs throw from
// `new URL(url)` and are rejected by the catch.
export function isSafeHttpUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// Common second-level labels that sit under a 2-letter ccTLD and behave
// like a TLD for registration purposes (`bbc.co.uk`, `9news.com.au`,
// `stuff.co.nz`, `asahi.co.jp`, `naver.or.kr`…). Not a full Public Suffix
// List — we'd rather ship no data file than drag one into the bundle —
// but it covers the long tail of mainstream news domains well enough
// that we don't accidentally trim `9news.com.au` down to `9news`.
const NESTED_CCTLD_SECOND_LEVELS = new Set([
  'co',
  'com',
  'net',
  'org',
  'gov',
  'edu',
  'ac',
  'or',
  'ne',
  'mil',
  'gob',
]);

// Two-label suffixes where each subdomain is a separate user/project —
// Public Suffix List "private" entries. Trimming `jasoneckert.github.io`
// to `github.io` would throw away the owner, so we keep the first label.
// Hand-picked from the most common hosts seen on HN; not the full PSL
// (that would be ~15KB of data for a cosmetic feature).
const COMPOUND_EFFECTIVE_TLDS = new Set([
  'github.io',
  'gitlab.io',
  'substack.com',
  'wordpress.com',
  'blogspot.com',
  'tumblr.com',
  'herokuapp.com',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'r2.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'cloudfront.net',
  'medium.com',
]);

function registrablePartCount(parts: string[]): number {
  if (parts.length < 2) return parts.length;
  if (parts.length >= 3) {
    const last2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (COMPOUND_EFFECTIVE_TLDS.has(last2)) return 3;
  }
  if (parts.length < 3) return parts.length;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && NESTED_CCTLD_SECOND_LEVELS.has(sld)) return 3;
  return 2;
}

export const DEFAULT_DISPLAY_DOMAIN_LENGTH = 22;

/**
 * Formats a URL's hostname for display in a story row:
 *   - strips `www.`
 *   - always trims leading subdomains down to the registrable
 *     domain (so `fingfx.thomsonreuters.com` → `thomsonreuters.com`
 *     and `sport.bbc.co.uk` → `bbc.co.uk`), but never past it
 *     (so `9news.com.au` stays `9news.com.au`, and
 *     `jasoneckert.github.io` stays intact because `github.io` is
 *     on the compound-eTLD list)
 *   - falls back to a trailing-ellipsis truncation if the registrable
 *     domain itself is still over `maxLength`.
 *
 * Always-trim (vs. trim-only-when-long) is intentional: subdomains
 * rarely carry useful reader-facing identity — `sport.bbc.co.uk`,
 * `edition.cnn.com`, `old.reddit.com` all read better as the bare
 * domain — and the thread page still shows the full hostname for
 * anyone who wants the detail.
 */
export function formatDisplayDomain(
  url: string | undefined,
  maxLength: number = DEFAULT_DISPLAY_DOMAIN_LENGTH,
): string {
  if (!url) return '';
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return '';
  }
  hostname = hostname.replace(/^www\./, '');

  const parts = hostname.split('.');
  const keep = registrablePartCount(parts);
  if (parts.length > keep) {
    hostname = parts.slice(parts.length - keep).join('.');
  }

  if (hostname.length > maxLength) {
    const cut = Math.max(1, maxLength - 1);
    hostname = hostname.slice(0, cut) + '…';
  }

  return hostname;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function formatTimeAgo(unixSeconds: number, now: Date = new Date()): string {
  const nowS = Math.floor(now.getTime() / 1000);
  let diff = nowS - unixSeconds;
  if (diff < 0) diff = 0;

  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m}m`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h}h`;
  }
  if (diff < MONTH) {
    const d = Math.floor(diff / DAY);
    return `${d}d`;
  }
  if (diff < YEAR) {
    const mo = Math.floor(diff / MONTH);
    return `${mo}mo`;
  }
  const y = Math.floor(diff / YEAR);
  return `${y}y`;
}

export function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

export interface StoryMetaInput {
  time?: number;
  score?: number;
  descendants?: number;
  /**
   * Number of comments posted since the reader last opened the thread.
   * When > 0, the comments segment becomes `"{N}/{M} comment(s)"` so the
   * new-count piggybacks on the existing meta item rather than adding a
   * fourth one. 0 or undefined renders the plain `"{M} comment(s)"` form.
   */
  newCommentCount?: number;
}

// A story is "hot" if it's either a big-story-of-the-day (a lot of
// total points at any age) OR a fast-riser (enough points in the
// first couple of hours that it's clearly climbing the front page).
// The recent-window threshold is deliberately lower so a story that
// just crossed 40 points in under 2h lights up as an early mover,
// while the separate 100+ rule flags larger stories regardless of age.
//
// TODO: tune these thresholds against real feed traffic. The numbers
// below are a first cut based on typical HN front-page rhythms;
// revisit once we've watched how many rows actually light up in a
// normal feed and whether the signal is too loud or too quiet.
const HOT_MIN_SCORE_ANY_AGE = 100;
const HOT_MIN_SCORE_RECENT = 40;
const HOT_RECENT_WINDOW_HOURS = 2;

/**
 * Returns true when the story is "trending enough" to flag with the
 * orange Hot pill in the story row. Display-only — no state, no
 * storage, no side effects.
 */
export function isHotStory(item: StoryMetaInput, now: Date = new Date()): boolean {
  const score = item.score ?? 0;
  if (score >= HOT_MIN_SCORE_ANY_AGE) return true;
  if (score < HOT_MIN_SCORE_RECENT) return false;
  if (!item.time) return false;
  const nowS = Math.floor(now.getTime() / 1000);
  const ageHours = (nowS - item.time) / 3600;
  return ageHours >= 0 && ageHours < HOT_RECENT_WINDOW_HOURS;
}

/**
 * Formats the trailing segment of a story's metadata line used in
 * both the list row and the thread header: `"{age} · {N} point(s) · {M}
 * comment(s)"`. Callers prepend the view-specific prefix (plain-text
 * domain on the list, author or domain link on the thread) so the
 * ordering, pluralization, and separator live in one place.
 */
export function formatStoryMetaTail(item: StoryMetaInput, now?: Date): string {
  const parts: string[] = [];
  const age = item.time ? formatTimeAgo(item.time, now) : '';
  if (age) parts.push(age);
  const points = item.score ?? 0;
  parts.push(`${points} ${pluralize(points, 'point')}`);
  const comments = item.descendants ?? 0;
  const newCount = item.newCommentCount ?? 0;
  const countText = newCount > 0 ? `${newCount}/${comments}` : `${comments}`;
  parts.push(`${countText} ${pluralize(comments, 'comment')}`);
  return parts.join(' · ');
}
