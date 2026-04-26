import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOME_PROMO_DISMISSED_STORAGE_KEY,
  dismissHomePromo,
  isHomePromoDismissed,
} from './homePromo';

describe('homePromo lib', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('is not dismissed by default', () => {
    expect(isHomePromoDismissed()).toBe(false);
  });

  it('reads a stored dismissal', () => {
    window.localStorage.setItem(HOME_PROMO_DISMISSED_STORAGE_KEY, '1');
    expect(isHomePromoDismissed()).toBe(true);
  });

  it('treats unrelated values as not-dismissed', () => {
    window.localStorage.setItem(HOME_PROMO_DISMISSED_STORAGE_KEY, '0');
    expect(isHomePromoDismissed()).toBe(false);
  });

  it('dismissHomePromo persists the flag', () => {
    dismissHomePromo();
    expect(
      window.localStorage.getItem(HOME_PROMO_DISMISSED_STORAGE_KEY),
    ).toBe('1');
    expect(isHomePromoDismissed()).toBe(true);
  });
});
