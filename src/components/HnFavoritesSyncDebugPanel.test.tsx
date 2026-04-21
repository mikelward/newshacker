import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HnFavoritesSyncDebugPanel } from './HnFavoritesSyncDebugPanel';
import {
  _resetHnFavoritesSyncForTests,
  startHnFavoritesSync,
  enqueueHnFavoriteAction,
} from '../lib/hnFavoritesSync';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HnFavoritesSyncDebugPanel', () => {
  beforeEach(() => {
    _resetHnFavoritesSyncForTests();
    window.localStorage.clear();
    vi.useRealTimers();
  });
  afterEach(() => {
    _resetHnFavoritesSyncForTests();
    window.localStorage.clear();
  });

  it('shows "not running" before anyone signs in', () => {
    render(<HnFavoritesSyncDebugPanel />);
    expect(screen.getByText(/not running/i)).toBeInTheDocument();
    expect(screen.getByText('0 pending')).toBeInTheDocument();
  });

  it('reflects a live signed-in sync with a queued action', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/hn-favorites-list') return jsonResponse({ ids: [] });
      if (url === '/api/hn-favorite') {
        // Keep the request pending so the queue shows the entry
        // before the worker drains it. 60 s > any plausible test
        // timeout; the afterEach tears down the runtime.
        return await new Promise<Response>((r) =>
          setTimeout(() => r(new Response(null, { status: 204 })), 60_000),
        );
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    await startHnFavoritesSync('alice', { fetchImpl });
    enqueueHnFavoriteAction('alice', 'favorite', 42);

    render(<HnFavoritesSyncDebugPanel />);

    await waitFor(() => {
      expect(screen.getByText(/running/i)).toBeInTheDocument();
      expect(screen.getByText('alice')).toBeInTheDocument();
      expect(screen.getByText('1 pending')).toBeInTheDocument();
    });
  });
});
