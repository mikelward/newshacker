import { afterEach, beforeEach, vi } from 'vitest';
import { _resetNetworkStatusForTests } from './src/lib/networkStatus';

// Tests never touch the real network. Anything a test needs comes from a
// stubbed `fetch` (see src/test/mockFetch.ts). A request that reaches the
// environment instead — Node's fetch, or happy-dom's fetch, link navigation
// or resource loading — would go out to the live Hacker News API (or any
// other host) from CI. Refuse every such request, and record it so the test
// that made it fails in afterEach: callers such as `prefetchQuery` swallow a
// rejected fetch, so refusing alone would go unnoticed.
const unmockedRequests: string[] = [];

function refuse(url: string): TypeError {
  unmockedRequests.push(url);
  return new TypeError(`Unmocked request in a test: ${url}. Stub or prevent it.`);
}

if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = (input: RequestInfo | URL) =>
    Promise.reject(
      refuse(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      ),
    );
}

// happy-dom also requests on its own, e.g. loading the page an <a> click
// navigates to. Its interceptor sees every request it makes.
interface HappyDOMSettings {
  fetch: {
    interceptor: {
      beforeAsyncRequest(context: { request: Request }): Promise<void>;
      beforeSyncRequest(context: { request: Request }): void;
    } | null;
  };
}
const happyDOM = (
  globalThis as { happyDOM?: { settings: HappyDOMSettings } }
).happyDOM;
if (happyDOM) {
  happyDOM.settings.fetch.interceptor = {
    beforeAsyncRequest: ({ request }) => Promise.reject(refuse(request.url)),
    beforeSyncRequest: ({ request }) => {
      throw refuse(request.url);
    },
  };
}

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
  if (unmockedRequests.length > 0) {
    const urls = unmockedRequests.splice(0);
    throw new Error(
      `Test made ${urls.length} unmocked network request(s); stub or prevent:\n  ${urls.join('\n  ')}`,
    );
  }
});
