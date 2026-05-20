import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotStoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

// Build a "fast riser" story: 50 points in 30 min = 100/h velocity,
// well above the >15/h floor, with 25 comments to clear the
// descendants > 10 gate. `time` is computed off `Date.now()` rather
// than fixed seconds so the test stays valid as the clock advances.
function makeFastRiser(id: number, overrides = {}) {
  return makeStory(id, {
    score: 50,
    descendants: 25,
    time: Math.floor(Date.now() / 1000) - 30 * 60,
    ...overrides,
  });
}

// Build a "big story" — score and comment thresholds for the
// big-story branch (`score > 200 && descendants > 100`), at any age.
// The velocity may have cooled but the total engagement still
// qualifies.
function makeBigStory(id: number, overrides = {}) {
  return makeStory(id, {
    score: 250,
    descendants: 150,
    time: Math.floor(Date.now() / 1000) - 12 * 60 * 60,
    ...overrides,
  });
}

// Build a story that should NOT pass `isHotStory` — velocity well
// under 15/h, score below the big-story floor.
function makeCold(id: number, overrides = {}) {
  return makeStory(id, {
    score: 5,
    descendants: 1,
    time: Math.floor(Date.now() / 1000) - 6 * 60 * 60,
    ...overrides,
  });
}

describe('<HotStoryList>', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('renders only stories that satisfy isHotStory, drawn from the union of /top and /new', async () => {
    // /top has a big story (1) and a cold one (2). /new has a fast
    // riser (3) and another cold one (4). Only 1 and 3 should land
    // on /hot.
    installHNFetchMock({
      feeds: {
        topstories: [1, 2],
        newstories: [3, 4],
      },
      items: {
        1: makeBigStory(1, { title: 'big-story-from-top' }),
        2: makeCold(2, { title: 'cold-from-top' }),
        3: makeFastRiser(3, { title: 'fast-riser-from-new' }),
        4: makeCold(4, { title: 'cold-from-new' }),
      },
    });

    renderWithProviders(<HotStoryList />);

    await waitFor(() => {
      expect(screen.getByText('big-story-from-top')).toBeInTheDocument();
    });
    expect(screen.getByText('fast-riser-from-new')).toBeInTheDocument();
    expect(screen.queryByText('cold-from-top')).toBeNull();
    expect(screen.queryByText('cold-from-new')).toBeNull();
  });

  it('renders the `new` debug segment for /new-source rows and suppresses `hot` for /top-source rows', async () => {
    installHNFetchMock({
      feeds: {
        topstories: [1],
        newstories: [3],
      },
      items: {
        1: makeBigStory(1, { title: 'big-story-from-top' }),
        3: makeFastRiser(3, { title: 'fast-riser-from-new' }),
      },
    });

    renderWithProviders(<HotStoryList />);

    await waitFor(() => {
      expect(screen.getByText('big-story-from-top')).toBeInTheDocument();
    });

    // The /top-source row's flag segment is suppressed entirely
    // (every row on /hot is hot by construction, so a literal `hot`
    // word is noise).
    const topRow = screen.getByText('big-story-from-top').closest('a');
    expect(topRow).not.toBeNull();
    expect(topRow!.textContent).not.toMatch(/\bhot\b/);
    expect(topRow!.textContent).not.toMatch(/\bnew\b/);

    // The /new-source row carries the temporary `new` debug
    // segment (lowercase orange text in the same meta slot — see
    // SPEC.md *Hot flag*).
    const newRow = screen.getByText('fast-riser-from-new').closest('a');
    expect(newRow).not.toBeNull();
    expect(newRow!.textContent).toMatch(/\bnew\b/);
  });

  it('dedupes ids that appear in both source feeds (top wins)', async () => {
    // Same id 1 in both slices. It should render exactly once, and
    // because it was in the /top slice for the page where it first
    // appeared, it should NOT carry the `new` debug segment.
    installHNFetchMock({
      feeds: {
        topstories: [1],
        newstories: [1],
      },
      items: {
        1: makeBigStory(1, { title: 'shared-story' }),
      },
    });

    renderWithProviders(<HotStoryList />);

    await waitFor(() => {
      expect(screen.getByText('shared-story')).toBeInTheDocument();
    });
    expect(screen.queryAllByText('shared-story')).toHaveLength(1);
    const row = screen.getByText('shared-story').closest('a');
    expect(row!.textContent).not.toMatch(/\bnew\b/);
  });

  it('shows the empty-state copy when no candidate satisfies isHotStory', async () => {
    // Both source feeds are populated with cold stories — none
    // qualify, so the page resolves to "Nothing hot right now."
    installHNFetchMock({
      feeds: {
        topstories: [2],
        newstories: [4],
      },
      items: {
        2: makeCold(2),
        4: makeCold(4),
      },
    });

    renderWithProviders(<HotStoryList />);

    await waitFor(() => {
      expect(screen.getByText(/nothing hot right now/i)).toBeInTheDocument();
    });
  });

  it('reveals a "More" button that advances both source feeds in lockstep', async () => {
    // Page 0 covers slice [0..30] of each source. Make page 0 yield
    // exactly one hot row from /top, with one extra id beyond the
    // page-size window in /new so a "More" tap is justified.
    const topPage0 = Array.from({ length: 30 }, (_, i) => 100 + i);
    const newPage0 = Array.from({ length: 30 }, (_, i) => 200 + i);
    const topPage1 = [400];
    const newPage1 = [401];
    const items: Record<number, ReturnType<typeof makeStory>> = {};
    // Only id 100 is hot on page 0. The rest are cold so the
    // visible row count for page 0 is exactly 1.
    items[100] = makeBigStory(100, { title: 'page-0-hot' });
    for (let i = 1; i < 30; i++) items[100 + i] = makeCold(100 + i);
    for (const id of newPage0) items[id] = makeCold(id);
    items[400] = makeBigStory(400, { title: 'page-1-hot-from-top' });
    items[401] = makeCold(401);

    installHNFetchMock({
      feeds: {
        topstories: [...topPage0, ...topPage1],
        newstories: [...newPage0, ...newPage1],
      },
      items,
    });

    renderWithProviders(<HotStoryList />);

    await waitFor(() => {
      expect(screen.getByText('page-0-hot')).toBeInTheDocument();
    });
    // page-1-hot-from-top is in slice [30..60] which page 0 didn't
    // cover, so it shouldn't be on screen yet.
    expect(screen.queryByText('page-1-hot-from-top')).toBeNull();

    const more = screen.getByRole('button', { name: /^More$/i });
    await userEvent.click(more);

    await waitFor(() => {
      expect(screen.getByText('page-1-hot-from-top')).toBeInTheDocument();
    });
    // The page-0 hot row remains on screen — pages accumulate.
    expect(screen.getByText('page-0-hot')).toBeInTheDocument();
  });

  it('grays out the footer button when both source feeds are exhausted', async () => {
    // Both source feeds fit inside page 0 (≤30 ids each) with one hot
    // row, so there is no next page. The footer button stays visible as
    // a disabled "No more stories" affordance rather than vanishing.
    installHNFetchMock({
      feeds: { topstories: [100, 101], newstories: [200] },
      items: {
        100: makeBigStory(100, { title: 'the-hot-row' }),
        101: makeCold(101),
        200: makeCold(200),
      },
    });

    renderWithProviders(<HotStoryList />);

    await waitFor(() => {
      expect(screen.getByText('the-hot-row')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^More$/i })).toBeNull();
    const endBtn = screen.getByRole('button', { name: /no more stories/i });
    expect(endBtn).toBeDisabled();
  });

  it('a single More tap chases past a fully-filtered page to the next hot row', async () => {
    // Regression: on /hot the isHotStory predicate can reject an entire
    // page of candidates, so one More tap that paged in a fully-cold
    // page used to reveal nothing and read as a dead button. A tap now
    // keeps advancing until a hot row surfaces (or the feeds run out).
    // Page 0: one hot row (100). Page 1 (ids 200..229): all cold.
    // Page 2 (starts at id 300): a hot row. /new is cold throughout.
    const top: number[] = [];
    const items: Record<number, ReturnType<typeof makeStory>> = {};
    items[100] = makeBigStory(100, { title: 'page-0-hot' });
    top.push(100);
    for (let i = 1; i < 30; i++) {
      items[100 + i] = makeCold(100 + i);
      top.push(100 + i);
    }
    for (let i = 0; i < 30; i++) {
      items[200 + i] = makeCold(200 + i);
      top.push(200 + i);
    }
    items[300] = makeBigStory(300, { title: 'page-2-hot' });
    top.push(300);
    for (let i = 1; i < 30; i++) {
      items[300 + i] = makeCold(300 + i);
      top.push(300 + i);
    }
    const newIds = Array.from({ length: 90 }, (_, i) => 900 + i);
    for (const id of newIds) items[id] = makeCold(id);

    installHNFetchMock({
      feeds: { topstories: top, newstories: newIds },
      items,
    });

    renderWithProviders(<HotStoryList />);

    await waitFor(() => {
      expect(screen.getByText('page-0-hot')).toBeInTheDocument();
    });
    expect(screen.queryByText('page-2-hot')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /^More$/i }));

    await waitFor(() => {
      expect(screen.getByText('page-2-hot')).toBeInTheDocument();
    });
    // The page-0 hot row stays — pages accumulate, the chase doesn't drop them.
    expect(screen.getByText('page-0-hot')).toBeInTheDocument();
  });

  it('stops the More chase when a page fetch fails instead of looping forever', async () => {
    // Regression: a failed page fetch resolves without adding a page
    // (TanStack Query's default throwOnError: false), so the chase's
    // projected-count guard would never advance and one tap could spin
    // failing requests forever. The chase must bail when no new page
    // lands. Page 0 (id 100) is hot; page 1's items request (ids
    // 200..229) fails. We gate that failing request so the loading state
    // is observable deterministically, then assert exactly one page-1
    // attempt — a runaway loop would re-fetch and keep the button stuck.
    const top: number[] = [];
    const items: Record<number, ReturnType<typeof makeStory>> = {};
    items[100] = makeBigStory(100, { title: 'page-0-hot' });
    top.push(100);
    for (let i = 1; i < 30; i++) {
      items[100 + i] = makeCold(100 + i);
      top.push(100 + i);
    }
    for (let i = 0; i < 30; i++) top.push(200 + i); // page 1 — fetch fails
    items[300] = makeBigStory(300, { title: 'page-2-hot' });
    top.push(300);

    let page1ItemFetches = 0;
    let releasePage1: () => void = () => {};
    const page1Gate = new Promise<void>((resolve) => {
      releasePage1 = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/items')) {
        const ids = (
          new URL(url, 'http://localhost').searchParams.get('ids') ?? ''
        )
          .split(',')
          .map(Number);
        if (ids.some((id) => id >= 200 && id < 230)) {
          page1ItemFetches += 1;
          await page1Gate; // hold the failing fetch open until released
          return new Response('upstream boom', { status: 502 });
        }
        return new Response(JSON.stringify(ids.map((id) => items[id] ?? null)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const path = url.replace('https://hacker-news.firebaseio.com/v0/', '');
      if (path === 'topstories.json') {
        return new Response(JSON.stringify(top), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === 'newstories.json') {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<HotStoryList />);

    await waitFor(() => {
      expect(screen.getByText('page-0-hot')).toBeInTheDocument();
    });

    const moreBtn = screen.getByRole('button', { name: /^More$/i });
    await userEvent.click(moreBtn);

    // Page 1's fetch is in flight (gated) — the button shows the loading
    // state, and exactly one page-1 attempt has been made.
    await waitFor(() => expect(moreBtn).toBeDisabled());
    expect(page1ItemFetches).toBe(1);

    // Let it fail. The chase must bail and surface the feed's error state
    // — not re-issue the page-1 fetch in a loop (which would never
    // settle, since the projected count can't advance past a failed
    // page).
    releasePage1();
    await waitFor(() => {
      expect(screen.getByText(/could not load stories/i)).toBeInTheDocument();
    });
    expect(page1ItemFetches).toBe(1);
    expect(screen.queryByText('page-2-hot')).toBeNull();
  });

  it('does not render the velocity segment in the meta line', async () => {
    // /hot used to surface a "(N/h)" inline rate next to points;
    // it was pulled to keep the row meta tight on phones, leaving
    // velocity exclusive to the operator-only /tuning Preview.
    const nowS = Math.floor(Date.now() / 1000);
    installHNFetchMock({
      feeds: { topstories: [10], newstories: [] },
      items: {
        10: makeStory(10, {
          title: 'velocity-row',
          score: 200,
          descendants: 30,
          time: nowS - 4 * 60 * 60,
        }),
      },
    });
    renderWithProviders(<HotStoryList />);
    await waitFor(() => {
      expect(screen.getByText('velocity-row')).toBeInTheDocument();
    });
    const meta = screen.getByTestId('story-meta');
    expect(meta.textContent).not.toMatch(/\/h\b/);
  });
});
