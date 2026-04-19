import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StoryRowMenu, type StoryRowMenuItem } from './StoryRowMenu';

function items(handlers: Partial<Record<string, () => void>> = {}) {
  return [
    { key: 'pin', label: 'Pin', onSelect: handlers.pin ?? vi.fn() },
    { key: 'ignore', label: 'Ignore', onSelect: handlers.ignore ?? vi.fn() },
    { key: 'share', label: 'Share', onSelect: handlers.share ?? vi.fn() },
  ] as StoryRowMenuItem[];
}

describe('StoryRowMenu', () => {
  it('renders nothing when closed', () => {
    render(
      <StoryRowMenu
        open={false}
        title="A story"
        items={items()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('story-row-menu')).toBeNull();
  });

  it('renders the title and all items when open', () => {
    render(
      <StoryRowMenu
        open
        title="A story"
        items={items()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('story-row-menu')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'A story');
    expect(screen.getByTestId('story-row-menu-pin')).toHaveTextContent(
      'Pin',
    );
    expect(screen.getByTestId('story-row-menu-ignore')).toHaveTextContent(
      'Ignore',
    );
    expect(screen.getByTestId('story-row-menu-share')).toHaveTextContent(
      'Share',
    );
  });

  it('calls the item handler and closes the menu when an item is clicked', () => {
    const onPin = vi.fn();
    const onClose = vi.fn();
    render(
      <StoryRowMenu
        open
        title="A story"
        items={items({ pin: onPin })}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('story-row-menu-pin'));
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <StoryRowMenu
        open
        title="A story"
        items={items()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('story-row-menu-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the cancel button is clicked', () => {
    const onClose = vi.fn();
    render(
      <StoryRowMenu
        open
        title="A story"
        items={items()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('story-row-menu-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <StoryRowMenu
        open
        title="A story"
        items={items()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
