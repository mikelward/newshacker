import { useCallback, useEffect, useMemo, useRef } from 'react';

// Batches server-side summary cache warms as stories scroll into (or
// near) the viewport. The caller enqueues ids one at a time; we debounce
// and flush them in a single POST to /api/warm-summaries. The endpoint
// has its own per-id dedup in Redis — the session set here just avoids
// wasting a round trip for the same id twice in the same tab.

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_BATCH_CAP = 30;
const DEFAULT_ENDPOINT = '/api/warm-summaries';

export interface WarmQueueOptions {
  debounceMs?: number;
  batchCap?: number;
  endpoint?: string;
  // Exposed for tests. Production uses the global fetch.
  fetchImpl?: typeof fetch;
  // Production leaves this undefined so the session-dedup set lives for
  // the hook's lifetime; tests can pass a shared set to introspect it.
  seenRef?: React.MutableRefObject<Set<number>>;
}

export interface WarmQueueApi {
  enqueue: (id: number) => void;
  // Force an immediate flush — useful for tests and for page hide events
  // where we want to send before the tab goes away.
  flush: () => void;
}

export function useWarmQueue(options: WarmQueueOptions = {}): WarmQueueApi {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const batchCap = options.batchCap ?? DEFAULT_BATCH_CAP;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl;

  const pendingRef = useRef<Set<number>>(new Set());
  const internalSeenRef = useRef<Set<number>>(new Set());
  const seenRef = options.seenRef ?? internalSeenRef;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      const fetcher = fetchImpl ?? (globalThis.fetch?.bind(globalThis));
      if (!fetcher) return;
      // keepalive: true lets the request outlive a tab hide. The
      // response is ignored — we never need the per-id outcomes on the
      // client in production; the endpoint exists to warm the server
      // cache for the next reader, whoever they are.
      fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
        keepalive: true,
      }).catch(() => {
        // Fire-and-forget: network errors are expected offline and
        // during tab transitions. A single console.error would be
        // noisy; the stats endpoint is where real failures surface.
      });
    },
    [endpoint, fetchImpl],
  );

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending.size === 0) return;
    const ids = Array.from(pending);
    pending.clear();
    for (const id of ids) seenRef.current.add(id);
    send(ids);
  }, [send, seenRef]);

  const enqueue = useCallback(
    (id: number) => {
      if (!Number.isSafeInteger(id) || id <= 0) return;
      if (seenRef.current.has(id)) return;
      if (pendingRef.current.has(id)) return;
      pendingRef.current.add(id);
      if (pendingRef.current.size >= batchCap) {
        flush();
        return;
      }
      if (timerRef.current) return;
      timerRef.current = setTimeout(flush, debounceMs);
    },
    [batchCap, debounceMs, flush, seenRef],
  );

  useEffect(() => {
    // One last flush on unmount so the final batch isn't orphaned.
    return () => {
      flush();
    };
  }, [flush]);

  return useMemo(() => ({ enqueue, flush }), [enqueue, flush]);
}
