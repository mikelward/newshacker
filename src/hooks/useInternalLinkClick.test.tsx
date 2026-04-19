import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { useInternalLinkClick } from './useInternalLinkClick';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search + loc.hash}</div>;
}

function Host({ html }: { html: string }) {
  const onClick = useInternalLinkClick();
  return (
    <div>
      <div
        data-testid="host"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <LocationProbe />
    </div>
  );
}

function renderWith(html: string, route = '/start') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="*" element={<Host html={html} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('useInternalLinkClick', () => {
  it('navigates via router for same-origin /item links', async () => {
    const user = userEvent.setup();
    renderWith('<a href="/item/123">go</a>');
    await user.click(screen.getByText('go'));
    expect(screen.getByTestId('loc').textContent).toBe('/item/123');
  });

  it('preserves the fragment when navigating', async () => {
    const user = userEvent.setup();
    renderWith('<a href="/item/123#456">c</a>');
    await user.click(screen.getByText('c'));
    expect(screen.getByTestId('loc').textContent).toBe('/item/123#456');
  });

  it('does not intercept absolute external links', async () => {
    const user = userEvent.setup();
    renderWith('<a href="https://example.com/x" target="_blank">ext</a>');
    await user.click(screen.getByText('ext'));
    // No navigation happened — location is unchanged.
    expect(screen.getByTestId('loc').textContent).toBe('/start');
  });

  it('does not intercept protocol-relative URLs', async () => {
    const user = userEvent.setup();
    renderWith('<a href="//example.com/x">pr</a>');
    await user.click(screen.getByText('pr'));
    expect(screen.getByTestId('loc').textContent).toBe('/start');
  });

  it('does not intercept when a modifier key is held', async () => {
    const user = userEvent.setup();
    renderWith('<a href="/item/123">go</a>');
    await user.keyboard('{Meta>}');
    await user.click(screen.getByText('go'));
    await user.keyboard('{/Meta}');
    expect(screen.getByTestId('loc').textContent).toBe('/start');
  });
});
