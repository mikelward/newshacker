// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// Regression guard for the service-worker runtime cache rules in
// vite.config.ts. Workbox's `generateSW` ships the SW from a built
// artifact, so a wrong strategy here lands silently on production — the
// only failure mode is "the thread root keeps painting the cached
// descendants/kids snapshot from when the user first opened the story,"
// which is exactly what these assertions guard against.
describe('vite.config service worker runtimeCaching', () => {
  const source = readFileSync(
    new URL('./vite.config.ts', import.meta.url),
    'utf-8',
  );

  function findRuleBlock(cacheName: string): string {
    // Each runtimeCaching entry in vite.config.ts is laid out as
    // `urlPattern: …, handler: '…', options: { cacheName: '…', … }`.
    // Slice from the `handler:` line that precedes the cacheName up
    // through the next `cacheableResponse:` line (the closing option
    // every rule sets) so the slice contains both the strategy name
    // and the per-rule options like `networkTimeoutSeconds`.
    const idx = source.indexOf(`cacheName: '${cacheName}'`);
    expect(idx).toBeGreaterThan(-1);
    const sliceStart = source.lastIndexOf('handler:', idx);
    const sliceEnd = source.indexOf('cacheableResponse:', idx);
    expect(sliceStart).toBeGreaterThan(-1);
    expect(sliceEnd).toBeGreaterThan(idx);
    return source.slice(sliceStart, sliceEnd);
  }

  it('serves /v0/item/<id>.json via NetworkFirst so a thread-root refetch actually reaches Firebase instead of replaying the SW cache', () => {
    const block = findRuleBlock('hn-items');
    expect(block).toMatch(/handler:\s*'NetworkFirst'/);
    expect(block).toMatch(/networkTimeoutSeconds:\s*6/);
  });

  it('keeps the /api/items batch on NetworkFirst (same rationale, sibling rule)', () => {
    const block = findRuleBlock('hn-items-batch');
    expect(block).toMatch(/handler:\s*'NetworkFirst'/);
  });

  it('keeps hedge < SW cache-fallback window < client read cap', () => {
    // The connectivity tracker's timings only work if the service worker's
    // NetworkFirst fallback window sits strictly between the hedge probe and
    // the client-side read cap: the hedge must fire while the read can still
    // be rescued, and the SW must get its chance to answer from cache before
    // the client aborts the read. Parsed from source (same style as the
    // config assertions above) because this file lives in the node tsconfig
    // project and can't import from src/.
    const netSource = readFileSync(
      new URL('./src/lib/networkStatus.ts', import.meta.url),
      'utf-8',
    );
    const constant = (name: string): number => {
      const m = new RegExp(`${name} = ([\\d_]+)`).exec(netSource);
      expect(m, `${name} missing from networkStatus.ts`).not.toBeNull();
      return Number(m![1].replace(/_/g, ''));
    };
    const hedgeMs = constant('CORE_READ_HEDGE_DELAY_MS');
    const capMs = constant('CORE_READ_TIMEOUT_MS');
    const windows = [...source.matchAll(/networkTimeoutSeconds:\s*(\d+)/g)].map(
      (m) => Number(m[1]) * 1000,
    );
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      expect(hedgeMs).toBeLessThan(w);
      expect(w).toBeLessThan(capMs);
    }
  });
});
