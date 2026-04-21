import { describe, expect, it } from 'vitest';
import { parseFavoritesPage } from './hnFavoritesScrape';

// Minimal HN favorites-page fixture. The real page wraps story rows in
// a `<table class="itemlist">` with a vote arrow row and a subtext row
// per item; the scraper only cares about the `<tr class="athing">`
// rows and the `<a class="morelink">` pagination link, so the fixture
// keeps just those pieces.
function fixturePage(opts: {
  storyIds: number[];
  commentIds?: number[];
  morePath?: string | null;
}): string {
  const storyRows = opts.storyIds
    .map(
      (id) =>
        `<tr class="athing" id="${id}"><td class="title">story ${id}</td></tr>` +
        `<tr><td class="subtext">subtext ${id}</td></tr>` +
        `<tr class="spacer" style="height:5px"></tr>`,
    )
    .join('\n');
  const commentRows = (opts.commentIds ?? [])
    .map(
      (id) =>
        `<tr class="athing comtr" id="${id}"><td class="ind">comment ${id}</td></tr>`,
    )
    .join('\n');
  const moreRow =
    opts.morePath === null || opts.morePath === undefined
      ? ''
      : `<tr class="morespace"></tr>` +
        `<tr><td colspan="2"></td>` +
        `<td class="title"><a href="${opts.morePath}" class="morelink" rel="next">More</a></td></tr>`;
  return `<html><body><table class="itemlist">${storyRows}${commentRows}${moreRow}</table></body></html>`;
}

describe('parseFavoritesPage', () => {
  it('returns empty result for empty / garbage input', () => {
    expect(parseFavoritesPage('')).toEqual({ ids: [], morePath: null });
    expect(parseFavoritesPage('not html at all')).toEqual({
      ids: [],
      morePath: null,
    });
    expect(parseFavoritesPage('<html><body>no favorites yet</body></html>')).toEqual({
      ids: [],
      morePath: null,
    });
  });

  it('extracts story IDs in document order', () => {
    const html = fixturePage({ storyIds: [111, 222, 333], morePath: null });
    expect(parseFavoritesPage(html)).toEqual({
      ids: [111, 222, 333],
      morePath: null,
    });
  });

  it('captures the morelink href for paginated pages', () => {
    // HN emits `&amp;` — the scraper returns a real `&` so callers
    // can use the path directly.
    const html = fixturePage({
      storyIds: [42],
      morePath: 'favorites?id=alice&amp;p=2',
    });
    expect(parseFavoritesPage(html)).toEqual({
      ids: [42],
      morePath: 'favorites?id=alice&p=2',
    });
  });

  it('ignores comment favorites (class="athing comtr")', () => {
    const html = fixturePage({
      storyIds: [1, 2],
      commentIds: [9_990, 9_991],
      morePath: null,
    });
    expect(parseFavoritesPage(html).ids).toEqual([1, 2]);
  });

  it('handles attribute order with id before class', () => {
    const html =
      `<tr id="555" class="athing"><td>a</td></tr>` +
      `<tr class="athing" id="666"><td>b</td></tr>`;
    expect(parseFavoritesPage(html).ids).toEqual([555, 666]);
  });

  it('handles single-quoted attributes', () => {
    const html =
      `<tr class='athing' id='777'><td>a</td></tr>` +
      `<a class='morelink' href='favorites?id=bob&amp;p=3' rel='next'>More</a>`;
    expect(parseFavoritesPage(html)).toEqual({
      ids: [777],
      morePath: 'favorites?id=bob&p=3',
    });
  });

  it('deduplicates repeat IDs', () => {
    const html =
      `<tr class="athing" id="10"></tr>` +
      `<tr class="athing" id="20"></tr>` +
      `<tr class="athing" id="10"></tr>`;
    expect(parseFavoritesPage(html).ids).toEqual([10, 20]);
  });

  it('rejects non-numeric, zero, or negative IDs', () => {
    const html =
      `<tr class="athing" id="abc"></tr>` +
      `<tr class="athing" id="0"></tr>` +
      `<tr class="athing" id="-5"></tr>` +
      `<tr class="athing" id="123"></tr>`;
    expect(parseFavoritesPage(html).ids).toEqual([123]);
  });

  it('returns null morePath when no morelink is present', () => {
    const html = fixturePage({ storyIds: [1, 2, 3], morePath: null });
    expect(parseFavoritesPage(html).morePath).toBeNull();
  });

  it('tolerates extra class tokens on morelink', () => {
    const html = `<a class="foo morelink bar" href="favorites?id=u&amp;p=2">More</a>`;
    expect(parseFavoritesPage(html).morePath).toBe('favorites?id=u&p=2');
  });
});
