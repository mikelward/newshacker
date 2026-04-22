import { afterEach, beforeEach } from 'vitest';
import { _resetNetworkStatusForTests } from './src/lib/networkStatus';

// Only load DOM matchers when we're actually in a DOM environment.
// Pure-logic tests run under the node environment (see
// environmentMatchGlobs in vite.config.ts) and don't need them.
if (typeof window !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}

// The networkStatus module is a singleton (it has to be — one tab, one
// real network). Reset it around every test so a failed fetch in one
// test doesn't leave the next one starting offline, and vice versa.
beforeEach(() => {
  _resetNetworkStatusForTests();
});

afterEach(() => {
  _resetNetworkStatusForTests();
});
