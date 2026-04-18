export function extractDomain(url: string | undefined): string {
  if (!url) return '';
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function formatTimeAgo(unixSeconds: number, now: Date = new Date()): string {
  const nowS = Math.floor(now.getTime() / 1000);
  let diff = nowS - unixSeconds;
  if (diff < 0) diff = 0;

  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m}m`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h}h`;
  }
  if (diff < MONTH) {
    const d = Math.floor(diff / DAY);
    return `${d}d`;
  }
  if (diff < YEAR) {
    const mo = Math.floor(diff / MONTH);
    return `${mo}mo`;
  }
  const y = Math.floor(diff / YEAR);
  return `${y}y`;
}

export function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}
