import { beforeEach, describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { startQueryCacheSync } from './queryCacheSync';

// Minimal paired-channel harness: posting on one "end" dispatches on
// the other, mirroring what BroadcastChannel does between two tabs on
// the same origin. Handlers run in a microtask so a single tab's
// synchronous cache events complete before siblings observe them.
interface Listener {
  onmessage: ((ev: MessageEvent) => void) | null;
}
interface ChannelEnd extends Listener {
  postMessage: (msg: unknown) => void;
  close: () => void;
}

function makePair(): [ChannelEnd, ChannelEnd] {
  const a: ChannelEnd = { postMessage: () => {}, close: () => {}, onmessage: null };
  const b: ChannelEnd = { postMessage: () => {}, close: () => {}, onmessage: null };
  a.postMessage = (msg: unknown) => {
    queueMicrotask(() => {
      if (b.onmessage) b.onmessage({ data: msg } as MessageEvent);
    });
  };
  b.postMessage = (msg: unknown) => {
    queueMicrotask(() => {
      if (a.onmessage) a.onmessage({ data: msg } as MessageEvent);
    });
  };
  return [a, b];
}

function flush(): Promise<void> {
  // Two microtask cycles: one to deliver the channel message, one to
  // clear the `applying` guard set in the receiver.
  return Promise.resolve().then(() => Promise.resolve());
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('startQueryCacheSync', () => {
  let aEnd: ChannelEnd;
  let bEnd: ChannelEnd;
  let a: QueryClient;
  let b: QueryClient;
  let stopA: () => void;
  let stopB: () => void;

  beforeEach(() => {
    [aEnd, bEnd] = makePair();
    a = newClient();
    b = newClient();
    stopA = startQueryCacheSync(a, { channelFactory: () => aEnd });
    stopB = startQueryCacheSync(b, { channelFactory: () => bEnd });
  });

  it('propagates setQueryData on a synced key to the sibling tab', async () => {
    a.setQueryData(['itemRoot', 42], { item: { id: 42, title: 'hi' }, kidIds: [] });

    await flush();

    expect(b.getQueryData(['itemRoot', 42])).toEqual({
      item: { id: 42, title: 'hi' },
      kidIds: [],
    });
    stopA();
    stopB();
  });

  it('propagates summary and comments-summary writes', async () => {
    a.setQueryData(['summary', 7], { summary: 'one sentence' });
    a.setQueryData(['comments-summary', 7], { insights: ['one', 'two'] });

    await flush();

    expect(b.getQueryData(['summary', 7])).toEqual({ summary: 'one sentence' });
    expect(b.getQueryData(['comments-summary', 7])).toEqual({
      insights: ['one', 'two'],
    });
    stopA();
    stopB();
  });

  it('propagates individual comment writes so pinned-thread comments survive in the sibling cache', async () => {
    a.setQueryData(['comment', 500], { id: 500, text: 'body' });

    await flush();

    expect(b.getQueryData(['comment', 500])).toEqual({
      id: 500,
      text: 'body',
    });
    stopA();
    stopB();
  });

  it('ignores writes to keys outside the allow list (feed lists, story ids)', async () => {
    a.setQueryData(['storyIds', 'top'], [1, 2, 3]);
    a.setQueryData(['feedItems', 'top'], { pages: [[1, 2]], pageParams: [0] });

    await flush();

    expect(b.getQueryData(['storyIds', 'top'])).toBeUndefined();
    expect(b.getQueryData(['feedItems', 'top'])).toBeUndefined();
    stopA();
    stopB();
  });

  it('does not echo — applying a received write must not rebroadcast', async () => {
    const postsFromB: unknown[] = [];
    const origPost = bEnd.postMessage;
    bEnd.postMessage = (msg: unknown) => {
      postsFromB.push(msg);
      origPost(msg);
    };

    a.setQueryData(['itemRoot', 99], { item: { id: 99 }, kidIds: [] });
    await flush();

    expect(b.getQueryData(['itemRoot', 99])).toBeDefined();
    // B received the write from A via its channel, applied it to its
    // own cache, and must not have posted anything back. If it did, A
    // would see a duplicate apply and the loop continues forever.
    expect(postsFromB).toHaveLength(0);
    stopA();
    stopB();
  });

  it('does not overwrite when local data is newer (last-write-wins by dataUpdatedAt)', async () => {
    b.setQueryData(
      ['itemRoot', 1],
      { item: { id: 1, title: 'newer' }, kidIds: [] },
      { updatedAt: 2000 },
    );
    a.setQueryData(
      ['itemRoot', 1],
      { item: { id: 1, title: 'older' }, kidIds: [] },
      { updatedAt: 1000 },
    );

    await flush();

    expect(b.getQueryData(['itemRoot', 1])).toEqual({
      item: { id: 1, title: 'newer' },
      kidIds: [],
    });
    stopA();
    stopB();
  });

  it('stops broadcasting after the returned cleanup runs', async () => {
    stopA();
    a.setQueryData(['itemRoot', 5], { item: { id: 5 }, kidIds: [] });

    await flush();

    expect(b.getQueryData(['itemRoot', 5])).toBeUndefined();
    stopB();
  });

  it('is a no-op when no BroadcastChannel factory is available', () => {
    const client = newClient();
    const stop = startQueryCacheSync(client, { channelFactory: undefined });
    // Mutating the cache doesn't throw, and the cleanup is callable.
    expect(() =>
      client.setQueryData(['itemRoot', 1], { item: { id: 1 }, kidIds: [] }),
    ).not.toThrow();
    expect(() => stop()).not.toThrow();
  });
});
