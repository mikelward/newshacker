import { describe, it, expect } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { fireEvent, screen } from '@testing-library/react';
import { AppHeader } from './AppHeader';
import { renderWithProviders } from '../test/renderUtils';

describe('<AppHeader>', () => {
  it('does not render a top-right page-title label on feed routes', () => {
    renderWithProviders(
      <Routes>
        <Route path="/:feed" element={<AppHeader />} />
      </Routes>,
      { route: '/top' },
    );
    expect(document.querySelector('.app-header__feed')).toBeNull();
  });

  it('does not render a top-right page-title label on unknown routes', () => {
    renderWithProviders(
      <Routes>
        <Route path="*" element={<AppHeader />} />
      </Routes>,
      { route: '/no/such/path' },
    );
    expect(document.querySelector('.app-header__feed')).toBeNull();
    const banner = screen.getByRole('banner');
    const matches = banner.textContent?.match(/Newshacker/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('opens the drawer when the menu button is pressed', () => {
    renderWithProviders(
      <Routes>
        <Route path="/:feed" element={<AppHeader />} />
      </Routes>,
      { route: '/top' },
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
