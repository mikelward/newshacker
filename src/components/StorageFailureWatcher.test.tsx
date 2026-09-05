import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from './Toast';
import { StorageFailureWatcher } from './StorageFailureWatcher';
import {
  reportStorageFailure,
  resetStorageHealthForTest,
} from '../lib/storageHealth';

beforeEach(() => {
  resetStorageHealthForTest();
});

function mount() {
  render(
    <ToastProvider>
      <StorageFailureWatcher />
    </ToastProvider>,
  );
}

describe('<StorageFailureWatcher>', () => {
  it('names the reason when the device is out of space', async () => {
    mount();
    await act(async () => {
      reportStorageFailure(new DOMException('quota', 'QuotaExceededError'));
    });
    expect(screen.getByText('Error saving – out of storage')).toBeInTheDocument();
  });

  it('names blocked storage separately — the user fixes it differently', async () => {
    mount();
    await act(async () => {
      reportStorageFailure(new DOMException('denied', 'SecurityError'));
    });
    expect(screen.getByText('Error saving – storage blocked')).toBeInTheDocument();
  });

  it('falls back to the bare message when the failure is unclassified', async () => {
    mount();
    await act(async () => {
      reportStorageFailure(new Error('who knows'));
      reportStorageFailure(new Error('who knows'));
    });
    expect(screen.getByText('Error saving')).toBeInTheDocument();
  });

  it('does not raise the toast while another component is rendering', async () => {
    // A refusal can come from a READ, and reads happen during render — a hook's
    // useMemo calls into the store on the first frame. Delivered synchronously,
    // the toast's setState would land inside that component's render: React
    // refuses it ("Cannot update a component while rendering a different
    // component") and concurrent rendering makes it unsafe rather than noisy.
    function ReportsOnRerender() {
      const [reporting, setReporting] = useState(false);
      if (reporting) {
        reportStorageFailure(new DOMException('denied', 'SecurityError'));
      }
      return <button onClick={() => setReporting(true)}>go</button>;
    }
    const errors: unknown[] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        errors.push(args[0]);
      });

    render(
      <ToastProvider>
        <StorageFailureWatcher />
        <ReportsOnRerender />
      </ToastProvider>,
    );
    // The watcher is subscribed by now, so the report has somewhere to go.
    await act(async () => {
      fireEvent.click(screen.getByText('go'));
    });

    expect(
      errors.filter(
        (message) =>
          typeof message === 'string' &&
          message.includes('while rendering a different component'),
      ),
    ).toEqual([]);
    expect(screen.getByText('Error saving – storage blocked')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('says nothing while storage is working', () => {
    mount();
    expect(screen.queryByText(/Error saving/)).toBeNull();
  });
});
