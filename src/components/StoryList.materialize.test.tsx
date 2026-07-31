import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addPinnedId } from '../lib/pinnedStories';
import { addDoneId } from '../lib/doneStories';
import {
  installIntersectionObserverMock,
  uninstallIntersectionObserverMock,
} from '../test/intersectionObserver';

// Behaviors of the frozen "materialized set" (see src/lib/feedSnapshot.ts):
// remote changes overlay in place, local dismiss collapses, navigation
// compacts, More appends.

function titles(): string[] {
  return screen
    .getAllByTestId('story-row')
    .map((row) => row.querySelector('.story-row__title-text')?.textContent ?? '');
}

function stubWideViewport(wide: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes('min-width: 960px') ? wide : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function threeStoryFeed() {
  installHNFetchMock({
    feeds: { topstories: [1, 2, 3] },
    items: {
      1: makeStory(1, { title: 'One' }),
      2: makeStory(2, { title: 'Two' }),
      3: makeStory(3, { title: 'Three' }),
    },
  });
}

describe('<StoryList> materialized set', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installIntersectionObserverMock();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    uninstallIntersectionObserverMock();
  });

  it('shows a server pin in place with a badge — no reorder to the top', async () => {
    threeStoryFeed();
    renderWithProviders(<StoryList feed="top" />);
    await waitFor(() => expect(titles()).toEqual(['One', 'Two', 'Three']));

    // A pin arrives from another device (a store change, not a row tap).
    act(() => {
      addPinnedId(2);
    });

    // The row picks up the pressed pin badge but keeps its position — it
    // does not jump into the top block under the reader.
    await waitFor(() => {
      const row = screen.getByText('Two').closest('li')!;
      expect(within(row).getByTestId('pin-btn')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(titles()).toEqual(['One', 'Two', 'Three']);
  });

  it('grays a server dismiss (Done) in place — struck-through, not removed', async () => {
    threeStoryFeed();
    renderWithProviders(<StoryList feed="top" />);
    await waitFor(() => expect(titles()).toEqual(['One', 'Two', 'Three']));

    // A Done arrives from another device.
    act(() => {
      addDoneId(2);
    });

    // The row stays in place, struck-through (dimmed) — not removed.
    await waitFor(() => {
      const row = screen.getByText('Two').closest('article')!;
      expect(row.className).toContain('story-row--dimmed');
    });
    expect(titles()).toEqual(['One', 'Two', 'Three']);
  });

  it('removes and collapses on the reader’s own dismiss from a feed row', async () => {
    const restore = stubWideViewport(true); // wide viewport shows the row Done button
    try {
      threeStoryFeed();
      renderWithProviders(<StoryList feed="top" />);
      await waitFor(() => expect(titles()).toEqual(['One', 'Two', 'Three']));

      // Tap the row's own Done button — removes the row immediately.
      const row = screen.getByText('Two').closest('li')!;
      fireEvent.click(within(row).getByTestId('done-btn'));

      await waitFor(() => expect(titles()).toEqual(['One', 'Three']));
    } finally {
      restore();
    }
  });

  it('compacts pending server dismisses on a navigation return (remount)', async () => {
    threeStoryFeed();
    const { client, unmount } = renderWithProviders(<StoryList feed="top" />);
    await waitFor(() => expect(titles()).toEqual(['One', 'Two', 'Three']));

    // A Done syncs in from another device — grays in place, stays put.
    act(() => {
      addDoneId(2);
    });
    await waitFor(() => {
      const row = screen.getByText('Two').closest('article')!;
      expect(row.className).toContain('story-row--dimmed');
    });

    // Navigate away and back (remount the same feed, same query cache).
    unmount();
    renderWithProviders(<StoryList feed="top" />, { client });

    // The compacted return drops the finished row and collapses the gap.
    await waitFor(() => expect(titles()).toEqual(['One', 'Three']));
  });

  it('reflects an unpinned top-block row as unpinned (button flips, re-pin works)', async () => {
    // Pin story 2 before mount so it materializes into the top block while
    // still present in the loaded feed.
    addPinnedId(2);
    threeStoryFeed();
    renderWithProviders(<StoryList feed="top" />);
    await waitFor(() => expect(titles()).toEqual(['Two', 'One', 'Three']));

    const topRow = () => screen.getAllByTestId('story-row')[0];
    expect(within(topRow()).getByTestId('pin-btn')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Unpin from the top row: it stays in place (frozen) but the button
    // must flip to "Pin" so the action registers and the row can be
    // re-pinned — not stuck showing "Unpin" until the next materialize.
    fireEvent.click(within(topRow()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(within(topRow()).getByTestId('pin-btn')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });
    expect(titles()).toEqual(['Two', 'One', 'Three']); // still in place

    // Re-pin works from the same row.
    fireEvent.click(within(topRow()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(within(topRow()).getByTestId('pin-btn')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });

  it('More appends the next page below without reordering the top', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    installHNFetchMock({
      feeds: { topstories: ids },
      items: Object.fromEntries(
        ids.map((id) => [id, makeStory(id, { title: `S${id}` })]),
      ),
    });
    renderWithProviders(<StoryList feed="top" />);
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(30),
    );
    const firstThirty = titles();
    expect(firstThirty[0]).toBe('S1');

    fireEvent.click(screen.getByRole('button', { name: /^more$/i }));
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(60),
    );

    // The first page is untouched; the second page is appended in order.
    const all = titles();
    expect(all.slice(0, 30)).toEqual(firstThirty);
    expect(all[30]).toBe('S31');
    expect(all[59]).toBe('S60');
  });
});
