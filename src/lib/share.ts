import type { HNItem } from './hn';

export interface SharePayload {
  title: string;
  text: string;
  url: string;
}

export function buildSharePayload(
  story: HNItem,
  origin: string,
): SharePayload {
  const title = story.title ?? 'Hacker News story';
  const threadUrl = `${origin.replace(/\/$/, '')}/item/${story.id}`;
  const url = story.url ?? threadUrl;
  return { title, text: title, url };
}

export interface ShareDeps {
  share?: (data: SharePayload) => Promise<void>;
  copy?: (text: string) => Promise<void>;
}

export type ShareResult = 'shared' | 'copied' | 'unavailable' | 'cancelled';

export async function shareOrCopy(
  payload: SharePayload,
  deps: ShareDeps,
): Promise<ShareResult> {
  if (deps.share) {
    try {
      await deps.share(payload);
      return 'shared';
    } catch (err) {
      // AbortError = user dismissed the share sheet; treat as cancelled.
      if (err instanceof Error && err.name === 'AbortError') {
        return 'cancelled';
      }
      // Fall through to clipboard fallback.
    }
  }
  if (deps.copy) {
    try {
      await deps.copy(payload.url);
      return 'copied';
    } catch {
      return 'unavailable';
    }
  }
  return 'unavailable';
}
