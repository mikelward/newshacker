// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  buildItemDescription,
  escapeHtml,
  formatTimeAgo,
  handleOgRequest,
} from './og';

// 2024-01-15 12:00:00 UTC, used as a fixed "now" for age formatting.
const NOW_MS = 1_705_320_000_000;
const NOW_S = NOW_MS / 1000;

function makeRequest(
  query = '',
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://newshacker.app/api/og?${query}`, { headers });
}

describe('escapeHtml', () => {
  it('escapes HTML-sensitive characters', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml(`it's & me`)).toBe(`it&#39;s &amp; me`);
  });
});

describe('formatTimeAgo', () => {
  it('renders sub-minute ages as "just now"', () => {
    expect(formatTimeAgo(NOW_S - 30, NOW_MS)).toBe('just now');
  });

  it('renders minutes / hours / days / months / years with " ago"', () => {
    expect(formatTimeAgo(NOW_S - 5 * 60, NOW_MS)).toBe('5m ago');
    expect(formatTimeAgo(NOW_S - 2 * 3600, NOW_MS)).toBe('2h ago');
    expect(formatTimeAgo(NOW_S - 3 * 86400, NOW_MS)).toBe('3d ago');
    expect(formatTimeAgo(NOW_S - 60 * 86400, NOW_MS)).toBe('2mo ago');
    expect(formatTimeAgo(NOW_S - 800 * 86400, NOW_MS)).toBe('2y ago');
  });

  it('clamps negative diffs (future timestamps) to "just now"', () => {
    expect(formatTimeAgo(NOW_S + 60, NOW_MS)).toBe('just now');
  });
});

describe('buildItemDescription', () => {
  it('renders just the article age when item.time is present', () => {
    expect(
      buildItemDescription({ time: NOW_S - 2 * 3600 }, NOW_MS),
    ).toBe('2h ago');
  });

  it('drops the author and score even when they are present', () => {
    expect(
      buildItemDescription(
        { by: 'alice', score: 42, descendants: 7, time: NOW_S - 86400 },
        NOW_MS,
      ),
    ).toBe('1d ago');
  });

  it('falls back to a generic line when item.time is missing', () => {
    expect(buildItemDescription({}, NOW_MS)).toMatch(/newshacker/);
  });
});

describe('handleOgRequest', () => {
  it('returns the default site preview when no id is given', async () => {
    const res = await handleOgRequest(makeRequest(''));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('newshacker — a reader for Hacker News');
    expect(body).toContain('og:title');
    expect(body).toContain('twitter:card');
  });

  it('returns the default site preview for a non-numeric id', async () => {
    const res = await handleOgRequest(makeRequest('id=abc'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('newshacker — a reader for Hacker News');
  });

  it('renders item-specific OG tags for a real story', async () => {
    const fetchItem = vi.fn(async (id: number) => ({
      id,
      type: 'story',
      title: 'A great story',
      by: 'alice',
      score: 100,
      descendants: 20,
      time: NOW_S - 3 * 3600,
    }));
    const res = await handleOgRequest(makeRequest('id=42'), {
      fetchItem,
      now: () => NOW_MS,
    });
    expect(res.status).toBe(200);
    expect(fetchItem).toHaveBeenCalledWith(42);
    const body = await res.text();
    expect(body).toContain('<title>A great story</title>');
    expect(body).toContain('content="A great story"');
    expect(body).toContain('3h ago');
    // Author, score, and comment count were intentionally removed from
    // the description — the preview shows age only.
    expect(body).not.toContain('alice');
    expect(body).not.toContain('100 points');
    expect(body).not.toContain('20 comments');
    expect(body).toContain('https://newshacker.app/icon-512.png');
    expect(body).toContain('https://newshacker.app/item/42');
    expect(body).toContain('twitter:card" content="summary"');
    expect(body).toContain('og:type" content="article"');
  });

  it('escapes HTML in the story title to block injection', async () => {
    const fetchItem = vi.fn(async () => ({
      id: 1,
      title: '<script>alert(1)</script>',
    }));
    const res = await handleOgRequest(makeRequest('id=1'), { fetchItem });
    const body = await res.text();
    expect(body).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('falls back to the default preview when the item is dead/deleted', async () => {
    const fetchItem = vi.fn(async () => ({
      id: 1,
      title: 'dead story',
      dead: true,
    }));
    const res = await handleOgRequest(makeRequest('id=1'), { fetchItem });
    const body = await res.text();
    expect(body).toContain('newshacker — a reader for Hacker News');
    expect(body).not.toContain('dead story');
  });

  it('falls back to the default preview when the item is missing', async () => {
    const fetchItem = vi.fn(async () => null);
    const res = await handleOgRequest(makeRequest('id=9999'), { fetchItem });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('newshacker');
  });

  it('falls back to the default preview when fetch throws', async () => {
    const fetchItem = vi.fn(async () => {
      throw new Error('network down');
    });
    const res = await handleOgRequest(makeRequest('id=99'), { fetchItem });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('newshacker');
  });

  it('sets a canonical link to the SPA route', async () => {
    const fetchItem = vi.fn(async () => ({
      id: 42,
      title: 'x',
    }));
    const res = await handleOgRequest(makeRequest('id=42'), { fetchItem });
    const body = await res.text();
    expect(body).toMatch(/rel="canonical" href="https:\/\/newshacker\.app\/item\/42"/);
  });

  it('redirects accidental human visitors to the SPA route via meta-refresh', async () => {
    const fetchItem = vi.fn(async () => ({ id: 42, title: 'x' }));
    const res = await handleOgRequest(makeRequest('id=42'), { fetchItem });
    const body = await res.text();
    expect(body).toMatch(/http-equiv="refresh".*url=https:\/\/newshacker\.app\/item\/42/);
  });

  it('uses x-forwarded-host when present', async () => {
    const fetchItem = vi.fn(async () => ({ id: 1, title: 't' }));
    const res = await handleOgRequest(
      makeRequest('id=1', { 'x-forwarded-host': 'preview.example.com' }),
      { fetchItem },
    );
    const body = await res.text();
    expect(body).toContain('https://preview.example.com/item/1');
  });

  it('sets a long cache for resolved items and short cache for fallbacks', async () => {
    const fetchItem = vi.fn(async () => ({ id: 1, title: 'ok' }));
    const ok = await handleOgRequest(makeRequest('id=1'), { fetchItem });
    expect(ok.headers.get('cache-control')).toContain('max-age=3600');

    const bad = await handleOgRequest(makeRequest('id=2'), {
      fetchItem: async () => null,
    });
    expect(bad.headers.get('cache-control')).toContain('max-age=60');
  });

  it('rejects ids that overflow safe integers', async () => {
    const fetchItem = vi.fn(async () => null);
    const res = await handleOgRequest(
      makeRequest('id=99999999999999999999'),
      { fetchItem },
    );
    expect(res.status).toBe(200);
    expect(fetchItem).not.toHaveBeenCalled();
    const body = await res.text();
    expect(body).toContain('newshacker — a reader for Hacker News');
  });
});
