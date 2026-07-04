import { describe, expect, it, vi } from 'vitest';
import {
  ConnectTokenError,
  createToken,
  listTokens,
  revokeToken,
} from './connectTokens';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('listTokens', () => {
  it('returns the token list', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        tokens: [{ id: 'a', label: 'Readmo', last4: 'wxyz', createdAt: 1 }],
      }),
    );
    const tokens = await listTokens(fetchMock as unknown as typeof fetch);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].label).toBe('Readmo');
    expect(fetchMock).toHaveBeenCalledWith('/api/connect-token');
  });

  it('tolerates a missing/!array tokens field', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({}));
    expect(await listTokens(fetchMock as unknown as typeof fetch)).toEqual([]);
  });

  it('throws a ConnectTokenError with the server message on failure', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ error: 'Not authenticated' }, 401),
    );
    await expect(
      listTokens(fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 401, message: 'Not authenticated' });
  });
});

describe('createToken', () => {
  it('posts the label and returns the one-time token', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(
        { token: 'nht_abc', id: 'i', label: 'Readmo', last4: '_abc', createdAt: 2 },
        201,
      ),
    );
    const created = await createToken('Readmo', fetchMock as unknown as typeof fetch);
    expect(created.token).toBe('nht_abc');
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      label: 'Readmo',
    });
  });

  it('surfaces the cap error', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ error: 'Too many tokens; revoke one first' }, 409),
    );
    await expect(
      createToken('x', fetchMock as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(ConnectTokenError);
  });
});

describe('revokeToken', () => {
  it('deletes by id', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }));
    await revokeToken('i', fetchMock as unknown as typeof fetch);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe('DELETE');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ id: 'i' });
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ error: 'No such token' }, 404));
    await expect(
      revokeToken('i', fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 404 });
  });
});
