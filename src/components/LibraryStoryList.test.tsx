import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { LibraryStoryList } from './LibraryStoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

function Harness() {
  const [ids, setIds] = useState([1, 2, 3]);
  return (
    <>
      <button onClick={() => setIds([1, 4, 3])}>swap-middle-id</button>
      <LibraryStoryList queryKey="test" ids={ids} emptyMessage="none" />
    </>
  );
}

describe('<LibraryStoryList>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('refetches when a mid-list id changes (same length, first, and last)', async () => {
    // Regression: the query key used to encode only length+first+last,
    // so swapping a middle id collided with the cached batch and the
    // old story rendered against the new id (wrong title over wrong
    // pin/share/thread actions).
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'One' }),
        2: makeStory(2, { title: 'Two' }),
        3: makeStory(3, { title: 'Three' }),
        4: makeStory(4, { title: 'Four' }),
      },
    });

    renderWithProviders(<Harness />);
    await waitFor(() => {
      expect(screen.getByText('Two')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('swap-middle-id'));

    await waitFor(() => {
      expect(screen.getByText('Four')).toBeInTheDocument();
    });
    expect(screen.queryByText('Two')).toBeNull();
  });

  it('honors the sticky bottom toolbar setting on its footer', async () => {
    installHNFetchMock({ items: { 1: makeStory(1, { title: 'One' }) } });
    window.localStorage.setItem('newshacker:stickyBottomBar', '1');
    renderWithProviders(
      <LibraryStoryList queryKey="sticky" ids={[1]} emptyMessage="none" />,
    );
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());
    expect(
      document.querySelector('.story-list__footer'),
    ).toHaveClass('story-list__footer--sticky');
  });
});
