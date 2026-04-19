# TODO

Short running list of things that aren't in flight but worth doing. For
user-facing feature decisions, see `SPEC.md`; for phase ordering, see
`IMPLEMENTATION_PLAN.md`.

## Performance

- **Faster sweep.** The broom currently rebuilds the dismissed-ids
  localStorage entry once per swept story, firing a storage change
  event each time. Batch the write so a sweep of 30 rows is one
  write + one event.
- **Prefetch the next page** while the user is still reading the current
  one. With `useInfiniteQuery` in place, each page is now a cheap 30-item
  fetch, but the sentinel still only fires when the user scrolls near
  the bottom — we could trigger the next page earlier or in the
  background so it's warm on arrival.
- **Batch the item fetch.** Firebase's HN API is one-HTTP-request-per-
  item. Algolia's HN Search API returns multiple stories in a single
  request — a drop-in for the feed view would turn 30 requests into 1,
  especially useful for users with many dismissed stories who need
  several pages just to fill a screen.
- **Persist item cache to localStorage.** React Query's in-memory cache
  doesn't survive a reload. A small, bounded IndexedDB/localStorage
  cache of item bodies would make repeat visits instant for the common
  set of top stories.
