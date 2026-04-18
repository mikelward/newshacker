import type { ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

interface Options extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  client?: QueryClient;
}

export function renderWithProviders(ui: ReactElement, options: Options = {}) {
  const {
    route = '/',
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 0 },
      },
    }),
    ...rest
  } = options;

  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </QueryClientProvider>,
      rest,
    ),
  };
}
