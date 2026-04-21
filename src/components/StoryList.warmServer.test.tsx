import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import {
  installIntersectionObserverMock,
  uninstallIntersectionObserverMock,
} from '../test/intersectionObserver';

// The mock IntersectionObserver fires with ratio=1 on observe, so every
// row rendered counts as "fully in view" — which is exactly the signal
// we use to warm the server summary cache.

describe('<StoryList> server summary cache warming', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installIntersectionObserverMock();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    uninstallIntersectionObserverMock();
  });

  it('fires /api/summary and /api/comments-summary once per visible story', async () => {
    const ids = [1, 2];
    const items = {
      1: makeStory(1, { title: 'One', score: 10 }),
      2: makeStory(2, { title: 'Two', score: 10 }),
    };
    const fetchMock = installHNFetchMock({
      feeds: { topstories: ids },
      items,
      summaries: { 1: { summary: 'one' }, 2: { summary: 'two' } },
      commentsSummaries: { 1: { insights: ['a'] }, 2: { insights: ['b'] } },
    });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([input]) =>
        typeof input === 'string' ? input : input.toString(),
      );
      expect(calls.some((u) => u.includes('/api/summary?id=1'))).toBe(true);
      expect(calls.some((u) => u.includes('/api/summary?id=2'))).toBe(true);
      expect(
        calls.some((u) => u.includes('/api/comments-summary?id=1')),
      ).toBe(true);
      expect(
        calls.some((u) => u.includes('/api/comments-summary?id=2')),
      ).toBe(true);
    });
  });

  it('does not warm for score ≤ 1 stories (they are also hidden from the feed)', async () => {
    // Score ≤ 1 = no organic upvote yet. Such stories are filtered out
    // of the feed entirely (see StoryList.tsx), so no row renders and
    // therefore no IntersectionObserver entry fires a warm.
    const ids = [100, 200, 300];
    const items = {
      100: makeStory(100, { title: 'Just submitted', score: 1 }),
      200: makeStory(200, { title: 'Self-flagged', score: 0 }),
      300: makeStory(300, { title: 'Has an upvote', score: 2 }),
    };
    const fetchMock = installHNFetchMock({
      feeds: { topstories: ids },
      items,
      summaries: { 300: { summary: 'ok' } },
      commentsSummaries: { 300: { insights: ['ok'] } },
    });

    renderWithProviders(<StoryList feed="top" />);

    // Only the score=2 row renders.
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(1);
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([input]) =>
        typeof input === 'string' ? input : input.toString(),
      );
      expect(calls.some((u) => u.includes('/api/summary?id=300'))).toBe(true);
    });

    const calls = fetchMock.mock.calls.map(([input]) =>
      typeof input === 'string' ? input : input.toString(),
    );
    expect(calls.some((u) => u.includes('/api/summary?id=100'))).toBe(false);
    expect(calls.some((u) => u.includes('/api/summary?id=200'))).toBe(false);
    expect(
      calls.some((u) => u.includes('/api/comments-summary?id=100')),
    ).toBe(false);
    expect(
      calls.some((u) => u.includes('/api/comments-summary?id=200')),
    ).toBe(false);
  });

  it('skips /api/summary for stories with no URL (Ask HN, job posts) but still warms comments', async () => {
    const ids = [42];
    const items = {
      42: makeStory(42, {
        title: 'Ask HN: something',
        score: 10,
        url: undefined,
        text: 'body',
      }),
    };
    const fetchMock = installHNFetchMock({
      feeds: { topstories: ids },
      items,
      commentsSummaries: { 42: { insights: ['x'] } },
    });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(1);
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([input]) =>
        typeof input === 'string' ? input : input.toString(),
      );
      expect(
        calls.some((u) => u.includes('/api/comments-summary?id=42')),
      ).toBe(true);
    });

    const calls = fetchMock.mock.calls.map(([input]) =>
      typeof input === 'string' ? input : input.toString(),
    );
    expect(calls.some((u) => u.includes('/api/summary?id=42'))).toBe(false);
  });
});
