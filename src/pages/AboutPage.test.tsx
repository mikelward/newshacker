import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { AboutPage } from './AboutPage';
import { renderWithProviders } from '../test/renderUtils';

describe('<AboutPage>', () => {
  it('renders the title and unofficial-client disclaimer', () => {
    renderWithProviders(<AboutPage />, { route: '/about' });
    expect(
      screen.getByRole('heading', { level: 1, name: /about hnews\.app/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not affiliated with, endorsed by, or sponsored by/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Y Combinator/i)).toBeInTheDocument();
  });

  it('links to the Hacker News site and public API', () => {
    renderWithProviders(<AboutPage />, { route: '/about' });
    const hnLinks = screen.getAllByRole('link', { name: /hacker news/i });
    expect(hnLinks.length).toBeGreaterThan(0);
    expect(hnLinks[0]).toHaveAttribute(
      'href',
      'https://news.ycombinator.com',
    );
    expect(
      screen.getByRole('link', { name: /hacker news api/i }),
    ).toHaveAttribute('href', 'https://github.com/HackerNews/API');
  });

  it('opens external links in a new tab with noopener noreferrer', () => {
    renderWithProviders(<AboutPage />, { route: '/about' });
    const apiLink = screen.getByRole('link', { name: /hacker news api/i });
    expect(apiLink).toHaveAttribute('target', '_blank');
    expect(apiLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('has a back link to Top', () => {
    renderWithProviders(<AboutPage />, { route: '/about' });
    expect(screen.getByRole('link', { name: /back to top/i })).toHaveAttribute(
      'href',
      '/top',
    );
  });
});
