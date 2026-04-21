import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { summaryQueryKey } from '../hooks/useSummary';
import { commentsSummaryQueryKey } from '../hooks/useCommentsSummary';

describe('<StoryList> trending-score cache warming', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('warms the full thread cache (item, comments, summaries) for score > 100 stories but skips low-score rows', async () => {
    const ids = [1, 2, 3];
    const items = {
      1: makeStory(1, { title: 'Trending', score: 250, kids: [11, 12] }),
      2: makeStory(2, { title: 'Sleepy', score: 42, kids: [21] }),
      3: makeStory(3, { title: 'Right at the line', score: 100, kids: [31] }),
      11: {
        id: 11,
        type: 'comment' as const,
        by: 'a',
        text: 'c11',
        time: 1,
      },
      12: {
        id: 12,
        type: 'comment' as const,
        by: 'b',
        text: 'c12',
        time: 2,
      },
    };
    installHNFetchMock({
      feeds: { topstories: ids },
      items,
      summaries: { 1: { summary: 'hot article' } },
      commentsSummaries: { 1: { insights: ['hot insight'] } },
    });

    const { client } = renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    await waitFor(() => {
      expect(client.getQueryData(['itemRoot', 1])).toMatchObject({
        item: { id: 1 },
        kidIds: [11, 12],
      });
      expect(client.getQueryData(['comment', 11])).toMatchObject({ id: 11 });
      expect(client.getQueryData(summaryQueryKey(1))).toEqual({
        summary: 'hot article',
      });
      expect(client.getQueryData(commentsSummaryQueryKey(1))).toEqual({
        insights: ['hot insight'],
      });
    });

    // Low-score story (42) and the exactly-100 story are below the
    // "> 100" threshold, so they must not be warmed.
    expect(client.getQueryData(['itemRoot', 2])).toBeUndefined();
    expect(client.getQueryData(['itemRoot', 3])).toBeUndefined();
    expect(client.getQueryData(summaryQueryKey(2))).toBeUndefined();
    expect(client.getQueryData(summaryQueryKey(3))).toBeUndefined();
  });
});
