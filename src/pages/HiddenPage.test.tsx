import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { HiddenPage } from './HiddenPage';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addHiddenId } from '../lib/hiddenStories';
import { addOpenedId } from '../lib/openedStories';

describe('<HiddenPage>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows an empty state when nothing is hidden', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<HiddenPage />);
    expect(screen.getByText(/Nothing hidden/i)).toBeInTheDocument();
  });

  it('shows hidden-but-not-opened stories', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'Alpha' }),
        2: makeStory(2, { title: 'Beta' }),
      },
    });
    addHiddenId(1);
    addHiddenId(2);
    addOpenedId(2);

    renderWithProviders(<HiddenPage />);

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('unhide removes the row and its hidden record', async () => {
    installHNFetchMock({
      items: { 5: makeStory(5, { title: 'Five' }) },
    });
    addHiddenId(5);

    renderWithProviders(<HiddenPage />);
    await waitFor(() => {
      expect(screen.getByText('Five')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /unhide/i }));
    });

    await waitFor(() => {
      expect(screen.queryByText('Five')).toBeNull();
    });

    const stored = window.localStorage.getItem(
      'newshacker:hiddenStoryIds',
    );
    const parsed = stored
      ? (JSON.parse(stored) as Array<{ id: number; deleted?: true }>)
      : [];
    expect(parsed.filter((e) => !e.deleted)).toEqual([]);
  });

  it('does not show a Forget all button when nothing is hidden', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<HiddenPage />);
    expect(
      screen.queryByRole('button', { name: /forget all hidden/i }),
    ).toBeNull();
  });

  it('Forget all clears every hidden story after confirmation', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'Alpha' }),
        2: makeStory(2, { title: 'Beta' }),
      },
    });
    addHiddenId(1);
    addHiddenId(2);
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);

    renderWithProviders(<HiddenPage />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /forget all hidden/i }),
      );
    });

    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/forget all 2 hidden stories/i),
    );
    await waitFor(() => {
      expect(screen.getByText(/Nothing hidden/i)).toBeInTheDocument();
    });
    expect(
      window.localStorage.getItem('newshacker:hiddenStoryIds'),
    ).toBe('[]');
  });

  it('Forget all is a no-op when the user cancels the confirmation', async () => {
    installHNFetchMock({
      items: { 1: makeStory(1, { title: 'Alpha' }) },
    });
    addHiddenId(1);
    vi.stubGlobal('confirm', vi.fn(() => false));

    renderWithProviders(<HiddenPage />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /forget all hidden/i }),
      );
    });

    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('Forget all does not touch pinned stories', async () => {
    installHNFetchMock({
      items: { 1: makeStory(1, { title: 'Alpha' }) },
    });
    addHiddenId(1);
    window.localStorage.setItem(
      'newshacker:pinnedStoryIds',
      JSON.stringify([{ id: 99, at: Date.now() }]),
    );
    vi.stubGlobal('confirm', vi.fn(() => true));

    renderWithProviders(<HiddenPage />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /forget all hidden/i }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/Nothing hidden/i)).toBeInTheDocument();
    });
    const pinned = window.localStorage.getItem('newshacker:pinnedStoryIds');
    expect(pinned).not.toBeNull();
    expect(JSON.parse(pinned as string)).toHaveLength(1);
  });

  // Hide shields against Pin: the menu "Pin" item must not appear on
  // a hidden row. Without this, swipe-left or menu "Pin" on /hidden
  // would recreate the pin ∩ hidden collision the rest of the shield
  // rule exists to prevent. See SPEC.md under *Pinned vs. Favorite
  // vs. Done*.
  it('does not show a Pin menu item on hidden rows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installHNFetchMock({
      items: { 5: makeStory(5, { title: 'Five' }) },
    });
    addHiddenId(5);

    renderWithProviders(<HiddenPage />);
    await waitFor(() => {
      expect(screen.getByText('Five')).toBeInTheDocument();
    });

    const row = screen.getByTestId('story-row');
    // Long-press to open the row menu.
    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(down, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
      button: 0,
      isPrimary: true,
    });
    act(() => {
      row.dispatchEvent(down);
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // Share (and Hide, if present) may render, but Pin must not.
    expect(screen.queryByTestId('story-row-menu-pin')).toBeNull();
    expect(screen.queryByTestId('story-row-menu-unpin')).toBeNull();
    vi.useRealTimers();
  });

  it('orders hidden stories newest first by hide time', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'One' }),
        2: makeStory(2, { title: 'Two' }),
      },
    });
    const now = Date.now();
    addHiddenId(1, now - 2000);
    addHiddenId(2, now - 1000);

    renderWithProviders(<HiddenPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('story-row');
    expect(rows[0]).toHaveTextContent('Two');
    expect(rows[1]).toHaveTextContent('One');
  });
});
