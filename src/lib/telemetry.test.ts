// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLocalEvents,
  exportLocalEvents,
  getLocalEvents,
  recordFirstAction,
  type TelemetryEvent,
} from './telemetry';

const STORY = {
  id: 12345,
  // Score crosses the `isHotStory` big-story threshold so the
  // emitted `isHot` field is `true` — keeps the cases tidy.
  score: 150,
  // 30 minutes ago — still in the recent-window branch.
  time: Math.floor(Date.now() / 1000) - 30 * 60,
};

const FETCH_ENDPOINT = '/api/admin-telemetry-action';

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function fetchSpy() {
  const calls: Request[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.includes(FETCH_ENDPOINT)) {
      const headers = new Headers(init?.headers);
      calls.push(
        new Request(input, {
          method: init?.method,
          body: init?.body as BodyInit | null,
          headers,
        }),
      );
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

describe('recordFirstAction', () => {
  it('does not emit in production when not authenticated', () => {
    const { calls } = fetchSpy();
    recordFirstAction('pin', STORY, 'top', {
      isAuthenticated: false,
      env: 'production',
    });
    expect(calls).toHaveLength(0);
    expect(getLocalEvents()).toHaveLength(0);
  });

  it('emits in production when authenticated', async () => {
    const { calls } = fetchSpy();
    recordFirstAction('pin', STORY, 'top', {
      isAuthenticated: true,
      env: 'production',
    });
    expect(calls).toHaveLength(1);
    const events = getLocalEvents();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('pin');
    expect(events[0].id).toBe(STORY.id);
    expect(events[0].sourceFeed).toBe('top');
    expect(events[0].isHot).toBe(true);
  });

  it('emits in preview regardless of auth state', () => {
    const { calls } = fetchSpy();
    recordFirstAction('hide', STORY, 'new', {
      isAuthenticated: false,
      env: 'preview',
    });
    expect(calls).toHaveLength(1);
    expect(getLocalEvents()).toHaveLength(1);
  });

  it('does not emit in development or test environments', () => {
    const { calls } = fetchSpy();
    recordFirstAction('pin', STORY, 'top', {
      isAuthenticated: true,
      env: 'development',
    });
    recordFirstAction('pin', STORY, 'top', {
      isAuthenticated: true,
      env: 'test',
    });
    expect(calls).toHaveLength(0);
  });

  it('dedupes per-action: a second pin on the same id does not re-fire', () => {
    const { calls } = fetchSpy();
    recordFirstAction('pin', STORY, 'top', {
      isAuthenticated: true,
      env: 'production',
    });
    recordFirstAction('pin', STORY, 'top', {
      isAuthenticated: true,
      env: 'production',
    });
    expect(calls).toHaveLength(1);
    expect(getLocalEvents()).toHaveLength(1);
  });

  it('does not dedupe across actions: a hide after a pin still fires', () => {
    const { calls } = fetchSpy();
    recordFirstAction('pin', STORY, 'top', {
      isAuthenticated: true,
      env: 'production',
    });
    recordFirstAction('hide', STORY, 'top', {
      isAuthenticated: true,
      env: 'production',
    });
    expect(calls).toHaveLength(2);
    const events = getLocalEvents();
    expect(events.map((e) => e.action)).toEqual(['pin', 'hide']);
  });

  it('writes the localStorage ring buffer in addition to firing the POST', () => {
    fetchSpy();
    recordFirstAction('pin', STORY, 'top', {
      isAuthenticated: true,
      env: 'production',
      now: 1700000000000,
    });
    const events = getLocalEvents();
    expect(events[0].eventTime).toBe(1700000000000);
  });
});

describe('getLocalEvents / clearLocalEvents / exportLocalEvents', () => {
  it('clearLocalEvents wipes the ring buffer', () => {
    fetchSpy();
    recordFirstAction('pin', STORY, 'top', {
      isAuthenticated: true,
      env: 'production',
    });
    expect(getLocalEvents()).toHaveLength(1);
    clearLocalEvents();
    expect(getLocalEvents()).toHaveLength(0);
  });

  it('exportLocalEvents returns a JSON-encoded array of stored events', () => {
    fetchSpy();
    recordFirstAction('pin', STORY, 'top', {
      isAuthenticated: true,
      env: 'production',
    });
    const out = exportLocalEvents();
    const parsed = JSON.parse(out) as TelemetryEvent[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe(STORY.id);
  });

  it('getLocalEvents tolerates corrupted storage by returning an empty array', () => {
    window.localStorage.setItem('newshacker:telemetry:events', 'not json');
    expect(getLocalEvents()).toEqual([]);
  });
});
