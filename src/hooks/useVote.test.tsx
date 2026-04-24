import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useVote } from './useVote';
import { useAuth } from './useAuth';
import {
  addDownvotedId,
  addVotedId,
  getDownvotedIds,
  getVotedIds,
} from '../lib/votes';
import { ToastContext, type ToastOptions } from './useToast';

function newClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'always' },
    },
  });
}

interface FetchPlan {
  me: string | null;
  vote: (body: { id: number; how: string }) => Response;
}

function stubFetch(plan: FetchPlan): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/me') {
      if (plan.me) {
        return new Response(JSON.stringify({ username: plan.me }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'nope' }), { status: 401 });
    }
    if (url === '/api/vote') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return plan.vote(body as { id: number; how: string });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function wrapperFor(client: QueryClient, toasts: ToastOptions[] = []) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <ToastContext.Provider
          value={{
            showToast: (opts) => {
              toasts.push(opts);
            },
          }}
        >
          {children}
        </ToastContext.Provider>
      </QueryClientProvider>
    );
  };
}

// Render useAuth alongside useVote so tests can wait for /api/me to
// resolve without poking at useVote (whose toggleVote is destructive —
// it flips state and POSTs, so it can't be used as an idempotent probe).
function renderVoteAndAuth(client: QueryClient, toasts: ToastOptions[] = []) {
  return renderHook(
    () => ({ vote: useVote(), auth: useAuth() }),
    { wrapper: wrapperFor(client, toasts) },
  );
}

async function waitUntilLoggedIn(
  result: { current: { auth: ReturnType<typeof useAuth> } },
  username: string,
): Promise<void> {
  await waitFor(() => {
    expect(result.current.auth.user?.username).toBe(username);
  });
}

describe('useVote', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('logged out: toggleVote is a no-op', () => {
    stubFetch({
      me: null,
      vote: () => new Response(null, { status: 204 }),
    });
    const { result } = renderHook(() => useVote(), {
      wrapper: wrapperFor(newClient()),
    });
    act(() => {
      result.current.toggleVote(42);
    });
    expect(result.current.votedIds).toEqual(new Set());
  });

  it('logged in: toggleVote flips optimistically and POSTs /api/vote', async () => {
    const fetchMock = stubFetch({
      me: 'alice',
      vote: () => new Response(null, { status: 204 }),
    });
    const { result } = renderVoteAndAuth(newClient());
    await waitUntilLoggedIn(result, 'alice');

    act(() => {
      result.current.vote.toggleVote(42);
    });
    // Optimistic: the set should already include 42, without waiting
    // on the network.
    expect(result.current.vote.isVoted(42)).toBe(true);
    expect(getVotedIds('alice').has(42)).toBe(true);

    await waitFor(() => {
      const votes = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(votes.length).toBeGreaterThan(0);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    );
    expect(call).toBeDefined();
    const [, init] = call!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      id: 42,
      how: 'up',
    });
  });

  it('logged in: toggling again sends how=un', async () => {
    addVotedId('alice', 42); // pre-voted
    const fetchMock = stubFetch({
      me: 'alice',
      vote: () => new Response(null, { status: 204 }),
    });
    const { result } = renderVoteAndAuth(newClient());
    await waitUntilLoggedIn(result, 'alice');
    await waitFor(() => {
      expect(result.current.vote.isVoted(42)).toBe(true);
    });

    act(() => {
      result.current.vote.toggleVote(42);
    });
    expect(result.current.vote.isVoted(42)).toBe(false);

    await waitFor(() => {
      const votes = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(votes.length).toBeGreaterThan(0);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    );
    const body = JSON.parse(String((call![1] as RequestInit).body));
    expect(body).toEqual({ id: 42, how: 'un' });
  });

  it('rolls back optimistic vote on server failure and toasts', async () => {
    const toasts: ToastOptions[] = [];
    stubFetch({
      me: 'alice',
      vote: () =>
        new Response(JSON.stringify({ error: 'Hacker News is down' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const { result } = renderVoteAndAuth(newClient(), toasts);
    await waitUntilLoggedIn(result, 'alice');

    act(() => {
      result.current.vote.toggleVote(7);
    });
    // Optimistic flip
    expect(result.current.vote.isVoted(7)).toBe(true);

    await waitFor(() => {
      expect(toasts.length).toBeGreaterThan(0);
    });
    expect(result.current.vote.isVoted(7)).toBe(false);
    expect(getVotedIds('alice').has(7)).toBe(false);
    expect(toasts[toasts.length - 1].message).toBe('Hacker News is down');
  });

  it('logged-out hook exposes an empty set even when some user has ids stored', async () => {
    // Pre-populate alice's store; with no signed-in user, useVote
    // should still read an empty set for both directions.
    addVotedId('alice', 1);
    addDownvotedId('alice', 2);
    stubFetch({
      me: null,
      vote: () => new Response(null, { status: 204 }),
    });
    const { result } = renderVoteAndAuth(newClient());
    await waitFor(() => {
      expect(result.current.auth.user).toBeNull();
    });
    expect(result.current.vote.votedIds.size).toBe(0);
    expect(result.current.vote.downvotedIds.size).toBe(0);
    expect(result.current.vote.isVoted(1)).toBe(false);
    expect(result.current.vote.isDownvoted(2)).toBe(false);
  });

  it('logged in: toggleDownvote flips optimistically and POSTs how=down', async () => {
    const fetchMock = stubFetch({
      me: 'alice',
      vote: () => new Response(null, { status: 204 }),
    });
    const { result } = renderVoteAndAuth(newClient());
    await waitUntilLoggedIn(result, 'alice');

    act(() => {
      result.current.vote.toggleDownvote(99);
    });
    expect(result.current.vote.isDownvoted(99)).toBe(true);
    expect(getDownvotedIds('alice').has(99)).toBe(true);

    await waitFor(() => {
      const votes = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(votes.length).toBeGreaterThan(0);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    );
    const body = JSON.parse(String((call![1] as RequestInit).body));
    expect(body).toEqual({ id: 99, how: 'down' });
  });

  it('logged in: toggling an already-downvoted item sends how=un', async () => {
    addDownvotedId('alice', 99);
    const fetchMock = stubFetch({
      me: 'alice',
      vote: () => new Response(null, { status: 204 }),
    });
    const { result } = renderVoteAndAuth(newClient());
    await waitUntilLoggedIn(result, 'alice');
    await waitFor(() => {
      expect(result.current.vote.isDownvoted(99)).toBe(true);
    });

    act(() => {
      result.current.vote.toggleDownvote(99);
    });
    expect(result.current.vote.isDownvoted(99)).toBe(false);

    await waitFor(() => {
      const votes = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(votes.length).toBeGreaterThan(0);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    );
    const body = JSON.parse(String((call![1] as RequestInit).body));
    expect(body).toEqual({ id: 99, how: 'un' });
  });

  it('switching upvote → downvote chains un then down', async () => {
    addVotedId('alice', 50);
    const fetchMock = stubFetch({
      me: 'alice',
      vote: () => new Response(null, { status: 204 }),
    });
    const { result } = renderVoteAndAuth(newClient());
    await waitUntilLoggedIn(result, 'alice');
    await waitFor(() => {
      expect(result.current.vote.isVoted(50)).toBe(true);
    });

    act(() => {
      result.current.vote.toggleDownvote(50);
    });
    expect(result.current.vote.isVoted(50)).toBe(false);
    expect(result.current.vote.isDownvoted(50)).toBe(true);

    await waitFor(() => {
      const votes = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(votes.length).toBe(2);
    });
    const voteCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === '/api/vote',
    );
    const bodies = voteCalls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(bodies[0]).toEqual({ id: 50, how: 'un' });
    expect(bodies[1]).toEqual({ id: 50, how: 'down' });
  });

  it('direction switch: `un` leg failing restores the original direction', async () => {
    // Starting: upvoted. Tap Downvote. The `un` call fails (server
    // still has the upvote). Local must restore the upvote so the
    // UI and server agree.
    addVotedId('alice', 70);
    const toasts: ToastOptions[] = [];
    stubFetch({
      me: 'alice',
      vote: () =>
        new Response(JSON.stringify({ error: 'un failed' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const { result } = renderVoteAndAuth(newClient(), toasts);
    await waitUntilLoggedIn(result, 'alice');
    await waitFor(() => {
      expect(result.current.vote.isVoted(70)).toBe(true);
    });

    act(() => {
      result.current.vote.toggleDownvote(70);
    });
    await waitFor(() => {
      expect(toasts.length).toBeGreaterThan(0);
    });
    expect(result.current.vote.isVoted(70)).toBe(true);
    expect(result.current.vote.isDownvoted(70)).toBe(false);
  });

  it('direction switch: second leg failing after successful `un` leaves the item NEUTRAL', async () => {
    // Starting: upvoted. Tap Downvote. `un` succeeds (server now
    // neutral) but `down` fails (e.g. karma gate). Local must end
    // at NEUTRAL — not restore upvoted — or the UI lies about a
    // vote HN no longer has.
    addVotedId('alice', 71);
    const toasts: ToastOptions[] = [];
    let call = 0;
    stubFetch({
      me: 'alice',
      vote: () => {
        call += 1;
        if (call === 1) return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ error: 'down failed' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const { result } = renderVoteAndAuth(newClient(), toasts);
    await waitUntilLoggedIn(result, 'alice');
    await waitFor(() => {
      expect(result.current.vote.isVoted(71)).toBe(true);
    });

    act(() => {
      result.current.vote.toggleDownvote(71);
    });
    await waitFor(() => {
      expect(toasts.length).toBeGreaterThan(0);
    });
    expect(result.current.vote.isVoted(71)).toBe(false);
    expect(result.current.vote.isDownvoted(71)).toBe(false);
  });
});
