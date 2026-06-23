// Shared session/cookie helpers for `api/*.ts` handlers.
//
// This module lives outside `api/` intentionally: it is a plain
// library module that is bundled into each handler's Vercel Lambda
// via `functions[...].includeFiles` in `vercel.json`. See
// AGENTS.md § "Vercel `api/` gotchas" for the historical context
// and `api/imports.test.ts` for the guard that keeps this arrangement
// narrow (only `../lib/api/*` is allowed from a handler).

export const SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ?? 'hn_session';
export const HN_COOKIE_NAME = process.env.HN_COOKIE_NAME ?? 'user';

// HN usernames: letters, digits, dashes, underscores. HN's own form says
// 2–15 chars but historical accounts occasionally exceed that; 2–32 is
// lenient without being absurd.
export const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

// Parse a `Cookie:` header value into a name → value map. Values are URL
// decoded to reverse the `encodeURIComponent` we apply at Set-Cookie
// time. Non-spec cookies (no `=`) are ignored.
export function parseCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const raw of header.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

// HN's cookie value is `<username>&<opaque-hash>`. We treat the portion
// before `&` as the username and validate it against HN_USERNAME_RE.
export function usernameFromSessionValue(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const amp = value.indexOf('&');
  const candidate = amp === -1 ? value : value.slice(0, amp);
  return HN_USERNAME_RE.test(candidate) ? candidate : null;
}
