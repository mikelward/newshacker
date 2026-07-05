import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotStoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addDoneId } from '../lib/doneStories';
import {
  DEFAULT_HOT_THRESHOLDS,
  setStoredHotThresholds,
} from '../lib/hotThresholds';

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

  it('a More tap chases past a page whose only hot row is marked done', async () => {
    // Regression: the chase decided "this tap revealed a row" off the
    // bare isHotStory predicate, ignoring the reader's done/hidden
    // filter that StoryListImpl applies on render. So a page whose only
    // hot story was one the reader had marked done would stop the chase,
    // get filtered out on render, and leave the More button visible but
    // doing nothing. Page 1's only hot row (200) is done; the chase must
    // skip past it to page 2's hot row (300).
    const top: number[] = [];
    const items: Record<number, ReturnType<typeof makeStory>> = {};
    items[100] = makeBigStory(100, { title: 'page-0-hot' });
    top.push(100);
    for (let i = 1; i < 30; i++) {
      items[100 + i] = makeCold(100 + i);
      top.push(100 + i);
    }
    items[200] = makeBigStory(200, { title: 'page-1-hot-but-done' });
    top.push(200);
    for (let i = 1; i < 30; i++) {
      items[200 + i] = makeCold(200 + i);
      top.push(200 + i);
    }
    items[300] = makeBigStory(300, { title: 'page-2-hot' });
    top.push(300);

    addDoneId(200);

    installHNFetchMock({
      feeds: { topstories: top, newstories: [] },
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
    // The done row never surfaces, and the page-0 row stays put.
    expect(screen.queryByText('page-1-hot-but-done')).toBeNull();
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

  it('a Customize re-filter GCs the stale body hold, so re-admitting a pinned row does not reorder it back into the body', async () => {
    // Regression: the reconcile effect keys consolidation off a refetch
    // (`dataUpdatedAt`), but a /hot Customize change re-filters cached
    // pages with no refetch — `items` moves while `dataUpdatedAt` and
    // `pinnedIds` stay put. If the effect only watched `dataUpdatedAt`,
    // a body pin dropped by a tightened predicate would keep its stale
    // "stay in body" hold and get routed back into the body (reordering
    // under the reader) when the predicate is loosened again. The
    // membership-GC half of the effect must clear the hold on the drop.
    const nowS = Math.floor(Date.now() / 1000);
    // Both qualify only via the big-story (Top) branch — their velocity
    // is cooled well under 15/h, so raising `topScoreMin` alone decides
    // membership. `keep` stays hot at topScoreMin 250; `pin` drops.
    installHNFetchMock({
      feeds: { topstories: [1, 2], newstories: [] },
      items: {
        1: makeStory(1, {
          title: 'keep-hot',
          score: 300,
          descendants: 200,
          time: nowS - 100 * 60 * 60,
        }),
        2: makeStory(2, {
          title: 'pin-me',
          score: 210,
          descendants: 110,
          time: nowS - 100 * 60 * 60,
        }),
      },
    });

    renderWithProviders(<HotStoryList />);

    // Both hot under defaults, in source-feed order.
    await waitFor(() => {
      expect(screen.getByText('pin-me')).toBeInTheDocument();
    });
    const rowTitles = () =>
      screen
        .getAllByTestId('story-row')
        .map(
          (row) => row.querySelector('.story-row__title-text')?.textContent ?? '',
        );
    expect(rowTitles()).toEqual(['keep-hot', 'pin-me']);

    // Pin `pin-me` in the body — it stays at its natural position (a pin
    // doesn't yank a /hot body row to the top either).
    const pinRow = () => screen.getByText('pin-me').closest('li')!;
    fireEvent.click(within(pinRow()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(within(pinRow()).getByTestId('pin-btn')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(rowTitles()).toEqual(['keep-hot', 'pin-me']);

    // Tighten the Top rule so `pin-me` (score 210) drops out of the hot
    // filter while `keep-hot` (score 300) survives. No refetch — this is
    // a pure client-side re-filter. The dropped pin surfaces in the top
    // block, and its stale body hold must be GC'd here.
    act(() => {
      setStoredHotThresholds({ ...DEFAULT_HOT_THRESHOLDS, topScoreMin: 250 });
    });
    await waitFor(() => {
      expect(rowTitles()).toEqual(['pin-me', 'keep-hot']);
    });

    // Loosen it back so `pin-me` is re-admitted to the hot filter. With
    // the hold GC'd, it stays consolidated in the top block instead of
    // snapping back into the body — no reorder on this local action.
    act(() => {
      setStoredHotThresholds({ ...DEFAULT_HOT_THRESHOLDS, topScoreMin: 200 });
    });
    // Give the re-filter a beat to land, then assert the order held.
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    expect(rowTitles()).toEqual(['pin-me', 'keep-hot']);
  });
});
