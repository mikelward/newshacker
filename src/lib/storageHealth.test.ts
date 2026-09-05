import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reportStorageFailure,
  resetStorageHealthForTest,
  subscribeStorageFailure,
} from './storageHealth';

/** A DOMException carrying a legacy `code` its name doesn't imply — Firefox's
 * quota error, which no constructor here produces. */
function legacyDomException(name: string, code: number): DOMException {
  const error = Object.create(DOMException.prototype) as DOMException;
  Object.defineProperty(error, 'name', { value: name });
  Object.defineProperty(error, 'code', { value: code });
  return error;
}

/** Let the deferred delivery run. */
function flush(): Promise<void> {
  return Promise.resolve();
}

beforeEach(() => {
  resetStorageHealthForTest();
});

describe('storageHealth', () => {
  it('reports a quota refusal on the first one', async () => {
    const heard = vi.fn();
    subscribeStorageFailure(heard);
    reportStorageFailure(new DOMException('quota', 'QuotaExceededError'));
    // Delivery is deferred to a microtask — a report can come from a read, and
    // reads happen during render (see scheduleFlush).
    expect(heard).not.toHaveBeenCalled();
    await flush();
    expect(heard).toHaveBeenCalledWith('quota');
  });

  it('recognizes the browsers that spell the quota error differently', async () => {
    // Firefox throws NS_ERROR_DOM_QUOTA_REACHED (legacy code 1014) and older
    // WebKit the legacy 22 — matching on the modern name alone would file both
    // as unknown, which then waits for a second refusal to say anything.
    for (const error of [
      legacyDomException('NS_ERROR_DOM_QUOTA_REACHED', 1014),
      legacyDomException('SomethingElse', 22),
    ]) {
      resetStorageHealthForTest();
      const heard = vi.fn();
      const stop = subscribeStorageFailure(heard);
      reportStorageFailure(error);
      await flush();
      expect(heard).toHaveBeenCalledWith('quota');
      stop();
    }
  });

  it('reports blocked storage on the first one', async () => {
    const heard = vi.fn();
    subscribeStorageFailure(heard);
    reportStorageFailure(new DOMException('denied', 'SecurityError'));
    await flush();
    expect(heard).toHaveBeenCalledWith('denied');
  });

  it('waits for a second unclassified refusal before saying anything', async () => {
    // Out of space and blocked access hold until the user acts, so one is the
    // whole story. Anything else could be a blip, and a message about a blip
    // the user cannot act on is worse than silence.
    const heard = vi.fn();
    subscribeStorageFailure(heard);
    reportStorageFailure(new Error('who knows'));
    await flush();
    expect(heard).not.toHaveBeenCalled();
    reportStorageFailure(new Error('who knows'));
    await flush();
    expect(heard).toHaveBeenCalledWith('unknown');
  });

  it('speaks once per kind per session', async () => {
    // Every refused pin reports, because the store cannot know how many have
    // gone before it. A toast each would be worse than silence.
    const heard = vi.fn();
    subscribeStorageFailure(heard);
    for (let i = 0; i < 5; i += 1) {
      reportStorageFailure(new DOMException('quota', 'QuotaExceededError'));
    }
    await flush();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('still delivers a refusal that arrived before anything was listening', async () => {
    // The stores are read on the first render, so a blocked read can beat the
    // watcher's mount.
    reportStorageFailure(new DOMException('denied', 'SecurityError'));
    await flush();
    const heard = vi.fn();
    subscribeStorageFailure(heard);
    await flush();
    expect(heard).toHaveBeenCalledWith('denied');

    // And only once — it has been delivered.
    const later = vi.fn();
    subscribeStorageFailure(later);
    await flush();
    expect(later).not.toHaveBeenCalled();
  });

  it('stops delivering once unsubscribed', async () => {
    const heard = vi.fn();
    const stop = subscribeStorageFailure(heard);
    stop();
    reportStorageFailure(new DOMException('quota', 'QuotaExceededError'));
    await flush();
    expect(heard).not.toHaveBeenCalled();
  });
});
