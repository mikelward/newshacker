import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StoryRowMenu, type StoryRowMenuItem } from './StoryRowMenu';

function items(handlers: Partial<Record<string, () => void>> = {}) {
  return [
    { key: 'pin', label: 'Pin', onSelect: handlers.pin ?? vi.fn() },
    { key: 'hide', label: 'Hide', onSelect: handlers.hide ?? vi.fn() },
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
    expect(screen.getByTestId('story-row-menu-hide')).toHaveTextContent(
      'Hide',
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

describe('StoryRowMenu popover mode (anchor supplied)', () => {
  it('renders as a popover whenever an anchor is supplied — pointer or touch', () => {
    const anchor = document.createElement('button');
    anchor.getBoundingClientRect = () =>
      ({
        top: 100,
        left: 200,
        right: 248,
        bottom: 148,
        width: 48,
        height: 48,
        x: 200,
        y: 100,
        toJSON() {},
      }) as DOMRect;
    document.body.appendChild(anchor);
    try {
      render(
        <StoryRowMenu
          open
          title="A story"
          items={items()}
          anchorEl={anchor}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByTestId('story-row-menu')).toHaveAttribute(
        'data-variant',
        'popover',
      );
      // No backdrop and no Cancel button in popover mode.
      expect(screen.queryByTestId('story-row-menu-backdrop')).toBeNull();
      expect(screen.queryByTestId('story-row-menu-cancel')).toBeNull();
    } finally {
      document.body.removeChild(anchor);
    }
  });

  it('falls back to the bottom sheet when no anchor is provided', () => {
    render(
      <StoryRowMenu
        open
        title="A story"
        items={items()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('story-row-menu')).toHaveAttribute(
      'data-variant',
      'sheet',
    );
    expect(screen.getByTestId('story-row-menu-backdrop')).toBeInTheDocument();
    expect(screen.getByTestId('story-row-menu-cancel')).toBeInTheDocument();
  });

  it('closes when a mousedown lands outside both the menu and the anchor', () => {
    const anchor = document.createElement('button');
    anchor.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        right: 48,
        bottom: 48,
        width: 48,
        height: 48,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    document.body.appendChild(anchor);
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const onClose = vi.fn();
    try {
      render(
        <StoryRowMenu
          open
          title="A story"
          items={items()}
          anchorEl={anchor}
          onClose={onClose}
        />,
      );
      act(() => {
        outside.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true }),
        );
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeChild(outside);
      document.body.removeChild(anchor);
    }
  });

  it('does NOT close when a mousedown lands inside the anchor (the trigger owns toggling)', () => {
    const anchor = document.createElement('button');
    anchor.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        right: 48,
        bottom: 48,
        width: 48,
        height: 48,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    document.body.appendChild(anchor);
    const onClose = vi.fn();
    try {
      render(
        <StoryRowMenu
          open
          title="A story"
          items={items()}
          anchorEl={anchor}
          onClose={onClose}
        />,
      );
      act(() => {
        anchor.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true }),
        );
      });
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(anchor);
    }
  });
});
