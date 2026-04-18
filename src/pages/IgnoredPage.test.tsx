import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { IgnoredPage } from './IgnoredPage';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addDismissedId } from '../lib/dismissedStories';
import { addOpenedId } from '../lib/openedStories';

describe('<IgnoredPage>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows an empty state when nothing is ignored', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<IgnoredPage />);
    expect(screen.getByText(/Nothing ignored/i)).toBeInTheDocument();
  });

  it('shows dismissed-but-not-opened stories', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'Alpha' }),
        2: makeStory(2, { title: 'Beta' }),
      },
    });
    addDismissedId(1);
    addDismissedId(2);
    addOpenedId(2);

    renderWithProviders(<IgnoredPage />);

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('un-ignore removes the row and its dismissed record', async () => {
    installHNFetchMock({
      items: { 5: makeStory(5, { title: 'Five' }) },
    });
    addDismissedId(5);

    renderWithProviders(<IgnoredPage />);
    await waitFor(() => {
      expect(screen.getByText('Five')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /un-ignore/i }));
    });

    await waitFor(() => {
      expect(screen.queryByText('Five')).toBeNull();
    });

    expect(
      window.localStorage.getItem('newshacker:dismissedStoryIds'),
    ).toBe('[]');
  });

  it('does not show a Forget all button when nothing is ignored', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<IgnoredPage />);
    expect(
      screen.queryByRole('button', { name: /forget all ignored/i }),
    ).toBeNull();
  });

  it('Forget all clears every ignored story after confirmation', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'Alpha' }),
        2: makeStory(2, { title: 'Beta' }),
      },
    });
    addDismissedId(1);
    addDismissedId(2);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithProviders(<IgnoredPage />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /forget all ignored/i }),
      );
    });

    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/forget all 2 ignored stories/i),
    );
    await waitFor(() => {
      expect(screen.getByText(/Nothing ignored/i)).toBeInTheDocument();
    });
    expect(
      window.localStorage.getItem('newshacker:dismissedStoryIds'),
    ).toBe('[]');
  });

  it('Forget all is a no-op when the user cancels the confirmation', async () => {
    installHNFetchMock({
      items: { 1: makeStory(1, { title: 'Alpha' }) },
    });
    addDismissedId(1);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderWithProviders(<IgnoredPage />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /forget all ignored/i }),
      );
    });

    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('Forget all does not touch saved stories', async () => {
    installHNFetchMock({
      items: { 1: makeStory(1, { title: 'Alpha' }) },
    });
    addDismissedId(1);
    window.localStorage.setItem(
      'newshacker:savedStoryIds',
      JSON.stringify([{ id: 99, at: Date.now() }]),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithProviders(<IgnoredPage />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /forget all ignored/i }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/Nothing ignored/i)).toBeInTheDocument();
    });
    const saved = window.localStorage.getItem('newshacker:savedStoryIds');
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved as string)).toHaveLength(1);
  });

  it('orders ignored stories newest first by dismissal time', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'One' }),
        2: makeStory(2, { title: 'Two' }),
      },
    });
    const now = Date.now();
    addDismissedId(1, now - 2000);
    addDismissedId(2, now - 1000);

    renderWithProviders(<IgnoredPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('story-row');
    expect(rows[0]).toHaveTextContent('Two');
    expect(rows[1]).toHaveTextContent('One');
  });
});
