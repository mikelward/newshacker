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

// Route a single fetch mock by URL. /api/me gates the page at the
// useAuth boundary; /api/admin delivers the operator data.
function installFetchMock({
  me,
  admin,
  adminStatus = 200,
}: {
  me: MeBody | (() => MeBody);
  admin: AdminBody | (() => AdminBody);
  adminStatus?: number | (() => number);
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
    // host-locale thousands separators. Accept either "1,234,567"
    // (en-US) or "1.234.567" (de-DE) etc. — the test shouldn't
    // depend on which locale happens to be active.
    const total = await screen.findByTestId('admin-jina-total-balance');
    expect(total.textContent).toMatch(/1[.,\s]234[.,\s]567/);
    const regular = screen.getByTestId('admin-jina-regular-balance');
    expect(regular.textContent).toMatch(/100[.,\s]000/);
    const threshold = screen.getByTestId('admin-jina-threshold');
    expect(threshold.textContent).toMatch(/50[.,\s]000/);

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
    await user.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() =>
      expect(screen.getByText(/9 ms/)).toBeInTheDocument(),
    );
    // /api/me once + /api/admin twice.
    const adminCalls = fetchMock.mock.calls.filter((c) => {
      const url =
        typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString();
      return url.includes('/api/admin');
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
