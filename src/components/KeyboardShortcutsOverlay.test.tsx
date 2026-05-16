import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeyboardShortcutsOverlay } from './KeyboardShortcutsOverlay';
import { renderWithProviders } from '../test/renderUtils';

afterEach(() => {
  // Some tests inject a transient focus target — clean up.
  document
    .querySelectorAll('[data-test-cleanup]')
    .forEach((el) => el.remove());
});

describe('<KeyboardShortcutsOverlay>', () => {
  it('opens when the user presses `?`', async () => {
    renderWithProviders(<KeyboardShortcutsOverlay />);
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();
    await userEvent.keyboard('?');
    expect(
      screen.getByTestId('keyboard-shortcuts-overlay'),
    ).toBeInTheDocument();
  });

  it('closes when the user presses Escape, restoring focus', async () => {
    renderWithProviders(<KeyboardShortcutsOverlay />);
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    trigger.setAttribute('data-test-cleanup', 'true');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    await userEvent.keyboard('?');
    expect(
      screen.getByTestId('keyboard-shortcuts-overlay'),
    ).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByTestId('keyboard-shortcuts-overlay'),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when the Close button is clicked', async () => {
    renderWithProviders(<KeyboardShortcutsOverlay />);
    await userEvent.keyboard('?');
    await userEvent.click(screen.getByTestId('keyboard-shortcuts-close'));
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();
  });

  it('closes when the backdrop is clicked', async () => {
    renderWithProviders(<KeyboardShortcutsOverlay />);
    await userEvent.keyboard('?');
    const overlay = screen.getByTestId('keyboard-shortcuts-overlay');
    await userEvent.click(overlay);
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();
  });

  it('does not open while focus is in a text input', async () => {
    renderWithProviders(<KeyboardShortcutsOverlay />);
    const input = document.createElement('input');
    input.setAttribute('data-test-cleanup', 'true');
    document.body.appendChild(input);
    input.focus();
    await userEvent.keyboard('?');
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();
  });

  it('lists the shortcut bindings expected by users', async () => {
    renderWithProviders(<KeyboardShortcutsOverlay />);
    await userEvent.keyboard('?');
    const overlay = screen.getByTestId('keyboard-shortcuts-overlay');
    // Sanity-check a couple of the bindings; the full list is in the
    // KEYBOARD_SHORTCUTS constant.
    expect(overlay).toHaveTextContent(/Next story/);
    expect(overlay).toHaveTextContent(/Open comments/);
    expect(overlay).toHaveTextContent(/Pin or unpin/);
    expect(overlay).toHaveTextContent(/Dismiss/);
  });
});
