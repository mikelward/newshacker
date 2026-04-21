import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DebugPage } from './DebugPage';
import { renderWithProviders } from '../test/renderUtils';

interface StatusBody {
  region: string | null;
  build: string | null;
  services: {
    gemini: { configured: boolean };
    jina: { configured: boolean };
    redis: {
      configured: boolean;
      reachable?: boolean;
      latencyMs?: number;
    };
    sync?: {
      configured: boolean;
      reachable?: boolean;
      latencyMs?: number;
    };
  };
}

function mockStatus(body: StatusBody | (() => StatusBody), ok = true) {
  const fetchMock = vi.fn(async () => {
    const resolved = typeof body === 'function' ? body() : body;
    return new Response(JSON.stringify(resolved), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('<DebugPage>', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the deployment and services sections after the fetch resolves', async () => {
    mockStatus({
      region: 'iad1',
      build: 'abc1234def5678',
      services: {
        gemini: { configured: true },
        jina: { configured: false },
        redis: { configured: true, reachable: true, latencyMs: 4 },
        sync: { configured: true, reachable: true, latencyMs: 4 },
      },
    });
    renderWithProviders(<DebugPage />, { route: '/debug' });

    expect(
      screen.getByRole('heading', { level: 1, name: /debug/i }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('iad1')).toBeInTheDocument();
    });
    // Build SHA is shortened to 7 chars.
    expect(screen.getByText('abc1234')).toBeInTheDocument();

    // Each service row renders with its own detail string.
    expect(screen.getByText('Gemini')).toBeInTheDocument();
    expect(screen.getByText('Jina')).toBeInTheDocument();
    expect(screen.getByText(/^not configured$/i)).toBeInTheDocument();
    // Sync is reported separately from Redis so operators can see at
    // a glance whether cross-device sync will work.
    expect(screen.getByText('Sync')).toBeInTheDocument();
  });

  it('falls back to the Redis status for Sync when the server omits it', async () => {
    mockStatus({
      region: null,
      build: null,
      services: {
        gemini: { configured: false },
        jina: { configured: false },
        redis: { configured: true, reachable: true, latencyMs: 2 },
        // sync omitted — simulates an older deployment.
      },
    });
    renderWithProviders(<DebugPage />, { route: '/debug' });
    await waitFor(() => {
      expect(screen.getByText('Sync')).toBeInTheDocument();
    });
    // The Sync row should surface the same "configured · reachable"
    // state as Redis, not an empty/unknown line.
    const syncRow = screen.getByText('Sync').closest('li');
    expect(syncRow).not.toBeNull();
    expect(syncRow).toHaveTextContent(/configured · reachable/i);
  });


  it('shows an unreachable Redis cleanly without a latency number', async () => {
    mockStatus({
      region: 'iad1',
      build: null,
      services: {
        gemini: { configured: true },
        jina: { configured: false },
        redis: { configured: true, reachable: false },
        sync: { configured: true, reachable: false },
      },
    });
    renderWithProviders(<DebugPage />, { route: '/debug' });
    await waitFor(() => {
      // Both the Redis and Sync rows show the unreachable state.
      expect(
        screen.getAllByText(/configured · unreachable/i).length,
      ).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/ms/)).not.toBeInTheDocument();
  });

  it('shows an error state with a retry button when the endpoint fails', async () => {
    const fetchMock = mockStatus(
      {
        region: null,
        build: null,
        services: {
          gemini: { configured: false },
          jina: { configured: false },
          redis: { configured: false },
        },
      },
      false,
    );
    renderWithProviders(<DebugPage />, { route: '/debug' });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /could not load status/i,
      );
    });
    expect(
      screen.getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('refetches when the user clicks Refresh', async () => {
    let call = 0;
    const fetchMock = mockStatus(() => {
      call += 1;
      const latency = call === 1 ? 4 : 9;
      return {
        region: 'iad1',
        build: null,
        services: {
          gemini: { configured: true },
          jina: { configured: false },
          redis: { configured: true, reachable: true, latencyMs: latency },
          sync: { configured: true, reachable: true, latencyMs: latency },
        },
      };
    });
    renderWithProviders(<DebugPage />, { route: '/debug' });
    await waitFor(() =>
      expect(screen.getAllByText(/4 ms/).length).toBeGreaterThan(0),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() =>
      expect(screen.getAllByText(/9 ms/).length).toBeGreaterThan(0),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders the back-to-Top link', async () => {
    mockStatus({
      region: null,
      build: null,
      services: {
        gemini: { configured: false },
        jina: { configured: false },
        redis: { configured: false },
      },
    });
    renderWithProviders(<DebugPage />, { route: '/debug' });
    // Wait for the fetch to resolve (the Services heading only renders
    // after data is available).
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 2, name: /services/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('link', { name: /back to top/i }),
    ).toHaveAttribute('href', '/top');
  });
});
