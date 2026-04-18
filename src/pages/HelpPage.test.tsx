import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { HelpPage } from './HelpPage';
import { renderWithProviders } from '../test/renderUtils';

describe('<HelpPage>', () => {
  it('describes saving with both swipe and button methods', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 1, name: /help/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /saving stories/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/swipe a story left/i)).toBeInTheDocument();
    // The "Save" instruction mentions the button and how to unsave
    expect(
      screen.getByText(/tap again to unsave/i),
    ).toBeInTheDocument();
  });

  it('describes dismissing (swipe right / scroll past)', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 2, name: /dismissing stories/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/swipe a story right/i)).toBeInTheDocument();
    expect(screen.getByText(/scrolling past/i)).toBeInTheDocument();
  });

  it('links to the Saved and Ignored pages', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(screen.getByRole('link', { name: /saved/i })).toHaveAttribute(
      'href',
      '/saved',
    );
    expect(screen.getByRole('link', { name: /ignored/i })).toHaveAttribute(
      'href',
      '/ignored',
    );
  });
});
