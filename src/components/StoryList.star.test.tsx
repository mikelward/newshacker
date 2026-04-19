import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { StoryList } from './StoryList';
import { AppHeader } from './AppHeader';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addSavedId } from '../lib/savedStories';

describe('<StoryList> star (save) and sweep', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('tapping a star saves (and untaps unsaves) without firing a toast', async () => {
    const ids = [10, 20];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    const rows = screen.getAllByTestId('story-row');
    const target = rows[0];
    const star = within(target).getByTestId('star-btn');
    expect(star).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(star);

    expect(star).toHaveAttribute('aria-pressed', 'true');
    const stored = window.localStorage.getItem('newshacker:savedStoryIds');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as Array<{ id: number }>;
    expect(parsed.map((e) => e.id)).toContain(10);

    // No save/unsave toast should be rendered — the star button is the
    // single source of truth for saved state.
    const toastHost = screen.queryByTestId('toast-host');
    if (toastHost) {
      expect(within(toastHost).queryByText('Saved')).toBeNull();
    }

    // Tapping again unsaves, still no toast, persistence matches.
    fireEvent.click(star);
    expect(star).toHaveAttribute('aria-pressed', 'false');
    expect(window.localStorage.getItem('newshacker:savedStoryIds')).toBe('[]');
  });

  it('sweep button dismisses unstarred stories and keeps starred ones', async () => {
    const ids = [1, 2, 3, 4];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    addSavedId(2);

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(4);
    });

    const sweep = screen.getByTestId('sweep-btn');
    expect(sweep).toHaveAccessibleName(/dismiss 3 unstarred/i);
    expect(sweep).not.toBeDisabled();

    fireEvent.click(sweep);

    await waitFor(() => {
      expect(screen.queryByText('Story 1')).toBeNull();
      expect(screen.queryByText('Story 3')).toBeNull();
      expect(screen.queryByText('Story 4')).toBeNull();
    });
    expect(screen.getByText('Story 2')).toBeInTheDocument();
    // Once nothing is left to sweep, the button stays put but disables.
    expect(screen.getByTestId('sweep-btn')).toBeDisabled();
  });

  it('disables the sweep button when the whole list is empty', async () => {
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    });
    expect(screen.getByTestId('sweep-btn')).toBeDisabled();
  });

  it('disables the sweep button when every story is starred', async () => {
    const ids = [11, 22];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    addSavedId(11);
    addSavedId(22);

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    expect(screen.getByTestId('sweep-btn')).toBeDisabled();
  });

  it('toggling Show Dismissed reveals dismissed rows inline, marked dismissed', async () => {
    const ids = [1, 2, 3];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    window.localStorage.setItem(
      'newshacker:dismissedStoryIds',
      JSON.stringify([{ id: 2, at: Date.now() }]),
    );

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    expect(screen.queryByText('Story 2')).toBeNull();

    const toggle = screen.getByTestId('show-dismissed-btn');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    const rows = screen.getAllByTestId('story-row');
    const dismissedRow = rows.find((r) =>
      r.textContent?.includes('Story 2'),
    )!;
    expect(dismissedRow.className).toContain('story-row--dismissed');
  });

  it('tapping a dismissed row (when shown) un-dismisses it', async () => {
    const ids = [1, 2];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    window.localStorage.setItem(
      'newshacker:dismissedStoryIds',
      JSON.stringify([{ id: 2, at: Date.now() }]),
    );

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );

    fireEvent.click(screen.getByTestId('show-dismissed-btn'));

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    const rows = screen.getAllByTestId('story-row');
    const dismissedRow = rows.find((r) =>
      r.textContent?.includes('Story 2'),
    )!;
    fireEvent.click(within(dismissedRow).getByTestId('story-title'));

    await waitFor(() => {
      const stored = window.localStorage.getItem(
        'newshacker:dismissedStoryIds',
      );
      const parsed = stored
        ? (JSON.parse(stored) as Array<{ id: number }>)
        : [];
      expect(parsed.map((e) => e.id)).not.toContain(2);
    });
  });
});
