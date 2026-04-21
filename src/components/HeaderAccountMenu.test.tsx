import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { HeaderAccountMenu } from './HeaderAccountMenu';
import { renderWithProviders } from '../test/renderUtils';
import {
  AVATAR_PREFS_STORAGE_KEY,
  getStoredAvatarPrefs,
} from '../lib/avatarPrefs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(responder: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return responder(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function AppShell() {
  return (
    <Routes>
      <Route path="/login" element={<div data-testid="login-page">Login</div>} />
      <Route path="/user/:id" element={<div data-testid="user-page">User</div>} />
      <Route path="*" element={<HeaderAccountMenu />} />
    </Routes>
  );
}

describe('<HeaderAccountMenu>', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('renders the anonymous silhouette when logged out', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/api/me')) {
        return jsonResponse({ error: 'Not authenticated' }, 401);
      }
      return jsonResponse({}, 404);
    });
    renderWithProviders(<HeaderAccountMenu />);
    await waitFor(() => {
      expect(screen.getByTestId('user-avatar-anon')).toBeInTheDocument();
    });
    expect(screen.getByTestId('header-account-btn')).toHaveAttribute(
      'aria-label',
      'Sign in',
    );
  });

  it('navigates to /login when the silhouette is tapped while logged out', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/api/me')) {
        return jsonResponse({ error: 'Not authenticated' }, 401);
      }
      return jsonResponse({}, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<AppShell />);
    await waitFor(() => {
      expect(screen.getByTestId('user-avatar-anon')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('header-account-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
  });

  it('shows the initial avatar and opens the menu on tap when logged in', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/api/me')) {
        return jsonResponse({ username: 'alice' });
      }
      if (url.includes('/user/alice.json')) {
        return jsonResponse({ id: 'alice', created: 1000, karma: 1234 });
      }
      return jsonResponse({}, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<HeaderAccountMenu />);

    await waitFor(() => {
      expect(screen.getByTestId('user-avatar')).toHaveTextContent('A');
    });
    expect(screen.queryByTestId('header-account-menu')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('header-account-btn'));
    expect(screen.getByTestId('header-account-menu')).toBeInTheDocument();
    expect(screen.getByTestId('header-account-profile')).toHaveAttribute(
      'href',
      '/user/alice',
    );
  });

  it('displays karma in the open menu when the profile resolves', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/api/me')) return jsonResponse({ username: 'alice' });
      if (url.includes('/user/alice.json')) {
        return jsonResponse({ id: 'alice', created: 1000, karma: 1234 });
      }
      return jsonResponse({}, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<HeaderAccountMenu />);
    await waitFor(() => {
      expect(screen.getByTestId('user-avatar')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('header-account-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('header-account-karma')).toHaveTextContent(
        /1,234 karma/,
      );
    });
  });

  it('closes the menu on Escape', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/api/me')) return jsonResponse({ username: 'alice' });
      return jsonResponse({}, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<HeaderAccountMenu />);
    await waitFor(() =>
      expect(screen.getByTestId('user-avatar')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('header-account-btn'));
    expect(screen.getByTestId('header-account-menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('header-account-menu')).not.toBeInTheDocument();
    });
  });

  it('defaults to a GitHub avatar picture for the logged-in HN username', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/api/me')) return jsonResponse({ username: 'alice' });
      return jsonResponse({}, 404);
    });
    renderWithProviders(<HeaderAccountMenu />);
    await waitFor(() => {
      expect(screen.getByTestId('user-avatar-img')).toBeInTheDocument();
    });
    expect(screen.getByTestId('user-avatar-img')).toHaveAttribute(
      'src',
      'https://github.com/alice.png?size=64',
    );
  });

  it('omits the image when prefs are set to Letter only', async () => {
    window.localStorage.setItem(
      AVATAR_PREFS_STORAGE_KEY,
      JSON.stringify({ source: 'none' }),
    );
    mockFetch(async (url) => {
      if (url.endsWith('/api/me')) return jsonResponse({ username: 'alice' });
      return jsonResponse({}, 404);
    });
    renderWithProviders(<HeaderAccountMenu />);
    await waitFor(() => {
      expect(screen.getByTestId('user-avatar')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('user-avatar-img')).not.toBeInTheDocument();
  });

  it('opens the Edit avatar form and saves a GitHub override', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/api/me')) return jsonResponse({ username: 'alice' });
      return jsonResponse({}, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<HeaderAccountMenu />);
    await waitFor(() =>
      expect(screen.getByTestId('user-avatar')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('header-account-btn'));
    await user.click(screen.getByTestId('header-account-edit-avatar'));
    expect(screen.getByTestId('edit-avatar-form')).toBeInTheDocument();

    const input = screen.getByTestId('edit-avatar-github-input');
    await user.clear(input);
    await user.type(input, 'alice-real');
    await user.click(screen.getByTestId('edit-avatar-save'));

    expect(getStoredAvatarPrefs()).toEqual({
      source: 'github',
      githubUsername: 'alice-real',
      at: expect.any(Number),
    });
    // Form closes and the menu returns to normal items.
    expect(screen.queryByTestId('edit-avatar-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('header-account-edit-avatar')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('user-avatar-img')).toHaveAttribute(
        'src',
        'https://github.com/alice-real.png?size=64',
      );
    });
  });

  it('resets to the standard menu when reopened after canceling edit', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/api/me')) return jsonResponse({ username: 'alice' });
      return jsonResponse({}, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<HeaderAccountMenu />);
    await waitFor(() =>
      expect(screen.getByTestId('user-avatar')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('header-account-btn'));
    await user.click(screen.getByTestId('header-account-edit-avatar'));
    expect(screen.getByTestId('edit-avatar-form')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByTestId('header-account-menu'),
      ).not.toBeInTheDocument();
    });
    await user.click(screen.getByTestId('header-account-btn'));
    // Reopened menu should be the standard menu, not the form.
    expect(screen.queryByTestId('edit-avatar-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('header-account-edit-avatar')).toBeInTheDocument();
  });

  it('calls /api/logout and flips back to the silhouette on Log out', async () => {
    const fetchMock = mockFetch(async (url) => {
      if (url.endsWith('/api/me')) return jsonResponse({ username: 'alice' });
      if (url.endsWith('/api/logout')) return jsonResponse({ ok: true });
      return jsonResponse({}, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<HeaderAccountMenu />);
    await waitFor(() =>
      expect(screen.getByTestId('user-avatar')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('header-account-btn'));
    await user.click(screen.getByTestId('header-account-logout'));

    await waitFor(() => {
      expect(screen.getByTestId('user-avatar-anon')).toBeInTheDocument();
    });
    const logoutCall = fetchMock.mock.calls.find((c) => {
      const u = typeof c[0] === 'string' ? c[0] : c[0].toString();
      return u.endsWith('/api/logout');
    });
    expect(logoutCall).toBeDefined();
    expect((logoutCall![1] as RequestInit).method).toBe('POST');
  });
});
