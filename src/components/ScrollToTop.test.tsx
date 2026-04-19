import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { ScrollToTop } from './ScrollToTop';

function NavigateOnMount({ to }: { to: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to);
  }, [navigate, to]);
  return null;
}

describe('<ScrollToTop>', () => {
  let scrollToSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollToSpy = vi.fn();
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollToSpy,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scrolls to top on forward navigation to a new pathname', () => {
    render(
      <MemoryRouter initialEntries={['/top']}>
        <ScrollToTop />
        <Routes>
          <Route path="/top" element={<NavigateOnMount to="/item/1" />} />
          <Route path="/item/:id" element={<div>item</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(scrollToSpy).toHaveBeenCalledWith(0, 0);
  });

  it('does not scroll on POP (back/forward) navigation', () => {
    render(
      <MemoryRouter
        initialEntries={['/top', '/item/1']}
        initialIndex={1}
      >
        <ScrollToTop />
        <Routes>
          <Route path="/top" element={<div>top</div>} />
          <Route path="/item/:id" element={<div>item</div>} />
        </Routes>
      </MemoryRouter>,
    );
    // Initial render is a POP from the MemoryRouter's perspective, so no scroll.
    expect(scrollToSpy).not.toHaveBeenCalled();
  });
});
