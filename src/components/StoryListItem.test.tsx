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

  it('adds "N new" to the meta when the current count exceeds the last seen count', () => {
    renderWithProviders(
      <StoryListItem story={baseStory} seenCommentCount={4} />,
    );
    // baseStory has 7 comments; last seen was 4 → 3 new.
    expect(screen.getByTestId('story-meta')).toHaveTextContent(
      /7 comments · 3 new/,
    );
  });

  it('omits "N new" when the user has never opened the thread', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    expect(screen.getByTestId('story-meta')).not.toHaveTextContent(/new/);
  });

  it('omits "N new" when the seen count already matches the current count', () => {
    renderWithProviders(
      <StoryListItem story={baseStory} seenCommentCount={7} />,
    );
    expect(screen.getByTestId('story-meta')).not.toHaveTextContent(/new/);
  });

  it('omits "N new" when comments were deleted (seen count exceeds current)', () => {
    renderWithProviders(
      <StoryListItem story={baseStory} seenCommentCount={10} />,
    );
    expect(screen.getByTestId('story-meta')).not.toHaveTextContent(/new/);
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
