// Non-orange palette so the user avatar disc never clashes with the
// brand mark's orange `n`. Saturation roughly matches HN orange so the
// avatar reads as a peer of the logo rather than fighting it.
export const AVATAR_COLORS = [
  '#2563eb', // blue
  '#0d9488', // teal
  '#16a34a', // green
  '#7c3aed', // purple
  '#db2777', // pink
  '#0891b2', // cyan
  '#4f46e5', // indigo
  '#be185d', // rose
  '#475569', // slate
] as const;

// Small deterministic hash — same input always picks the same color,
// and two different users with matching first letters usually land on
// different colors.
export function avatarColorForUsername(username: string): string {
  if (!username) return AVATAR_COLORS[0];
  let h = 0;
  for (let i = 0; i < username.length; i += 1) {
    h = (h * 31 + username.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
