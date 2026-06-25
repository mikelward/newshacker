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

  it('swallows the click that follows an outside tap so nothing underneath also fires', () => {
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
    // Stand in for whatever sits under the first outside tap (e.g. a
    // story row's stretched link). Its click handler must NOT run.
    const outside = document.createElement('button');
    const outsideClick = vi.fn();
    outside.addEventListener('click', outsideClick);
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
        outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      const click = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail: 1,
      });
      act(() => {
        outside.dispatchEvent(click);
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(outsideClick).not.toHaveBeenCalled();
      expect(click.defaultPrevented).toBe(true);
      // The swallow is one-shot: a second, later tap is a normal click.
      const next = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
      act(() => {
        outside.dispatchEvent(next);
      });
      expect(outsideClick).toHaveBeenCalledTimes(1);
      expect(next.defaultPrevented).toBe(false);
    } finally {
      document.body.removeChild(outside);
      document.body.removeChild(anchor);
    }
  });

  it('does not arm the swallower for a non-primary (right-button) dismissal', () => {
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
    const outside = document.createElement('button');
    const outsideClick = vi.fn();
    outside.addEventListener('click', outsideClick);
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
      // Right-click outside still dismisses, but produces contextmenu /
      // auxclick rather than a primary click, so no swallower is armed.
      act(() => {
        outside.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, button: 2 }),
        );
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      // A later, unrelated left click must NOT be swallowed.
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
      act(() => {
        outside.dispatchEvent(click);
      });
      expect(outsideClick).toHaveBeenCalledTimes(1);
      expect(click.defaultPrevented).toBe(false);
    } finally {
      document.body.removeChild(outside);
      document.body.removeChild(anchor);
    }
  });

  it('tears down a stranded swallower on the next gesture when no click follows', () => {
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
    const outside = document.createElement('button');
    const outsideClick = vi.fn();
    outside.addEventListener('click', outsideClick);
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
      // Primary mousedown arms the swallower, but the gesture ends with
      // no click (e.g. a drag/selection released elsewhere).
      act(() => {
        outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      // A brand-new gesture begins; its pointerdown must tear the stale
      // swallower down so the new gesture's click is not eaten.
      act(() => {
        outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      });
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
      act(() => {
        outside.dispatchEvent(click);
      });
      expect(outsideClick).toHaveBeenCalledTimes(1);
      expect(click.defaultPrevented).toBe(false);
    } finally {
      document.body.removeChild(outside);
      document.body.removeChild(anchor);
    }
  });

  it('does not swallow a keyboard-activated click (detail 0) that follows a no-click dismissal', () => {
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
    const outside = document.createElement('button');
    const outsideClick = vi.fn();
    outside.addEventListener('click', outsideClick);
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
      // Primary mousedown arms the swallower; the gesture produces no
      // click (drag/selection). The user then activates a focused
      // control with Enter/Space — a click with detail 0 and no
      // preceding pointer event. It must NOT be swallowed.
      act(() => {
        outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      const kbClick = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail: 0,
      });
      act(() => {
        outside.dispatchEvent(kbClick);
      });
      expect(outsideClick).toHaveBeenCalledTimes(1);
      expect(kbClick.defaultPrevented).toBe(false);
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
