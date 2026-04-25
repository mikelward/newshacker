import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThresholdTuningPage } from './ThresholdTuningPage';
import { renderWithProviders } from '../test/renderUtils';
import { addPinnedId } from '../lib/pinnedStories';
import { addDoneId } from '../lib/doneStories';
import { addHiddenId } from '../lib/hiddenStories';

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

  it('keeps done stories visible in the Preview', async () => {
    // /hot strips done stories from the rendered list as part of
    // the reader's normal "I've already handled this" sweep. The
    // Preview is asking what the *rule* surfaces, independent of
    // how much of the list the operator has already worked
    // through, so done stories must stay visible — otherwise an
    // operator with an active reading habit sees a near-empty
    // Preview even when the rule is matching plenty of trending
    // stories.
    addDoneId(100);
    const nowS = Math.floor(Date.now() / 1000);
    const doneHotStory = {
      id: 100,
      type: 'story',
      title: 'done-but-still-hot',
      url: 'https://example.com/100',
      by: 'alice',
      score: 200,
      descendants: 50,
      time: nowS - 60 * 60,
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
          return new Response(JSON.stringify([100]), {
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
          const ids =
            new URL(url, 'http://localhost').searchParams.get('ids') ?? '';
          const wanted = ids.split(',').map(Number);
          const body = wanted.map((id) => (id === 100 ? doneHotStory : null));
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    await waitFor(() =>
      expect(screen.getByText('done-but-still-hot')).toBeInTheDocument(),
    );
  });

  it('does not prepend fully off-feed pinned stories', async () => {
    // The reader has pinned a story (id 999) that has dropped
    // off both /top *and* /new — it's purely off-feed. The
    // off-feed pin overlay would surface it on /hot; the
    // Preview must not show it because the page is asking what
    // the *rule* (over /top ∪ /new) would render.
    addPinnedId(999);
    const nowS = Math.floor(Date.now() / 1000);
    const hotStory = {
      id: 100,
      type: 'story',
      title: 'genuinely-hot',
      url: 'https://example.com/100',
      by: 'bob',
      score: 200,
      descendants: 50,
      time: nowS - 60 * 60,
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
          // Pinned id 999 is *not* in /top *or* /new — fully
          // off-feed.
          return new Response(JSON.stringify([100]), {
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
          const body = wanted.map((id) => (id === 100 ? hotStory : null));
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    await waitFor(() =>
      expect(screen.getByText('genuinely-hot')).toBeInTheDocument(),
    );
    // The pinned-but-fully-off-feed story must not appear via
    // the off-feed-pinned overlay.
    expect(screen.queryByText('pinned-but-off-feed')).toBeNull();
  });

  it('renders pinned-still-on-source-feed stories with the exclam right-action', async () => {
    // The reader has pinned a cold story (score 5) that is still
    // present in /top. The expression rule alone wouldn't surface
    // it (score 5), but the combined rule-OR-pinned predicate
    // includes it — and the right-side icon flips to the
    // exclamation marker telling the operator "you cared about
    // this but the rule wouldn't promote it; consider loosening".
    addPinnedId(777);
    const nowS = Math.floor(Date.now() / 1000);
    const pinnedColdInTop = {
      id: 777,
      type: 'story',
      title: 'pinned-cold-still-on-top',
      url: 'https://example.com/777',
      by: 'alice',
      score: 5,
      descendants: 1,
      time: nowS - 6 * 60 * 60,
    };
    const hotStory = {
      id: 100,
      type: 'story',
      title: 'genuinely-hot',
      url: 'https://example.com/100',
      by: 'bob',
      score: 200,
      descendants: 50,
      time: nowS - 60 * 60,
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
          return new Response(JSON.stringify([100, 777]), {
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
            id === 100 ? hotStory : id === 777 ? pinnedColdInTop : null,
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
    await waitFor(() =>
      expect(
        screen.getByText('pinned-cold-still-on-top'),
      ).toBeInTheDocument(),
    );
    // The exclam button identifies the cared-but-not-hot row.
    expect(
      screen.getByTestId('preview-cared-not-hot-btn-777'),
    ).toBeInTheDocument();
  });

  it('renders done-still-on-source-feed stories with the exclam right-action', async () => {
    // Same shape as the pinned-cold test above, except the
    // operator marked the cold story done (not pinned). Done is
    // weighted equally with pinned for tuning: either is "you
    // engaged with this story", so the rule missing it is
    // suboptimal regardless of which list it ended up on.
    addDoneId(777);
    const nowS = Math.floor(Date.now() / 1000);
    const doneColdInTop = {
      id: 777,
      type: 'story',
      title: 'done-cold-still-on-top',
      url: 'https://example.com/777',
      by: 'alice',
      score: 5,
      descendants: 1,
      time: nowS - 6 * 60 * 60,
    };
    const hotStory = {
      id: 100,
      type: 'story',
      title: 'genuinely-hot',
      url: 'https://example.com/100',
      by: 'bob',
      score: 200,
      descendants: 50,
      time: nowS - 60 * 60,
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
          return new Response(JSON.stringify([100, 777]), {
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
          const ids =
            new URL(url, 'http://localhost').searchParams.get('ids') ?? '';
          const wanted = ids.split(',').map(Number);
          const body = wanted.map((id) =>
            id === 100 ? hotStory : id === 777 ? doneColdInTop : null,
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
    await waitFor(() =>
      expect(screen.getByText('done-cold-still-on-top')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('preview-cared-not-hot-btn-777'),
    ).toBeInTheDocument();
  });

  it('does not surface a done story that has dropped off both source feeds', async () => {
    // Off-feed done stories must not appear: `useHotFeedItems`
    // only fetches from /top ∪ /new, and the Preview never
    // overlays anything outside that fetched set. Same constraint
    // we have for off-feed pinned.
    addDoneId(999);
    const nowS = Math.floor(Date.now() / 1000);
    const hotStory = {
      id: 100,
      type: 'story',
      title: 'genuinely-hot',
      url: 'https://example.com/100',
      by: 'bob',
      score: 200,
      descendants: 50,
      time: nowS - 60 * 60,
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
          // 999 (done) is *not* in /top *or* /new — fully off-feed.
          return new Response(JSON.stringify([100]), {
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
          const ids =
            new URL(url, 'http://localhost').searchParams.get('ids') ?? '';
          const wanted = ids.split(',').map(Number);
          const body = wanted.map((id) => (id === 100 ? hotStory : null));
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    await waitFor(() =>
      expect(screen.getByText('genuinely-hot')).toBeInTheDocument(),
    );
    // The done-but-fully-off-feed story must not appear at all,
    // and no exclam button (any per-row id) should render.
    expect(screen.queryByTestId(/^preview-cared-not-hot-btn-/)).toBeNull();
  });

  it('flags hidden-but-rule-matches stories with the red exclam', async () => {
    // The operator hid story 100 but the rule (default
    // isHotStory) would happily surface it again — a false
    // positive that calls for tightening, not loosening. The
    // Preview must (a) keep the row visible despite hiddenIds
    // (StoryListImpl's default would strip it) and (b) light up
    // the rule-matches-hidden right action so the operator can
    // see at a glance "rule is too loose for this row".
    addHiddenId(100);
    const nowS = Math.floor(Date.now() / 1000);
    const hiddenButHotStory = {
      id: 100,
      type: 'story',
      title: 'hidden-but-the-rule-still-promotes',
      url: 'https://example.com/100',
      by: 'alice',
      score: 200,
      descendants: 50,
      time: nowS - 60 * 60,
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
          return new Response(JSON.stringify([100]), {
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
          const ids =
            new URL(url, 'http://localhost').searchParams.get('ids') ?? '';
          const wanted = ids.split(',').map(Number);
          const body = wanted.map((id) =>
            id === 100 ? hiddenButHotStory : null,
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
    await waitFor(() =>
      expect(
        screen.getByText('hidden-but-the-rule-still-promotes'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('preview-rule-matches-hidden-btn-100'),
    ).toBeInTheDocument();
  });

  it('does not surface a hidden story the rule does not match', async () => {
    // Symmetric to the test above: the operator hid story 200
    // and the rule wouldn't surface it either (score 5). Both
    // signals agree — no signal needed, the row stays out of the
    // Preview. Confirms `includeHidden` doesn't accidentally
    // widen the candidate pool to "every hidden story".
    addHiddenId(200);
    const nowS = Math.floor(Date.now() / 1000);
    const hotStory = {
      id: 100,
      type: 'story',
      title: 'genuinely-hot',
      url: 'https://example.com/100',
      by: 'alice',
      score: 200,
      descendants: 50,
      time: nowS - 60 * 60,
    };
    const hiddenColdStory = {
      id: 200,
      type: 'story',
      title: 'hidden-and-cold',
      url: 'https://example.com/200',
      by: 'bob',
      score: 5,
      descendants: 1,
      time: nowS - 6 * 60 * 60,
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
          const ids =
            new URL(url, 'http://localhost').searchParams.get('ids') ?? '';
          const wanted = ids.split(',').map(Number);
          const body = wanted.map((id) =>
            id === 100 ? hotStory : id === 200 ? hiddenColdStory : null,
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
    await waitFor(() =>
      expect(screen.getByText('genuinely-hot')).toBeInTheDocument(),
    );
    // Hidden cold story shouldn't appear (rule misses, hidden
    // not widened in).
    expect(screen.queryByText('hidden-and-cold')).toBeNull();
    expect(
      screen.queryByTestId(/^preview-rule-matches-hidden-btn-/),
    ).toBeNull();
  });

  it('renders Preview rows as read-only — no live pin/unpin button', async () => {
    // Two rows: one pinned, one neither pinned nor done. The
    // default `StoryListImpl` would render a real Pin/Unpin
    // button (testId `pin-btn`) for both, which would mutate
    // reader state when tapped. The Preview overrides every row
    // to return a no-op informational action instead.
    addPinnedId(100);
    const nowS = Math.floor(Date.now() / 1000);
    const pinnedHotStory = {
      id: 100,
      type: 'story',
      title: 'pinned-and-hot',
      url: 'https://example.com/100',
      by: 'alice',
      score: 200,
      descendants: 50,
      time: nowS - 60 * 60,
    };
    const unpinnedHotStory = {
      id: 200,
      type: 'story',
      title: 'unpinned-and-hot',
      url: 'https://example.com/200',
      by: 'bob',
      score: 300,
      descendants: 80,
      time: nowS - 90 * 60,
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
          const ids =
            new URL(url, 'http://localhost').searchParams.get('ids') ?? '';
          const wanted = ids.split(',').map(Number);
          const body = wanted.map((id) =>
            id === 100 ? pinnedHotStory : id === 200 ? unpinnedHotStory : null,
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
    await waitFor(() =>
      expect(screen.getByText('pinned-and-hot')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText('unpinned-and-hot')).toBeInTheDocument(),
    );
    // Pinned row gets the read-only-pinned variant.
    const pinnedRowBtn = screen.getByTestId('preview-readonly-pinned-btn-100');
    expect(pinnedRowBtn).toBeInTheDocument();
    // Pinned variant inherits the orange `pin-btn--active` class
    // (mirrors the live feed's pinned affordance, just non-interactive).
    expect(pinnedRowBtn.className).toContain('pin-btn--active');
    // Unpinned row gets the plain read-only variant *without*
    // pin-btn--active so the icon doesn't render in HN orange —
    // the operator's eye distinguishes "engaged" rows from
    // "rule-matches-but-untouched" rows by color.
    const unpinnedRowBtn = screen.getByTestId('preview-readonly-btn-200');
    expect(unpinnedRowBtn).toBeInTheDocument();
    expect(unpinnedRowBtn.className).not.toContain('pin-btn--active');
    // No live Pin/Unpin button should render anywhere in the Preview.
    expect(screen.queryAllByTestId('pin-btn')).toHaveLength(0);
    // The bulk Sweep button — the only other "mutate every row"
    // affordance — also shouldn't render under readOnly.
    expect(screen.queryByTestId('sweep-btn-bottom')).toBeNull();
  });

  it('Preview rows do not open the long-press / right-click menu', async () => {
    // The long-press menu is the third mutation surface (after
    // the right-side button and the bulk Sweep button). When
    // `readOnly` is set, `useSwipeToDismiss` sees no handlers
    // and binds no pointer events, so a long-press should
    // produce no menu — `story-row-menu` never appears.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    addPinnedId(100);
    const nowS = Math.floor(Date.now() / 1000);
    const story = {
      id: 100,
      type: 'story',
      title: 'long-press-target',
      url: 'https://example.com/100',
      by: 'alice',
      score: 200,
      descendants: 50,
      time: nowS - 60 * 60,
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
          return new Response(JSON.stringify([100]), {
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
          const ids =
            new URL(url, 'http://localhost').searchParams.get('ids') ?? '';
          const wanted = ids.split(',').map(Number);
          const body = wanted.map((id) => (id === 100 ? story : null));
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    renderWithProviders(<ThresholdTuningPage />, { route: '/tuning' });
    await waitFor(() =>
      expect(screen.getByText('long-press-target')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('story-row-menu')).toBeNull();

    // Synthesize a long-press in the same shape `HiddenPage`'s
    // shield test uses: pointerdown then advance past the
    // long-press timeout. `useSwipeToDismiss` should never have
    // bound the pointerdown listener under readOnly, so the
    // menu must stay closed.
    const row = screen.getByTestId('story-row');
    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(down, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
      button: 0,
      isPrimary: true,
    });
    act(() => {
      row.dispatchEvent(down);
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByTestId('story-row-menu')).toBeNull();
    vi.useRealTimers();
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
