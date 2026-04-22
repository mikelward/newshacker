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
  });

  it('scrolls the window to the top on click, requesting a smooth scroll', async () => {
    const scrollToSpy = vi.fn();
    vi.stubGlobal('scrollTo', scrollToSpy);

    render(<BackToTopButton />);
    await userEvent.click(screen.getByTestId('back-to-top'));

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });
});
