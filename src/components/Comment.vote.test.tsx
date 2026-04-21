import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Comment } from './Comment';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock } from '../test/mockFetch';
import type { HNItem } from '../lib/hn';

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

// Wraps installHNFetchMock with /api/me and /api/vote handlers so the
// Comment component sees a logged-in user and can POST votes. Mirrors
// the pattern in Thread.test.tsx.
function installCommentVoteFetchMock(
  username: string | null,
  voteResponse: () => Response = () => new Response(null, { status: 204 }),
) {
  const hnMock = installHNFetchMock({
    items: {
      900: commentFixture(900, { text: 'root comment body' }),
    },
  });
  const outer = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/me') {
        if (username) {
          return new Response(JSON.stringify({ username }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'nope' }), {
          status: 401,
        });
      }
      if (url === '/api/vote') {
        return voteResponse();
      }
      return hnMock(input);
    },
  );
  vi.stubGlobal('fetch', outer);
  return outer;
}

describe('<Comment> action bar', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('hides the action bar while collapsed and shows it on expand', async () => {
    installCommentVoteFetchMock(null);
    renderWithProviders(<Comment id={900} />);

    await waitFor(() => {
      expect(screen.getByText('root comment body')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('comment-actions')).toBeNull();

    act(() => {
      fireEvent.click(screen.getByText('root comment body'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('comment-actions')).toBeInTheDocument();
    });
    expect(screen.getByTestId('comment-reply')).toHaveAttribute(
      'href',
      'https://news.ycombinator.com/reply?id=900',
    );
  });

  it('does not render the upvote button when logged out', async () => {
    installCommentVoteFetchMock(null);
    renderWithProviders(<Comment id={900} />);

    await waitFor(() => {
      expect(screen.getByText('root comment body')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByText('root comment body'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('comment-actions')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('comment-vote')).toBeNull();
  });

  it('toggles the upvote button when signed in and POSTs /api/vote', async () => {
    const fetchMock = installCommentVoteFetchMock('alice');
    renderWithProviders(<Comment id={900} />);

    await waitFor(() => {
      expect(screen.getByText('root comment body')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByText('root comment body'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('comment-vote')).toBeInTheDocument();
    });

    const vote = screen.getByTestId('comment-vote');
    expect(vote).toHaveAttribute('aria-pressed', 'false');
    expect(vote.className).not.toContain('comment__action-button--active');

    await userEvent.click(vote);
    expect(vote).toHaveAttribute('aria-pressed', 'true');
    expect(vote.className).toContain('comment__action-button--active');

    // Comment ids share the same voted-ids set as stories (items are
    // items as far as the HN vote endpoint is concerned).
    expect(
      window.localStorage.getItem('newshacker:votedStoryIds:alice'),
    ).toContain('900');

    await waitFor(() => {
      const voteCalls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(voteCalls.length).toBeGreaterThan(0);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    );
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      id: 900,
      how: 'up',
    });

    // A second tap toggles back — same hook wiring as the thread page.
    await userEvent.click(vote);
    expect(vote).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => {
      const unvoteCalls = fetchMock.mock.calls.filter(([url, init]) => {
        if (String(url) !== '/api/vote') return false;
        const body = JSON.parse(String((init as RequestInit).body));
        return body.how === 'un';
      });
      expect(unvoteCalls.length).toBeGreaterThan(0);
    });
  });

  it('rolls back the optimistic vote when /api/vote rejects', async () => {
    installCommentVoteFetchMock(
      'alice',
      () =>
        new Response(
          JSON.stringify({ error: 'Hacker News session expired' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    );
    renderWithProviders(<Comment id={900} />);

    await waitFor(() => {
      expect(screen.getByText('root comment body')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByText('root comment body'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('comment-vote')).toBeInTheDocument();
    });

    const vote = screen.getByTestId('comment-vote');
    await userEvent.click(vote);

    await waitFor(() => {
      expect(vote).toHaveAttribute('aria-pressed', 'false');
    });
    expect(
      window.localStorage.getItem('newshacker:votedStoryIds:alice'),
    ).toBeNull();
  });

  it('does not toggle collapse when the upvote button is tapped', async () => {
    installCommentVoteFetchMock('alice');
    renderWithProviders(<Comment id={900} />);

    await waitFor(() => {
      expect(screen.getByText('root comment body')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByText('root comment body'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('comment-vote')).toBeInTheDocument();
    });

    // Still expanded (action bar visible) after clicking the vote button.
    await userEvent.click(screen.getByTestId('comment-vote'));
    expect(screen.getByTestId('comment-actions')).toBeInTheDocument();
  });
});
