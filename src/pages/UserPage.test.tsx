import { afterEach, describe, it, expect, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserPage } from './UserPage';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock } from '../test/mockFetch';

function renderAt(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/user/:id" element={<UserPage />} />
    </Routes>,
    { route },
  );
}

describe('<UserPage>', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows karma and a sanitized about section', async () => {
    installHNFetchMock({
      users: {
        alice: {
          id: 'alice',
          karma: 1234,
          created: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365,
          about: 'Hi <script>evil()</script><b>bold</b>',
        },
      },
    });
    renderAt('/user/alice');
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });
    expect(screen.getByText('1,234')).toBeInTheDocument();
    // Sanitized: no script
    expect(document.body.innerHTML).not.toContain('<script>');
    expect(document.body.innerHTML).toContain('<b>bold</b>');
  });

  it('shows empty state when the user is not found', async () => {
    installHNFetchMock({ users: { missing: null } });
    renderAt('/user/missing');
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toHaveTextContent(/not found/i);
    });
  });

  it('shows error state with working retry', async () => {
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempt++;
        if (attempt === 1) return new Response('no', { status: 500 });
        return new Response(
          JSON.stringify({
            id: 'bob',
            karma: 10,
            created: Math.floor(Date.now() / 1000),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    renderAt('/user/bob');

    await waitFor(() => {
      expect(screen.getByTestId('error-state')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => {
      expect(screen.getByText('bob')).toBeInTheDocument();
    });
  });
});
