// Threshold-tuning telemetry. See SPEC.md *Hot threshold tuning*
// and TODO.md *Threshold tuning telemetry*.
//
// Public surface:
//   recordFirstAction(action, story, sourceFeed, opts) — fire-and-
//     forget. Builds a TelemetryEvent, dedupes against this device's
//     "first seen" Set so subsequent toggles on the same id don't
//     re-fire, appends to a small localStorage ring buffer for the
//     local /admin fallback view, and POSTs to
//     /api/admin-telemetry-action. Never throws, never blocks.
//   getLocalEvents() — read the ring buffer for /admin.
//   clearLocalEvents() — drop the ring buffer.
//   exportLocalEvents() — stringify for the Export button.
//
// Emission gate (`opts.isAuthenticated`):
//   - production: emit only when the caller passes `true` (i.e. the
//     user is signed in via /api/me). Anonymous events would 204 on
//     the server anyway, but skipping the POST saves a wasted
//     round-trip and avoids polluting the device's ring buffer.
//   - preview: always emit. The Vercel preview URL is the operator's
//     own staging surface; collecting from any visitor helps top up
//     sparse datasets.
//   - development / test: never emit. Local dev shouldn't accumulate
//     anything; tests don't want a live POST in the way.
//
// Dedup is per-device — if you first-pin the same story on two
// devices, you get two events. SPEC.md notes this as accepted noise.

import type { HNItem } from './hn';
import { isHotStory } from './format';
import { getDeployEnv, type DeployEnv } from './deployEnv';

export type TelemetryAction = 'pin' | 'hide';

export interface TelemetryEvent {
  action: TelemetryAction;
  id: number;
  // `score` and `time` (epoch seconds, from `story.time`) at the
  // moment of action. Pairs with `eventTime` so the reader can
  // recompute `ageAtAction = eventTime/1000 - time` later.
  score: number;
  time: number;
  isHot: boolean;
  // Which view the user was on when they fired the action — `top`,
  // `new`, `hot`, `pinned`, `done`, `hidden`, `thread`, etc. Free-
  // form string; the renderer slices by it.
  sourceFeed: string;
  eventTime: number;
}

// Ring-buffer cap on the local mirror. 2000 entries × ~200 bytes
// per JSON-stringified event is ~400 KB, well under localStorage's
// per-origin quota (5–10 MB depending on browser). The /admin
// view is happy with this many points; the server-side cap of
// 10k is the canonical store.
const LOCAL_RING_CAP = 2000;

const EVENTS_KEY = 'newshacker:telemetry:events';
const SEEN_IDS_KEY = 'newshacker:telemetry:firstSeenIds';
const ENDPOINT = '/api/admin-telemetry-action';

interface SeenIds {
  pin: number[];
  hide: number[];
}

function emptySeen(): SeenIds {
  return { pin: [], hide: [] };
}

function readSeen(): SeenIds {
  if (typeof localStorage === 'undefined') return emptySeen();
  try {
    const raw = localStorage.getItem(SEEN_IDS_KEY);
    if (!raw) return emptySeen();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptySeen();
    const p = parsed as Partial<SeenIds>;
    return {
      pin: Array.isArray(p.pin) ? p.pin.filter((n) => typeof n === 'number') : [],
      hide: Array.isArray(p.hide) ? p.hide.filter((n) => typeof n === 'number') : [],
    };
  } catch {
    return emptySeen();
  }
}

function writeSeen(seen: SeenIds): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SEEN_IDS_KEY, JSON.stringify(seen));
  } catch {
    // localStorage quota exceeded or storage disabled — give up
    // silently. The next call will retry the read+write.
  }
}

function readEvents(): TelemetryEvent[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is TelemetryEvent =>
        !!e &&
        typeof e === 'object' &&
        (e.action === 'pin' || e.action === 'hide') &&
        typeof e.id === 'number' &&
        typeof e.score === 'number' &&
        typeof e.time === 'number' &&
        typeof e.isHot === 'boolean' &&
        typeof e.sourceFeed === 'string' &&
        typeof e.eventTime === 'number',
    );
  } catch {
    return [];
  }
}

function writeEvents(events: TelemetryEvent[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch {
    // Same as writeSeen — drop on failure.
  }
}

function shouldEmit(env: DeployEnv, isAuthenticated: boolean): boolean {
  if (env === 'preview') return true;
  if (env === 'production') return isAuthenticated;
  return false;
}

function postEvent(event: TelemetryEvent): void {
  if (typeof fetch === 'undefined') return;
  // Fire-and-forget. Any failure is swallowed — telemetry must
  // never break a pin or hide. We don't even await the promise; the
  // browser keeps the request in flight on its own.
  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    // `keepalive: true` lets the request survive a tab close, so a
    // pin-then-immediately-close-tab still records.
    keepalive: true,
  }).catch(() => {});
}

export interface RecordOpts {
  isAuthenticated: boolean;
  // `now` and `env` are injection points so unit tests can pin both
  // without monkey-patching globals.
  now?: number;
  env?: DeployEnv;
}

export function recordFirstAction(
  action: TelemetryAction,
  story: Pick<HNItem, 'id' | 'score' | 'time'>,
  sourceFeed: string,
  opts: RecordOpts,
): void {
  const env = opts.env ?? getDeployEnv();
  if (!shouldEmit(env, opts.isAuthenticated)) return;

  const seen = readSeen();
  const list = seen[action];
  if (list.includes(story.id)) return;
  list.push(story.id);
  writeSeen(seen);

  const event: TelemetryEvent = {
    action,
    id: story.id,
    score: story.score ?? 0,
    time: story.time ?? 0,
    isHot: isHotStory(story),
    sourceFeed,
    eventTime: opts.now ?? Date.now(),
  };

  const events = readEvents();
  events.push(event);
  // Drop oldest entries to keep the ring under the cap.
  const trimmed =
    events.length > LOCAL_RING_CAP
      ? events.slice(events.length - LOCAL_RING_CAP)
      : events;
  writeEvents(trimmed);

  postEvent(event);
}

export function getLocalEvents(): TelemetryEvent[] {
  return readEvents();
}

export function clearLocalEvents(): void {
  writeEvents([]);
}

export function exportLocalEvents(): string {
  return JSON.stringify(readEvents(), null, 2);
}
