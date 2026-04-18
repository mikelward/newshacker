import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
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
  it('links the title to the external article in a new tab for URL stories', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const title = screen.getByTestId('story-title');
    expect(title).toHaveAttribute('href', 'https://example.com/post');
    expect(title).toHaveAttribute('target', '_blank');
    expect(title).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('links the title to /item/:id for self-posts (no url)', () => {
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

  it('renders the domain outside the title link so the title tap zone does not wrap the domain', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const title = screen.getByTestId('story-title');
    expect(title).not.toHaveTextContent(/example\.com/);
    const row = screen.getByTestId('story-row');
    expect(row).toHaveTextContent(/example\.com/);
  });

  it('renders the comments button as a real button-like link to /item/:id', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const btn = screen.getByTestId('comments-btn');
    expect(btn).toHaveAttribute('href', '/item/1');
    expect(btn).toHaveTextContent('7');
    expect(btn).toHaveAccessibleName('7 comments');
    // Not pointed at external url
    expect(btn.getAttribute('href')).not.toContain('example.com');
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

  it('marks the article opened when the title of a URL story is clicked', () => {
    const onMarkOpened = vi.fn();
    renderWithProviders(
      <StoryListItem story={baseStory} onMarkOpened={onMarkOpened} />,
    );
    fireEvent.click(screen.getByTestId('story-title'));
    expect(onMarkOpened).toHaveBeenCalledWith(baseStory.id, 'article');
  });

  it('marks comments opened when the title of a self-post is clicked', () => {
    const selfPost: HNItem = { ...baseStory, url: undefined };
    const onMarkOpened = vi.fn();
    renderWithProviders(
      <StoryListItem story={selfPost} onMarkOpened={onMarkOpened} />,
    );
    fireEvent.click(screen.getByTestId('story-title'));
    expect(onMarkOpened).toHaveBeenCalledWith(baseStory.id, 'comments');
  });

  it('marks comments opened when the comments button is clicked', () => {
    const onMarkOpened = vi.fn();
    renderWithProviders(
      <StoryListItem story={baseStory} onMarkOpened={onMarkOpened} />,
    );
    fireEvent.click(screen.getByTestId('comments-btn'));
    expect(onMarkOpened).toHaveBeenCalledWith(baseStory.id, 'comments');
  });

  it('dims only the title when just the article has been opened', () => {
    renderWithProviders(
      <StoryListItem story={baseStory} articleOpened={true} />,
    );
    const row = screen.getByTestId('story-row');
    expect(row.className).toContain('story-row--title-opened');
    expect(row.className).not.toContain('story-row--comments-opened');
  });

  it('dims only the comments button when just the comments have been opened', () => {
    renderWithProviders(
      <StoryListItem story={baseStory} commentsOpened={true} />,
    );
    const row = screen.getByTestId('story-row');
    expect(row.className).toContain('story-row--comments-opened');
    expect(row.className).not.toContain('story-row--title-opened');
  });

  it('dims the title for a self-post when the comments have been opened', () => {
    const selfPost: HNItem = { ...baseStory, url: undefined };
    renderWithProviders(
      <StoryListItem story={selfPost} commentsOpened={true} />,
    );
    const row = screen.getByTestId('story-row');
    expect(row.className).toContain('story-row--title-opened');
    expect(row.className).toContain('story-row--comments-opened');
  });

  it('leaves the row unmodified when nothing has been opened', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const row = screen.getByTestId('story-row');
    expect(row.className).not.toContain('story-row--title-opened');
    expect(row.className).not.toContain('story-row--comments-opened');
  });

  it('shows a non-interactive "Saved" badge in the meta row when saved=true', () => {
    renderWithProviders(<StoryListItem story={baseStory} saved={true} />);
    const badge = screen.getByTestId('saved-badge');
    expect(badge).toBeInTheDocument();
    // Badge lives inside the meta span (not its own link/button)
    expect(badge.tagName.toLowerCase()).toBe('span');
    expect(screen.getByTestId('story-meta')).toContainElement(badge);
  });

  it('does not show the saved badge when saved=false', () => {
    renderWithProviders(<StoryListItem story={baseStory} saved={false} />);
    expect(screen.queryByTestId('saved-badge')).toBeNull();
  });
});
