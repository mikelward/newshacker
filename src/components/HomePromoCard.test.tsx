import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomePromoCard } from './HomePromoCard';
import { renderWithProviders } from '../test/renderUtils';
import {
  HOME_PROMO_DISMISSED_STORAGE_KEY,
  isHomePromoDismissed,
} from '../lib/homePromo';

describe('<HomePromoCard>', () => {
  beforeEach(() => {
    window.localStorage.removeItem(HOME_PROMO_DISMISSED_STORAGE_KEY);
  });
  afterEach(() => {
    window.localStorage.removeItem(HOME_PROMO_DISMISSED_STORAGE_KEY);
  });

  it('renders the promo link to /hot and a dismiss button', () => {
    renderWithProviders(<HomePromoCard />);
    const link = screen.getByTestId('home-promo-link');
    expect(link).toHaveAttribute('href', '/hot');
    expect(link).toHaveTextContent(/hot view/i);
    expect(screen.getByTestId('home-promo-dismiss')).toBeInTheDocument();
  });

  it('clicking dismiss hides the card and persists the flag', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomePromoCard />);
    await user.click(screen.getByTestId('home-promo-dismiss'));
    expect(screen.queryByTestId('home-promo-link')).not.toBeInTheDocument();
    expect(isHomePromoDismissed()).toBe(true);
  });

  it('does not render when previously dismissed', () => {
    window.localStorage.setItem(HOME_PROMO_DISMISSED_STORAGE_KEY, '1');
    renderWithProviders(<HomePromoCard />);
    expect(screen.queryByTestId('home-promo-link')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('home-promo-dismiss'),
    ).not.toBeInTheDocument();
  });
});
