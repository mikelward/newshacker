import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import {
  installIntersectionObserverMock,
  uninstallIntersectionObserverMock,
} from '../test/intersectionObserver';

describe('<StoryList> server-side summary warming', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installIntersectionObserverMock();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    uninstallIntersectionObserverMock();
  });

  function readWarmCalls(fetchMock: ReturnType<typeof installHNFetchMock>) {
    // The shared mock is typed as a single-arg fn; cast the raw calls
    // array so we can inspect the POST body second arg.
    const calls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit | undefined]
    >;
    return calls
      .map(([input, init]) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('/api/warm-summaries')) return null;
        const body = init?.body
          ? (JSON.parse(init.body as string) as { ids: number[] })
          : { ids: [] };
        return body.ids;
      })
      .filter((v): v is number[] => v !== null);
  }

  it('POSTs visible story ids to /api/warm-summaries as rows appear', async () => {
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [
        id,
        makeStory(id, { title: `Story ${id}`, url: `https://ex.test/${id}` }),
      ]),
    );
    const fetchMock = installHNFetchMock({
      feeds: { topstories: ids },
      items,
    });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    await waitFor(() => {
      const warmed = new Set(readWarmCalls(fetchMock).flat());
      expect(warmed.has(10)).toBe(true);
      expect(warmed.has(20)).toBe(true);
      expect(warmed.has(30)).toBe(true);
    });
  });

  it('does not warm self-posts (stories with no url)', async () => {
    const ids = [40, 41];
    const items = {
      40: makeStory(40, { url: 'https://ex.test/40' }),
      // Ask HN style: no url, has text.
      41: makeStory(41, { url: undefined, text: 'Ask HN body' }),
    };
    const fetchMock = installHNFetchMock({
      feeds: { topstories: ids },
      items,
    });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    await waitFor(() => {
      const warmed = new Set(readWarmCalls(fetchMock).flat());
      expect(warmed.has(40)).toBe(true);
    });
    // Flush the 200ms debounce and any follow-up batches.
    await new Promise((r) => setTimeout(r, 300));
    const warmed = new Set(readWarmCalls(fetchMock).flat());
    expect(warmed.has(41)).toBe(false);
  });

  it('does not re-warm a story that was already warmed this session', async () => {
    const ids = [50];
    const items = { 50: makeStory(50, { url: 'https://ex.test/50' }) };
    const fetchMock = installHNFetchMock({
      feeds: { topstories: ids },
      items,
    });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(1);
    });
    await waitFor(() => {
      const count = readWarmCalls(fetchMock)
        .flat()
        .filter((id) => id === 50).length;
      expect(count).toBe(1);
    });

    // Let any additional debounce cycles pass — the hook should not
    // re-enqueue an id it already sent, even if IntersectionObserver
    // fires for it again.
    await new Promise((r) => setTimeout(r, 400));
    const after = readWarmCalls(fetchMock)
      .flat()
      .filter((id) => id === 50).length;
    expect(after).toBe(1);
  });

  it('does not break when IntersectionObserver is unavailable', async () => {
    uninstallIntersectionObserverMock();
    const orig = (globalThis as { IntersectionObserver?: unknown })
      .IntersectionObserver;
    delete (globalThis as { IntersectionObserver?: unknown })
      .IntersectionObserver;
    try {
      const ids = [60];
      const items = { 60: makeStory(60, { url: 'https://ex.test/60' }) };
      installHNFetchMock({ feeds: { topstories: ids }, items });
      renderWithProviders(<StoryList feed="top" />);
      await waitFor(() => {
        expect(screen.getAllByTestId('story-row')).toHaveLength(1);
      });
    } finally {
      if (orig) {
        (globalThis as { IntersectionObserver?: unknown })
          .IntersectionObserver = orig;
      }
    }
  });
});
