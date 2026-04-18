import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './StoryRowMenu.css';

export interface StoryRowMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

interface Props {
  open: boolean;
  title: string;
  items: StoryRowMenuItem[];
  onClose: () => void;
}

export function StoryRowMenu({ open, title, items, onClose }: Props) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

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

  return createPortal(
    <div
      className="story-menu"
      data-testid="story-row-menu"
      role="presentation"
      onClick={stop}
      onPointerDown={stop}
      onPointerUp={stop}
    >
      <div
        className="story-menu__backdrop"
        data-testid="story-row-menu-backdrop"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        className="story-menu__sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="story-menu__title" title={title}>
          {title}
        </div>
        <ul className="story-menu__list" role="menu">
          {items.map((item) => (
            <li key={item.key} role="none">
              <button
                type="button"
                role="menuitem"
                data-menu-item
                data-testid={`story-row-menu-${item.key}`}
                className={
                  'story-menu__item' +
                  (item.destructive ? ' story-menu__item--destructive' : '')
                }
                onClick={() => handleSelect(item)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="story-menu__cancel"
          data-testid="story-row-menu-cancel"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}
