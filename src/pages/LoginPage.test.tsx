import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { LoginPage } from './LoginPage';
import { renderWithProviders } from '../test/renderUtils';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetchSequence(responses: Array<Response | (() => Response | Promise<Response>)>) {
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('No more mocked fetch responses');
    return typeof next === 'function' ? await next() : next;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/top" element={<div data-testid="top-page">Top</div>} />
      <Route path="/favorites" element={<div data-testid="favorites-page">Favorites</div>} />
    </Routes>
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the form with a disclosure about credential handling', async () => {
    mockFetchSequence([jsonResponse({ error: 'Not authenticated' }, 401)]);
    renderWithProviders(<App />, { route: '/login' });
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(
      screen.getByText(/credentials are sent to Hacker News through our server/i),
    ).toBeInTheDocument();
  });

  it('submits to /api/login and navigates to /top on success', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({ error: 'Not authenticated' }, 401), // initial /api/me
      jsonResponse({ username: 'alice' }, 200), // /api/login
    ]);
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/login' });

    await user.type(screen.getByTestId('login-username'), 'alice');
    await user.type(screen.getByTestId('login-password'), 'secret');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('top-page')).toBeInTheDocument();
    });
    const loginCall = fetchMock.mock.calls.find((c) => c[0] === '/api/login');
    expect(loginCall).toBeDefined();
    expect(JSON.parse((loginCall![1] as RequestInit).body as string)).toEqual({
      username: 'alice',
      password: 'secret',
    });
  });

  it('shows an inline error on a 401 response from /api/login', async () => {
    mockFetchSequence([
      jsonResponse({ error: 'Not authenticated' }, 401), // initial /api/me
      jsonResponse({ error: 'Bad login' }, 401), // /api/login
    ]);
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/login' });

    await user.type(screen.getByTestId('login-username'), 'alice');
    await user.type(screen.getByTestId('login-password'), 'wrong');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toBeInTheDocument();
    });
    // Password field is cleared on failure so the user doesn't just re-submit it.
    expect(screen.getByTestId('login-password')).toHaveValue('');
    // Still on the login page — no redirect.
    expect(screen.queryByTestId('top-page')).not.toBeInTheDocument();
  });

  it('disables the submit button until both fields are non-empty', async () => {
    mockFetchSequence([jsonResponse({ error: 'Not authenticated' }, 401)]);
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/login' });

    const submit = screen.getByTestId('login-submit');
    expect(submit).toBeDisabled();
    await user.type(screen.getByTestId('login-username'), 'alice');
    expect(submit).toBeDisabled();
    await user.type(screen.getByTestId('login-password'), 'pw');
    expect(submit).toBeEnabled();
  });
});
