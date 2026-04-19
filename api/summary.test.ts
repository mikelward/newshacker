import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  handleSummaryRequest,
  isAllowedReferer,
  __clearCacheForTests,
} from './summary';

const ALLOWED_REFERER = 'https://newshacker.app/item/1';

function makeRequest(
  url: string | null,
  opts: { referer?: string | null } = {},
) {
  const base = 'https://newshacker.app/api/summary';
  const full = url === null ? base : `${base}?url=${encodeURIComponent(url)}`;
  const headers = new Headers();
  const referer = opts.referer === undefined ? ALLOWED_REFERER : opts.referer;
  if (referer !== null) headers.set('referer', referer);
  return new Request(full, { headers });
}

interface FakeResponse {
  text: string | null;
  candidates?: Array<{
    urlContextMetadata?: {
      urlMetadata?: Array<{
        retrievedUrl?: string;
        urlRetrievalStatus?: string;
      }>;
    };
  }>;
}

interface GenerateRequest {
  model: string;
  contents: string;
  config?: { tools?: unknown[] };
}

function createFakeClient(
  responses: Array<FakeResponse | Error>,
) {
  const queue = [...responses];
  const generateContent = vi.fn(async (_req: GenerateRequest) => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return next;
  });
  return { models: { generateContent } };
}

function successResponse(text: string): FakeResponse {
  return {
    text,
    candidates: [
      {
        urlContextMetadata: {
          urlMetadata: [
            { urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' },
          ],
        },
      },
    ],
  };
}

function retrievalFailedResponse(
  text = 'I do not have access to that URL.',
): FakeResponse {
  return {
    text,
    candidates: [
      {
        urlContextMetadata: {
          urlMetadata: [{ urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_ERROR' }],
        },
      },
    ],
  };
}

function makeHtmlFetch(
  html: string,
  opts: { ok?: boolean; contentType?: string } = {},
) {
  return vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(html, {
        status: opts.ok === false ? 500 : 200,
        headers: {
          'content-type': opts.contentType ?? 'text/html; charset=utf-8',
        },
      }),
  );
}

describe('handleSummaryRequest', () => {
  const origKey = process.env.GOOGLE_API_KEY;

  beforeEach(() => {
    __clearCacheForTests();
    process.env.GOOGLE_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (origKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origKey;
  });

  it('returns 403 when the Referer header is missing', async () => {
    const res = await handleSummaryRequest(
      makeRequest('https://example.com/a', { referer: null }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for a disallowed Referer host', async () => {
    const res = await handleSummaryRequest(
      makeRequest('https://example.com/a', { referer: 'https://evil.com/' }),
    );
    expect(res.status).toBe(403);
  });

  it('accepts Referers from localhost and vercel.app previews', async () => {
    const client = createFakeClient([successResponse('ok')]);
    const r1 = await handleSummaryRequest(
      makeRequest('https://example.com/a', {
        referer: 'http://localhost:5173/item/1',
      }),
      { createClient: () => client },
    );
    expect(r1.status).toBe(200);

    __clearCacheForTests();
    const r2 = await handleSummaryRequest(
      makeRequest('https://example.com/a', {
        referer: 'https://newshacker-preview-abc.vercel.app/item/1',
      }),
      { createClient: () => createFakeClient([successResponse('ok')]) },
    );
    expect(r2.status).toBe(200);
  });

  it('honors SUMMARY_REFERER_ALLOWLIST when set', async () => {
    const orig = process.env.SUMMARY_REFERER_ALLOWLIST;
    try {
      process.env.SUMMARY_REFERER_ALLOWLIST = 'example.org';
      expect(isAllowedReferer('https://example.org/foo')).toBe(true);
      expect(isAllowedReferer('https://sub.example.org/foo')).toBe(true);
      expect(isAllowedReferer('https://newshacker.app/foo')).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.SUMMARY_REFERER_ALLOWLIST;
      else process.env.SUMMARY_REFERER_ALLOWLIST = orig;
    }
  });

  it('returns 400 when url is missing', async () => {
    const res = await handleSummaryRequest(makeRequest(null));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid url parameter' });
  });

  it('returns 400 for non-http(s) protocols', async () => {
    const res = await handleSummaryRequest(makeRequest('javascript:alert(1)'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed urls', async () => {
    const res = await handleSummaryRequest(makeRequest('not a url'));
    expect(res.status).toBe(400);
  });

  it('returns 503 when GOOGLE_API_KEY is unset', async () => {
    delete process.env.GOOGLE_API_KEY;
    const res = await handleSummaryRequest(
      makeRequest('https://example.com/a'),
    );
    expect(res.status).toBe(503);
  });

  it('returns the model output as a summary', async () => {
    const client = createFakeClient([
      successResponse('A concise one-sentence summary.'),
    ]);
    const res = await handleSummaryRequest(
      makeRequest('https://example.com/a'),
      { createClient: () => client },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      summary: 'A concise one-sentence summary.',
    });
    expect(client.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash',
        contents: expect.stringContaining('https://example.com/a'),
        config: { tools: [{ urlContext: {} }] },
      }),
    );
  });

  it('returns 502 when the model returns an empty string and fetch fallback yields no content', async () => {
    const client = createFakeClient([successResponse('   ')]);
    const fetchImpl = makeHtmlFetch('', { ok: false });
    const res = await handleSummaryRequest(
      makeRequest('https://example.com/b'),
      { createClient: () => client, fetchImpl },
    );
    expect(res.status).toBe(502);
  });

  it('returns 502 when the model throws and fallback fetch also fails', async () => {
    const client = createFakeClient([new Error('boom'), new Error('boom2')]);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network');
    });
    const res = await handleSummaryRequest(
      makeRequest('https://example.com/c'),
      { createClient: () => client, fetchImpl },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Could not access the article',
    });
  });

  it('falls back to fetching the article when urlContext reports no access', async () => {
    const client = createFakeClient([
      retrievalFailedResponse(),
      successResponse('Fallback summary from article body.'),
    ]);
    const fetchImpl = makeHtmlFetch(
      '<html><body><article>Real article text.</article></body></html>',
    );
    const res = await handleSummaryRequest(
      makeRequest('https://www.theverge.com/foo'),
      { createClient: () => client, fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      summary: 'Fallback summary from article body.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const fetchCall = fetchImpl.mock.calls[0]!;
    expect(fetchCall[0]).toBe('https://www.theverge.com/foo');
    const headers = (fetchCall[1]!.headers ?? {}) as Record<string, string>;
    expect(headers['user-agent']).toMatch(/Mozilla/);
    expect(client.models.generateContent).toHaveBeenCalledTimes(2);
    const secondCall = client.models.generateContent.mock.calls[1]![0];
    expect(secondCall.config).toBeUndefined();
    expect(secondCall.contents).toContain('Real article text.');
    expect(secondCall.contents).toContain('https://www.theverge.com/foo');
  });

  it('returns a descriptive error when urlContext fails and fallback fetch returns non-html', async () => {
    const client = createFakeClient([retrievalFailedResponse()]);
    const fetchImpl = makeHtmlFetch('{"not":"html"}', {
      contentType: 'application/json',
    });
    const res = await handleSummaryRequest(
      makeRequest('https://example.com/api'),
      { createClient: () => client, fetchImpl },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Could not access the article',
    });
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
  });

  it('serves a cached summary on a repeat request', async () => {
    const client = createFakeClient([successResponse('first-summary')]);
    const url = 'https://example.com/cached';
    const res1 = await handleSummaryRequest(makeRequest(url), {
      createClient: () => client,
    });
    expect(await res1.json()).toEqual({ summary: 'first-summary' });

    const client2 = createFakeClient([successResponse('would-be-second')]);
    const res2 = await handleSummaryRequest(makeRequest(url), {
      createClient: () => client2,
    });
    expect(await res2.json()).toEqual({
      summary: 'first-summary',
      cached: true,
    });
    expect(client2.models.generateContent).not.toHaveBeenCalled();
  });

  it('re-fetches after the cache ttl expires', async () => {
    const url = 'https://example.com/expire';
    let now = 1_000_000;
    const client = createFakeClient([successResponse('v1')]);
    await handleSummaryRequest(makeRequest(url), {
      createClient: () => client,
      now: () => now,
    });

    now += 60 * 60 * 1000 + 1;
    const client2 = createFakeClient([successResponse('v2')]);
    const res2 = await handleSummaryRequest(makeRequest(url), {
      createClient: () => client2,
      now: () => now,
    });
    expect(await res2.json()).toEqual({ summary: 'v2' });
    expect(client2.models.generateContent).toHaveBeenCalledTimes(1);
  });
});
