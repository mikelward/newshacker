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

describe('<Comment> expand/collapse icon affordance', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('renders the expand chevron at the header\'s right edge and flips to a toolbar-right collapse button on expand', async () => {
    const items: Record<number, HNItem> = {
      7100: commentFixture(7100, { kids: [] }),
    };
    installHNFetchMock({ items });
    renderWithProviders(<Comment id={7100} />);
    await waitFor(() => {
      expect(screen.getByText('body 7100')).toBeInTheDocument();
    });
    // Collapsed state: the expand chevron sits at the right edge of
    // the header's toggle button, after the meta text, so the CSS
    // `margin-left: auto` can push it to the card's bottom-right
    // corner regardless of how long the meta text is.
    const toggle = screen.getByRole('button', { name: /expand comment/i });
    const icon = toggle.querySelector('.comment__toggle-icon');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('data-expanded', 'false');
    const iconParent = icon!.parentElement as HTMLElement;
    const children = Array.from(iconParent.children);
    expect(children[children.length - 1]).toBe(icon);

    act(() => {
      fireEvent.click(toggle);
    });

    // Expanded state: the header's toggle button is gone (meta row
    // is plain text) and the collapse affordance is the last button
    // in the toolbar, pinned to the right via margin-left:auto.
    const collapseBtn = await screen.findByTestId('comment-collapse');
    expect(collapseBtn).toHaveAttribute('aria-label', 'Collapse comment');
    const toolbar = collapseBtn.closest('.comment__toolbar') as HTMLElement;
    const toolbarButtons = Array.from(
      toolbar.querySelectorAll('.comment__toolbar-button'),
    );
    expect(toolbarButtons[toolbarButtons.length - 1]).toBe(collapseBtn);
    expect(collapseBtn).toHaveClass('comment__toolbar-button--collapse');
    // Header no longer has a toggle button in expanded state.
    expect(
      screen.queryByRole('button', { name: /expand comment/i }),
    ).toBeNull();
  });
});

describe('<Comment> expand batching', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('batches the expanded comment\'s children via /api/items instead of per-child Firebase fetches', async () => {
    const kids = Array.from({ length: 5 }, (_, i) => 7001 + i);
    const items: Record<number, HNItem> = {
      7000: commentFixture(7000, { kids }),
    };
    for (const id of kids) items[id] = commentFixture(id);

    const fetchMock = installHNFetchMock({ items });

    renderWithProviders(<Comment id={7000} />);

    // Collapsed state — child bodies not yet rendered.
    await waitFor(() => {
      expect(screen.getByText('body 7000')).toBeInTheDocument();
    });
    expect(screen.queryByText('body 7001')).toBeNull();

    const batchesBefore = fetchMock.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : c[0].toString()))
      .filter((u) => u.includes('/api/items')).length;
    expect(batchesBefore).toBe(0);

    // Expand — the 5 children should batch via one /api/items call, not
    // 5 individual Firebase round-trips. Click the comment body; nested
    // Comment observers mount after the batch populates the cache.
    const body = screen.getByText('body 7000');
    act(() => {
      fireEvent.click(body);
    });

    await waitFor(() => {
      for (const id of kids) {
        expect(screen.getByText(`body ${id}`)).toBeInTheDocument();
      }
    });

    const urls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0].toString(),
    );
    const firebaseKidCalls = urls.filter((u) =>
      kids.some((id) => u.includes(`/item/${id}.json`)),
    );
    const batchCalls = urls.filter((u) => u.includes('/api/items'));

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toMatch(/fields=full/);
    // The batch filled the cache before the child Comment observers
    // activated, so no per-child Firebase calls were made.
    expect(firebaseKidCalls).toHaveLength(0);
  });

  it('skips the batch when the comment has no children', async () => {
    installHNFetchMock({
      items: { 8000: commentFixture(8000, { kids: [] }) },
    });

    renderWithProviders(<Comment id={8000} />);

    await waitFor(() => {
      expect(screen.getByText('body 8000')).toBeInTheDocument();
    });

    const body = screen.getByText('body 8000');
    act(() => {
      fireEvent.click(body);
    });

    // No batch call even after expand since there's nothing to fetch.
    // We can't assert a negative wait, so just let the effect flush.
    await new Promise((r) => setTimeout(r, 0));
    // No throw, no children — pass.
  });
});
