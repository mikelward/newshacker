import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { ConnectedApps } from './ConnectedApps';
import { renderWithProviders } from '../test/renderUtils';
import { ME_QUERY_KEY } from '../hooks/useAuth';
import * as api from '../lib/connectTokens';

vi.mock('../lib/connectTokens', () => ({
  listTokens: vi.fn(async () => []),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
}));

const mocked = api as unknown as {
  listTokens: ReturnType<typeof vi.fn>;
  createToken: ReturnType<typeof vi.fn>;
  revokeToken: ReturnType<typeof vi.fn>;
};

function clientWithUser(user: unknown): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // Seed the auth query so useAuth reports (un)authenticated without a network
  // round-trip.
  client.setQueryData(ME_QUERY_KEY, user);
  return client;
}

beforeEach(() => {
  mocked.listTokens.mockReset().mockResolvedValue([]);
  mocked.createToken.mockReset();
  mocked.revokeToken.mockReset();
});

describe('<ConnectedApps>', () => {
  it('renders nothing (and fetches nothing) when logged out', () => {
    renderWithProviders(<ConnectedApps />, { client: clientWithUser(null) });
    expect(
      screen.queryByRole('heading', { name: /connected apps/i }),
    ).toBeNull();
    expect(mocked.listTokens).not.toHaveBeenCalled();
  });

  it('lists existing tokens for a signed-in user', async () => {
    mocked.listTokens.mockResolvedValue([
      { id: 'a', label: 'Readmo', last4: 'wxyz', createdAt: 1_700_000_000_000 },
    ]);
    renderWithProviders(<ConnectedApps />, {
      client: clientWithUser({ username: 'alice' }),
    });
    expect(await screen.findByText(/Readmo/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /revoke readmo/i }),
    ).toBeInTheDocument();
  });

  it('generates and reveals a token exactly once', async () => {
    mocked.createToken.mockResolvedValue({
      token: 'nht_secretvalue',
      id: 'n',
      label: 'Readmo',
      last4: 'alue',
      createdAt: 1,
    });
    renderWithProviders(<ConnectedApps />, {
      client: clientWithUser({ username: 'alice' }),
    });
    fireEvent.click(
      await screen.findByRole('button', { name: /generate token/i }),
    );
    expect(await screen.findByText('nht_secretvalue')).toBeInTheDocument();
    expect(mocked.createToken).toHaveBeenCalledWith('Readmo');
    expect(screen.getByText(/see it again/i)).toBeInTheDocument();
  });

  it('revokes a token by id', async () => {
    mocked.listTokens.mockResolvedValue([
      { id: 'a', label: 'Readmo', last4: 'wxyz', createdAt: 1 },
    ]);
    mocked.revokeToken.mockResolvedValue(undefined);
    renderWithProviders(<ConnectedApps />, {
      client: clientWithUser({ username: 'alice' }),
    });
    fireEvent.click(
      await screen.findByRole('button', { name: /revoke readmo/i }),
    );
    await waitFor(() =>
      expect(mocked.revokeToken).toHaveBeenCalledWith('a'),
    );
  });
});
