import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotThresholdTuning } from './HotThresholdTuning';
import { renderWithProviders } from '../test/renderUtils';

interface ServerEvent {
  action: 'pin' | 'hide';
  id: number;
  score: number;
  time: number;
  isHot: boolean;
  sourceFeed: string;
  eventTime: number;
}

function makeEvent(overrides: Partial<ServerEvent> = {}): ServerEvent {
  return {
    action: 'pin',
    id: 1,
    score: 100,
    time: Math.floor(Date.now() / 1000) - 60 * 60,
    isHot: true,
    sourceFeed: 'top',
    eventTime: Date.now(),
    ...overrides,
  };
}

function installEventsMock(body: { user: ServerEvent[]; anon: ServerEvent[] } | { error: string }, status = 200) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.includes('/api/admin-telemetry-events')) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('<HotThresholdTuning>', () => {
  it('shows the empty-state when there are no events at all', async () => {
    installEventsMock({ user: [], anon: [] });
    renderWithProviders(<HotThresholdTuning />);
    await waitFor(() =>
      expect(
        screen.getByTestId('threshold-scatter-empty'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/Pinned \(0\)/)).toBeInTheDocument();
    expect(screen.getByText(/Hidden \(0\)/)).toBeInTheDocument();
  });

  it('renders the scatter and per-action stats from the server response', async () => {
    installEventsMock({
      user: [
        makeEvent({ action: 'pin', id: 1, score: 80 }),
        makeEvent({ action: 'pin', id: 2, score: 200 }),
        makeEvent({ action: 'hide', id: 3, score: 5 }),
      ],
      anon: [],
    });
    renderWithProviders(<HotThresholdTuning />);
    await waitFor(() =>
      expect(screen.getByTestId('threshold-scatter')).toBeInTheDocument(),
    );
    expect(screen.getByText(/Pinned \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Hidden \(1\)/)).toBeInTheDocument();
    expect(screen.getByTestId('pin-stats')).toBeInTheDocument();
    expect(screen.getByTestId('hide-stats')).toBeInTheDocument();
  });

  it('falls back to local events when the server endpoint errors', async () => {
    installEventsMock({ error: 'unconfigured' }, 503);
    // Seed the local ring buffer so the fallback path has data to
    // render. Stamping the entry directly avoids depending on
    // recordFirstAction's own gating.
    window.localStorage.setItem(
      'newshacker:telemetry:events',
      JSON.stringify([
        makeEvent({ action: 'pin', id: 99, score: 120, sourceFeed: 'hot' }),
      ]),
    );
    renderWithProviders(<HotThresholdTuning />);
    // Wait for the server query to settle into the error path, then
    // confirm both the alert and the local-fallback count.
    await screen.findByText(/Could not reach the telemetry endpoint/i);
    expect(screen.getByText(/Pinned \(1\)/)).toBeInTheDocument();
  });

  it('dedupes events that appear in both server and local sources', async () => {
    const both = makeEvent({
      action: 'pin',
      id: 7,
      score: 100,
      eventTime: 1700000000000,
    });
    installEventsMock({ user: [both], anon: [] });
    window.localStorage.setItem(
      'newshacker:telemetry:events',
      JSON.stringify([both]),
    );
    renderWithProviders(<HotThresholdTuning />);
    await waitFor(() =>
      // Despite appearing in both sources, the row should be
      // counted once.
      expect(screen.getByText(/Pinned \(1\)/)).toBeInTheDocument(),
    );
  });

  it('the Export local JSON button reveals the local buffer contents', async () => {
    installEventsMock({ user: [], anon: [] });
    window.localStorage.setItem(
      'newshacker:telemetry:events',
      JSON.stringify([makeEvent({ id: 42 })]),
    );
    renderWithProviders(<HotThresholdTuning />);
    await waitFor(() =>
      expect(screen.getByText(/Pinned \(1\)/)).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: /export local json/i }),
    );
    const exported = await screen.findByTestId('threshold-export');
    expect(exported.textContent).toMatch(/"id": 42/);
  });

  it('the Clear local buffer button wipes localStorage', async () => {
    installEventsMock({ user: [], anon: [] });
    window.localStorage.setItem(
      'newshacker:telemetry:events',
      JSON.stringify([makeEvent({ id: 42 })]),
    );
    renderWithProviders(<HotThresholdTuning />);
    await waitFor(() =>
      expect(screen.getByText(/Pinned \(1\)/)).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: /clear local buffer/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/Pinned \(0\)/)).toBeInTheDocument(),
    );
    expect(window.localStorage.getItem('newshacker:telemetry:events')).toBe(
      '[]',
    );
  });
});
