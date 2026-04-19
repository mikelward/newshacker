# TODO

Short running list of things that aren't in flight but worth doing. For
user-facing feature decisions, see `SPEC.md`; for phase ordering, see
`IMPLEMENTATION_PLAN.md`.

## Performance

- **Faster sweep.** The broom currently rebuilds the dismissed-ids
  localStorage entry once per swept story, firing a storage change
  event each time. Batch the write so a sweep of 30 rows is one
  write + one event.
- **Prefetch page N+1 after each landed page.** With `/api/items`
  batched and edge-cached, each prefetch is effectively free — so
  keeping one page of lookahead warm would eliminate nearly every
  visible pagination "Loading…" for steady scrollers. Cap the
  lookahead so we don't drain the whole feed on mount.
- **Experiment with Algolia HN Search** as an alternative data source.
  One request returns a page of items with the fields we need; tags
  map to most of our feeds (`top`→`front_page`, `ask`→`ask_hn`,
  `show`→`show_hn`, `jobs`→`job`, `new`→`search_by_date&tags=story`).
  `best` has no direct equivalent — may need a different definition
  (e.g. "highest-voted story in the last 24h" via numericFilters).
  Worth prototyping a side-by-side to see if the order / content
  differs meaningfully from Firebase's `topstories` etc.
- **Persist item bodies across sessions.** React Query's localStorage
  persister caches the whole client; for item bodies specifically we
  could tier the persistence so they survive longer (days) than the
  ID lists (minutes), since titles/urls rarely change.
