// Pure HTML scraper for https://news.ycombinator.com/favorites?id=<user>.
// No I/O, no dependencies — takes raw HTML and returns the favorited
// story IDs plus the relative path of the "More" link for pagination,
// or null if this is the last page.
//
// Regex-based rather than DOM-parser-based because (a) we run in the
// Vercel Node runtime where bundling a parser is avoidable weight,
// and (b) HN's markup is simple and stable enough that anchoring on
// the table-row + class attributes is safe. If HN's HTML ever
// changes shape, the scraper returns empty results rather than
// throwing — callers treat an empty/null result as "nothing to sync"
// and local state stays authoritative.
//
// HN's default favorites page (no `&comments=t`) shows story rows as
// `<tr class="athing" id="<id>">`. Comment favorites are a separate
// tab and their rows carry `class="athing comtr"`. We deliberately
// include only the former by checking for `athing` and excluding
// `comtr` on the same row.

export interface FavoritesScrapeResult {
  ids: number[];
  morePath: string | null;
}

// Match the opening `<tr …>` tag and capture its attribute blob so we
// can inspect class + id together. Using a single regex to capture the
// whole opening tag keeps class/id order independent.
const TR_OPEN_RE = /<tr\b([^>]*)>/gi;
const CLASS_ATTR_RE = /\bclass=(?:"([^"]*)"|'([^']*)')/i;
const ID_ATTR_RE = /\bid=(?:"(\d+)"|'(\d+)')/i;

// Match the opening `<a …>` of a "More" pagination link. HN emits
// `<a class="morelink" href="favorites?id=…&p=2" rel="next">More</a>`.
// Class token matching is tolerant of extra tokens / order.
const A_OPEN_RE = /<a\b([^>]*)>/gi;
const HREF_ATTR_RE = /\bhref=(?:"([^"]*)"|'([^']*)')/i;

function classTokens(attrs: string): string[] {
  const m = CLASS_ATTR_RE.exec(attrs);
  if (!m) return [];
  const raw = m[1] ?? m[2] ?? '';
  return raw.split(/\s+/).filter(Boolean);
}

function idValue(attrs: string): number | null {
  const m = ID_ATTR_RE.exec(attrs);
  if (!m) return null;
  const raw = m[1] ?? m[2];
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function hrefValue(attrs: string): string | null {
  const m = HREF_ATTR_RE.exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

// HN's hrefs arrive with literal `&amp;` entities. We don't fully
// decode entities (there should be nothing else in an href on this
// page); just the ampersand.
function decodeAmp(s: string): string {
  return s.replace(/&amp;/gi, '&');
}

export function parseFavoritesPage(html: string): FavoritesScrapeResult {
  const ids: number[] = [];
  const seen = new Set<number>();

  for (const m of html.matchAll(TR_OPEN_RE)) {
    const attrs = m[1] ?? '';
    const tokens = classTokens(attrs);
    if (!tokens.includes('athing')) continue;
    if (tokens.includes('comtr')) continue;
    const id = idValue(attrs);
    if (id == null) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  let morePath: string | null = null;
  for (const m of html.matchAll(A_OPEN_RE)) {
    const attrs = m[1] ?? '';
    const tokens = classTokens(attrs);
    if (!tokens.includes('morelink')) continue;
    const href = hrefValue(attrs);
    if (!href) break;
    morePath = decodeAmp(href);
    break;
  }

  return { ids, morePath };
}
