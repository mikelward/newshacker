import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ToastContext } from './useToast';
import { useShareCurrentPage } from './useShareCurrentPage';

function ToastSpyProvider({
  showToast,
  children,
}: {
  showToast: (opts: { message: string }) => void;
  children: ReactNode;
}) {
  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
    </ToastContext.Provider>
  );
}

interface NavWithShare {
  share?: (data: { title: string; text: string; url: string }) => Promise<void>;
  clipboard?: { writeText?: (s: string) => Promise<void> };
}

function withNavigator(nav: NavWithShare) {
  const original = window.navigator;
  Object.defineProperty(window, 'navigator', {
    configurable: true,
    value: { ...original, ...nav },
  });
  return () => {
    Object.defineProperty(window, 'navigator', {
      configurable: true,
      value: original,
    });
  };
}

describe('useShareCurrentPage', () => {
  const originalTitle = document.title;

  beforeEach(() => {
    document.title = 'A story · newshacker';
    window.history.replaceState({}, '', '/item/42?ref=test');
  });

  afterEach(() => {
    document.title = originalTitle;
    window.history.replaceState({}, '', '/');
  });

  it('calls navigator.share with the current title and URL when available', async () => {
    type SharePayload = { title: string; text: string; url: string };
    const share = vi.fn<(data: SharePayload) => Promise<void>>(
      async () => undefined,
    );
    const restore = withNavigator({ share });
    const showToast = vi.fn();
    const { result } = renderHook(() => useShareCurrentPage(), {
      wrapper: ({ children }) => (
        <ToastSpyProvider showToast={showToast}>{children}</ToastSpyProvider>
      ),
    });
    await act(async () => {
      await result.current();
    });
    expect(share).toHaveBeenCalledTimes(1);
    const payload = share.mock.calls[0]?.[0];
    expect(payload?.title).toBe('A story · newshacker');
    expect(payload?.url).toBe(window.location.href);
    expect(showToast).not.toHaveBeenCalled();
    restore();
  });

  it('falls back to clipboard.writeText when navigator.share is not present', async () => {
    const writeText = vi.fn(async () => undefined);
    const restore = withNavigator({ clipboard: { writeText } });
    const showToast = vi.fn();
    const { result } = renderHook(() => useShareCurrentPage(), {
      wrapper: ({ children }) => (
        <ToastSpyProvider showToast={showToast}>{children}</ToastSpyProvider>
      ),
    });
    await act(async () => {
      await result.current();
    });
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(showToast).toHaveBeenCalledWith({ message: 'Link copied' });
    restore();
  });

  it('falls back to clipboard when share rejects with a non-abort error', async () => {
    const share = vi.fn(async () => {
      throw new Error('share blew up');
    });
    const writeText = vi.fn(async () => undefined);
    const restore = withNavigator({ share, clipboard: { writeText } });
    const showToast = vi.fn();
    const { result } = renderHook(() => useShareCurrentPage(), {
      wrapper: ({ children }) => (
        <ToastSpyProvider showToast={showToast}>{children}</ToastSpyProvider>
      ),
    });
    await act(async () => {
      await result.current();
    });
    expect(share).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(showToast).toHaveBeenCalledWith({ message: 'Link copied' });
    restore();
  });

  it('does not show a toast when the user cancels the share sheet', async () => {
    const share = vi.fn(async () => {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      throw err;
    });
    const writeText = vi.fn(async () => undefined);
    const restore = withNavigator({ share, clipboard: { writeText } });
    const showToast = vi.fn();
    const { result } = renderHook(() => useShareCurrentPage(), {
      wrapper: ({ children }) => (
        <ToastSpyProvider showToast={showToast}>{children}</ToastSpyProvider>
      ),
    });
    await act(async () => {
      await result.current();
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    restore();
  });

  it('reports unavailable when neither share nor clipboard are present', async () => {
    const restore = withNavigator({});
    const showToast = vi.fn();
    const { result } = renderHook(() => useShareCurrentPage(), {
      wrapper: ({ children }) => (
        <ToastSpyProvider showToast={showToast}>{children}</ToastSpyProvider>
      ),
    });
    await act(async () => {
      await result.current();
    });
    expect(showToast).toHaveBeenCalledWith({ message: 'Sharing not available' });
    restore();
  });

  it('uses a fallback title if document.title is empty', async () => {
    document.title = '';
    type SharePayload = { title: string; text: string; url: string };
    const share = vi.fn<(data: SharePayload) => Promise<void>>(
      async () => undefined,
    );
    const restore = withNavigator({ share });
    const { result } = renderHook(() => useShareCurrentPage(), {
      wrapper: ({ children }) => (
        <ToastSpyProvider showToast={() => {}}>{children}</ToastSpyProvider>
      ),
    });
    await act(async () => {
      await result.current();
    });
    expect(share.mock.calls[0]?.[0]?.title).toBe('newshacker');
    restore();
  });
});
