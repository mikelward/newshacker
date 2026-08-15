// In-memory log of recent thread opens, surfaced on /debug next to the
// persisted-cache stats. Answers the field report "opening a story took
// N seconds" with the facts that locate the wait: how long the reader
// actually looked at the loading state before content committed, whether
// the content came from cache or a fetch, and — when the thread WAS the
// page load — how long the whole boot took. Session memory only — never
// persisted, never sent anywhere. Deliberately not live-synced across
// tabs or navigations: each tab has its own module instance, and opening
// a thread in this tab unmounts /debug first, so the reader always
// arrives at /debug AFTER the opens they care about — a plain render-time
// read shows them.

export interface ThreadOpenRecord {
  id: number;
  // Time from the Thread component mounting to its first commit with
  // content (0 for a cache hit that painted on the first frame). Only
  // successful content commits are recorded — an error or item-not-found
  // state isn't an "open", and a retry that later succeeds records the
  // full wait including the failed attempt.
  waitedMs: number;
  // Whether the content came from cache — judged at commit time by the
  // query's dataUpdatedAt: data stamped BEFORE the component mounted was
  // already there (memory cache, or the persisted blob's hydration
  // finishing mid-wait); data stamped after mount was fetched during the
  // wait. Judging at mount time instead mislabels the hydration case —
  // the exact distinction this diagnostic exists to make.
  rootCached: boolean;
  // For the thread the page itself loaded on (reload of an /item URL,
  // deep link, PWA relaunch): total time from navigation start to the
  // content commit. This is the reader's real wait on a reload — it
  // includes JS download/parse, the persisted-cache restore, and the
  // hydrate pass, all of which happen before the component exists and
  // are invisible to waitedMs. Absent for in-app navigations.
  sinceNavMs?: number;
}

const MAX_RECORDS = 5;

// Newest first. Bounded, so a long session can't grow it.
const records: ThreadOpenRecord[] = [];

// The item id the page itself loaded on, captured at module-evaluation
// time — before React Router mounts, so SPA navigation can't rewrite it.
// This, not a time window, is what identifies a boot open: a slow device
// can spend arbitrarily long in JS/restore before Thread mounts, and an
// in-app open can happen seconds after a feed load — elapsed time can't
// tell those apart, the initial URL can.
function readInitialItemId(): number | null {
  try {
    const match = /^\/item\/(\d+)(?:\/|$)/.exec(
      globalThis.location?.pathname ?? '',
    );
    return match ? Number(match[1]) : null;
  } catch (error) {
    // Some restricted hosts/test shims throw on location access. The
    // boot-open diagnostic degrades to in-app-only; log at debug so an
    // always-missing sinceNavMs is traceable to this, not mistaken for
    // "the page never loads on a thread". No URL in the log — only the
    // failure itself.
    console.debug('threadOpenStats: initial-route read failed', error);
    return null;
  }
}

let bootThreadId: number | null = readInitialItemId();
let bootOpenClaimed = false;

// True exactly once, for the first recorded open of the thread the page
// loaded on. The claim is single-use so a later in-app return to the
// same story isn't re-labeled as a boot open.
export function claimBootOpen(id: number): boolean {
  if (bootOpenClaimed || bootThreadId === null || id !== bootThreadId) {
    return false;
  }
  bootOpenClaimed = true;
  return true;
}

export function noteThreadOpen(record: ThreadOpenRecord): void {
  records.unshift(record);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
}

export function getThreadOpenRecords(): readonly ThreadOpenRecord[] {
  return records;
}

export function _resetThreadOpenStatsForTests(
  initialItemId: number | null = null,
): void {
  records.length = 0;
  bootThreadId = initialItemId;
  bootOpenClaimed = false;
}
