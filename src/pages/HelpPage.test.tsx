import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { HelpPage } from './HelpPage';
import { renderWithProviders } from '../test/renderUtils';

describe('<HelpPage>', () => {
  it('describes pinning with both tap and swipe methods', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 1, name: /help/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /pinning stories/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/📌 pin/i)).toBeInTheDocument();
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

  it('explains that comments start collapsed and tap expands them', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 2, name: /reading comments/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/three lines/i)).toBeInTheDocument();
    expect(screen.getByText(/tap a comment/i)).toBeInTheDocument();
    expect(screen.getByText(/reply on hn/i)).toBeInTheDocument();
  });

  it('links to the Pinned and Ignored pages', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(screen.getByRole('link', { name: /pinned/i })).toHaveAttribute(
      'href',
      '/pinned',
    );
    expect(screen.getByRole('link', { name: /ignored/i })).toHaveAttribute(
      'href',
      '/ignored',
    );
  });

  it('describes favoriting via the heart on the thread page', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 2, name: /favoriting stories/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/heart/i, { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /favorites/i })).toHaveAttribute(
      'href',
      '/favorites',
    );
  });

  it('covers the long-press story actions menu including share', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 2, name: /story actions menu/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/long-press/i)).toBeInTheDocument();
    expect(screen.getByText(/share/i, { selector: 'strong' })).toBeInTheDocument();
  });

  it('describes the undo control in the top bar', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 2, name: /undoing a dismiss/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/undo/i, { selector: 'strong' })).toBeInTheDocument();
  });

  it('explains AI article summaries on the thread page', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 2, name: /article summaries/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/gemini/i)).toBeInTheDocument();
    expect(screen.getByText(/may be inaccurate/i)).toBeInTheDocument();
  });

  it('describes the Recently Opened library', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 2, name: /recently opened/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /opened/i })).toHaveAttribute(
      'href',
      '/opened',
    );
  });

  it('explains switching theme with three options', () => {
    renderWithProviders(<HelpPage />, { route: '/help' });
    expect(
      screen.getByRole('heading', { level: 2, name: /switching theme/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/light/i, { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/dark/i, { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/system/i, { selector: 'strong' })).toBeInTheDocument();
  });
});
