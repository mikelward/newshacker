// Shared HTTP helpers for `api/*.ts` handlers. See `./session.ts` for
// the rationale behind this directory layout.

// JSON response with `cache-control: private, no-store`. Every handler
// that returns user-scoped or session-derived data should default to
// this so intermediate caches (edge, browser, extensions) never hold
// another user's response.
//
// `extraHeaders` is merged *first* so it can't accidentally overwrite
// `content-type` or the no-store `cache-control` — those are
// security-sensitive defaults. In practice callers only pass it to
// add `set-cookie`.
export function json(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...extraHeaders,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
}
