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

// A story is "hot" if it's either climbing fast with real discussion
// (velocity > 15 points/h AND descendants > 10) OR a clearly
// established big story with a heavy comment thread (score > 200 AND
// descendants > 100). The fast-riser branch catches stories that
// haven't accumulated huge totals yet but are climbing the front
// page; the big-story branch keeps the Hot flag on stories whose
// velocity has cooled but whose total engagement still stands out.
//
// Velocity is computed against `safeAge = max(ageHours, 0.01)` (a
// ~36-second floor) so a brand-new story doesn't blow up to Infinity
// while its age is still rounding to zero — the same floor the
// `/tuning` page uses on its own `safeAge`, so the rule's *shape*
// matches what the operator previewed there. The age inputs differ
// in a tiny way (`isHotStory` floors `now` to whole seconds via
// `Math.floor(now.getTime() / 1000)` while `/tuning`'s `evalForItem`
// uses `nowMs / 1000`); within the 36-second `safeAge` floor the
// difference is washed out.
//
// Exported so the `/admin` "Hot threshold tuning" view can render
// reference lines and the default expression against the same
// numbers `isHotStory` actually uses — without that single source
// of truth, the UI silently drifts when these are tuned.
export const HOT_MIN_VELOCITY = 15;
export const HOT_MIN_DESCENDANTS = 10;
export const HOT_BIG_SCORE = 200;
export const HOT_BIG_DESCENDANTS = 100;

/**
 * Returns true when the story is "trending enough" to flag with the
 * orange Hot pill in the story row. Display-only — no state, no
 * storage, no side effects.
 */
export function isHotStory(item: StoryMetaInput, now: Date = new Date()): boolean {
  const score = item.score ?? 0;
  const descendants = item.descendants ?? 0;
  if (score > HOT_BIG_SCORE && descendants > HOT_BIG_DESCENDANTS) return true;
  if (!item.time) return false;
  const nowS = Math.floor(now.getTime() / 1000);
  const ageHours = (nowS - item.time) / 3600;
  if (ageHours < 0) return false;
  const safeAge = Math.max(ageHours, 0.01);
  return (
    score / safeAge > HOT_MIN_VELOCITY && descendants > HOT_MIN_DESCENDANTS
  );
}

// Shared core for the `(N/h)` velocity readouts. Returns `null`
// when there isn't enough signal — `time` missing, `value` <= 0,
// age sub-minute (matches `formatTimeAgo`'s `< MINUTE` boundary so
// "just now" stories don't display a wildly extrapolated rate),
// or the rate ends up non-finite.
function formatRatePerHour(
  time: number | undefined,
  value: number,
  now: Date,
): string | null {
  if (!time) return null;
  if (value <= 0) return null;
  const nowS = Math.floor(now.getTime() / 1000);
  const ageS = nowS - time;
  if (ageS < 60) return null;
  const ageHours = ageS / 3600;
  const rate = Math.round(value / ageHours);
  if (!Number.isFinite(rate)) return null;
  return `${rate}/h`;
}

/**
 * Velocity in points per hour at `now`. Returns `null` when there
 * isn't enough information (no `time` or `score`) or the story is
 * effectively age-zero (avoids `Infinity` for stories submitted in
 * the same second the reader hits the page). Used by the optional
 * velocity readout in the meta line on the `/tuning` Preview —
 * "this story is climbing at N points/h" is exactly the signal
 * the threshold-tuning question wants.
 */
export function formatVelocity(
  item: Pick<StoryMetaInput, 'time' | 'score'>,
  now: Date = new Date(),
): string | null {
  return formatRatePerHour(item.time, item.score ?? 0, now);
}

/**
 * Comment velocity — descendants (top-level + replies) per hour
 * at `now`. Same shape as `formatVelocity` but on the comments
 * track. Used to surface "this story is generating discussion at
 * N comments/h" alongside the score velocity, since a high-comment
 * low-score story is a different beast from a high-score
 * low-comment one.
 */
export function formatCommentVelocity(
  item: Pick<StoryMetaInput, 'time' | 'descendants'>,
  now: Date = new Date(),
): string | null {
  return formatRatePerHour(item.time, item.descendants ?? 0, now);
}

/**
 * Formats the trailing segment of a story's metadata line used in
 * both the list row and the thread header: `"{age} · {N} point(s) · {M}
 * comment(s)"`. Callers prepend the view-specific prefix (plain-text
 * domain on the list, author or domain link on the thread) so the
 * ordering, pluralization, and separator live in one place.
 *
 * `showVelocity` (default `false`) tucks an inline `(N/h)` rate
 * suffix into both the points segment AND the comments segment —
 * `"… · 50 points (25/h) · 10 comments (5/h)"`. Inline rather
 * than separate `· 25/h ·` dot-segments so narrow phones don't
 * lose a row to extra separators. Only the `/tuning` Preview
 * enables it; the standard feed views (including `/hot`) keep
 * the row meta tight to honor the fewer-density goal.
 */
export function formatStoryMetaTail(
  item: StoryMetaInput,
  now?: Date,
  options: { showVelocity?: boolean } = {},
): string {
  const parts: string[] = [];
  const age = item.time ? formatTimeAgo(item.time, now) : '';
  if (age) parts.push(age);
  const points = item.score ?? 0;
  let pointsPart = `${points} ${pluralize(points, 'point')}`;
  if (options.showVelocity) {
    const v = formatVelocity(item, now);
    if (v) pointsPart += ` (${v})`;
  }
  parts.push(pointsPart);
  const comments = item.descendants ?? 0;
  const newCount = item.newCommentCount ?? 0;
  const countText = newCount > 0 ? `${newCount}/${comments}` : `${comments}`;
  let commentsPart = `${countText} ${pluralize(comments, 'comment')}`;
  if (options.showVelocity) {
    const cv = formatCommentVelocity(item, now);
    if (cv) commentsPart += ` (${cv})`;
  }
  parts.push(commentsPart);
  return parts.join(' · ');
}
