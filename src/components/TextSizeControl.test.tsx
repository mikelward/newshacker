import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderUtils';
import { TextSizeControl } from './TextSizeControl';
import { FONT_SIZES, FONT_SIZE_STORAGE_KEY } from '../lib/fontSize';

const stored = () => window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
const smaller = () => screen.getByRole('button', { name: 'Smaller text' });
const larger = () => screen.getByRole('button', { name: 'Larger text' });

describe('TextSizeControl', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  it('shows the current size and steps it both ways', () => {
    renderWithProviders(<TextSizeControl />);
    expect(screen.getByText('16px')).toBeInTheDocument();

    fireEvent.click(larger());
    expect(screen.getByText('17px')).toBeInTheDocument();
    expect(stored()).toBe('17');

    fireEvent.click(smaller());
    expect(screen.getByText('16px')).toBeInTheDocument();
    // 16 is the default, so it clears the key rather than writing it.
    expect(stored()).toBeNull();
  });

  it('reaches both ends of the ladder and stops there', () => {
    renderWithProviders(<TextSizeControl />);
    for (let i = 0; i < FONT_SIZES.length + 3; i++) fireEvent.click(larger());
    expect(screen.getByText('32px')).toBeInTheDocument();
    expect(larger()).toHaveAttribute('aria-disabled', 'true');

    for (let i = 0; i < FONT_SIZES.length + 3; i++) fireEvent.click(smaller());
    expect(screen.getByText('14px')).toBeInTheDocument();
    expect(smaller()).toHaveAttribute('aria-disabled', 'true');
    // Each end goes inert rather than wrapping — a stepper that jumped from
    // largest to smallest would be a trap on a control people hold down.
    expect(larger()).not.toHaveAttribute('aria-disabled');
  });

  it('renders the glyph at the size it is setting, capped short of the row', () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, '20');
    const { container } = renderWithProviders(<TextSizeControl />);
    expect(container.querySelector('.text-size__glyph')).toHaveStyle({
      fontSize: '20px',
    });

    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, '32');
    const second = renderWithProviders(<TextSizeControl />);
    // Capped: past ~30px the readout would set the row's height and make the
    // picker the tallest thing in the drawer.
    expect(
      second.container.querySelector('.text-size__glyph'),
    ).toHaveStyle({ fontSize: '30px' });
  });

  it('keeps the glyph and its label on one baseline, in one box', () => {
    // The row centering measures that box, so the two must live inside it.
    renderWithProviders(<TextSizeControl />);
    const readout = document.querySelector('.text-size__readout');
    expect(readout).not.toBeNull();
    expect(readout?.querySelector('.text-size__glyph')?.textContent).toBe('A');
    expect(readout?.querySelector('.text-size__px')?.textContent).toBe('16px');
  });

  it('announces the size, so stepping is not silent to a screen reader', () => {
    renderWithProviders(<TextSizeControl />);
    expect(screen.getByText('16px').closest('[aria-live]')).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });

  it('stays usable if the stored size is somehow off the ladder', () => {
    // Belt and braces against a future ladder edit: an unrecognized value must
    // not leave both directions inert with no way back.
    renderWithProviders(<TextSizeControl />);
    expect(smaller()).not.toHaveAttribute('aria-disabled');
    expect(larger()).not.toHaveAttribute('aria-disabled');
  });
});
