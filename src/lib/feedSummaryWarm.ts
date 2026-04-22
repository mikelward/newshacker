import type { HNItem } from './hn';
import { hasSelfPostBody } from './selfPostBody';

// Fire-and-forget warm for the server-side Gemini summary caches
// (/api/summary and /api/comments-summary, both Upstash-backed).
// Called from the feed when a story row enters the viewport so that,
// by the time the user (or any other user) opens the thread, the KV
// entry is already populated and the thread renders instantly without
// paying a Gemini round-trip.
//
// Triggering this from visible rows instead of a scheduled cron means
// we only generate summaries that at least one real user has seen,
// which keeps Gemini spend proportional to actual interest rather than
// to the full feed size every 30 minutes.
//
// Both endpoints already short-circuit on a KV hit (see api/summary.ts
// and api/comments-summary.ts), so repeat calls within the TTL cost a
// single Redis read rather than a Gemini generation.
//
// Errors are swallowed on purpose — this is a best-effort prefetch,
// not a user-visible action. If the request 4xx/5xxs, the real
// thread-open path will surface the error.

// Keep in sync with the `> 1` gate in api/summary.ts and
// api/comments-summary.ts. This is the client-side mirror so we don't
// waste a round-trip for ineligible stories; the server enforces the
// real gate. In normal usage the feed never renders a score ≤ 1 row
// anyway (see the score filter in StoryList.tsx), so this branch is
// primarily for defensive consistency with the server.
export function warmFeedSummaries(
  story: Pick<HNItem, 'id' | 'url' | 'score' | 'text'>,
): void {
  if (!(typeof story.score === 'number' && story.score > 1)) return;
  // Warm /api/summary when the story has *something* to summarize: an
  // external URL (article path, via Jina) OR a self-post body (Ask HN,
  // Show HN, etc. — summarized directly from `text`). Stories with
  // neither (rare: a titled-only job post with no URL and no body),
  // or whose body is effectively empty after HTML strip (e.g.
  // `<p> </p>`), would 400 `no_article`, so skip the call rather
  // than burn a request.
  if (story.url || hasSelfPostBody(story.text)) {
    void fetch(`/api/summary?id=${story.id}`).catch(() => {});
  }
  void fetch(`/api/comments-summary?id=${story.id}`).catch(() => {});
}
