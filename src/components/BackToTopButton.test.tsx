import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BackToTopButton } from './BackToTopButton';

describe('<BackToTopButton>', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a "Back to top" button', () => {
    render(<BackToTopButton />);
    const btn = screen.getByTestId('back-to-top');
    expect(btn).toHaveAccessibleName(/back to top/i);
    // Default (labeled) variant keeps the visible "Back to top" text so
    // the library footer — where this is the only button on the row —
    // reads as a full-width labeled target.
    expect(btn).toHaveTextContent(/back to top/i);
  });

  it('renders an icon-only variant with no visible label but a preserved accessible name', () => {
    // Feed footers swap to the icon-only variant so More can sit
    // visually centered between two same-sized 56×56 squares. The
    // accessible name still has to be "Back to top" — assistive tech
    // and the long-press tooltip both rely on it.
    render(<BackToTopButton iconOnly />);
    const btn = screen.getByTestId('back-to-top');
    expect(btn).toHaveAccessibleName(/back to top/i);
    expect(btn).not.toHaveTextContent(/back to top/i);
    expect(btn.classList.contains('back-to-top-btn--icon')).toBe(true);
  });

  it('scrolls the window to the top on click, requesting a smooth scroll', async () => {
    const scrollToSpy = vi.fn();
    vi.stubGlobal('scrollTo', scrollToSpy);

    render(<BackToTopButton />);
    await userEvent.click(screen.getByTestId('back-to-top'));

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });
});
