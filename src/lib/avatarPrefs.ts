export const AVATAR_PREFS_STORAGE_KEY = 'newshacker:avatarPrefs';
export const AVATAR_PREFS_CHANGE_EVENT = 'newshacker:avatarPrefsChanged';

export type AvatarSource = 'github' | 'gravatar' | 'none';

export interface AvatarPrefs {
  source: AvatarSource;
  // Only set when the user has overridden it to something other than
  // their HN username; an unset value means "fall back to the HN
  // username at render time".
  githubUsername?: string;
  // Kept so the edit form can show the user what email they typed
  // last time; the URL is built from `gravatarHash`. Never synced to
  // the server — only the hash leaves the device.
  gravatarEmail?: string;
  gravatarHash?: string;
  // Monotonic timestamp of the last user-initiated save. Used by
  // cloudSync for last-write-wins across devices. Absent on a pristine
  // device (never edited) so the server's record always wins on first
  // login from that device.
  at?: number;
}

export const DEFAULT_AVATAR_PREFS: AvatarPrefs = { source: 'github' };

export const GITHUB_USERNAME_MAX = 39;
export const GRAVATAR_EMAIL_MAX = 254;

// GitHub's actual username rules: 1–39 chars, alphanumerics or hyphens,
// no leading/trailing hyphen, no consecutive hyphens.
const GITHUB_USERNAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

// Not full RFC 5322 — a pragmatic "has an @ with something on each side
// and a dot in the domain" so we reject obvious garbage before hashing.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const HASH_HEX_RE = /^[a-f0-9]{64}$/;

export function isValidGithubUsername(value: string): boolean {
  if (value.length === 0 || value.length > GITHUB_USERNAME_MAX) return false;
  return GITHUB_USERNAME_RE.test(value);
}

export function isValidGravatarEmail(value: string): boolean {
  if (value.length === 0 || value.length > GRAVATAR_EMAIL_MAX) return false;
  return EMAIL_RE.test(value);
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isAvatarSource(value: unknown): value is AvatarSource {
  return value === 'github' || value === 'gravatar' || value === 'none';
}

function sanitize(raw: unknown): AvatarPrefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AVATAR_PREFS };
  const r = raw as Record<string, unknown>;
  const source = isAvatarSource(r.source)
    ? r.source
    : DEFAULT_AVATAR_PREFS.source;
  const out: AvatarPrefs = { source };
  if (
    typeof r.githubUsername === 'string' &&
    isValidGithubUsername(r.githubUsername)
  ) {
    out.githubUsername = r.githubUsername;
  }
  if (
    typeof r.gravatarEmail === 'string' &&
    isValidGravatarEmail(r.gravatarEmail)
  ) {
    out.gravatarEmail = r.gravatarEmail;
  }
  if (typeof r.gravatarHash === 'string' && HASH_HEX_RE.test(r.gravatarHash)) {
    out.gravatarHash = r.gravatarHash;
  }
  if (typeof r.at === 'number' && Number.isFinite(r.at) && r.at >= 0) {
    out.at = r.at;
  }
  return out;
}

export function getStoredAvatarPrefs(): AvatarPrefs {
  if (!hasWindow()) return { ...DEFAULT_AVATAR_PREFS };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(AVATAR_PREFS_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_AVATAR_PREFS };
  }
  if (!raw) return { ...DEFAULT_AVATAR_PREFS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_AVATAR_PREFS };
  }
  return sanitize(parsed);
}

export function setStoredAvatarPrefs(
  prefs: AvatarPrefs,
  now: number = Date.now(),
): void {
  if (!hasWindow()) return;
  // User-initiated saves always stamp a fresh `at` so cloudSync can
  // beat an older server record on its next push. Callers that want to
  // preserve an incoming `at` (e.g. the sync layer applying a server
  // pull) use `replaceAvatarPrefs` instead.
  const clean: AvatarPrefs = { ...sanitize(prefs), at: now };
  try {
    window.localStorage.setItem(
      AVATAR_PREFS_STORAGE_KEY,
      JSON.stringify(clean),
    );
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(AVATAR_PREFS_CHANGE_EVENT));
}

// Overwrite stored prefs with exactly what's given — no `at` stamping.
// Used by the sync layer after a pull to replay the server record. The
// incoming `at` (if any) is preserved so subsequent LWW comparisons
// against other devices are consistent.
export function replaceAvatarPrefs(prefs: AvatarPrefs): void {
  if (!hasWindow()) return;
  const clean = sanitize(prefs);
  try {
    window.localStorage.setItem(
      AVATAR_PREFS_STORAGE_KEY,
      JSON.stringify(clean),
    );
  } catch {
    // non-fatal
  }
  window.dispatchEvent(new CustomEvent(AVATAR_PREFS_CHANGE_EVENT));
}

export function clearStoredAvatarPrefs(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(AVATAR_PREFS_STORAGE_KEY);
  } catch {
    // non-fatal
  }
  window.dispatchEvent(new CustomEvent(AVATAR_PREFS_CHANGE_EVENT));
}

// SHA-256 hex digest of the lowercased, trimmed email. Gravatar moved
// from MD5 to SHA-256 as the recommended identifier in 2023, and the
// /avatar/<hash> endpoint accepts either.
export async function gravatarHashFromEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const encoded = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// Build the image URL for the given prefs. Returns null when the user
// has opted out of a picture, or when no usable identifier is present
// (e.g. GitHub source with no override and no HN username).
export function avatarImageUrl(
  prefs: AvatarPrefs,
  hnUsername: string | null | undefined,
  size = 64,
): string | null {
  if (prefs.source === 'none') return null;
  if (prefs.source === 'gravatar') {
    if (!prefs.gravatarHash) return null;
    return `https://gravatar.com/avatar/${prefs.gravatarHash}?s=${size}&d=404`;
  }
  const name = prefs.githubUsername ?? (hnUsername ? hnUsername : null);
  if (!name) return null;
  if (!isValidGithubUsername(name)) return null;
  return `https://github.com/${name}.png?size=${size}`;
}
