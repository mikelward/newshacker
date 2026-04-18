import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Thread } from './Thread';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

describe('<Thread>', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders story header, a Read article button, and nested comments', async () => {
    installHNFetchMock({
      items: {
        100: makeStory(100, { title: 'Parent', kids: [101], descendants: 3 }),
        101: {
          id: 101,
          type: 'comment',
          by: 'bob',
          text: 'hello <b>world</b>',
          time: Math.floor(Date.now() / 1000) - 60,
          kids: [102],
        },
        102: {
          id: 102,
          type: 'comment',
          by: 'carol',
          text: 'nested reply',
          time: Math.floor(Date.now() / 1000) - 30,
          kids: [103],
        },
        103: {
          id: 103,
          type: 'comment',
          by: 'dave',
          text: 'deep',
          time: Math.floor(Date.now() / 1000) - 10,
        },
      },
    });

    renderWithProviders(<Thread id={100} />, { route: '/item/100' });

    await waitFor(() => {
      expect(screen.getByText('Parent')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /read article/i })).toHaveAttribute(
      'href',
      'https://example.com/100',
    );
    expect(screen.getByText(/hello/)).toBeInTheDocument();
    expect(screen.getByText(/nested reply/)).toBeInTheDocument();
    expect(screen.getByText(/deep/)).toBeInTheDocument();
  });

  it('collapses and expands comment subtrees', async () => {
    installHNFetchMock({
      items: {
        200: makeStory(200, { kids: [201], descendants: 2 }),
        201: {
          id: 201,
          type: 'comment',
          by: 'x',
          text: 'top comment',
          kids: [202],
          time: 1,
        },
        202: {
          id: 202,
          type: 'comment',
          by: 'y',
          text: 'child comment',
          time: 2,
        },
      },
    });

    renderWithProviders(<Thread id={200} />);

    await waitFor(() => {
      expect(screen.getByText(/child comment/)).toBeInTheDocument();
    });

    const toggle = screen.getAllByRole('button', { name: /collapse comment/i })[0];
    await userEvent.click(toggle);
    expect(screen.queryByText(/child comment/)).toBeNull();

    const expander = screen.getAllByRole('button', { name: /expand comment/i })[0];
    await userEvent.click(expander);
    expect(screen.getByText(/child comment/)).toBeInTheDocument();
  });

  it('shows placeholder for deleted items without crashing', async () => {
    installHNFetchMock({
      items: {
        300: { id: 300, deleted: true },
      },
    });

    renderWithProviders(<Thread id={300} />);
    await waitFor(() => {
      expect(screen.getByText('[deleted]')).toBeInTheDocument();
    });
  });
});
