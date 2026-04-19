import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { HelpPage } from './HelpPage';
import { renderWithProviders } from '../test/renderUtils';

describe('<HelpPage>', () => {
  it('describes starring with both tap and swipe methods', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 1, name: /help/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /starring stories/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/☆ star/i)).toBeInTheDocument();
    expect(screen.getByText(/swipe a story left/i)).toBeInTheDocument();
  });

  it('describes dismissing (swipe right / sweep)', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 2, name: /dismissing stories/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/swipe a story right/i)).toBeInTheDocument();
    expect(screen.getByText(/sweep/i, { selector: 'strong' })).toBeInTheDocument();
  });

  it('describes the peek-at-dismissed eye toggle', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: /peeking at dismissed stories/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/eye/i, { selector: 'strong' })).toBeInTheDocument();
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
