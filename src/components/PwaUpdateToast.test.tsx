import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ToastProvider } from './Toast';
import { PwaUpdateToast } from './PwaUpdateToast';

// Capture the handlers passed to registerPwa so we can simulate the SW
// telling us "new version waiting". The mocked update() resolves as a no-op
// stand-in for the real skipWaiting+reload call.
const update = vi.fn().mockResolvedValue(undefined);
const registerPwaMock = vi.fn();

vi.mock('../lib/pwa', () => ({
  registerPwa: (handlers: unknown) => {
    registerPwaMock(handlers);
    return Promise.resolve(update);
  },
}));

describe('<PwaUpdateToast>', () => {
  beforeEach(() => {
    registerPwaMock.mockClear();
    update.mockClear();
  });

  it('shows a reload toast when the SW signals an update is ready', async () => {
    render(
      <ToastProvider>
        <PwaUpdateToast />
      </ToastProvider>,
    );

    // Let the registerPwa() promise settle and the handlers get captured.
    await act(async () => {
      await Promise.resolve();
    });

    const handlers = registerPwaMock.mock.calls.at(-1)?.[0] as {
      onNeedRefresh?: () => void;
    };
    expect(typeof handlers.onNeedRefresh).toBe('function');

    act(() => {
      handlers.onNeedRefresh?.();
    });

    expect(screen.getByText(/new version available/i)).toBeInTheDocument();
    const reload = screen.getByRole('button', { name: /reload/i });
    act(() => {
      reload.click();
    });
    expect(update).toHaveBeenCalledWith(true);
  });
});
