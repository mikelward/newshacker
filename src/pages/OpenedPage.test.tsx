import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { OpenedPage } from './OpenedPage';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addOpenedId } from '../lib/openedStories';

describe('<OpenedPage>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows an empty state when nothing is opened', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<OpenedPage />);
    expect(
      screen.getByText(/haven't opened any stories/i),
    ).toBeInTheDocument();
  });

  it('lists opened stories newest first', async () => {
    installHNFetchMock({
      items: {
        11: makeStory(11, { title: 'Eleven' }),
        22: makeStory(22, { title: 'Twenty-two' }),
      },
    });
    const now = Date.now();
    addOpenedId(11, now - 2000);
    addOpenedId(22, now - 1000);

    renderWithProviders(<OpenedPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('story-row');
    expect(rows[0]).toHaveTextContent('Twenty-two');
    expect(rows[1]).toHaveTextContent('Eleven');
  });

  it('does not show a Forget all button when nothing is opened', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<OpenedPage />);
    expect(
      screen.queryByRole('button', { name: /forget all opened/i }),
    ).toBeNull();
  });

  it('Forget all clears opened history after confirmation', async () => {
    installHNFetchMock({
      items: {
        11: makeStory(11, { title: 'Eleven' }),
        22: makeStory(22, { title: 'Twenty-two' }),
      },
    });
    addOpenedId(11);
    addOpenedId(22);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithProviders(<OpenedPage />);
    await waitFor(() => {
      expect(screen.getByText('Eleven')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /forget all opened/i }),
      );
    });

    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/forget all 2 opened stories/i),
    );
    await waitFor(() => {
      expect(
        screen.getByText(/haven't opened any stories/i),
      ).toBeInTheDocument();
    });
    expect(
      window.localStorage.getItem('newshacker:openedStoryIds'),
    ).toBe('[]');
  });

  it('Forget all is a no-op when the user cancels', async () => {
    installHNFetchMock({
      items: { 7: makeStory(7, { title: 'Seven' }) },
    });
    addOpenedId(7);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderWithProviders(<OpenedPage />);
    await waitFor(() => {
      expect(screen.getByText('Seven')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /forget all opened/i }),
      );
    });

    expect(screen.getByText('Seven')).toBeInTheDocument();
  });

  it('Forget all does not touch dismissed or saved stores', async () => {
    installHNFetchMock({
      items: { 7: makeStory(7, { title: 'Seven' }) },
    });
    addOpenedId(7);
    window.localStorage.setItem(
      'newshacker:dismissedStoryIds',
      JSON.stringify([{ id: 88, at: Date.now() }]),
    );
    window.localStorage.setItem(
      'newshacker:savedStoryIds',
      JSON.stringify([{ id: 99, at: Date.now() }]),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithProviders(<OpenedPage />);
    await waitFor(() => {
      expect(screen.getByText('Seven')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /forget all opened/i }),
      );
    });

    await waitFor(() => {
      expect(
        screen.getByText(/haven't opened any stories/i),
      ).toBeInTheDocument();
    });
    const dismissed = window.localStorage.getItem(
      'newshacker:dismissedStoryIds',
    );
    const saved = window.localStorage.getItem('newshacker:savedStoryIds');
    expect(JSON.parse(dismissed as string)).toHaveLength(1);
    expect(JSON.parse(saved as string)).toHaveLength(1);
  });

  it('renders opened rows with the opened modifier class', async () => {
    installHNFetchMock({
      items: { 7: makeStory(7, { title: 'Seven' }) },
    });
    addOpenedId(7);

    renderWithProviders(<OpenedPage />);
    await waitFor(() => {
      expect(screen.getByTestId('story-row')).toBeInTheDocument();
    });
    const className = screen.getByTestId('story-row').className;
    expect(className).toContain('story-row--title-opened');
    expect(className).toContain('story-row--comments-opened');
  });
});
