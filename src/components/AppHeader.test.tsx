import { describe, it, expect } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen } from '@testing-library/react';
import { AppHeader } from './AppHeader';
import { renderWithProviders } from '../test/renderUtils';

describe('<AppHeader>', () => {
  it('shows the feed label in the top-right on feed routes', () => {
    renderWithProviders(
      <Routes>
        <Route path="/:feed" element={<AppHeader />} />
      </Routes>,
      { route: '/top' },
    );
    const feedIndicator = document.querySelector('.app-header__feed');
    expect(feedIndicator).not.toBeNull();
    expect(feedIndicator).toHaveTextContent('Top');
  });

  it('does not show "Newshacker" as a top-right label on unknown routes', () => {
    renderWithProviders(
      <Routes>
        <Route path="*" element={<AppHeader />} />
      </Routes>,
      { route: '/no/such/path' },
    );
    expect(document.querySelector('.app-header__feed')).toBeNull();
    // The brand link still contains "Newshacker"; there should only be one occurrence.
    const banner = screen.getByRole('banner');
    const matches = banner.textContent?.match(/Newshacker/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
