import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminPage } from './AdminPage';
import { renderWithProviders } from '../test/renderUtils';

interface MeBody {
  username?: string;
  error?: string;
}

interface JinaAccount {
  configured: boolean;
  reachable?: boolean;
  httpStatus?: number;
  regularBalance?: number | null;
  totalBalance?: number | null;
  threshold?: number | null;
  raw?: unknown;
}

interface AdminBody {
  username: string;
  region: string | null;
  build: string | null;
  services: {
    gemini: { configured: boolean; reachable?: boolean; latencyMs?: number };
    jina: JinaAccount;
    redis: { configured: boolean; reachable?: boolean; latencyMs?: number };
  };
}

// Default `admin-stats` payload: not-configured. Tests that care about
// the analytics rendering pass an explicit stats body.
const NOT_CONFIGURED_STATS = {
  configured: false,
  axiom: { tokenConfigured: false, dataset: null as string | null },
  cards: null,
};

// Route a single fetch mock by URL. /api/me gates the page at the
// useAuth boundary; /api/admin delivers the operator data.
function installFetchMock({
  me,
  admin,
  adminStatus = 200,
  stats = NOT_CONFIGURED_STATS,
  statsStatus = 200,
}: {
  me: MeBody | (() => MeBody);
  admin: AdminBody | (() => AdminBody);
  adminStatus?: number | (() => number);
  stats?: unknown | (() => unknown);
  statsStatus?: number | (() => number);
}) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.includes('/api/me')) {
      const body = typeof me === 'function' ? me() : me;
      const status = body.username ? 200 : 401;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Match the base /api/admin endpoint without catching the
    // telemetry sub-endpoints (which need their own response shape
    // — see ThresholdTuningPage.test.tsx).
    if (url.includes('/api/admin-telemetry-events')) {
      return new Response(JSON.stringify({ user: [], anon: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/admin-stats')) {
      const body = typeof stats === 'function' ? stats() : stats;
      const status =
        typeof statsStatus === 'function' ? statsStatus() : statsStatus;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/admin')) {
      const body = typeof admin === 'function' ? admin() : admin;
      const status =
        typeof adminStatus === 'function' ? adminStatus() : adminStatus;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

const OK_ADMIN: AdminBody = {
  username: 'mikelward',
  region: 'iad1',
  build: 'abc1234def5678',
  services: {
    gemini: { configured: true },
    jina: {
      configured: true,
      reachable: true,
      httpStatus: 200,
      regularBalance: 100_000,
      totalBalance: 1_234_567,
      threshold: 50_000,
      raw: {
        email: 'ops@example.com',
        wallet: {
          regular_balance: 100_000,
          total_balance: 1_234_567,
        },
        metadata: { threshold: 50_000 },
      },
    },
    redis: { configured: true, reachable: true, latencyMs: 5 },
  },
};

describe('<AdminPage>', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects unauthenticated users to /login', async () => {
    installFetchMock({
      me: { error: 'Not authenticated' },
      admin: OK_ADMIN,
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    // The Navigate component replaces the route; the admin heading must
    // not render. We also tolerate a brief loading state before the
    // /api/me probe resolves.
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { level: 1, name: /admin/i }),
      ).toBeNull();
    });
  });

  it('renders identity + Jina balances/threshold + dashboard links for an admin user', async () => {
    installFetchMock({
      me: { username: 'mikelward' },
      admin: OK_ADMIN,
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: /admin/i }),
      ).toBeInTheDocument();
    });
    expect(await screen.findByText('mikelward')).toBeInTheDocument();
    expect(screen.getByText('iad1')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();

    // Balances are rendered via `toLocaleString`, which produces
    // host-locale thousands separators. Accept anything Intl treats
    // as a grouping character: ASCII comma/dot (en-US, de-DE), any
    // whitespace incl. NBSP (fr-FR), the straight apostrophe (de-CH)
    // and the typographic right single quote some locales prefer.
    // The test shouldn't depend on which locale the CI host is
    // running in.
    const GROUP = "[.,\\s'’]";
    const total = await screen.findByTestId('admin-jina-total-balance');
    expect(total.textContent).toMatch(new RegExp(`1${GROUP}234${GROUP}567`));
    const regular = screen.getByTestId('admin-jina-regular-balance');
    expect(regular.textContent).toMatch(new RegExp(`100${GROUP}000`));
    const threshold = screen.getByTestId('admin-jina-threshold');
    expect(threshold.textContent).toMatch(new RegExp(`50${GROUP}000`));

    // Raw response is behind a <details> but still in the DOM.
    expect(screen.getByText(/ops@example\.com/)).toBeInTheDocument();

    expect(
      screen.getByRole('link', { name: /jina dashboard/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /google ai studio/i }),
    ).toBeInTheDocument();
  });

  it('shows "unknown" for any Jina field missing from the response', async () => {
    installFetchMock({
      me: { username: 'mikelward' },
      admin: {
        ...OK_ADMIN,
        services: {
          ...OK_ADMIN.services,
          jina: {
            configured: true,
            reachable: true,
            regularBalance: null,
            totalBalance: null,
            threshold: null,
          },
        },
      },
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    const total = await screen.findByTestId('admin-jina-total-balance');
    expect(total).toHaveTextContent(/unknown/i);
  });

  it('surfaces Jina unreachable with the upstream HTTP status', async () => {
    installFetchMock({
      me: { username: 'mikelward' },
      admin: {
        ...OK_ADMIN,
        services: {
          ...OK_ADMIN.services,
          jina: {
            configured: true,
            reachable: false,
            httpStatus: 401,
          },
        },
      },
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    await waitFor(() => {
      expect(
        screen.getByText(/configured · unreachable \(HTTP 401\)/i),
      ).toBeInTheDocument();
    });
    // Balance list must not render when unreachable.
    expect(screen.queryByTestId('admin-jina-total-balance')).toBeNull();
  });

  it('renders indeterminate state when Jina reachable is undefined (tri-state guard)', async () => {
    // Older /api/admin responses (or partial ones) may omit
    // `reachable`. That must not render as a green "reachable"
    // label, and the balance list must stay hidden — otherwise we
    // show three "unavailable" cells for numbers we can't actually
    // prove are absent.
    installFetchMock({
      me: { username: 'mikelward' },
      admin: {
        ...OK_ADMIN,
        services: {
          ...OK_ADMIN.services,
          jina: { configured: true },
        },
      },
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    // The Services section only renders once the admin query
    // resolves; waiting on the Jina h2 avoids racing against the
    // initial loading state.
    const jinaHeading = await screen.findByRole('heading', {
      level: 2,
      name: /^jina$/i,
    });
    // The detail line sits in the service row immediately after the
    // Jina heading; scope the assertion so we don't accidentally
    // match the Redis row's own "configured · reachable · N ms".
    const jinaRow = jinaHeading.nextElementSibling as HTMLElement | null;
    expect(jinaRow).not.toBeNull();
    expect(jinaRow!.textContent).toMatch(/configured/);
    expect(jinaRow!.textContent).not.toMatch(/reachable/);
    // Balance list is hidden.
    expect(screen.queryByTestId('admin-jina-total-balance')).toBeNull();
  });

  it('redirects to /login when the admin endpoint returns 401 (stale auth cache)', async () => {
    // `useAuth` keeps /api/me around for up to an hour, so the client
    // can believe it's signed in after the server-side cookie has
    // actually expired. A 401 from /api/admin is the authoritative
    // signal that the session is gone — we must bounce to /login
    // rather than show a generic error.
    installFetchMock({
      me: { username: 'mikelward' },
      admin: { error: 'Not authenticated' } as unknown as AdminBody,
      adminStatus: 401,
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { level: 1, name: /admin/i }),
      ).toBeNull();
    });
    // The generic error panel must not render.
    expect(screen.queryByText(/could not load admin status/i)).toBeNull();
  });

  it('shows a Forbidden message with signed-in identity for non-admins', async () => {
    installFetchMock({
      me: { username: 'alice' },
      admin: {
        error: 'Forbidden',
        reason: 'admin_user_mismatch',
        signedInAs: 'alice',
      } as unknown as AdminBody,
      adminStatus: 403,
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /signed in as alice/i,
      );
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /only available to the site operator/i,
    );
    // The operator dashboard sections must not render for a
    // forbidden user.
    expect(screen.queryByText(/identity/i)).toBeNull();
    expect(
      screen.queryByRole('link', { name: /open jina dashboard/i }),
    ).toBeNull();
  });

  it('shows a "not logged in" reason when HN rejects the session cookie', async () => {
    // This is what an operator sees when their /api/admin succeeded
    // the prefix check but HN itself reports them as signed out
    // (expired cookie, different browser session, etc.).
    installFetchMock({
      me: { username: 'mikelward' },
      admin: {
        error: 'Forbidden',
        reason: 'not_logged_in',
      } as unknown as AdminBody,
      adminStatus: 403,
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /hacker news does not consider this session logged in/i,
      );
    });
  });

  it('shows a timeout reason on 503 when HN is unreachable', async () => {
    installFetchMock({
      me: { username: 'mikelward' },
      admin: {
        error: 'Forbidden',
        reason: 'timeout',
      } as unknown as AdminBody,
      adminStatus: 503,
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /timed out verifying your session with hacker news/i,
      );
    });
  });

  it('shows a retry button when the admin endpoint fails with an unexpected error', async () => {
    installFetchMock({
      me: { username: 'mikelward' },
      admin: { error: 'server exploded' } as unknown as AdminBody,
      adminStatus: 500,
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /could not load admin status/i,
      );
    });
    expect(
      screen.getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
  });

  it('refetches when the user clicks Refresh', async () => {
    let call = 0;
    const fetchMock = installFetchMock({
      me: { username: 'mikelward' },
      admin: () => {
        call += 1;
        return {
          ...OK_ADMIN,
          services: {
            ...OK_ADMIN.services,
            redis: {
              configured: true,
              reachable: true,
              latencyMs: call === 1 ? 5 : 9,
            },
          },
        };
      },
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    await waitFor(() =>
      expect(screen.getByText(/5 ms/)).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    // Exact "Refresh" — there's also a "Refresh analytics" button on
    // the page, and a regex match would be ambiguous.
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.getByText(/9 ms/)).toBeInTheDocument(),
    );
    // /api/me once + /api/admin twice. Filter to the base
    // /api/admin endpoint only — exclude similarly-prefixed
    // sub-endpoints like /api/admin-telemetry-events that other
    // pages (e.g. /tuning) drive.
    const adminCalls = fetchMock.mock.calls.filter((c) => {
      const url =
        typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString();
      return url.includes('/api/admin') && !url.includes('/api/admin-');
    });
    expect(adminCalls).toHaveLength(2);
  });

  it('renders a back-to-Top link', async () => {
    installFetchMock({
      me: { username: 'mikelward' },
      admin: OK_ADMIN,
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 2, name: /identity/i }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole('link', { name: /back to top/i }),
    ).toHaveAttribute('href', '/top');
  });
});

describe('<AdminPage> — analytics section', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a "not configured" hint when AXIOM_API_TOKEN/DATASET are unset', async () => {
    installFetchMock({
      me: { username: 'mikelward' },
      admin: OK_ADMIN,
      stats: NOT_CONFIGURED_STATS,
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    const card = await screen.findByTestId('admin-stats-not-configured');
    expect(card).toHaveTextContent(/AXIOM_API_TOKEN/);
    expect(card).toHaveTextContent(/AXIOM_DATASET/);
  });

  it('renders all five cards from a happy-path stats response', async () => {
    installFetchMock({
      me: { username: 'mikelward' },
      admin: OK_ADMIN,
      stats: {
        configured: true,
        axiom: { tokenConfigured: true, dataset: 'vercel' },
        cards: {
          cacheHits: {
            ok: true,
            value: {
              windowSeconds: 3600,
              byOutcome: { cached: 80, generated: 20 },
            },
          },
          tokens: {
            ok: true,
            value: {
              windowSeconds: 86_400,
              geminiTotalTokens: 12_345,
              jinaTokens: 5_678,
            },
          },
          failures: {
            ok: true,
            value: {
              windowSeconds: 86_400,
              byReason: [
                { reason: 'story_unreachable', count: 7 },
                { reason: 'summarization_failed', count: 3 },
              ],
            },
          },
          rateLimit: {
            ok: true,
            value: { windowSeconds: 3600, count: 4 },
          },
          warmCron: {
            ok: true,
            value: {
              windowSeconds: 21_600,
              lastRun: {
                tISO: new Date(Date.now() - 60_000).toISOString(),
                durationMs: 12_345,
                processed: 60,
                storyCount: 30,
              },
            },
          },
        },
      },
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });

    const rate = await screen.findByTestId('admin-stats-cache-hits-rate');
    // 80 / (80 + 20) = 80.0 %.
    expect(rate).toHaveTextContent('80.0%');

    const gemini = screen.getByTestId('admin-stats-gemini-tokens');
    expect(gemini.textContent).toMatch(/12[.,\s'’]345/);
    const jina = screen.getByTestId('admin-stats-jina-tokens');
    expect(jina.textContent).toMatch(/5[.,\s'’]678/);

    const failures = screen.getByTestId('admin-stats-failures');
    expect(failures).toHaveTextContent('story_unreachable');
    expect(failures).toHaveTextContent('summarization_failed');

    const rateLimit = screen.getByTestId('admin-stats-rate-limit-count');
    expect(rateLimit).toHaveTextContent('4');

    const when = screen.getByTestId('admin-stats-warm-cron-when');
    expect(when.textContent).toMatch(/(s|m) ago$/);
    const stories = screen.getByTestId('admin-stats-warm-cron-stories');
    expect(stories).toHaveTextContent('30');
  });

  it('renders a degraded card while keeping the rest of the dashboard alive', async () => {
    installFetchMock({
      me: { username: 'mikelward' },
      admin: OK_ADMIN,
      stats: {
        configured: true,
        axiom: { tokenConfigured: true, dataset: 'vercel' },
        cards: {
          cacheHits: {
            ok: true,
            value: { windowSeconds: 3600, byOutcome: { cached: 1 } },
          },
          tokens: { ok: false, reason: 'axiom_http_502' },
          failures: { ok: true, value: { windowSeconds: 86_400, byReason: [] } },
          rateLimit: {
            ok: true,
            value: { windowSeconds: 3600, count: 0 },
          },
          warmCron: {
            ok: true,
            value: { windowSeconds: 21_600, lastRun: null },
          },
        },
      },
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    const tokens = await screen.findByTestId('admin-stats-tokens');
    expect(tokens).toHaveTextContent(/Unavailable:/);
    expect(tokens).toHaveTextContent('axiom_http_502');
    // The other cards still render their happy-path content.
    expect(screen.getByTestId('admin-stats-cache-hits-rate')).toHaveTextContent(
      '100.0%',
    );
    // Empty buckets render explanatory copy rather than a stat.
    expect(screen.getByTestId('admin-stats-failures')).toHaveTextContent(
      /No errors in this window/i,
    );
    expect(screen.getByTestId('admin-stats-warm-cron')).toHaveTextContent(
      /No .*warm-run.* log lines/i,
    );
  });

  it('refetches analytics independently when the operator clicks "Refresh analytics"', async () => {
    let call = 0;
    const fetchMock = installFetchMock({
      me: { username: 'mikelward' },
      admin: OK_ADMIN,
      stats: () => {
        call += 1;
        return {
          configured: true,
          axiom: { tokenConfigured: true, dataset: 'vercel' },
          cards: {
            cacheHits: {
              ok: true,
              value: {
                windowSeconds: 3600,
                byOutcome: { cached: call === 1 ? 5 : 9 },
              },
            },
            tokens: {
              ok: true,
              value: {
                windowSeconds: 86_400,
                geminiTotalTokens: 0,
                jinaTokens: 0,
              },
            },
            failures: {
              ok: true,
              value: { windowSeconds: 86_400, byReason: [] },
            },
            rateLimit: {
              ok: true,
              value: { windowSeconds: 3600, count: 0 },
            },
            warmCron: {
              ok: true,
              value: { windowSeconds: 21_600, lastRun: null },
            },
          },
        };
      },
    });
    renderWithProviders(<AdminPage />, { route: '/admin' });
    // First paint: the `cached` count from call #1.
    const card = await screen.findByTestId('admin-stats-cache-hits');
    expect(card).toHaveTextContent(/cached/);
    await waitFor(() => expect(card).toHaveTextContent('5'));

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: /refresh analytics/i }),
    );
    // Second paint after refetch.
    await waitFor(() => expect(card).toHaveTextContent('9'));

    // /api/admin-stats was called twice; /api/admin only once (we
    // didn't trigger the service-health refresh).
    const statsCalls = fetchMock.mock.calls.filter((c) => {
      const url =
        typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString();
      return url.includes('/api/admin-stats');
    });
    expect(statsCalls).toHaveLength(2);
    const adminCalls = fetchMock.mock.calls.filter((c) => {
      const url =
        typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString();
      return url.includes('/api/admin') && !url.includes('/api/admin-');
    });
    expect(adminCalls).toHaveLength(1);
  });
});
