import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Comment } from './Comment';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock } from '../test/mockFetch';
import type { HNItem } from '../lib/hn';
import { addDownvotedId, addVotedId } from '../lib/votes';

function commentFixture(id: number, overrides: Partial<HNItem> = {}): HNItem {
  return {
    id,
    type: 'comment',
    by: 'alice',
    text: `body ${id}`,
    time: 1_700_000_000,
    kids: [],
    ...overrides,
  };
}

describe('<Comment> action toolbar', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('is hidden while the comment is collapsed', async () => {
    installHNFetchMock({ items: { 9100: commentFixture(9100) } });
    renderWithProviders(<Comment id={9100} />);

    await waitFor(() => {
      expect(screen.getByText('body 9100')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('comment-upvote')).toBeNull();
    expect(screen.queryByTestId('comment-downvote')).toBeNull();
    expect(screen.queryByTestId('comment-reply')).toBeNull();
  });

  it('renders upvote, downvote, and reply controls when expanded', async () => {
    installHNFetchMock({ items: { 9101: commentFixture(9101) } });
    renderWithProviders(<Comment id={9101} />);

    await waitFor(() => {
      expect(screen.getByText('body 9101')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /expand comment/i }),
      );
    });

    const upvote = await screen.findByTestId('comment-upvote');
    const downvote = screen.getByTestId('comment-downvote');
    const reply = screen.getByTestId('comment-reply');

    expect(upvote).toHaveAttribute('aria-label', 'Upvote');
    expect(downvote).toHaveAttribute('aria-label', 'Downvote');
    expect(downvote).not.toBeDisabled();
    expect(reply).toHaveAttribute('aria-label', 'Reply on HN');
    expect(reply).toHaveAttribute(
      'href',
      'https://news.ycombinator.com/reply?id=9101',
    );
    expect(reply).toHaveAttribute('target', '_blank');
    expect(reply).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('tapping upvote does not collapse the comment', async () => {
    installHNFetchMock({ items: { 9102: commentFixture(9102) } });
    renderWithProviders(<Comment id={9102} />);

    await waitFor(() => {
      expect(screen.getByText('body 9102')).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByRole('button', { name: /expand comment/i }),
    );

    expect(
      screen.getByRole('button', { name: /collapse comment/i }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('comment-upvote'));
    expect(
      screen.getByRole('button', { name: /collapse comment/i }),
    ).toBeInTheDocument();
  });
});

// Fetch mock that layers /api/me and /api/vote on top of the
// HN item fixtures — installHNFetchMock doesn't speak our server
// endpoints, and the upvote path needs both to be present. Kept
// local to this file because it's a one-off testing concern; if a
// second spec needs the same shape, promote to src/test/.
interface VoteFetchPlan {
  me: string | null;
  items?: Record<number, HNItem>;
  vote?: (body: { id: number; how: string }) => Response;
}

function stubVoteFetch(plan: VoteFetchPlan) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
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
      const handler = plan.vote ?? (() => new Response(null, { status: 204 }));
      return handler(body as { id: number; how: string });
    }
    const m = url.match(/\/item\/(\d+)\.json/);
    if (m) {
      const id = Number(m[1]);
      return new Response(JSON.stringify(plan.items?.[id] ?? null), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('<Comment> upvote wiring', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('signed-in user tapping upvote POSTs /api/vote with how=up and flips aria-pressed', async () => {
    const fetchMock = stubVoteFetch({
      me: 'alice',
      items: { 9200: commentFixture(9200) },
    });
    renderWithProviders(<Comment id={9200} />);

    await waitFor(() => {
      expect(screen.getByText('body 9200')).toBeInTheDocument();
    });
    await userEvent.click(
      screen.getByRole('button', { name: /expand comment/i }),
    );

    const upvote = await screen.findByTestId('comment-upvote');
    expect(upvote).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(upvote);
    // Optimistic flip — aria-pressed should already be true before
    // the network call settles.
    await waitFor(() => {
      expect(
        screen.getByTestId('comment-upvote'),
      ).toHaveAttribute('aria-pressed', 'true');
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(calls.length).toBe(1);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toEqual({ id: 9200, how: 'up' });
  });

  it('tapping an already-upvoted comment sends how=un and clears aria-pressed', async () => {
    addVotedId('alice', 9201);
    const fetchMock = stubVoteFetch({
      me: 'alice',
      items: { 9201: commentFixture(9201) },
    });
    renderWithProviders(<Comment id={9201} />);

    await waitFor(() => {
      expect(screen.getByText('body 9201')).toBeInTheDocument();
    });
    await userEvent.click(
      screen.getByRole('button', { name: /expand comment/i }),
    );

    const upvote = await screen.findByTestId('comment-upvote');
    await waitFor(() => {
      expect(upvote).toHaveAttribute('aria-pressed', 'true');
    });
    expect(upvote).toHaveAttribute('aria-label', 'Unvote');

    await userEvent.click(upvote);
    await waitFor(() => {
      expect(
        screen.getByTestId('comment-upvote'),
      ).toHaveAttribute('aria-pressed', 'false');
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(calls.length).toBe(1);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toEqual({ id: 9201, how: 'un' });
  });

  it('logged-out tap is a no-op — no request, no aria-pressed flip', async () => {
    // Guards the contract: useVote.toggleVote returns early when
    // there's no signed-in user, so the comment row shouldn't surface
    // a "failed to upvote" toast either. This test would regress if a
    // refactor started POSTing speculatively and relying on the
    // server to 401.
    const fetchMock = stubVoteFetch({
      me: null,
      items: { 9202: commentFixture(9202) },
    });
    renderWithProviders(<Comment id={9202} />);

    await waitFor(() => {
      expect(screen.getByText('body 9202')).toBeInTheDocument();
    });
    await userEvent.click(
      screen.getByRole('button', { name: /expand comment/i }),
    );

    const upvote = await screen.findByTestId('comment-upvote');
    await userEvent.click(upvote);

    // Give the optimistic path + any async auth settling a beat.
    await waitFor(() => {
      expect(upvote).toHaveAttribute('aria-pressed', 'false');
    });
    const voteCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === '/api/vote',
    );
    expect(voteCalls.length).toBe(0);
  });
});

describe('<Comment> downvote wiring', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('signed-in user tapping downvote POSTs /api/vote with how=down and flips aria-pressed', async () => {
    const fetchMock = stubVoteFetch({
      me: 'alice',
      items: { 9300: commentFixture(9300) },
    });
    renderWithProviders(<Comment id={9300} />);

    await waitFor(() => {
      expect(screen.getByText('body 9300')).toBeInTheDocument();
    });
    await userEvent.click(
      screen.getByRole('button', { name: /expand comment/i }),
    );

    const downvote = await screen.findByTestId('comment-downvote');
    expect(downvote).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(downvote);
    await waitFor(() => {
      expect(
        screen.getByTestId('comment-downvote'),
      ).toHaveAttribute('aria-pressed', 'true');
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(calls.length).toBe(1);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toEqual({ id: 9300, how: 'down' });
  });

  it('tapping an already-downvoted comment sends how=un and clears aria-pressed', async () => {
    addDownvotedId('alice', 9301);
    const fetchMock = stubVoteFetch({
      me: 'alice',
      items: { 9301: commentFixture(9301) },
    });
    renderWithProviders(<Comment id={9301} />);

    await waitFor(() => {
      expect(screen.getByText('body 9301')).toBeInTheDocument();
    });
    await userEvent.click(
      screen.getByRole('button', { name: /expand comment/i }),
    );

    const downvote = await screen.findByTestId('comment-downvote');
    await waitFor(() => {
      expect(downvote).toHaveAttribute('aria-pressed', 'true');
    });
    expect(downvote).toHaveAttribute('aria-label', 'Undownvote');

    await userEvent.click(downvote);
    await waitFor(() => {
      expect(
        screen.getByTestId('comment-downvote'),
      ).toHaveAttribute('aria-pressed', 'false');
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(calls.length).toBe(1);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toEqual({ id: 9301, how: 'un' });
  });

  it('switching from upvoted to downvoted swaps aria-pressed on both buttons', async () => {
    addVotedId('alice', 9302);
    const fetchMock = stubVoteFetch({
      me: 'alice',
      items: { 9302: commentFixture(9302) },
    });
    renderWithProviders(<Comment id={9302} />);

    await waitFor(() => {
      expect(screen.getByText('body 9302')).toBeInTheDocument();
    });
    await userEvent.click(
      screen.getByRole('button', { name: /expand comment/i }),
    );

    const upvote = await screen.findByTestId('comment-upvote');
    const downvote = screen.getByTestId('comment-downvote');
    await waitFor(() => {
      expect(upvote).toHaveAttribute('aria-pressed', 'true');
    });

    await userEvent.click(downvote);

    await waitFor(() => {
      expect(
        screen.getByTestId('comment-upvote'),
      ).toHaveAttribute('aria-pressed', 'false');
      expect(
        screen.getByTestId('comment-downvote'),
      ).toHaveAttribute('aria-pressed', 'true');
    });

    // Chained: un then down — two POSTs, in that order.
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(calls.length).toBe(2);
    });
    const voteCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === '/api/vote',
    );
    const bodies = voteCalls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(bodies[0]).toEqual({ id: 9302, how: 'un' });
    expect(bodies[1]).toEqual({ id: 9302, how: 'down' });
  });
});
