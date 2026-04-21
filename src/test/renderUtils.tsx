import type { ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FeedBarProvider } from '../components/FeedBarContext';

interface Options extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  client?: QueryClient;
}

export function renderWithProviders(ui: ReactElement, options: Options = {}) {
  const {
    route = '/top',
    client = new QueryClient({
      defaultOptions: {
        // Mirror main.tsx's networkMode so tests reflect what users get
        // in production — in particular so the offline-error path runs
        // the queryFn instead of pausing when onlineManager is offline.
        queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'offlineFirst' },
      },
    }),
    ...rest
  } = options;

  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <FeedBarProvider>{ui}</FeedBarProvider>
        </MemoryRouter>
      </QueryClientProvider>,
      rest,
    ),
  };
}
