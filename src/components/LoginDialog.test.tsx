import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLoginDialog } from '../hooks/useLoginDialog';
import { renderWithProviders } from '../test/renderUtils';

function Opener({
  reason,
  label = 'open dialog',
}: {
  reason?: string;
  label?: string;
}) {
  const { openLoginDialog } = useLoginDialog();
  return (
    <button type="button" onClick={() => openLoginDialog({ reason })}>
      {label}
    </button>
  );
}

function stubLoginFetch(
  options: {
    login?: (body: { username: string; password: string }) => Response;
  } = {},
) {
  const { login } = options;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/me') {
      return new Response(JSON.stringify({ error: 'nope' }), { status: 401 });
    }
    if (url === '/api/login') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const handler =
        login ??
        (() =>
          new Response(JSON.stringify({ username: body.username }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }));
      return handler(body);
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('<LoginDialog>', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('is not rendered until openLoginDialog is called', async () => {
    stubLoginFetch();
    renderWithProviders(<Opener />);
    expect(screen.queryByTestId('login-dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'open dialog' }));
    expect(await screen.findByTestId('login-dialog')).toBeInTheDocument();
  });

  it('uses the caller-supplied reason as the heading', async () => {
    stubLoginFetch();
    renderWithProviders(<Opener reason="Sign in to upvote" />);
    await userEvent.click(screen.getByRole('button', { name: 'open dialog' }));
    const dialog = await screen.findByTestId('login-dialog');
    expect(dialog).toHaveTextContent('Sign in to upvote');
  });

  it('closes when the close button is clicked', async () => {
    stubLoginFetch();
    renderWithProviders(<Opener />);
    await userEvent.click(screen.getByRole('button', { name: 'open dialog' }));
    await screen.findByTestId('login-dialog');
    await userEvent.click(screen.getByTestId('login-dialog-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('login-dialog')).toBeNull();
    });
  });

  it('closes when the scrim is clicked', async () => {
    stubLoginFetch();
    renderWithProviders(<Opener />);
    await userEvent.click(screen.getByRole('button', { name: 'open dialog' }));
    await screen.findByTestId('login-dialog');
    await userEvent.click(screen.getByTestId('login-dialog-scrim'));
    await waitFor(() => {
      expect(screen.queryByTestId('login-dialog')).toBeNull();
    });
  });

  it('closes when Escape is pressed', async () => {
    stubLoginFetch();
    renderWithProviders(<Opener />);
    await userEvent.click(screen.getByRole('button', { name: 'open dialog' }));
    await screen.findByTestId('login-dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('login-dialog')).toBeNull();
    });
  });

  it('closes itself when login succeeds', async () => {
    stubLoginFetch();
    renderWithProviders(<Opener />);
    await userEvent.click(screen.getByRole('button', { name: 'open dialog' }));
    await screen.findByTestId('login-dialog');

    await userEvent.type(screen.getByTestId('login-username'), 'alice');
    await userEvent.type(screen.getByTestId('login-password'), 'hunter2');
    await userEvent.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.queryByTestId('login-dialog')).toBeNull();
    });
  });

  it('surfaces a 401 from /api/login inline without closing', async () => {
    stubLoginFetch({
      login: () =>
        new Response(JSON.stringify({ error: 'nope' }), { status: 401 }),
    });
    renderWithProviders(<Opener />);
    await userEvent.click(screen.getByRole('button', { name: 'open dialog' }));
    await screen.findByTestId('login-dialog');

    await userEvent.type(screen.getByTestId('login-username'), 'alice');
    await userEvent.type(screen.getByTestId('login-password'), 'wrong');
    await userEvent.click(screen.getByTestId('login-submit'));

    expect(await screen.findByTestId('login-error')).toHaveTextContent(
      /incorrect/i,
    );
    expect(screen.getByTestId('login-dialog')).toBeInTheDocument();
    // Password input is cleared so the user doesn't re-submit the
    // same wrong one by accident — matches HN's own login behavior.
    expect(screen.getByTestId('login-password')).toHaveValue('');
  });
});
