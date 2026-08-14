import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import {
  installIntersectionObserverMock,
  setVisibilityForTest,
  uninstallIntersectionObserverMock,
} from '../test/intersectionObserver';
import { FEED_PREFETCH_SCORE_THRESHOLD } from '../lib/feedStoryPrefetch';

// The drive-by warm for trending rows (prefetchFeedStory) is what made the
// first screen expensive: it fetches each story's root with a *single-item*
// Firebase read, so gating it on the whole loaded page instead of the
// viewport meant 30 direct HN requests fired alongside the feed's own
// id-list and items calls. These guard the viewport gate.

const HOT = FEED_PREFETCH_SCORE_THRESHOLD + 50;

function rowFor(id: number): Element {
  const el = document.querySelector(`[data-story-id="${id}"]`);
  if (!el) throw new Error(`no rendered row for story ${id}`);
  return el;
}

function firebaseItemCalls(fetchMock: ReturnType<typeof installHNFetchMock>) {
  return fetchMock.mock.calls
    .map(([input]) => (typeof input === 'string' ? input : input.toString()))
    .filter((u) => /\/v0\/item\/\d+\.json/.test(u));
}

describe('<StoryList> trending drive-by warm', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installIntersectionObserverMock();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    uninstallIntersectionObserverMock();
  });

  it('warms a trending row that is in view', async () => {
    const fetchMock = installHNFetchMock({
      feeds: { topstories: [1] },
      items: { 1: makeStory(1, { title: 'Trending', score: HOT }) },
    });

    renderWithProviders(<StoryList feed="top" />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(1);
    });

    await waitFor(() => {
      expect(firebaseItemCalls(fetchMock)).toContain(
        'https://hacker-news.firebaseio.com/v0/item/1.json',
      );
    });
  });

  it('does not warm a trending row that is scrolled out of view', async () => {
    // The regression this exists for: before the viewport gate, every row
    // of the loaded page was warmed on first paint whether or not the
    // reader could see it — 30 single-item Firebase reads competing with
    // the feed's own requests. A row the reader cannot see is not a row
    // they can tap, so it must not be warmed.
    // Start every row below the fold, then scroll only the first into
    // view. Setting a ratio after render would be too late — the mock
    // fires each observer's callback synchronously on `observe`, so the
    // warm effect would already have seen both rows as visible.
    uninstallIntersectionObserverMock();
    installIntersectionObserverMock({ defaultRatio: 0 });

    const fetchMock = installHNFetchMock({
      feeds: { topstories: [1, 2] },
      items: {
        1: makeStory(1, { title: 'On screen', score: HOT }),
        2: makeStory(2, { title: 'Below the fold', score: HOT }),
      },
    });

    renderWithProviders(<StoryList feed="top" />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    // The observed element is the `<li>` carrying `data-story-id`, not the
    // inner `story-row` testid node.
    setVisibilityForTest(rowFor(1), 1);

    await waitFor(() => {
      expect(firebaseItemCalls(fetchMock)).toContain(
        'https://hacker-news.firebaseio.com/v0/item/1.json',
      );
    });
    expect(firebaseItemCalls(fetchMock)).not.toContain(
      'https://hacker-news.firebaseio.com/v0/item/2.json',
    );
  });

  it('does not warm an in-view row below the trending score threshold', async () => {
    const fetchMock = installHNFetchMock({
      feeds: { topstories: [1, 2] },
      items: {
        1: makeStory(1, { title: 'Trending', score: HOT }),
        2: makeStory(2, {
          title: 'Not trending',
          score: FEED_PREFETCH_SCORE_THRESHOLD,
        }),
      },
    });

    renderWithProviders(<StoryList feed="top" />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    await waitFor(() => {
      expect(firebaseItemCalls(fetchMock)).toContain(
        'https://hacker-news.firebaseio.com/v0/item/1.json',
      );
    });
    expect(firebaseItemCalls(fetchMock)).not.toContain(
      'https://hacker-news.firebaseio.com/v0/item/2.json',
    );
  });

  it('warms a row only once even as it re-enters the viewport', async () => {
    const fetchMock = installHNFetchMock({
      feeds: { topstories: [1] },
      items: { 1: makeStory(1, { title: 'Trending', score: HOT }) },
    });

    renderWithProviders(<StoryList feed="top" />);
    await screen.findAllByTestId('story-row');
    await waitFor(() => {
      expect(firebaseItemCalls(fetchMock)).toHaveLength(1);
    });

    setVisibilityForTest(rowFor(1), 0);
    setVisibilityForTest(rowFor(1), 1);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(1);
    });
    expect(firebaseItemCalls(fetchMock)).toHaveLength(1);
  });
});
