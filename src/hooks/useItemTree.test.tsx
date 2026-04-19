import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Thread, TOP_LEVEL_PAGE_SIZE } from '../components/Thread';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import {
  installIntersectionObserverMock,
  uninstallIntersectionObserverMock,
} from '../test/intersectionObserver';
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
    installIntersectionObserverMock();
  });
  afterEach(() => {
    window.localStorage.clear();
    uninstallIntersectionObserverMock();
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

  it('fires another /api/items batch when the reader scrolls past the first page', async () => {
    // 40 kids = 2 full pages. The mock IntersectionObserver fires
    // ratio=1 on observe, so the sentinel triggers onLoadMore as soon
    // as it mounts — exercising the same pagination path a real scroll
    // would. We expect exactly two batches: the initial useItemTree
    // prefetch, plus the pagination batch for the uncached second page.
    const total = TOP_LEVEL_PAGE_SIZE * 2;
    const kids = Array.from({ length: total }, (_, i) => 3000 + i);
    const items: Record<number, HNItem> = {
      42: makeStory(42, { kids, descendants: total }),
    };
    for (const id of kids) items[id] = comment(id);

    const fetchMock = installHNFetchMock({ items });

    renderWithProviders(<Thread id={42} />, { route: '/item/42' });

    await waitFor(() => {
      expect(
        screen.getByText(`body ${kids[TOP_LEVEL_PAGE_SIZE]}`),
      ).toBeInTheDocument();
    });

    const batchCalls = fetchMock.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : c[0].toString()))
      .filter((u) => u.includes('/api/items'));
    expect(batchCalls).toHaveLength(2);

    const firstIds = new URL(batchCalls[0], 'http://localhost').searchParams
      .get('ids')
      ?.split(',')
      .map(Number);
    const secondIds = new URL(batchCalls[1], 'http://localhost').searchParams
      .get('ids')
      ?.split(',')
      .map(Number);
    // Initial batch covers up to the shared 30-item cap (kids 0..29).
    // Pagination's slice(20, 40) runs through the "already cached?"
    // filter, so the second batch only carries the ids missing from
    // the first batch — kids 30..39.
    expect(firstIds).toEqual(kids.slice(0, 30));
    expect(secondIds).toEqual(kids.slice(30, 40));
  });
});
