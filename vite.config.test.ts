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
    // Match the `/api/items` sibling's 10s budget — slow mobile networks
    // already need this much before we fall through to the offline cache.
    expect(block).toMatch(/networkTimeoutSeconds:\s*10/);
  });

  it('keeps the /api/items batch on NetworkFirst (same rationale, sibling rule)', () => {
    const block = findRuleBlock('hn-items-batch');
    expect(block).toMatch(/handler:\s*'NetworkFirst'/);
  });
});
