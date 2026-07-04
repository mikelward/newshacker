import { afterEach, beforeEach, vi } from 'vitest';
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
  // window.close() tears the whole document down in the DOM test environment,
  // cascading "document is not defined" into later tests. The thread's
  // Done/back ladder (closeArticleView) calls it when there's no back entry — a
  // real browser dismisses the tab/Custom Tab back to the OS; here we
  // neutralize it. Individual tests still spy to assert the close branch fired.
  if (typeof window !== 'undefined') {
    vi.spyOn(window, 'close').mockImplementation(() => {});
  }
});

afterEach(() => {
  _resetNetworkStatusForTests();
});
