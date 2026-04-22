import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePointerDevice } from '../hooks/usePointerDevice';
import './StoryRowMenu.css';

// TODO: re-evaluate the bottom-sheet fallback on touch. The sheet is
// an iOS convention; Android (and likely most touch devices) would
// feel more native with the anchored popover that desktop already
// uses. Kept for now so we land the desktop change without a
// simultaneous mobile UX shift.

export interface StoryRowMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
}

interface Props {
  open: boolean;
  title: string;
  items: StoryRowMenuItem[];
  /**
   * On `(hover: hover)` pointer-device browsers, when an anchor
   * element is supplied the menu renders as an anchored popover near
   * it instead of the mobile bottom sheet. Pass the element that
   * triggered the open — a `<button>`, or the row itself for a
   * row-level right-click / long-press — and the menu positions
   * itself below (or above, flipped) that element, right-aligned to
   * its right edge.
   */
  anchorEl?: HTMLElement | null;
  onClose: () => void;
}

interface PopoverPosition {
  top: number;
  left: number;
  placement: 'below' | 'above';
}

export function StoryRowMenu({
  open,
  title,
  items,
  anchorEl,
  onClose,
}: Props) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const pointerDevice = usePointerDevice();
  const popover = open && pointerDevice && !!anchorEl;
  const [pos, setPos] = useState<PopoverPosition | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    const firstBtn =
      sheetRef.current?.querySelector<HTMLButtonElement>('button[data-menu-item]');
    firstBtn?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const prev = previouslyFocused.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [open, onClose]);

  // Measure anchor + own size and place the popover right-aligned
  // below the anchor, flipping above when there's no room below.
  // Re-runs on resize and scroll so the menu follows its anchor if
  // the page shifts while open. Scroll-driven updates are
  // rAF-throttled, and we skip `setPos` entirely when the computed
  // coordinates haven't changed, so a scroll that doesn't move the
  // anchor by >1px never triggers a re-render.
  useLayoutEffect(() => {
    if (!popover || !anchorEl || !sheetRef.current) {
      setPos(null);
      return;
    }
    let rafId = 0;
    const place = () => {
      if (!sheetRef.current || !anchorEl) return;
      const a = anchorEl.getBoundingClientRect();
      const m = sheetRef.current.getBoundingClientRect();
      const margin = 4;
      const pad = 8;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
      const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
      const spaceBelow = vh - a.bottom;
      const spaceAbove = a.top;
      const placement: 'below' | 'above' =
        spaceBelow >= m.height + margin || spaceBelow >= spaceAbove
          ? 'below'
          : 'above';
      const top =
        placement === 'below'
          ? Math.min(a.bottom + margin, Math.max(pad, vh - m.height - pad))
          : Math.max(pad, a.top - m.height - margin);
      let left = a.right - m.width;
      left = Math.max(pad, Math.min(left, Math.max(pad, vw - m.width - pad)));
      setPos((prev) => {
        if (
          prev &&
          prev.top === top &&
          prev.left === left &&
          prev.placement === placement
        ) {
          return prev;
        }
        return { top, left, placement };
      });
    };
    place();
    const scheduleRaf = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        place();
      });
    };
    const onResize = () => scheduleRaf();
    const onScroll = () => scheduleRaf();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [popover, anchorEl, items]);

  // Click-outside (popover mode only): close when a click lands outside
  // both the menu and its anchor. The anchor is excluded so re-clicking
  // the trigger to toggle the menu closed works naturally: the click
  // first closes via this handler, then the anchor's onClick re-opens,
  // which would be a wash — so we simply ignore anchor-origin clicks
  // here and let the anchor's own handler toggle.
  useEffect(() => {
    if (!popover) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (sheetRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
    };
  }, [popover, anchorEl, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const handleSelect = (item: StoryRowMenuItem) => {
    item.onSelect();
    onClose();
  };

  // Even with a DOM portal, React replays events up the virtual tree, so we
  // stop propagation here (bubble phase, after the inner targets handle it)
  // to keep menu clicks from reaching the parent row.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  const rootClass =
    'story-menu' + (popover ? ' story-menu--popover' : ' story-menu--sheet');
  const sheetClass =
    'story-menu__sheet' + (popover ? ' story-menu__sheet--popover' : '');
  const sheetStyle =
    popover && pos
      ? { top: pos.top, left: pos.left }
      : popover
        ? // First render of the popover, pre-measurement — hide so we
          // don't flash at (0, 0). The layout effect sets the real
          // position in the same frame.
          { visibility: 'hidden' as const }
        : undefined;

  return createPortal(
    <div
      className={rootClass}
      data-testid="story-row-menu"
      data-variant={popover ? 'popover' : 'sheet'}
      role="presentation"
      onClick={stop}
      onPointerDown={stop}
      onPointerUp={stop}
    >
      {popover ? null : (
        <div
          className="story-menu__backdrop"
          data-testid="story-row-menu-backdrop"
          onClick={onClose}
        />
      )}
      <div
        ref={sheetRef}
        // Popover: the whole card IS the menu — announce it as such
        // (role="menu"), so screen readers route arrow-key nav to the
        // items and don't treat the popover like a modal dialog.
        // Sheet (touch): keep the dialog framing — the darkened
        // backdrop + Cancel button really is modal, and aria-modal="true"
        // matches that experience.
        className={sheetClass}
        role={popover ? 'menu' : 'dialog'}
        aria-modal={popover ? undefined : 'true'}
        aria-label={title}
        style={sheetStyle}
        data-placement={pos?.placement}
      >
        <div className="story-menu__title" title={title}>
          {title}
        </div>
        <ul
          className="story-menu__list"
          // Inner list is purely presentational when the outer card
          // already carries role="menu"; otherwise (sheet), the list
          // itself is the menu nested inside the dialog.
          role={popover ? 'presentation' : 'menu'}
        >
          {items.map((item) => (
            <li key={item.key} role="none">
              <button
                type="button"
                role="menuitem"
                data-menu-item
                data-testid={`story-row-menu-${item.key}`}
                className="story-menu__item"
                onClick={() => handleSelect(item)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        {popover ? null : (
          <button
            type="button"
            className="story-menu__cancel"
            data-testid="story-row-menu-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
