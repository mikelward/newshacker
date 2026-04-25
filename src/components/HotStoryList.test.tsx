import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotStoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

// Build a "fast riser" story: score >= 40 inside the 2 h window so
// `isHotStory` returns true via the recent-window branch. `time` is
// computed off `Date.now()` rather than fixed seconds so the test
// stays valid as the clock advances.
function makeFastRiser(id: number, overrides = {}) {
  return makeStory(id, {
    score: 50,
    time: Math.floor(Date.now() / 1000) - 30 * 60,
    ...overrides,
  });
}

// Build a "big story" — score >= 100 at any age — that satisfies
// `isHotStory` via the big-story-of-the-day branch.
function makeBigStory(id: number, overrides = {}) {
  return makeStory(id, {
    score: 200,
    time: Math.floor(Date.now() / 1000) - 12 * 60 * 60,
    ...overrides,
  });
}

// Build a story that should NOT pass `isHotStory` — too cold for
// the big-story branch, too low for the fast-riser branch — so the
// /hot view filters it out.
function makeCold(id: number, overrides = {}) {
  return makeStory(id, {
    score: 5,
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

  it('renders the velocity segment in the meta line', async () => {
    // 200 points / 4 h = 50/h. Use a single hot story so the
    // story-meta testid resolves unambiguously to one row.
    const nowS = Math.floor(Date.now() / 1000);
    installHNFetchMock({
      feeds: { topstories: [10], newstories: [] },
      items: {
        10: makeStory(10, {
          title: 'velocity-row',
          score: 200,
          time: nowS - 4 * 60 * 60,
        }),
      },
    });
    renderWithProviders(<HotStoryList />);
    await waitFor(() => {
      expect(screen.getByText('velocity-row')).toBeInTheDocument();
    });
    // Meta line should include "50/h" — rendered inline inside the
    // points segment as a parenthetical ("200 points (50/h)") so the
    // assertion just looks for the substring.
    const meta = screen.getByTestId('story-meta');
    expect(meta.textContent).toMatch(/\b50\/h\b/);
  });
});
