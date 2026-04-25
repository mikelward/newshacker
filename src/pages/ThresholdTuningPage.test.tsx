import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThresholdTuningPage } from './ThresholdTuningPage';
import { renderWithProviders } from '../test/renderUtils';

interface ServerEvent {
  action: 'pin' | 'hide';
  id: number;
  score: number;
  time: number;
  isHot: boolean;
  sourceFeed: string;
  eventTime: number;
  descendants?: number;
  type?: string;
  articleOpened?: boolean;
  title?: string;
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
    descendants: 50,
    type: 'story',
    articleOpened: false,
    title: `Story ${1}`,
    ...overrides,
  };
}

interface MockOpts {
  me?: { username?: string } | null;
  adminStatus?: number;
  adminBody?: { username?: string; signedInAs?: string };
  events?: { user?: ServerEvent[]; anon?: ServerEvent[] };
}

function installMock({
  me = { username: 'mikelward' },
  adminStatus = 200,
  adminBody = { username: 'mikelward' },
  events = { user: [], anon: [] },
}: MockOpts = {}) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/me')) {
      const status = me?.username ? 200 : 401;
      return new Response(JSON.stringify(me ?? null), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/admin-telemetry-events')) {
      return new Response(
        JSON.stringify({ user: events.user ?? [], anon: events.anon ?? [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/admin')) {
      return new Response(JSON.stringify(adminBody), {
        status: adminStatus,
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

describe('<ThresholdTuningPage>', () => {
  it('redirects to /login when the user is not authenticated', async () => {
    installMock({ me: null });
    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    // The `<Navigate>` redirect lands on /login synchronously. The
    // page itself renders nothing, and the wrapper renders the
    // login route in its place — pin presence of the login form via
    // the LoginPage's heading text.
    await waitFor(() =>
      expect(
        screen.queryByText(/sign in|login|Hot threshold tuning/i),
      ).not.toBe(null),
    );
  });

  it('shows the forbidden message when /api/admin returns 403', async () => {
    installMock({
      adminStatus: 403,
      adminBody: { signedInAs: 'someoneelse' },
    });
    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    await waitFor(() =>
      expect(
        screen.getByText(/only available to the site operator/i),
      ).toBeInTheDocument(),
    );
  });

  it('renders the controls + body when the operator is authorized', async () => {
    installMock({});
    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    await waitFor(() =>
      expect(screen.getByTestId('threshold-controls')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('threshold-live-counts'),
    ).toBeInTheDocument();
    // Default expression mirrors isHotStory.
    const expr = screen.getByTestId('threshold-expression') as HTMLInputElement;
    expect(expr.value).toMatch(/normal_threshold/);
    expect(expr.value).toMatch(/young_age/);
  });

  it('updates the live counts when the expression changes', async () => {
    installMock({
      events: {
        user: [
          makeEvent({ action: 'pin', id: 1, score: 50 }),
          makeEvent({ action: 'pin', id: 2, score: 200 }),
          makeEvent({ action: 'hide', id: 3, score: 5 }),
        ],
      },
    });
    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    await waitFor(() =>
      expect(screen.getByTestId('pin-match')).toBeInTheDocument(),
    );

    // Type a stricter rule: only score >= 150. One of two pins
    // qualifies; the score-5 hide does not.
    const expr = screen.getByTestId('threshold-expression') as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(expr);
    await user.type(expr, 'score >= 150');
    await waitFor(() =>
      expect(screen.getByTestId('pin-match').textContent).toMatch(/1 of 2/),
    );
    expect(screen.getByTestId('hide-match').textContent).toMatch(/0 of 1/);
  });

  it('reset button restores the default expression and slider values', async () => {
    installMock({});
    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    await waitFor(() =>
      expect(screen.getByTestId('threshold-reset')).toBeInTheDocument(),
    );
    const expr = screen.getByTestId('threshold-expression') as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(expr);
    await user.type(expr, 'false');
    expect(expr.value).toBe('false');
    await user.click(screen.getByTestId('threshold-reset'));
    expect(expr.value).toMatch(/normal_threshold/);
  });

  it('renders the live Preview with /top ∪ /new candidates filtered by the rule', async () => {
    // Bootstrap the Preview's data path: /top + /new id lists +
    // /api/items batch. The mock dispatches by URL so the HN
    // endpoints (used by useHotFeedItems) and the auth endpoints
    // (/api/me, /api/admin) coexist.
    const nowS = Math.floor(Date.now() / 1000);
    const hotStory = {
      id: 100,
      type: 'story',
      title: 'big-hot-story',
      url: 'https://example.com/100',
      by: 'alice',
      score: 200,
      descendants: 50,
      time: nowS - 60 * 60,
    };
    const coldStory = {
      id: 200,
      type: 'story',
      title: 'cold-skip-story',
      url: 'https://example.com/200',
      by: 'bob',
      score: 5,
      descendants: 1,
      time: nowS - 12 * 60 * 60,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : (input as URL).toString();
        if (url.includes('/api/me')) {
          return new Response(JSON.stringify({ username: 'mikelward' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/admin-telemetry-events')) {
          return new Response(JSON.stringify({ user: [], anon: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/admin')) {
          return new Response(JSON.stringify({ username: 'mikelward' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('topstories.json')) {
          return new Response(JSON.stringify([100, 200]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('newstories.json')) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/items')) {
          const ids = new URL(url, 'http://localhost').searchParams.get('ids') ?? '';
          const wanted = ids.split(',').map(Number);
          const body = wanted.map((id) =>
            id === 100 ? hotStory : id === 200 ? coldStory : null,
          );
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    // Preview is open by default — story title appears once the
    // /top fetch + /api/items batch resolve.
    await waitFor(() =>
      expect(screen.getByTestId('threshold-preview')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText('big-hot-story')).toBeInTheDocument(),
    );
    // Score-5 story doesn't pass the default isHotStory rule, so
    // the Preview filters it out.
    expect(screen.queryByText('cold-skip-story')).toBeNull();
  });

  it('renders type breakdown counts', async () => {
    installMock({
      events: {
        user: [
          makeEvent({ action: 'pin', id: 1, type: 'story' }),
          makeEvent({ action: 'pin', id: 2, type: 'story' }),
          makeEvent({ action: 'hide', id: 3, type: 'job' }),
        ],
      },
    });
    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    await waitFor(() =>
      expect(
        screen.getByTestId('threshold-type-breakdown'),
      ).toBeInTheDocument(),
    );
    const t = screen.getByTestId('threshold-type-breakdown');
    expect(t.textContent).toMatch(/story/);
    expect(t.textContent).toMatch(/job/);
  });

  it('renders the opened ratio when articleOpened is captured', async () => {
    installMock({
      events: {
        user: [
          makeEvent({ action: 'pin', id: 1, articleOpened: true }),
          makeEvent({ action: 'pin', id: 2, articleOpened: false }),
          makeEvent({ action: 'hide', id: 3, articleOpened: true }),
        ],
      },
    });
    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    await waitFor(() =>
      expect(screen.getByTestId('threshold-opened-ratio')).toBeInTheDocument(),
    );
    const r = screen.getByTestId('threshold-opened-ratio');
    expect(r.textContent).toMatch(/Pinned after opening/);
    expect(r.textContent).toMatch(/Hidden after opening/);
  });
});
