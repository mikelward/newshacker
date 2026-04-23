import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { FeedActionToolbar } from './FeedActionToolbar';
import { useFeedBar } from '../hooks/useFeedBar';
import { renderWithProviders } from '../test/renderUtils';

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

describe('<FeedActionToolbar>', () => {
  afterEach(() => {
    setOnline(true);
  });

  it('renders Refresh, Undo, and Sweep buttons in that DOM order', () => {
    renderWithProviders(<FeedActionToolbar />);
    const refresh = screen.getByTestId('refresh-btn');
    const undo = screen.getByTestId('undo-btn');
    const sweep = screen.getByTestId('sweep-btn');
    const parent = refresh.parentElement!;
    const buttons = Array.from(parent.children);
    expect(buttons.indexOf(refresh)).toBeLessThan(buttons.indexOf(undo));
    expect(buttons.indexOf(undo)).toBeLessThan(buttons.indexOf(sweep));
  });

  it('disables Refresh when no feed has registered a handler', () => {
    renderWithProviders(<FeedActionToolbar />);
    expect(screen.getByTestId('refresh-btn')).toBeDisabled();
  });

  it('calls the registered feed refresh handler when Refresh is pressed', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    function FeedShim() {
      const { setRefresh } = useFeedBar();
      useEffect(() => {
        setRefresh(onRefresh);
        return () => setRefresh(null);
      }, [setRefresh]);
      return null;
    }
    renderWithProviders(
      <>
        <FeedActionToolbar />
        <FeedShim />
      </>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('refresh-btn')).not.toBeDisabled();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('refresh-btn'));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables Refresh while the browser is offline', () => {
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    const onRefresh = vi.fn();
    function FeedShim() {
      const { setRefresh } = useFeedBar();
      useEffect(() => {
        setRefresh(onRefresh);
        return () => setRefresh(null);
      }, [setRefresh]);
      return null;
    }
    renderWithProviders(
      <>
        <FeedActionToolbar />
        <FeedShim />
      </>,
    );
    expect(screen.getByTestId('refresh-btn')).toBeDisabled();
  });

  it('Undo and Sweep start disabled when no feed has registered handlers', () => {
    renderWithProviders(<FeedActionToolbar />);
    expect(screen.getByTestId('undo-btn')).toBeDisabled();
    expect(screen.getByTestId('sweep-btn')).toBeDisabled();
  });
});
