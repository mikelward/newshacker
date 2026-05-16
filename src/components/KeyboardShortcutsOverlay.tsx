import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './KeyboardShortcutsOverlay.css';

interface Shortcut {
  keys: string[];
  description: string;
}

const KEYBOARD_SHORTCUTS: Shortcut[] = [
  { keys: ['j', '↓'], description: 'Next story' },
  { keys: ['k', '↑'], description: 'Previous story' },
  { keys: ['Enter'], description: 'Open comments' },
  { keys: ['Space'], description: 'Open the row actions menu' },
  { keys: ['o'], description: 'Open the article in a new tab' },
  { keys: ['p'], description: 'Pin or unpin the story' },
  { keys: ['d'], description: 'Dismiss (hide) the story' },
  { keys: ['?'], description: 'Show this help' },
  { keys: ['Esc'], description: 'Close menus or this help' },
];

function shouldIgnoreKeyEvent(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

// Mounted once at the App root. Listens globally for `?` to open and
// Escape to close. Bails out when another modal is already open
// (StoryRowMenu / LoginDialog / AppDrawer / HeaderAccountMenu — all
// use role="dialog" or role="menu") so `?` doesn't punch through an
// active dialog.
export function KeyboardShortcutsOverlay() {
  const [open, setOpen] = useState(false);
  const previouslyFocused = useRef<Element | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKeyEvent(e)) return;
      if (open) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setOpen(false);
        }
        return;
      }
      if (e.key !== '?') return;
      // Don't punch through an open dialog/menu.
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      e.preventDefault();
      previouslyFocused.current = document.activeElement;
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    return () => {
      const prev = previouslyFocused.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [open]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return createPortal(
    <div
      className="kb-help"
      data-testid="keyboard-shortcuts-overlay"
      role="presentation"
      onClick={() => setOpen(false)}
    >
      <div className="kb-help__backdrop" />
      <div
        ref={dialogRef}
        className="kb-help__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onClick={stop}
      >
        <h2 className="kb-help__title">Keyboard shortcuts</h2>
        <dl className="kb-help__list" data-testid="keyboard-shortcuts-list">
          {KEYBOARD_SHORTCUTS.map((s) => (
            <div className="kb-help__row" key={s.description}>
              <dt className="kb-help__keys">
                {s.keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 ? (
                      <span className="kb-help__sep"> or </span>
                    ) : null}
                    <kbd className="kb-help__kbd">{k}</kbd>
                  </span>
                ))}
              </dt>
              <dd className="kb-help__desc">{s.description}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className="kb-help__close"
          data-testid="keyboard-shortcuts-close"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}
