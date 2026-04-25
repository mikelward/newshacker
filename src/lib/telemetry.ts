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
  // ---- All fields below are optional so older events recorded
  // before the field was added still parse cleanly. New emissions
  // populate them all.

  // Comment count at action time. Pairs with `score` on the
  // scatter — a 50-point story with 200 comments looks very
  // different from a 50-point story with 3.
  descendants?: number;
  // `'story' | 'job' | 'ask' | 'show' | 'poll'` (or whatever HN
  // returns; field is free-form so the validator doesn't reject a
  // future HN-side addition). Different categories have different
  // baseline scores — without slicing by type the median across
  // pins is a weighted average of "what was on screen the day you
  // binged".
  type?: string;
  // Did the reader open the article (clicked through and we
  // recorded it in `openedStories`) before firing this action?
  // True = stronger intent signal: pin-after-reading is a stronger
  // "yes" than pin-from-headline; same for hide.
  articleOpened?: boolean;
  // Story title at action time. Captured so the /tuning event
  // list can display human-readable rows ("Show HN: my project"
  // vs "Politics flame thread") instead of opaque ids — without
  // a title the page is unscanable. HN titles are public data
  // and bounded in length, so logging them carries no privacy
  // or storage cost worth bookkeeping.
  title?: string;
}

// Ring-buffer cap on the local mirror. 2000 entries × ~200 bytes
// per JSON-stringified event is ~400 KB, well under localStorage's
// per-origin quota (5–10 MB depending on browser). The /admin
// view is happy with this many points; the server-side cap of
// 10k is the canonical store.
const LOCAL_RING_CAP = 2000;

// Cap on the per-action seen-id list so the dedup metadata can't
// grow without bound. At 50 actions/day this is years of history;
// once it's full the oldest ids fall off and the user could re-emit
// telemetry for an ancient pin if they unpin and re-pin it. That's
// fine for "first action" semantics — the long-tail re-emission
// rate is essentially zero.
const MAX_SEEN_PER_ACTION = 5000;

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
    // `Number.isFinite` not `typeof === 'number'` — `NaN` and
    // `±Infinity` both pass the typeof check but break the
    // /admin view's sort/percentile math (`a - b === NaN`,
    // `Math.max(...) === NaN`). A corrupted entry should be
    // dropped, same as the server-side validator does.
    return parsed.filter(
      (e): e is TelemetryEvent =>
        !!e &&
        typeof e === 'object' &&
        (e.action === 'pin' || e.action === 'hide') &&
        Number.isFinite(e.id) &&
        Number.isFinite(e.score) &&
        Number.isFinite(e.time) &&
        typeof e.isHot === 'boolean' &&
        typeof e.sourceFeed === 'string' &&
        Number.isFinite(e.eventTime) &&
        (e.descendants === undefined || Number.isFinite(e.descendants)) &&
        (e.type === undefined || typeof e.type === 'string') &&
        (e.articleOpened === undefined || typeof e.articleOpened === 'boolean') &&
        (e.title === undefined || typeof e.title === 'string'),
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
  // Whether the reader had opened the article (recorded in the
  // `openedStories` store) at the moment of action. Caller passes
  // `articleOpenedIds.has(story.id)` so the lib doesn't have to
  // import the opened-stories layer just for this read.
  articleOpened?: boolean;
  // `now` and `env` are injection points so unit tests can pin both
  // without monkey-patching globals.
  now?: number;
  env?: DeployEnv;
}

export function recordFirstAction(
  action: TelemetryAction,
  story: Pick<HNItem, 'id' | 'score' | 'time' | 'descendants' | 'type' | 'title'>,
  sourceFeed: string,
  opts: RecordOpts,
): void {
  const env = opts.env ?? getDeployEnv();
  if (!shouldEmit(env, opts.isAuthenticated)) return;

  // Skip events where the underlying HN item didn't carry the
  // fields we need to make sense of the data point. Recording
  // `score: 0, time: 0` would put a phantom dot at age = 50+
  // years on the /admin scatter and skew every percentile.
  // Better to drop the event entirely than to dilute the dataset.
  if (!Number.isFinite(story.score) || (story.score ?? 0) < 0) return;
  if (!Number.isFinite(story.time) || (story.time ?? 0) <= 0) return;

  const seen = readSeen();
  // Set-based membership check — O(1) instead of `Array.includes`'s
  // O(n) — and cap the surviving list at the most-recent N so the
  // dedup metadata can't grow without bound.
  const set = new Set(seen[action]);
  if (set.has(story.id)) return;
  let next = [...seen[action], story.id];
  if (next.length > MAX_SEEN_PER_ACTION) {
    next = next.slice(next.length - MAX_SEEN_PER_ACTION);
  }
  seen[action] = next;
  writeSeen(seen);

  // Cap title at a generous length so a pathological HN title
  // can't blow out the event payload. Real HN titles are <100
  // chars by convention; 200 is a safe ceiling.
  const title =
    typeof story.title === 'string'
      ? story.title.slice(0, 200)
      : undefined;
  const event: TelemetryEvent = {
    action,
    id: story.id,
    score: story.score!,
    time: story.time!,
    isHot: isHotStory(story),
    sourceFeed,
    eventTime: opts.now ?? Date.now(),
    descendants: story.descendants ?? 0,
    type: story.type,
    articleOpened: opts.articleOpened,
    title,
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
