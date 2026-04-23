// Thin wrapper around the Vite-injected `__BUILD_COMMIT_TIME__` global
// so tests can `vi.mock('./buildInfo')` to cover the empty-string
// fallback path without relying on the compile-time define. The value
// is an ISO 8601 timestamp (`git log -1 --format=%cI`) or '' when git
// wasn't available at build time.
export const buildCommitTime: string = __BUILD_COMMIT_TIME__;
