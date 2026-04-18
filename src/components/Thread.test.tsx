import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Thread, TOP_LEVEL_PAGE_SIZE } from './Thread';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import type { HNItem } from '../lib/hn';

describe('<Thread>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders story header + top-level comments, with replies collapsed by default', async () => {
    installHNFetchMock({
      items: {
        100: makeStory(100, { title: 'Parent', kids: [101], descendants: 3 }),
        101: {
          id: 101,
          type: 'comment',
          by: 'bob',
          text: 'hello <b>world</b>',
          time: Math.floor(Date.now() / 1000) - 60,
          kids: [102],
        },
        102: {
          id: 102,
          type: 'comment',
          by: 'carol',
          text: 'nested reply',
          time: Math.floor(Date.now() / 1000) - 30,
          kids: [103],
        },
        103: {
          id: 103,
          type: 'comment',
          by: 'dave',
          text: 'deep',
          time: Math.floor(Date.now() / 1000) - 10,
        },
      },
    });

    renderWithProviders(<Thread id={100} />, { route: '/item/100' });

    await waitFor(() => {
      expect(screen.getByText('Parent')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /read article/i })).toHaveAttribute(
      'href',
      'https://example.com/100',
    );
    // Top-level comment body visible
    await waitFor(() => {
      expect(screen.getByText(/hello/)).toBeInTheDocument();
    });
    // Nested replies are collapsed by default
    expect(screen.queryByText(/nested reply/)).toBeNull();
    expect(screen.queryByText(/deep/)).toBeNull();
  });

  it('expands a collapsed subtree on click and lazy-loads children', async () => {
    installHNFetchMock({
      items: {
        200: makeStory(200, { kids: [201], descendants: 2 }),
        201: {
          id: 201,
          type: 'comment',
          by: 'x',
          text: 'top comment',
          kids: [202],
          time: 1,
        },
        202: {
          id: 202,
          type: 'comment',
          by: 'y',
          text: 'child comment',
          time: 2,
        },
      },
    });

    renderWithProviders(<Thread id={200} />);

    await waitFor(() => {
      expect(screen.getByText(/top comment/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/child comment/)).toBeNull();

    const expander = screen.getByRole('button', { name: /show 1 reply/i });
    await userEvent.click(expander);

    await waitFor(() => {
      expect(screen.getByText(/child comment/)).toBeInTheDocument();
    });

    const collapser = screen.getByRole('button', { name: /hide 1 reply/i });
    await userEvent.click(collapser);
    expect(screen.queryByText(/child comment/)).toBeNull();
  });

  it('shows a replies button at the bottom of a collapsed comment that expands it', async () => {
    installHNFetchMock({
      items: {
        400: makeStory(400, { kids: [401], descendants: 3 }),
        401: {
          id: 401,
          type: 'comment',
          by: 'x',
          text: 'top comment',
          kids: [402, 403],
          time: 1,
        },
        402: {
          id: 402,
          type: 'comment',
          by: 'y',
          text: 'child a',
          time: 2,
        },
        403: {
          id: 403,
          type: 'comment',
          by: 'z',
          text: 'child b',
          time: 3,
        },
      },
    });

    renderWithProviders(<Thread id={400} />);

    await waitFor(() => {
      expect(screen.getByText(/top comment/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/child a/)).toBeNull();

    const replies = screen.getByRole('button', { name: '2 replies' });
    expect(replies).toBeInTheDocument();

    await userEvent.click(replies);
    await waitFor(() => {
      expect(screen.getByText(/child a/)).toBeInTheDocument();
    });
    expect(screen.getByText(/child b/)).toBeInTheDocument();
  });

  it('uses singular "reply" on the bottom button when there is exactly one reply', async () => {
    installHNFetchMock({
      items: {
        600: makeStory(600, { kids: [601], descendants: 2 }),
        601: {
          id: 601,
          type: 'comment',
          by: 'a',
          text: 'parent',
          kids: [602],
          time: 1,
        },
        602: {
          id: 602,
          type: 'comment',
          by: 'b',
          text: 'only child',
          time: 2,
        },
      },
    });

    renderWithProviders(<Thread id={600} />);

    await waitFor(() => {
      expect(screen.getByText(/parent/)).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: '1 reply' })).toBeInTheDocument();
  });

  it('shows placeholder for deleted items without crashing', async () => {
    installHNFetchMock({
      items: {
        300: { id: 300, deleted: true },
      },
    });

    renderWithProviders(<Thread id={300} />);
    await waitFor(() => {
      expect(screen.getByText('[deleted]')).toBeInTheDocument();
    });
  });

  it('toggles saved state via the Save button in the header', async () => {
    installHNFetchMock({
      items: { 700: makeStory(700, { title: 'Savable' }) },
    });

    renderWithProviders(<Thread id={700} />);
    await waitFor(() => {
      expect(screen.getByText('Savable')).toBeInTheDocument();
    });

    const save = screen.getByTestId('thread-save');
    expect(save).toHaveTextContent(/save/i);
    expect(save).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(save);
    expect(save).toHaveTextContent(/saved/i);
    expect(save).toHaveAttribute('aria-pressed', 'true');
    expect(
      window.localStorage.getItem('newshacker:savedStoryIds'),
    ).toContain('"id":700');

    await userEvent.click(save);
    expect(save).toHaveAttribute('aria-pressed', 'false');
    expect(window.localStorage.getItem('newshacker:savedStoryIds')).toBe(
      '[]',
    );
  });

  it('paginates top-level comments (only renders first page)', async () => {
    const totalKids = TOP_LEVEL_PAGE_SIZE + 5;
    const kidIds = Array.from({ length: totalKids }, (_, i) => 1000 + i);
    const items: Record<number, HNItem | null> = {
      500: makeStory(500, { kids: kidIds, descendants: totalKids }),
    };
    for (const kid of kidIds) {
      items[kid] = {
        id: kid,
        type: 'comment',
        by: `u${kid}`,
        text: `comment ${kid}`,
        time: 1,
      };
    }
    installHNFetchMock({ items });

    renderWithProviders(<Thread id={500} />);

    await waitFor(() => {
      expect(screen.getByText(/comment 1000/)).toBeInTheDocument();
    });
    // Last item on first page visible
    expect(
      screen.getByText(`comment ${1000 + TOP_LEVEL_PAGE_SIZE - 1}`),
    ).toBeInTheDocument();
    // Items beyond the first page are NOT rendered yet
    expect(
      screen.queryByText(`comment ${1000 + TOP_LEVEL_PAGE_SIZE}`),
    ).toBeNull();
    // Sentinel exists so IntersectionObserver can trigger next page
    expect(screen.getByTestId('comments-sentinel')).toBeInTheDocument();
  });
});
