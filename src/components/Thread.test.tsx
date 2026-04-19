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
    const readArticle = screen.getByRole('link', { name: /read article/i });
    expect(readArticle).toHaveAttribute('href', 'https://example.com/100');
    expect(readArticle).toHaveTextContent(/^\s*Read article\s*$/);
    expect(readArticle).not.toHaveTextContent(/example\.com/);
    // Top-level comment body visible
    await waitFor(() => {
      expect(screen.getByText(/hello/)).toBeInTheDocument();
    });
    // Nested replies are collapsed by default
    expect(screen.queryByText(/nested reply/)).toBeNull();
    expect(screen.queryByText(/deep/)).toBeNull();
  });

  it('expands a collapsed subtree via the meta toggle and lazy-loads children', async () => {
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

    const expander = screen.getByRole('button', { name: /expand comment/i });
    await userEvent.click(expander);

    await waitFor(() => {
      expect(screen.getByText(/child comment/)).toBeInTheDocument();
    });

    const collapser = screen.getByRole('button', { name: /collapse comment/i });
    await userEvent.click(collapser);
    expect(screen.queryByText(/child comment/)).toBeNull();
  });

  it('clamps comment body by default and removes the clamp when expanded', async () => {
    installHNFetchMock({
      items: {
        400: makeStory(400, { kids: [401], descendants: 1 }),
        401: {
          id: 401,
          type: 'comment',
          by: 'x',
          text: 'a long enough comment body',
          time: 1,
        },
      },
    });

    renderWithProviders(<Thread id={400} />);

    const bodyText = await screen.findByText(/a long enough comment body/);
    const body = bodyText.closest('.comment__body') as HTMLElement;
    expect(body).toHaveClass('comment__body--clamped');

    await userEvent.click(body);
    expect(body).not.toHaveClass('comment__body--clamped');

    await userEvent.click(body);
    expect(body).toHaveClass('comment__body--clamped');
  });

  it('renders the comment author as an internal link to /user/<by>', async () => {
    installHNFetchMock({
      items: {
        500: makeStory(500, { kids: [501], descendants: 1 }),
        501: {
          id: 501,
          type: 'comment',
          by: 'alice',
          text: 'comment body',
          time: 1,
        },
      },
    });

    renderWithProviders(<Thread id={500} />);

    const author = await screen.findByRole('link', { name: 'alice' });
    expect(author).toHaveAttribute('href', '/user/alice');
  });

  it('shows a "Reply on HN" link on expanded comments, hidden when collapsed', async () => {
    installHNFetchMock({
      items: {
        450: makeStory(450, { kids: [451], descendants: 1 }),
        451: {
          id: 451,
          type: 'comment',
          by: 'x',
          text: 'comment body',
          time: 1,
        },
      },
    });

    renderWithProviders(<Thread id={450} />);
    await screen.findByText(/comment body/);

    expect(screen.queryByRole('link', { name: /reply on hn/i })).toBeNull();

    await userEvent.click(
      screen.getByRole('button', { name: /expand comment/i }),
    );

    const reply = screen.getByRole('link', { name: /reply on hn/i });
    expect(reply).toHaveAttribute(
      'href',
      'https://news.ycombinator.com/reply?id=451',
    );
    expect(reply).toHaveAttribute('target', '_blank');
    expect(reply).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('filters out deleted, dead, and empty comments from a thread', async () => {
    installHNFetchMock({
      items: {
        900: makeStory(900, { kids: [901, 902, 903, 904], descendants: 4 }),
        901: {
          id: 901,
          type: 'comment',
          by: 'alice',
          text: 'visible comment',
          time: 1,
        },
        902: { id: 902, type: 'comment', deleted: true, time: 2 },
        903: { id: 903, type: 'comment', dead: true, by: 'bob', text: 'x', time: 3 },
        904: { id: 904, type: 'comment', by: 'carol', time: 4 },
      },
    });

    renderWithProviders(<Thread id={900} />);

    await waitFor(() => {
      expect(screen.getByText(/visible comment/)).toBeInTheDocument();
    });
    expect(screen.queryByText('[deleted]')).toBeNull();
    expect(screen.queryByText('[dead]')).toBeNull();
    expect(screen.queryByText('carol')).toBeNull();
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

  it('marks the article as opened when the Read article link is clicked', async () => {
    installHNFetchMock({
      items: { 720: makeStory(720, { title: 'Readable' }) },
    });

    renderWithProviders(<Thread id={720} />);
    await waitFor(() => {
      expect(screen.getByText('Readable')).toBeInTheDocument();
    });

    const link = screen.getByRole('link', { name: /read article/i });
    // jsdom follows hrefs — cancel navigation so the click handler still runs.
    link.addEventListener('click', (e) => e.preventDefault());
    await userEvent.click(link);

    const stored = window.localStorage.getItem('newshacker:openedStoryIds');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as Array<{
      id: number;
      articleAt?: number;
    }>;
    const entry = parsed.find((e) => e.id === 720);
    expect(entry?.articleAt).toBeTruthy();
  });

  it('toggles favorite state via the Favorite button in the header, independently of Pin', async () => {
    installHNFetchMock({
      items: { 710: makeStory(710, { title: 'Lovable' }) },
    });

    renderWithProviders(<Thread id={710} />);
    await waitFor(() => {
      expect(screen.getByText('Lovable')).toBeInTheDocument();
    });

    const fav = screen.getByTestId('thread-favorite');
    const pin = screen.getByTestId('thread-pin');
    expect(fav).toHaveAccessibleName(/^favorite$/i);
    expect(fav).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(fav);
    expect(fav).toHaveAccessibleName(/unfavorite/i);
    expect(fav).toHaveAttribute('aria-pressed', 'true');
    expect(
      window.localStorage.getItem('newshacker:favoriteStoryIds'),
    ).toContain('"id":710');
    // Pin is untouched by Favorite
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    expect(window.localStorage.getItem('newshacker:pinnedStoryIds')).toBeNull();

    await userEvent.click(fav);
    expect(fav).toHaveAttribute('aria-pressed', 'false');
    expect(window.localStorage.getItem('newshacker:favoriteStoryIds')).toBe(
      '[]',
    );
  });

  it('toggles pinned state via the Pin button in the header', async () => {
    installHNFetchMock({
      items: { 700: makeStory(700, { title: 'Pinnable' }) },
    });

    renderWithProviders(<Thread id={700} />);
    await waitFor(() => {
      expect(screen.getByText('Pinnable')).toBeInTheDocument();
    });

    const pin = screen.getByTestId('thread-pin');
    expect(pin).toHaveAccessibleName(/^pin$/i);
    expect(pin).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(pin);
    expect(pin).toHaveAccessibleName(/unpin/i);
    expect(pin).toHaveAttribute('aria-pressed', 'true');
    expect(
      window.localStorage.getItem('newshacker:pinnedStoryIds'),
    ).toContain('"id":700');

    await userEvent.click(pin);
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    expect(pin).toHaveAccessibleName(/^pin$/i);
    expect(window.localStorage.getItem('newshacker:pinnedStoryIds')).toBe(
      '[]',
    );
  });

  it('auto-fetches and displays the summary card on mount', async () => {
    installHNFetchMock({
      items: {
        800: makeStory(800, { title: 'Linky', url: 'https://example.com/800' }),
      },
      summaries: {
        'https://example.com/800': {
          summary: 'A concise one-sentence summary.',
        },
      },
    });

    renderWithProviders(<Thread id={800} />);

    await waitFor(() => {
      expect(screen.getByTestId('thread-summary-card')).toBeInTheDocument();
    });
    expect(
      await screen.findByText('A concise one-sentence summary.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('thread-summarize')).toBeNull();
  });

  it('shows skeleton lines while the summary is loading and marks the card busy', async () => {
    installHNFetchMock({
      items: {
        820: makeStory(820, { title: 'Slow', url: 'https://example.com/820' }),
      },
      summaries: {
        'https://example.com/820': { summary: 'Eventually here.' },
      },
    });

    renderWithProviders(<Thread id={820} />);

    const skeleton = await screen.findByTestId('thread-summary-skeleton');
    expect(skeleton).toBeInTheDocument();
    expect(screen.getByTestId('thread-summary-card')).toHaveAttribute(
      'aria-busy',
      'true',
    );

    expect(
      await screen.findByText('Eventually here.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('thread-summary-skeleton')).toBeNull();
    expect(screen.getByTestId('thread-summary-card')).toHaveAttribute(
      'aria-busy',
      'false',
    );
  });

  it('shows an error + Retry in the summary card when the api fails', async () => {
    installHNFetchMock({
      items: {
        810: makeStory(810, { title: 'Flaky', url: 'https://example.com/810' }),
      },
      summaries: {
        'https://example.com/810': { error: 'Summarization failed', status: 502 },
      },
    });

    renderWithProviders(<Thread id={810} />);

    await waitFor(() => {
      expect(screen.getByText(/could not summarize/i)).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
  });

  it('does not render a summary card for self-posts without a url', async () => {
    installHNFetchMock({
      items: {
        850: makeStory(850, {
          title: 'Ask HN: no url',
          url: undefined,
          text: 'a self post',
        }),
      },
    });

    renderWithProviders(<Thread id={850} />);
    await waitFor(() => {
      expect(screen.getByText('Ask HN: no url')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('thread-summary-card')).toBeNull();
  });

  it('shows domain (not author) in the meta line for link posts', async () => {
    installHNFetchMock({
      items: {
        600: makeStory(600, {
          title: 'A link post',
          url: 'https://example.com/600',
          by: 'alice',
          score: 42,
          descendants: 7,
        }),
      },
    });

    renderWithProviders(<Thread id={600} />);

    const meta = await screen.findByTestId('thread-meta');
    expect(meta).toHaveTextContent(
      /example\.com · \S+ · 42 points · 7 comments/,
    );
    // Author link is not in the meta for link posts.
    expect(meta.querySelector('.thread__author')).toBeNull();

    const domainLink = meta.querySelector('.thread__domain');
    expect(domainLink).not.toBeNull();
    expect(domainLink).toHaveTextContent('example.com');
    expect(domainLink).toHaveAttribute('href', 'https://example.com/');
    expect(domainLink).toHaveAttribute('target', '_blank');
    expect(domainLink).toHaveAttribute(
      'rel',
      expect.stringContaining('noopener'),
    );
  });

  it('shows author link (not domain) in the meta line for self posts', async () => {
    installHNFetchMock({
      items: {
        610: makeStory(610, {
          title: 'Ask HN',
          url: undefined,
          by: 'bob',
          score: 5,
          descendants: 0,
          text: 'a self post',
        }),
      },
    });

    renderWithProviders(<Thread id={610} />);

    const meta = await screen.findByTestId('thread-meta');
    const author = meta.querySelector('.thread__author');
    expect(author).not.toBeNull();
    expect(author).toHaveTextContent('bob');
    expect(meta).toHaveTextContent(/bob · \S+ · 5 points · 0 comments/);
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
