import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { ItemPage } from './ItemPage';

const mounts: number[] = [];

vi.mock('../components/Thread', () => ({
  Thread: ({ id }: { id: number }) => {
    useEffect(() => {
      mounts.push(id);
      // Intentionally [] — this records MOUNTS only. Including `id`
      // would also record in-place prop changes, which is exactly the
      // unkeyed behavior the test exists to rule out.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="thread-stub">{id}</div>;
  },
}));

function GoToItem({ id }: { id: number }) {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate(`/item/${id}`)}>go-{id}</button>
  );
}

describe('<ItemPage>', () => {
  it('shows an error for a non-numeric id', () => {
    render(
      <MemoryRouter initialEntries={['/item/abc']}>
        <Routes>
          <Route path="/item/:id" element={<ItemPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/invalid item id/i);
  });

  it('remounts Thread when navigating thread→thread', () => {
    // Regression: <Thread> was rendered un-keyed, so navigating from
    // one thread to another (HN links inside comments) carried over
    // visibleCount and other state — rendering up to N comments
    // immediately and skipping the paging contract.
    mounts.length = 0;
    render(
      <MemoryRouter initialEntries={['/item/1']}>
        <GoToItem id={2} />
        <Routes>
          <Route path="/item/:id" element={<ItemPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(mounts).toEqual([1]);

    fireEvent.click(screen.getByText('go-2'));
    expect(screen.getByTestId('thread-stub')).toHaveTextContent('2');
    // A fresh mount for the new id proves state can't leak across.
    expect(mounts).toEqual([1, 2]);
  });
});
