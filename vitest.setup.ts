import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { _resetNetworkStatusForTests } from './src/lib/networkStatus';

// The networkStatus module is a singleton (it has to be — one tab, one
// real network). Reset it around every test so a failed fetch in one
// test doesn't leave the next one starting offline, and vice versa.
beforeEach(() => {
  _resetNetworkStatusForTests();
});

afterEach(() => {
  _resetNetworkStatusForTests();
});
