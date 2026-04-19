import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Thread } from '../components/Thread';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import type { HNItem } from '../lib/hn';

function comment(id: number, overrides: Partial<HNItem> = {}): HNItem {
  return {
    id,
    type: 'comment',
    by: 'alice',
    text: `body ${id}`,
    time: 1_700_000_000,
    kids: [],
    ...overrides,
  };
}

describe('useItemTree batching', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('loads the first page of top-level comments via a single /api/items batch', async () => {
    const kids = Array.from({ length: 10 }, (_, i) => 1001 + i);
    const items: Record<number, HNItem> = { 1: makeStory(1, { kids }) };
    for (const id of kids) items[id] = comment(id);

    const fetchMock = installHNFetchMock({ items });

    renderWithProviders(<Thread id={1} />, { route: '/item/1' });

    // All 10 top-level comment bodies render.
    await waitFor(() => {
      for (const id of kids) {
        expect(screen.getByText(`body ${id}`)).toBeInTheDocument();
      }
    });

    const urls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0].toString(),
    );
    const firebaseItemCalls = urls.filter((u) =>
      /\/v0\/item\/\d+\.json/.test(u),
    );
    const batchCalls = urls.filter((u) => u.includes('/api/items'));

    // Only the root item hits Firebase directly. The 10 top-level kids
    // come from a single /api/items batch, with fields=full so `kids`
    // survives for accurate reply counts.
    expect(firebaseItemCalls).toHaveLength(1);
    expect(firebaseItemCalls[0]).toMatch(/\/item\/1\.json/);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toMatch(/fields=full/);
  });

  it('still renders the thread when the batch endpoint fails (graceful fallback)', async () => {
    const kids = [2001, 2002, 2003];
    const items: Record<number, HNItem> = { 2: makeStory(2, { kids }) };
    for (const id of kids) items[id] = comment(id);

    // Install a mock that fails /api/items but serves Firebase items,
    // so the per-comment fallback path renders the top-levels.
    const base = installHNFetchMock({ items });
    base.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/items')) {
        return new Response('bad gateway', { status: 502 });
      }
      const itemMatch = url.match(/\/v0\/item\/(\d+)\.json/);
      if (itemMatch) {
        const id = Number(itemMatch[1]);
        const it = items[id] ?? null;
        return new Response(JSON.stringify(it), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    renderWithProviders(<Thread id={2} />, { route: '/item/2' });

    // The user still sees the thread — individual useCommentItem fetches
    // fill in after the batch fails.
    await waitFor(() => {
      expect(screen.getByText('body 2001')).toBeInTheDocument();
      expect(screen.getByText('body 2003')).toBeInTheDocument();
    });
  });
});
