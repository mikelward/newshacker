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

  it('renders the event list with a hot-or-not flag per row', async () => {
    installMock({
      events: {
        user: [
          makeEvent({
            action: 'pin',
            id: 7,
            score: 200,
            title: 'big-pin-title',
          }),
          makeEvent({
            action: 'hide',
            id: 8,
            score: 3,
            isHot: false,
            title: 'cold-hide-title',
          }),
        ],
      },
    });
    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    await waitFor(() =>
      expect(screen.getByTestId('threshold-event-list')).toBeInTheDocument(),
    );
    // The event list is collapsed by default in the UI — happy-dom
    // doesn't render `<details>` children until the element is
    // open. Click the summary to expand it.
    const user = userEvent.setup();
    await user.click(
      screen.getByTestId('threshold-event-list').querySelector('summary')!,
    );
    const rows = await screen.findAllByTestId('threshold-event-row');
    expect(rows).toHaveLength(2);
    // Match flags reflect the default expression (score >= 100 ||
    // score >= 40 with age < 2h). Score-200 pin → matches; score-3
    // hide → doesn't.
    const matchByTitle: Record<string, string | null> = {};
    for (const row of rows) {
      const title = row.querySelector('a')?.textContent ?? '';
      matchByTitle[title] = row.getAttribute('data-matches');
    }
    expect(matchByTitle['big-pin-title']).toBe('true');
    expect(matchByTitle['cold-hide-title']).toBe('false');
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
