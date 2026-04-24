import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { LogoPreviewPage } from './LogoPreviewPage';
import { renderWithProviders } from '../test/renderUtils';

describe('<LogoPreviewPage>', () => {
  it('renders the page heading', () => {
    renderWithProviders(<LogoPreviewPage />, { route: '/logo-preview' });
    expect(
      screen.getByRole('heading', { level: 1, name: /logo concepts/i }),
    ).toBeInTheDocument();
  });

  it('renders every concept card with a heading', () => {
    renderWithProviders(<LogoPreviewPage />, { route: '/logo-preview' });
    for (const name of [
      /current \(baseline\)/i,
      /keycap n/i,
      /terminal prompt/i,
      /phone frame/i,
      /notched n/i,
      /folded paper/i,
    ]) {
      expect(
        screen.getByRole('heading', { level: 2, name }),
      ).toBeInTheDocument();
    }
  });

  it('renders each concept at three preview sizes (512, 128, 32)', () => {
    renderWithProviders(<LogoPreviewPage />, { route: '/logo-preview' });
    // Six concepts × three sizes = eighteen size labels.
    expect(screen.getAllByText('512')).toHaveLength(6);
    expect(screen.getAllByText('128')).toHaveLength(6);
    expect(screen.getAllByText('32')).toHaveLength(6);
  });

  it('gives every logo an accessible name so it renders with role=img', () => {
    renderWithProviders(<LogoPreviewPage />, { route: '/logo-preview' });
    // Six concepts × three sizes = eighteen svgs.
    expect(screen.getAllByRole('img')).toHaveLength(18);
  });

  it('has a back link to Top', () => {
    renderWithProviders(<LogoPreviewPage />, { route: '/logo-preview' });
    expect(
      screen.getByRole('link', { name: /back to top/i }),
    ).toHaveAttribute('href', '/top');
  });
});
