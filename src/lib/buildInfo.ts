import { formatTimeAgo } from './format';

// Thin wrapper around the Vite-injected `__BUILD_COMMIT_TIME__` global
// so tests can `vi.mock('./buildInfo')` to cover the empty-string
// fallback path without relying on the compile-time define. The value
// is an ISO 8601 timestamp (`git log -1 --format=%cI`) or '' when git
// wasn't available at build time.
export const buildCommitTime: string = __BUILD_COMMIT_TIME__;

/**
 * One-line build age for the About page's Version section, e.g.
 * `Built 5d ago`. Uses the baked-in commit time so the line renders
 * without a network round-trip (the deployed commit SHA lives on
 * `/debug`, which the section links to). Falls back to
 * `Build info unavailable` when the commit time is missing (shallow
 * checkout, no git) or unparseable. Pass `now` in tests to keep
 * relative-time assertions deterministic.
 */
export function summarizeBuildAge(
  commitTime: string,
  now: Date = new Date(),
): string {
  if (!commitTime) return 'Build info unavailable';
  const built = new Date(commitTime);
  if (Number.isNaN(built.getTime())) return 'Build info unavailable';
  return `Built ${formatTimeAgo(Math.floor(built.getTime() / 1000), now)} ago`;
}
