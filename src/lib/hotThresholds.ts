export const HOT_THRESHOLDS_STORAGE_KEY = 'newshacker:hotThresholds';
export const HOT_THRESHOLDS_CHANGE_EVENT = 'newshacker:hotThresholdsChanged';

// Production defaults. This module is the single source of truth for
// the loose constants and `DEFAULT_HOT_THRESHOLDS`; `format.ts`
// re-exports the loose constants for backward compatibility with
// older call sites and tests that imported them from there.
export const HOT_MIN_VELOCITY = 15;
export const HOT_MIN_DESCENDANTS = 10;
export const HOT_BIG_SCORE = 200;
export const HOT_BIG_DESCENDANTS = 100;

// Shape of the user-tunable Hot rule. `isHotStory` is a two-branch OR:
// `(top branch) || (new branch)`. Each branch can be turned off
// individually via its `*Enabled` flag — off means the disjunct
// evaluates to `false`, i.e. that branch stops contributing rows. Both
// off → `/hot` is empty; the page surfaces an inline hint so the user
// knows why.
//
// Within a branch the comparisons are `>=` (not `>`), so dragging an
// individual slider to 0 effectively removes that gate from its branch
// while keeping the other gate active — e.g. `topScoreMin = 0` means
// "any score, but still require at least `topDescendantsMin` comments".
// If both gates in an enabled branch are 0, that branch matches
// everything and `/hot` becomes the unfiltered union of `/top ∪ /new`.
export interface HotThresholds {
  // Top branch: established, high-score stories.
  // Story qualifies iff score >= topScoreMin AND descendants >= topDescendantsMin.
  topEnabled: boolean;
  topScoreMin: number;
  topDescendantsMin: number;
  // New branch: fast-rising stories.
  // Story qualifies iff (score / ageHours) >= newVelocityMin AND descendants >= newDescendantsMin.
  newEnabled: boolean;
  newVelocityMin: number;
  newDescendantsMin: number;
  // Wall-clock timestamp (`Date.now()`) of the last user-initiated
  // save. Not strictly monotonic — a manual clock change can move it
  // backwards — so LWW is best-effort, but `Date.now()` is what every
  // device on this app uses, so all writers agree on the same axis.
  // Used by cloudSync for last-write-wins across devices; absent on a
  // pristine device (never edited) so the server's record always wins
  // on first login from that device. Same shape as `AvatarPrefs.at`.
  at?: number;
}

export const DEFAULT_HOT_THRESHOLDS: HotThresholds = {
  topEnabled: true,
  topScoreMin: HOT_BIG_SCORE,
  topDescendantsMin: HOT_BIG_DESCENDANTS,
  newEnabled: true,
  newVelocityMin: HOT_MIN_VELOCITY,
  newDescendantsMin: HOT_MIN_DESCENDANTS,
};

// Slider bounds. Tight enough to keep the UI usable but loose enough
// that a power user can ratchet either branch hard. Read by
// `<HotRuleCard>` (the `/hot` inline editor) to set `min`/`max` on
// the four `<input type="range">` controls.
export const HOT_THRESHOLD_BOUNDS = {
  topScoreMin: { min: 0, max: 2000, step: 10 },
  topDescendantsMin: { min: 0, max: 1000, step: 5 },
  newVelocityMin: { min: 0, max: 200, step: 1 },
  newDescendantsMin: { min: 0, max: 200, step: 1 },
} as const;

// Sanitize a numeric threshold field: round to integer, clamp to
// [min, max], then snap to the nearest valid step increment so the
// stored value always lands on a position the corresponding
// `<input type="range" step={...}>` can render — without this, a
// hand-edited or older synced `topScoreMin = 201` would survive
// untouched and produce an off-grid slider position.
function clampInt(
  raw: unknown,
  bounds: { min: number; max: number; step: number },
  fallback: number,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const rounded = Math.round(raw);
  const clamped = Math.min(bounds.max, Math.max(bounds.min, rounded));
  const snapped =
    bounds.min +
    Math.round((clamped - bounds.min) / bounds.step) * bounds.step;
  return Math.min(bounds.max, Math.max(bounds.min, snapped));
}

function sanitize(raw: unknown): HotThresholds {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_HOT_THRESHOLDS };
  const r = raw as Record<string, unknown>;
  const out: HotThresholds = {
    topEnabled:
      typeof r.topEnabled === 'boolean'
        ? r.topEnabled
        : DEFAULT_HOT_THRESHOLDS.topEnabled,
    topScoreMin: clampInt(
      r.topScoreMin,
      HOT_THRESHOLD_BOUNDS.topScoreMin,
      DEFAULT_HOT_THRESHOLDS.topScoreMin,
    ),
    topDescendantsMin: clampInt(
      r.topDescendantsMin,
      HOT_THRESHOLD_BOUNDS.topDescendantsMin,
      DEFAULT_HOT_THRESHOLDS.topDescendantsMin,
    ),
    newEnabled:
      typeof r.newEnabled === 'boolean'
        ? r.newEnabled
        : DEFAULT_HOT_THRESHOLDS.newEnabled,
    newVelocityMin: clampInt(
      r.newVelocityMin,
      HOT_THRESHOLD_BOUNDS.newVelocityMin,
      DEFAULT_HOT_THRESHOLDS.newVelocityMin,
    ),
    newDescendantsMin: clampInt(
      r.newDescendantsMin,
      HOT_THRESHOLD_BOUNDS.newDescendantsMin,
      DEFAULT_HOT_THRESHOLDS.newDescendantsMin,
    ),
  };
  if (typeof r.at === 'number' && Number.isFinite(r.at) && r.at >= 0) {
    out.at = r.at;
  }
  return out;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

export function getStoredHotThresholds(): HotThresholds {
  if (!hasWindow()) return { ...DEFAULT_HOT_THRESHOLDS };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(HOT_THRESHOLDS_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_HOT_THRESHOLDS };
  }
  if (!raw) return { ...DEFAULT_HOT_THRESHOLDS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_HOT_THRESHOLDS };
  }
  return sanitize(parsed);
}

export function setStoredHotThresholds(
  prefs: HotThresholds,
  now: number = Date.now(),
): void {
  if (!hasWindow()) return;
  // User-initiated saves always stamp a fresh `at` so cloudSync can
  // beat an older server record on its next push. Callers that want to
  // preserve an incoming `at` (e.g. the sync layer applying a server
  // pull) use `replaceHotThresholds` instead.
  const clean: HotThresholds = { ...sanitize(prefs), at: now };
  try {
    window.localStorage.setItem(
      HOT_THRESHOLDS_STORAGE_KEY,
      JSON.stringify(clean),
    );
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(HOT_THRESHOLDS_CHANGE_EVENT));
}

// Overwrite stored prefs with exactly what's given — no `at` stamping.
// Used by the sync layer after a pull to replay the server record.
export function replaceHotThresholds(prefs: HotThresholds): void {
  if (!hasWindow()) return;
  const clean = sanitize(prefs);
  try {
    window.localStorage.setItem(
      HOT_THRESHOLDS_STORAGE_KEY,
      JSON.stringify(clean),
    );
  } catch {
    // non-fatal
  }
  window.dispatchEvent(new CustomEvent(HOT_THRESHOLDS_CHANGE_EVENT));
}

export function clearStoredHotThresholds(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(HOT_THRESHOLDS_STORAGE_KEY);
  } catch {
    // non-fatal
  }
  window.dispatchEvent(new CustomEvent(HOT_THRESHOLDS_CHANGE_EVENT));
}

// Pure evaluator — used by `isHotStory` (with the user's overrides
// threaded through). Direct callers can also import this if they want
// to filter against a specific `HotThresholds` value without going
// through the format.ts `isHotStory` indirection.
//
// Mirrors the safe-age floor (~36 s) `isHotStory` has always used so a
// brand-new story doesn't blow up to Infinity on velocity while its age
// rounds to zero.
export interface HotStoryInput {
  score?: number;
  descendants?: number;
  time?: number;
}

export function evalHot(
  item: HotStoryInput,
  now: Date = new Date(),
  thresholds: HotThresholds = DEFAULT_HOT_THRESHOLDS,
): boolean {
  const score = item.score ?? 0;
  const descendants = item.descendants ?? 0;
  if (
    thresholds.topEnabled &&
    score >= thresholds.topScoreMin &&
    descendants >= thresholds.topDescendantsMin
  ) {
    return true;
  }
  if (!thresholds.newEnabled) return false;
  if (!item.time) return false;
  const nowS = Math.floor(now.getTime() / 1000);
  const ageHours = (nowS - item.time) / 3600;
  if (ageHours < 0) return false;
  const safeAge = Math.max(ageHours, 0.01);
  return (
    score / safeAge >= thresholds.newVelocityMin &&
    descendants >= thresholds.newDescendantsMin
  );
}

// Convenience for callers that want a yes/no on whether the user has
// turned BOTH branches off — `<HotRuleCard>`'s empty-feed hint reads
// this so it knows when to render.
export function hasAnyEnabledBranch(t: HotThresholds): boolean {
  return t.topEnabled || t.newEnabled;
}
