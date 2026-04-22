// Mirror of the server-side `no_article` predicate in api/summary.ts:
// after HTML tags are stripped and entities/whitespace collapse, a
// self-post body like `<p> </p>` or `&nbsp;&nbsp;` has nothing to
// summarize and the endpoint returns 400. Without this check the feed
// warmer burns a Gemini request and the thread UI shows a retryable
// "Could not summarize" error for posts that were never summarizable.
//
// Kept deliberately minimal (tag-strip + common-whitespace-entity
// replace + trim) rather than reusing the full server helper, which
// also handles &amp;/&lt;/etc. for model-facing plain text. Those
// non-whitespace entities don't change the emptiness decision.
export function hasSelfPostBody(text: string | undefined): boolean {
  if (!text) return false;
  const stripped = text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return stripped.length > 0;
}
