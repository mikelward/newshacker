// The "materialized feed set" — a frozen snapshot of which story rows a
// feed view renders, and in what order, between materialization moments.
//
// Why a snapshot at all? A live feed reorders and drops rows the instant
// any store changes — a pin from another device yanks a row to the top, a
// dismiss (Done) from another device makes a row vanish under the reader's
// eye, a background refetch injects brand-new articles mid-scroll. The
// reading model this implements deliberately *freezes* the set so nothing
// moves out from under the reader on a remote or background event. The set
// only re-derives on a small number of explicit moments:
//
//   - full materialize: a return after ≥6 h, or a pull-to-refresh. Pins
//     consolidate to the top block, dismissed rows drop out, and new
//     articles come in.
//   - compact: any list remount / navigation return (article → back).
//     Only drops rows the reader has finished with (Done / Hidden) and
//     collapses the gaps; it does NOT reorder pins or pull in new
//     articles. Does not reset the 6 h clock.
//   - append (More): the next page's qualifying rows are appended to the
//     body; the top block is never touched.
//
// Between those moments the component derives per-row overlays live from
// the stores — a pin badge appears in place, a remote dismiss grays the
// row in place — without changing membership or order. The reader's own
// dismiss from a feed row is the one local mutation that removes a row
// immediately (see `removeId`).
//
// This module is deliberately pure + data-only: no React, no DOM, no
// item payloads — just ordered id lists. `StoryListImpl` maps the ids back
// to live item data at render time. The per-session store below keeps a
// snapshot alive across the feed's own remounts (navigating into a story
// and back) without persisting across a cold app launch.

export interface FeedSnapshot {
  // The pinned block at the top of the feed, oldest-pin-first. Frozen
  // at the last full materialize; compact/append never reorder it.
  topPinIds: number[];
  // The feed body, in feed order. Frozen at the last full materialize,
  // extended by `appendMore`, trimmed by `compact` / `removeId`.
  bodyIds: number[];
  // Wall-clock of the last *full* materialize. `compact` and `appendMore`
  // preserve it — only a full materialize resets the 6 h clock.
  materializedAt: number;
}

// A return after this long re-materializes the set on mount instead of
// just compacting it (see `StoryListImpl`). Six hours: long enough that a
// same-day return keeps the reader's place, short enough that a feed
// opened the next morning is fresh.
export const MATERIALIZE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface MaterializeContext {
  // Pinned stories for the top block, oldest-pin-first (already filtered
  // to renderable pins by the caller).
  pinnedTopIds: readonly number[];
  // Feed body candidates in feed order — ids that pass the view's row
  // filter (score > 1, not hidden, not done, not pinned).
  bodyCandidateIds: readonly number[];
  now: number;
}

// Full materialize: recompute the whole set from live data. Pins take the
// top block; the body is every qualifying feed row that isn't already a
// pin. Resets the materialize clock.
export function materialize(ctx: MaterializeContext): FeedSnapshot {
  const topPinIds = [...ctx.pinnedTopIds];
  const pinned = new Set(topPinIds);
  const bodyIds = ctx.bodyCandidateIds.filter((id) => !pinned.has(id));
  return { topPinIds, bodyIds, materializedAt: ctx.now };
}

export interface CompactContext {
  doneIds: ReadonlySet<number>;
  hiddenIds: ReadonlySet<number>;
  // Does this body id still have renderable data (present, not
  // dead/deleted, score > 1)? Top-block pins bypass this — a pin that
  // dropped off the feed still renders from the pinned-item cache.
  isBodyRenderable: (id: number) => boolean;
}

// Compact: drop rows the reader is done with (Done / Hidden) and collapse
// the gaps, in place. Does NOT reorder pins, pull server pins to the top,
// or bring in new articles — that's a full materialize's job. Preserves
// `materializedAt` so the 6 h clock keeps ticking from the last full
// materialize.
export function compact(prev: FeedSnapshot, ctx: CompactContext): FeedSnapshot {
  const topPinIds = prev.topPinIds.filter(
    (id) => !ctx.doneIds.has(id) && !ctx.hiddenIds.has(id),
  );
  const bodyIds = prev.bodyIds.filter(
    (id) =>
      !ctx.doneIds.has(id) &&
      !ctx.hiddenIds.has(id) &&
      ctx.isBodyRenderable(id),
  );
  if (
    topPinIds.length === prev.topPinIds.length &&
    bodyIds.length === prev.bodyIds.length
  ) {
    return prev;
  }
  return { ...prev, topPinIds, bodyIds };
}

// Append (More): add the newly-loaded page's qualifying rows to the tail
// of the body, skipping anything already placed (in either block). Never
// touches the top block or the materialize clock.
export function appendMore(
  prev: FeedSnapshot,
  newBodyCandidateIds: readonly number[],
): FeedSnapshot {
  const present = new Set<number>(prev.topPinIds);
  for (const id of prev.bodyIds) present.add(id);
  const add = newBodyCandidateIds.filter((id) => !present.has(id));
  if (add.length === 0) return prev;
  return { ...prev, bodyIds: [...prev.bodyIds, ...add] };
}

// Remove a single id from the set immediately — the reader's own dismiss
// (Done) from a feed row, which collapses the row away at once rather than
// waiting for the next compact/materialize (that's a remote dismiss).
export function removeId(prev: FeedSnapshot, id: number): FeedSnapshot {
  const inTop = prev.topPinIds.includes(id);
  const inBody = prev.bodyIds.includes(id);
  if (!inTop && !inBody) return prev;
  return {
    ...prev,
    topPinIds: inTop ? prev.topPinIds.filter((x) => x !== id) : prev.topPinIds,
    bodyIds: inBody ? prev.bodyIds.filter((x) => x !== id) : prev.bodyIds,
  };
}

// Per-session store, keyed by feed. Survives the feed's own remounts (so a
// navigation return can compact the existing snapshot) but lives only in
// module memory — a cold app launch starts with no snapshot and
// materializes fresh.
const snapshots = new Map<string, FeedSnapshot>();

export function getFeedSnapshot(feed: string): FeedSnapshot | null {
  return snapshots.get(feed) ?? null;
}

export function setFeedSnapshot(feed: string, snapshot: FeedSnapshot): void {
  snapshots.set(feed, snapshot);
}

// Test-only: drop all in-memory snapshots so one test's frozen set can't
// leak into the next.
export function _clearFeedSnapshotsForTests(): void {
  snapshots.clear();
}
