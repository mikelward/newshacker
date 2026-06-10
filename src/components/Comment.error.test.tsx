import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Comment } from './Comment';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock } from '../test/mockFetch';
import type { HNItem } from '../lib/hn';

function commentFixture(id: number, overrides: Partial<HNItem> = {}): HNItem {
  return {
    id,
    type: 'comment',
    by: 'alice',
    text: `body ${id}`,
    time: 1_700_000_000,
    kids: [],
    ...overrides,
  };
}

describe('<Comment> load-failure state', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('shows a retryable error card (not a perpetual loading card) when Firebase resolves the comment to null', async () => {
    // Regression: a transient Firebase null used to be cached as fresh
    // data for the 7-day staleTime, leaving the comment as an endless
    // "…" card with no way to recover.
    installHNFetchMock({ items: {} });
    renderWithProviders(<Comment id={9100} />);

    await waitFor(() => {
      expect(
        screen.getByText(/couldn't load this comment/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
    expect(document.querySelector('.comment--loading')).toBeNull();
  });

  it('shows the same error card when the fetch itself rejects', async () => {
    const fetchMock = installHNFetchMock({ items: {} });
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'));
    renderWithProviders(<Comment id={9200} />);

    await waitFor(() => {
      expect(
        screen.getByText(/couldn't load this comment/i),
      ).toBeInTheDocument();
    });
  });

  it('recovers via the Retry button once the API serves the comment again', async () => {
    const items: Record<number, HNItem> = {};
    installHNFetchMock({ items });
    renderWithProviders(<Comment id={9300} />);

    const retry = await screen.findByRole('button', { name: /retry/i });

    // Upstream comes back: the same mock now resolves the item.
    items[9300] = commentFixture(9300);
    act(() => {
      fireEvent.click(retry);
    });

    await waitFor(() => {
      expect(screen.getByText('body 9300')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
