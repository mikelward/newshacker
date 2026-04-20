import { vi } from 'vitest';
import { HN_API_BASE, type HNItem, type HNUser } from '../lib/hn';

interface SummaryFixture {
  summary?: string;
  error?: string;
  reason?: string;
  status?: number;
}

interface CommentsSummaryFixture {
  insights?: string[];
  error?: string;
  status?: number;
}

interface Fixtures {
  feeds?: Partial<Record<string, number[]>>;
  items?: Record<number, HNItem | null>;
  users?: Record<string, HNUser | null>;
  summaries?: Record<number, SummaryFixture>;
  commentsSummaries?: Record<number, CommentsSummaryFixture>;
}

export function installHNFetchMock(fixtures: Fixtures) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/api/items')) {
      const parsed = new URL(url, 'http://localhost');
      const raw = parsed.searchParams.get('ids') ?? '';
      const ids = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n));
      const body = ids.map((id) => fixtures.items?.[id] ?? null);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('/api/comments-summary')) {
      const parsed = new URL(url, 'http://localhost');
      const idRaw = parsed.searchParams.get('id');
      const id = idRaw ? Number(idRaw) : NaN;
      const fixture = Number.isFinite(id)
        ? fixtures.commentsSummaries?.[id]
        : undefined;
      if (fixture?.insights !== undefined) {
        return new Response(JSON.stringify({ insights: fixture.insights }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (fixture?.error !== undefined) {
        return new Response(JSON.stringify({ error: fixture.error }), {
          status: fixture.status ?? 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not configured' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('/api/summary')) {
      const parsed = new URL(url, 'http://localhost');
      const idRaw = parsed.searchParams.get('id');
      const id = idRaw ? Number(idRaw) : NaN;
      const fixture = Number.isFinite(id)
        ? fixtures.summaries?.[id]
        : undefined;
      if (fixture?.summary !== undefined) {
        return new Response(JSON.stringify({ summary: fixture.summary }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (fixture?.error !== undefined) {
        const body: Record<string, unknown> = { error: fixture.error };
        if (fixture.reason !== undefined) body.reason = fixture.reason;
        return new Response(JSON.stringify(body), {
          status: fixture.status ?? 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not configured' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }

    const path = url.replace(`${HN_API_BASE}/`, '');

    if (path.endsWith('.json')) {
      const key = path.replace(/\.json$/, '');
      if (fixtures.feeds && key in fixtures.feeds) {
        return new Response(JSON.stringify(fixtures.feeds[key] ?? []), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const itemMatch = key.match(/^item\/(\d+)$/);
      if (itemMatch) {
        const id = Number(itemMatch[1]);
        const item = fixtures.items?.[id] ?? null;
        return new Response(JSON.stringify(item), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const userMatch = key.match(/^user\/(.+)$/);
      if (userMatch) {
        const id = decodeURIComponent(userMatch[1]);
        const user = fixtures.users?.[id] ?? null;
        return new Response(JSON.stringify(user), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function makeStory(
  id: number,
  overrides: Partial<HNItem> = {},
): HNItem {
  return {
    id,
    type: 'story',
    title: `Story ${id}`,
    url: `https://example.com/${id}`,
    by: 'author',
    score: id,
    descendants: id,
    time: Math.floor(Date.now() / 1000) - id * 60,
    ...overrides,
  };
}
