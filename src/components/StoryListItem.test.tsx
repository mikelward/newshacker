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

  it('renders a star button that toggles saved state via onSave / onUnsave', () => {
    const onSave = vi.fn();
    const onUnsave = vi.fn();
    const { unmount } = renderWithProviders(
      <StoryListItem
        story={baseStory}
        saved={false}
        onSave={onSave}
        onUnsave={onUnsave}
      />,
    );
    const star = screen.getByTestId('star-btn');
    expect(star).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(star);
    expect(onSave).toHaveBeenCalledWith(baseStory.id);
    expect(onUnsave).not.toHaveBeenCalled();
    unmount();

    onSave.mockReset();
    onUnsave.mockReset();
    renderWithProviders(
      <StoryListItem
        story={baseStory}
        saved={true}
        onSave={onSave}
        onUnsave={onUnsave}
      />,
    );
    const starAfter = screen.getByTestId('star-btn');
    expect(starAfter).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(starAfter);
    expect(onUnsave).toHaveBeenCalledWith(baseStory.id);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('does not render rank, hide, past, web, flag, via, or inline author links', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const row = screen.getByTestId('story-row');
    const inner = row.innerHTML.toLowerCase();
    expect(inner).not.toMatch(/\bhide\b/);
    expect(inner).not.toMatch(/\bpast\b/);
    expect(inner).not.toMatch(/\bflag\b/);
    expect(inner).not.toMatch(/\bvia\b/);
    // No author link in the row
    expect(within(row).queryByText('alice')).toBeNull();
  });

  it('renders no upvote button when logged out, exactly one when logged in', () => {
    const { unmount } = renderWithProviders(
      <StoryListItem story={baseStory} isLoggedIn={false} />,
    );
    expect(screen.queryByRole('button', { name: /upvote/i })).toBeNull();
    unmount();

    renderWithProviders(<StoryListItem story={baseStory} isLoggedIn={true} />);
    const voteButtons = screen.getAllByRole('button', { name: /upvote/i });
    expect(voteButtons).toHaveLength(1);
  });

  it('shows points and age as display-only text, not tappable', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const meta = screen.getByTestId('story-meta');
    expect(meta.tagName.toLowerCase()).toBe('span');
    expect(meta).toHaveTextContent(/42 points/);
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

  it('does not fire onOpenThread when the star button is tapped', () => {
    const onOpenThread = vi.fn();
    renderWithProviders(
      <StoryListItem
        story={baseStory}
        onOpenThread={onOpenThread}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('star-btn'));
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

  it('does not render a separate "Saved" meta badge — the star button shows saved state', () => {
    renderWithProviders(<StoryListItem story={baseStory} saved={true} />);
    expect(screen.queryByTestId('saved-badge')).toBeNull();
    expect(screen.getByTestId('star-btn')).toHaveAttribute(
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

  it('opens a menu with Save / Ignore / Share on long-press', () => {
    vi.useFakeTimers();
    renderWithProviders(
      <StoryListItem
        story={baseStory}
        onSave={vi.fn()}
        onUnsave={vi.fn()}
        onDismiss={vi.fn()}
        onShare={vi.fn()}
      />,
    );
    const row = screen.getByTestId('story-row');
    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByTestId('story-row-menu')).toBeInTheDocument();
    expect(screen.getByTestId('story-row-menu-save')).toBeInTheDocument();
    expect(screen.getByTestId('story-row-menu-ignore')).toBeInTheDocument();
    expect(screen.getByTestId('story-row-menu-share')).toBeInTheDocument();
  });

  it('shows Unsave instead of Save when the story is already saved', () => {
    vi.useFakeTimers();
    renderWithProviders(
      <StoryListItem
        story={baseStory}
        saved
        onSave={vi.fn()}
        onUnsave={vi.fn()}
        onDismiss={vi.fn()}
        onShare={vi.fn()}
      />,
    );
    const row = screen.getByTestId('story-row');
    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByTestId('story-row-menu-unsave')).toBeInTheDocument();
    expect(screen.queryByTestId('story-row-menu-save')).toBeNull();
  });

  it('invokes onSave when Save is selected from the menu', () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    renderWithProviders(
      <StoryListItem story={baseStory} onSave={onSave} onDismiss={vi.fn()} />,
    );
    const row = screen.getByTestId('story-row');
    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.click(screen.getByTestId('story-row-menu-save'));
    expect(onSave).toHaveBeenCalledWith(baseStory.id);
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
        onSave={vi.fn()}
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
