import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('<Comment> action toolbar', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('is hidden while the comment is collapsed', async () => {
    installHNFetchMock({ items: { 9100: commentFixture(9100) } });
    renderWithProviders(<Comment id={9100} />);

    await waitFor(() => {
      expect(screen.getByText('body 9100')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('comment-upvote')).toBeNull();
    expect(screen.queryByTestId('comment-downvote')).toBeNull();
    expect(screen.queryByTestId('comment-reply')).toBeNull();
  });

  it('renders upvote, downvote, and reply controls when expanded', async () => {
    installHNFetchMock({ items: { 9101: commentFixture(9101) } });
    renderWithProviders(<Comment id={9101} />);

    await waitFor(() => {
      expect(screen.getByText('body 9101')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: /expand comment/i }),
      );
    });

    const upvote = await screen.findByTestId('comment-upvote');
    const downvote = screen.getByTestId('comment-downvote');
    const reply = screen.getByTestId('comment-reply');

    expect(upvote).toHaveAttribute('aria-label', 'Upvote');
    expect(downvote).toHaveAttribute('aria-label', 'Downvote');
    expect(reply).toHaveAttribute('aria-label', 'Reply on HN');
    expect(reply).toHaveAttribute(
      'href',
      'https://news.ycombinator.com/reply?id=9101',
    );
    expect(reply).toHaveAttribute('target', '_blank');
    expect(reply).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('tapping upvote or downvote does not collapse the comment', async () => {
    installHNFetchMock({ items: { 9102: commentFixture(9102) } });
    renderWithProviders(<Comment id={9102} />);

    await waitFor(() => {
      expect(screen.getByText('body 9102')).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByRole('button', { name: /expand comment/i }),
    );

    expect(
      screen.getByRole('button', { name: /collapse comment/i }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('comment-upvote'));
    expect(
      screen.getByRole('button', { name: /collapse comment/i }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('comment-downvote'));
    expect(
      screen.getByRole('button', { name: /collapse comment/i }),
    ).toBeInTheDocument();
  });
});
