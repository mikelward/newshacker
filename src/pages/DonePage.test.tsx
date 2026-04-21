import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { DonePage } from './DonePage';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addDoneId } from '../lib/doneStories';

describe('<DonePage>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows an empty state when nothing is done', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<DonePage />);
    expect(screen.getByText(/Nothing marked done yet/i)).toBeInTheDocument();
  });

  it('shows done stories', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'Alpha' }),
        2: makeStory(2, { title: 'Beta' }),
      },
    });
    addDoneId(1);
    addDoneId(2);

    renderWithProviders(<DonePage />);

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  it('unmark done removes the row and writes a tombstone', async () => {
    installHNFetchMock({
      items: { 5: makeStory(5, { title: 'Five' }) },
    });
    addDoneId(5);

    renderWithProviders(<DonePage />);
    await waitFor(() => {
      expect(screen.getByText('Five')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /unmark done/i }));
    });

    await waitFor(() => {
      expect(screen.queryByText('Five')).toBeNull();
    });

    const stored = window.localStorage.getItem('newshacker:doneStoryIds');
    const parsed = stored
      ? (JSON.parse(stored) as Array<{ id: number; deleted?: true }>)
      : [];
    expect(parsed.filter((e) => !e.deleted)).toEqual([]);
  });

  it('orders done stories newest first by completion time', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'One' }),
        2: makeStory(2, { title: 'Two' }),
      },
    });
    const now = Date.now();
    addDoneId(1, now - 2000);
    addDoneId(2, now - 1000);

    renderWithProviders(<DonePage />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('story-row');
    expect(rows[0]).toHaveTextContent('Two');
    expect(rows[1]).toHaveTextContent('One');
  });

  it('does not show a Forget all button when nothing is done', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<DonePage />);
    expect(
      screen.queryByRole('button', { name: /forget all done/i }),
    ).toBeNull();
  });

  it('Forget all clears every done story after confirmation', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'Alpha' }),
        2: makeStory(2, { title: 'Beta' }),
      },
    });
    addDoneId(1);
    addDoneId(2);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithProviders(<DonePage />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /forget all done/i }),
      );
    });

    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/forget all 2 done stories/i),
    );
    await waitFor(() => {
      expect(screen.getByText(/Nothing marked done yet/i)).toBeInTheDocument();
    });
    expect(window.localStorage.getItem('newshacker:doneStoryIds')).toBe('[]');
  });

  it('Forget all is a no-op when the user cancels the confirmation', async () => {
    installHNFetchMock({
      items: { 1: makeStory(1, { title: 'Alpha' }) },
    });
    addDoneId(1);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderWithProviders(<DonePage />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /forget all done/i }),
      );
    });

    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});
