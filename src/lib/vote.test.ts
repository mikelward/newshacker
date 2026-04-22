// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { postVote, VoteError } from './vote';

function mockFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
): typeof fetch {
  return vi.fn(async (url, init) => impl(String(url), (init ?? {}) as RequestInit)) as unknown as typeof fetch;
}

describe('postVote', () => {
  it('POSTs JSON with id and how to /api/vote', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = mockFetch(async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });
    await postVote(42, 'up', { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/vote');
    expect(calls[0].init.method).toBe('POST');
    expect(
      (calls[0].init.headers as Record<string, string>)['content-type'],
    ).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      id: 42,
      how: 'up',
    });
  });

  it('resolves on 204', async () => {
    const fetchImpl = mockFetch(
      async () => new Response(null, { status: 204 }),
    );
    await expect(postVote(1, 'up', { fetchImpl })).resolves.toBeUndefined();
  });

  it('resolves on any 2xx', async () => {
    const fetchImpl = mockFetch(
      async () => new Response('ok', { status: 200 }),
    );
    await expect(postVote(1, 'un', { fetchImpl })).resolves.toBeUndefined();
  });

  it('throws VoteError with the server message on non-2xx', async () => {
    const fetchImpl = mockFetch(
      async () =>
        new Response(
          JSON.stringify({ error: 'Hacker News session expired' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(postVote(1, 'up', { fetchImpl })).rejects.toMatchObject({
      name: 'VoteError',
      status: 401,
      message: 'Hacker News session expired',
    });
  });

  it('falls back to a default message when the body is not JSON', async () => {
    const fetchImpl = mockFetch(
      async () => new Response('oops', { status: 500 }),
    );
    const err = await postVote(1, 'up', { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(VoteError);
    expect((err as VoteError).status).toBe(500);
    expect((err as VoteError).message).toBe('Could not upvote.');
  });

  it('throws VoteError with status 0 when fetch itself throws', async () => {
    const fetchImpl = mockFetch(async () => {
      throw new TypeError('offline');
    });
    const err = await postVote(1, 'up', { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(VoteError);
    expect((err as VoteError).status).toBe(0);
  });
});
