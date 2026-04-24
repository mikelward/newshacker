import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { StoryListItem } from './StoryListItem';
import { renderWithProviders } from '../test/renderUtils';
import type { HNItem } from '../lib/hn';

const baseStory: HNItem = {
  id: 1,
  type: 'story',
  title: 'A story title',
  url: 'https://example.com/post',
  by: 'alice',
  score: 42,
  descendants: 7,
  time: Math.floor(Date.now() / 1000) - 3600,
};

describe('StoryListItem', () => {
  it('links the row to /item/:id for URL stories (article opens from the thread page)', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const title = screen.getByTestId('story-title');
    expect(title).toHaveAttribute('href', '/item/1');
    expect(title).not.toHaveAttribute('target');
  });

  it('links the row to /item/:id for self-posts (no url)', () => {
    const selfPost: HNItem = { ...baseStory, url: undefined };
    renderWithProviders(<StoryListItem story={selfPost} />);
    const title = screen.getByTestId('story-title');
    expect(title).toHaveAttribute('href', '/item/1');
    expect(title).not.toHaveAttribute('target');
  });

  it('shows a "self post" placeholder where the domain would go for self-posts', () => {
    const selfPost: HNItem = { ...baseStory, url: undefined };
    renderWithProviders(<StoryListItem story={selfPost} />);
    expect(screen.getByTestId('story-row')).toHaveTextContent(/self post/i);
  });

  it('shows the domain in the meta row for URL stories', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    expect(screen.getByTestId('story-meta')).toHaveTextContent(/example\.com/);
  });

  it('renders the comment count in the meta row (no separate comments button)', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    expect(screen.getByTestId('story-meta')).toHaveTextContent(/7 comments/);
    expect(screen.queryByTestId('comments-btn')).toBeNull();
  });

  it('combines new and total counts as "n/m comments" when the current count exceeds the last seen count', () => {
    renderWithProviders(
      <StoryListItem story={baseStory} seenCommentCount={4} />,
    );
    // baseStory has 7 comments; last seen was 4 → 3 new.
    expect(screen.getByTestId('story-meta')).toHaveTextContent(/3\/7 comments/);
    expect(screen.getByTestId('story-meta')).not.toHaveTextContent(/\bnew\b/);
  });

  it('shows the plain "M comments" form when the user has never opened the thread', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    expect(screen.getByTestId('story-meta')).toHaveTextContent(/7 comments/);
    expect(screen.getByTestId('story-meta')).not.toHaveTextContent('/');
  });

  it('shows the plain "M comments" form when the seen count already matches the current count', () => {
    renderWithProviders(
      <StoryListItem story={baseStory} seenCommentCount={7} />,
    );
    expect(screen.getByTestId('story-meta')).toHaveTextContent(/7 comments/);
    expect(screen.getByTestId('story-meta')).not.toHaveTextContent('/');
  });

  it('shows the plain "M comments" form when comments were deleted (seen count exceeds current)', () => {
    renderWithProviders(
      <StoryListItem story={baseStory} seenCommentCount={10} />,
    );
    expect(screen.getByTestId('story-meta')).toHaveTextContent(/7 comments/);
    expect(screen.getByTestId('story-meta')).not.toHaveTextContent('/');
  });

  it('trims long hostnames to the registrable domain', () => {
    const story: HNItem = {
      ...baseStory,
      url: 'https://fingfx.thomsonreuters.com/a',
    };
    renderWithProviders(<StoryListItem story={story} />);
    const meta = screen.getByTestId('story-meta');
    expect(meta).toHaveTextContent(/thomsonreuters\.com/);
    expect(meta.textContent ?? '').not.toContain('fingfx');
  });

  it('keeps nested ccTLDs intact (9news.com.au stays 9news.com.au)', () => {
    const story: HNItem = {
      ...baseStory,
      url: 'https://www.9news.com.au/path',
    };
    renderWithProviders(<StoryListItem story={story} />);
    expect(screen.getByTestId('story-meta')).toHaveTextContent(
      /9news\.com\.au/,
    );
  });

  describe('swipe-reveal hint labels', () => {
    it('renders a "Pinned" shield hint on the left edge of pinned rows (revealed by finger-pushing-right)', () => {
      renderWithProviders(<StoryListItem story={baseStory} pinned />);
      const hint = screen.getByTestId('swipe-hint-pinned-left');
      expect(hint).toHaveTextContent('Pinned');
      expect(hint).toHaveClass('story-row__swipe-hint--left');
      expect(hint).toHaveAttribute('aria-hidden', 'true');
    });

    it('also renders a "Pinned" shield hint on the right edge of pinned rows (revealed by finger-pushing-left)', () => {
      // Both swipe directions are shielded on pinned rows — the
      // rubber-band is symmetric, and so is the reveal label.
      renderWithProviders(<StoryListItem story={baseStory} pinned />);
      const hint = screen.getByTestId('swipe-hint-pinned-right');
      expect(hint).toHaveTextContent('Pinned');
      expect(hint).toHaveClass('story-row__swipe-hint--right');
    });

    it('renders a "Hidden" shield hint on hidden rows (right edge, revealed by finger-pushing-left)', () => {
      renderWithProviders(<StoryListItem story={baseStory} hidden />);
      const hint = screen.getByTestId('swipe-hint-hidden');
      expect(hint).toHaveTextContent('Hidden');
      expect(hint).toHaveClass('story-row__swipe-hint--right');
      expect(hint).toHaveAttribute('aria-hidden', 'true');
    });

    it('renders a "Hide" action hint on the left when onHide is wired on an unpinned row', () => {
      renderWithProviders(
        <StoryListItem story={baseStory} onHide={vi.fn()} />,
      );
      const hint = screen.getByTestId('swipe-hint-hide');
      expect(hint).toHaveTextContent('Hide');
      expect(hint).toHaveClass('story-row__swipe-hint--left');
    });

    it('renders a "Pin" action hint on the right when onPin is wired on an unpinned, unhidden row', () => {
      renderWithProviders(
        <StoryListItem story={baseStory} onPin={vi.fn()} />,
      );
      const hint = screen.getByTestId('swipe-hint-pin');
      expect(hint).toHaveTextContent('Pin');
      expect(hint).toHaveClass('story-row__swipe-hint--right');
    });

    it('shield wins: pinned rows show "Pinned" instead of "Hide" even when onHide is wired', () => {
      renderWithProviders(
        <StoryListItem story={baseStory} pinned onHide={vi.fn()} />,
      );
      expect(screen.getByTestId('swipe-hint-pinned-left')).toBeInTheDocument();
      expect(screen.queryByTestId('swipe-hint-hide')).toBeNull();
    });

    it('shield wins: hidden rows show "Hidden" instead of "Pin" even when onPin is wired', () => {
      renderWithProviders(
        <StoryListItem story={baseStory} hidden onPin={vi.fn()} />,
      );
      expect(screen.getByTestId('swipe-hint-hidden')).toBeInTheDocument();
      expect(screen.queryByTestId('swipe-hint-pin')).toBeNull();
    });

    it('shield wins: pinned rows show "Pinned" on the right edge instead of "Pin" (no re-pin via stray swipe)', () => {
      renderWithProviders(
        <StoryListItem story={baseStory} pinned onPin={vi.fn()} />,
      );
      expect(screen.getByTestId('swipe-hint-pinned-right')).toBeInTheDocument();
      expect(screen.queryByTestId('swipe-hint-pin')).toBeNull();
    });

    it('renders no hints on a row with no swipe handlers wired', () => {
      renderWithProviders(<StoryListItem story={baseStory} />);
      expect(screen.queryByTestId('swipe-hint-pinned-left')).toBeNull();
      expect(screen.queryByTestId('swipe-hint-pinned-right')).toBeNull();
      expect(screen.queryByTestId('swipe-hint-hidden')).toBeNull();
      expect(screen.queryByTestId('swipe-hint-hide')).toBeNull();
      expect(screen.queryByTestId('swipe-hint-pin')).toBeNull();
    });
  });

  it('renders a pin button that toggles pinned state via onPin / onUnpin', () => {
    const onPin = vi.fn();
    const onUnpin = vi.fn();
    const { unmount } = renderWithProviders(
      <StoryListItem
        story={baseStory}
        pinned={false}
        onPin={onPin}
        onUnpin={onUnpin}
      />,
    );
    const pin = screen.getByTestId('pin-btn');
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    expect(pin).toHaveAccessibleName(/^pin /i);
    fireEvent.click(pin);
    expect(onPin).toHaveBeenCalledWith(baseStory.id);
    expect(onUnpin).not.toHaveBeenCalled();
    unmount();

    onPin.mockReset();
    onUnpin.mockReset();
    renderWithProviders(
      <StoryListItem
        story={baseStory}
        pinned={true}
        onPin={onPin}
        onUnpin={onUnpin}
      />,
    );
    const pinAfter = screen.getByTestId('pin-btn');
    expect(pinAfter).toHaveAttribute('aria-pressed', 'true');
    expect(pinAfter).toHaveAccessibleName(/^unpin /i);
    fireEvent.click(pinAfter);
    expect(onUnpin).toHaveBeenCalledWith(baseStory.id);
    expect(onPin).not.toHaveBeenCalled();
  });

  it('does not render rank, past, web, flag, via, or inline author links', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const row = screen.getByTestId('story-row');
    const inner = row.innerHTML.toLowerCase();
    // "Hide" appears only as a long-press menu item (and only when onHide is
    // set), not as an inline link in the row chrome itself.
    expect(inner).not.toMatch(/\bpast\b/);
    expect(inner).not.toMatch(/\bflag\b/);
    expect(inner).not.toMatch(/\bvia\b/);
    // No author link in the row
    expect(within(row).queryByText('alice')).toBeNull();
  });

  it('does not render a vote button on story rows (voting lives on the thread page)', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    expect(screen.queryByRole('button', { name: /upvote/i })).toBeNull();
    expect(screen.queryByTestId('vote-btn')).toBeNull();
  });

  it('shows points and age as display-only text, not tappable', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const meta = screen.getByTestId('story-meta');
    expect(meta.tagName.toLowerCase()).toBe('span');
    expect(meta).toHaveTextContent(/42 points/);
  });

  it('renders the age next to the domain (before points/comments)', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const meta = screen.getByTestId('story-meta');
    expect(meta).toHaveTextContent(
      /example\.com · \S+ · 42 points · 7 comments/,
    );
  });

  it('handles missing title with a placeholder', () => {
    renderWithProviders(
      <StoryListItem story={{ ...baseStory, title: undefined }} />,
    );
    expect(screen.getByTestId('story-title')).toHaveTextContent('[untitled]');
  });

  it('marks the thread opened when the row is clicked', () => {
    const onOpenThread = vi.fn();
    renderWithProviders(
      <StoryListItem story={baseStory} onOpenThread={onOpenThread} />,
    );
    fireEvent.click(screen.getByTestId('story-title'));
    expect(onOpenThread).toHaveBeenCalledWith(baseStory.id);
  });

  it('does not fire onOpenThread when the pin button is tapped', () => {
    const onOpenThread = vi.fn();
    renderWithProviders(
      <StoryListItem
        story={baseStory}
        onOpenThread={onOpenThread}
        onPin={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('pin-btn'));
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  describe('rightAction override', () => {
    it('replaces the default pin button with the custom action', () => {
      renderWithProviders(
        <StoryListItem
          story={baseStory}
          onPin={vi.fn()}
          rightAction={{
            label: 'Unmark done',
            icon: <span data-testid="done-icon" />,
            onToggle: vi.fn(),
          }}
        />,
      );
      expect(screen.queryByTestId('pin-btn')).toBeNull();
      expect(screen.getByTestId('row-action-btn')).toBeInTheDocument();
      expect(screen.getByTestId('done-icon')).toBeInTheDocument();
    });

    it('uses the label as the button accessible name', () => {
      renderWithProviders(
        <StoryListItem
          story={baseStory}
          rightAction={{
            label: 'Unfavorite',
            icon: <span />,
            onToggle: vi.fn(),
          }}
        />,
      );
      const btn = screen.getByRole('button', { name: /unfavorite/i });
      expect(btn).toHaveAttribute('aria-label', 'Unfavorite');
    });

    it('fires onToggle on click and does not touch onPin/onUnpin', () => {
      const onToggle = vi.fn();
      const onPin = vi.fn();
      const onUnpin = vi.fn();
      renderWithProviders(
        <StoryListItem
          story={baseStory}
          onPin={onPin}
          onUnpin={onUnpin}
          rightAction={{
            label: 'Unhide',
            icon: <span />,
            onToggle,
          }}
        />,
      );
      fireEvent.click(screen.getByTestId('row-action-btn'));
      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(onPin).not.toHaveBeenCalled();
      expect(onUnpin).not.toHaveBeenCalled();
    });

    it('paints the button in the --active (orange) state', () => {
      renderWithProviders(
        <StoryListItem
          story={baseStory}
          rightAction={{
            label: 'Unmark done',
            icon: <span />,
            onToggle: vi.fn(),
          }}
        />,
      );
      const btn = screen.getByTestId('row-action-btn');
      expect(btn.className).toContain('pin-btn--active');
    });

    it('honors a custom testId when provided', () => {
      renderWithProviders(
        <StoryListItem
          story={baseStory}
          rightAction={{
            label: 'Unmark done',
            icon: <span />,
            onToggle: vi.fn(),
            testId: 'done-btn',
          }}
        />,
      );
      expect(screen.getByTestId('done-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('row-action-btn')).toBeNull();
    });
  });

  it('dims the row when the comments have been opened', () => {
    renderWithProviders(
      <StoryListItem story={baseStory} commentsOpened={true} />,
    );
    const row = screen.getByTestId('story-row');
    expect(row.className).toContain('story-row--opened');
  });

  it('dims the row when the article has been opened', () => {
    renderWithProviders(
      <StoryListItem story={baseStory} articleOpened={true} />,
    );
    const row = screen.getByTestId('story-row');
    expect(row.className).toContain('story-row--opened');
  });

  it('leaves the row unmodified when nothing has been opened', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const row = screen.getByTestId('story-row');
    expect(row.className).not.toContain('story-row--opened');
  });

  it('does not render a separate "Pinned" meta badge — the pin button shows pinned state', () => {
    renderWithProviders(<StoryListItem story={baseStory} pinned={true} />);
    expect(screen.queryByTestId('pinned-badge')).toBeNull();
    expect(screen.getByTestId('pin-btn')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('marks the row link as a stretched link so taps anywhere on the row open it', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    expect(screen.getByTestId('story-title').className).toContain(
      'story-row__body--stretched',
    );
  });

  describe('Hot flag', () => {
    it('appends orange "hot" text to the meta line for fast risers (>= 40 points within 2h)', () => {
      const fastRiser: HNItem = {
        ...baseStory,
        score: 60,
        // 30 minutes ago
        time: Math.floor(Date.now() / 1000) - 30 * 60,
      };
      renderWithProviders(<StoryListItem story={fastRiser} />);
      const hot = screen.getByTestId('story-hot');
      expect(hot).toHaveTextContent('hot');
      expect(screen.getByTestId('story-meta')).toHaveTextContent(
        /7 comments · hot$/,
      );
    });

    it('shows "hot" for >= 100 points regardless of age', () => {
      const bigStory: HNItem = {
        ...baseStory,
        score: 250,
        // 12 hours ago
        time: Math.floor(Date.now() / 1000) - 12 * 60 * 60,
      };
      renderWithProviders(<StoryListItem story={bigStory} />);
      expect(screen.getByTestId('story-hot')).toBeInTheDocument();
    });

    it('does not show "hot" for a quiet story', () => {
      const quiet: HNItem = {
        ...baseStory,
        score: 12,
        time: Math.floor(Date.now() / 1000) - 60 * 60,
      };
      renderWithProviders(<StoryListItem story={quiet} />);
      expect(screen.queryByTestId('story-hot')).toBeNull();
    });

    it('does not show "hot" for a mid-score story past the 2h window', () => {
      const settled: HNItem = {
        ...baseStory,
        score: 55,
        // 5 hours ago — past the recent-riser window
        time: Math.floor(Date.now() / 1000) - 5 * 60 * 60,
      };
      renderWithProviders(<StoryListItem story={settled} />);
      expect(screen.queryByTestId('story-hot')).toBeNull();
    });
  });
});

describe('StoryListItem long-press menu', () => {
  function dispatch(
    target: Element,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    clientX: number,
    clientY: number,
  ) {
    const evt = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(evt, {
      pointerId: 1,
      pointerType: 'touch',
      clientX,
      clientY,
      button: 0,
      isPrimary: true,
    });
    act(() => {
      target.dispatchEvent(evt);
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a menu with Pin / Hide / Share on long-press', () => {
    vi.useFakeTimers();
    renderWithProviders(
      <StoryListItem
        story={baseStory}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onHide={vi.fn()}
        onShare={vi.fn()}
      />,
    );
    const row = screen.getByTestId('story-row');
    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByTestId('story-row-menu')).toBeInTheDocument();
    expect(screen.getByTestId('story-row-menu-pin')).toBeInTheDocument();
    expect(screen.getByTestId('story-row-menu-hide')).toBeInTheDocument();
    expect(screen.getByTestId('story-row-menu-share')).toBeInTheDocument();
  });

  it('shows Unpin instead of Pin when the story is already pinned', () => {
    vi.useFakeTimers();
    renderWithProviders(
      <StoryListItem
        story={baseStory}
        pinned
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onHide={vi.fn()}
        onShare={vi.fn()}
      />,
    );
    const row = screen.getByTestId('story-row');
    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByTestId('story-row-menu-unpin')).toBeInTheDocument();
    expect(screen.queryByTestId('story-row-menu-pin')).toBeNull();
    // Pin is a shield against Hide — the Hide menu item is suppressed
    // on pinned rows. Pinned exits via Done or Unpin, not Hide.
    expect(screen.queryByTestId('story-row-menu-hide')).toBeNull();
  });

  it('invokes onPin when Pin is selected from the menu', () => {
    vi.useFakeTimers();
    const onPin = vi.fn();
    renderWithProviders(
      <StoryListItem story={baseStory} onPin={onPin} onHide={vi.fn()} />,
    );
    const row = screen.getByTestId('story-row');
    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.click(screen.getByTestId('story-row-menu-pin'));
    expect(onPin).toHaveBeenCalledWith(baseStory.id);
  });

  it('invokes onShare with the story when Share is selected', () => {
    vi.useFakeTimers();
    const onShare = vi.fn();
    renderWithProviders(
      <StoryListItem story={baseStory} onShare={onShare} />,
    );
    const row = screen.getByTestId('story-row');
    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.click(screen.getByTestId('story-row-menu-share'));
    expect(onShare).toHaveBeenCalledWith(baseStory);
  });

  it('does not navigate to the thread on the click that follows a long-press', () => {
    vi.useFakeTimers();
    const onOpenThread = vi.fn();
    renderWithProviders(
      <StoryListItem
        story={baseStory}
        onPin={vi.fn()}
        onOpenThread={onOpenThread}
      />,
    );
    const row = screen.getByTestId('story-row');
    const title = screen.getByTestId('story-title');
    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    dispatch(row, 'pointerup', 100, 100);
    fireEvent.click(title);
    expect(onOpenThread).not.toHaveBeenCalled();
  });
});

describe('StoryListItem right-click menu (pointer devices)', () => {
  function withPointerDevice(matches: boolean) {
    const original = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({
        matches: query.includes('hover: hover') ? matches : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
    return () => {
      window.matchMedia = original;
    };
  }

  it('opens the row menu on right-click when `(hover: hover)` matches', () => {
    const restore = withPointerDevice(true);
    try {
      renderWithProviders(
        <StoryListItem
          story={baseStory}
          onPin={vi.fn()}
          onHide={vi.fn()}
          onShare={vi.fn()}
        />,
      );
      const row = screen.getByTestId('story-row');
      const evt = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        row.dispatchEvent(evt);
      });
      expect(evt.defaultPrevented).toBe(true);
      expect(screen.getByTestId('story-row-menu')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('does NOT open on right-click when `(hover: hover)` is false (touch devices already have long-press)', () => {
    const restore = withPointerDevice(false);
    try {
      renderWithProviders(
        <StoryListItem
          story={baseStory}
          onPin={vi.fn()}
          onHide={vi.fn()}
          onShare={vi.fn()}
        />,
      );
      const row = screen.getByTestId('story-row');
      act(() => {
        row.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
      expect(screen.queryByTestId('story-row-menu')).toBeNull();
    } finally {
      restore();
    }
  });

  it('is a no-op when the row has no menu actions configured', () => {
    const restore = withPointerDevice(true);
    try {
      // No onPin/onUnpin/onHide/onShare — the Share/Pin/Hide menu would
      // be empty; the right-click should not open an empty menu.
      renderWithProviders(<StoryListItem story={baseStory} />);
      const row = screen.getByTestId('story-row');
      act(() => {
        row.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
      expect(screen.queryByTestId('story-row-menu')).toBeNull();
    } finally {
      restore();
    }
  });

  it('renders the menu as an anchored popover (data-variant="popover") on pointer devices', () => {
    const restore = withPointerDevice(true);
    try {
      renderWithProviders(
        <StoryListItem
          story={baseStory}
          onPin={vi.fn()}
          onHide={vi.fn()}
        />,
      );
      const row = screen.getByTestId('story-row');
      act(() => {
        row.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
      expect(screen.getByTestId('story-row-menu')).toHaveAttribute(
        'data-variant',
        'popover',
      );
      // Popover variant has no bottom-sheet Cancel button.
      expect(screen.queryByTestId('story-row-menu-cancel')).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('StoryListItem long-press menu variant', () => {
  function dispatch(
    target: Element,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    clientX: number,
    clientY: number,
  ) {
    const evt = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(evt, {
      pointerId: 1,
      pointerType: 'touch',
      clientX,
      clientY,
      button: 0,
      isPrimary: true,
    });
    act(() => {
      target.dispatchEvent(evt);
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders as an anchored popover on touch too — no more full-width bottom sheet', () => {
    vi.useFakeTimers();
    renderWithProviders(
      <StoryListItem
        story={baseStory}
        onPin={vi.fn()}
        onHide={vi.fn()}
        onShare={vi.fn()}
      />,
    );
    const row = screen.getByTestId('story-row');
    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByTestId('story-row-menu')).toHaveAttribute(
      'data-variant',
      'popover',
    );
    // Popover variant has no backdrop and no Cancel button.
    expect(screen.queryByTestId('story-row-menu-backdrop')).toBeNull();
    expect(screen.queryByTestId('story-row-menu-cancel')).toBeNull();
  });
});
