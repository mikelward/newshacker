# TODO

Short running list of things that aren't in flight but worth doing. For
user-facing feature decisions, see `SPEC.md`; for phase ordering, see
`IMPLEMENTATION_PLAN.md`.

## Performance

- **Faster sweep.** The broom currently rebuilds the dismissed-ids
  localStorage entry once per swept story, firing a storage change
  event each time. Batch the write so a sweep of 30 rows is one
  write + one event.
- **Batch item fetch via a serverless proxy.** Firebase's HN API is
  one-HTTP-request-per-item. A `/api/items?ids=…` handler on our
  existing Vercel backend would fan out to Firebase in parallel and
  return a single JSON body. Setting `Cache-Control: public, max-age=60,
  stale-while-revalidate=300` lets the Vercel edge cache serve repeat
  requests (for the `top` feed, same ~30 IDs across most users →
  massive hit rate). Biggest single lever left for first-visit latency.
- **Widen the sentinel `rootMargin`** (currently 400px). With the
  prefetch of page 2 in place, the sentinel mostly handles page 3+ —
  firing earlier (say 1200px) would keep scroll ahead of the network.
- **Experiment with Algolia HN Search** as an alternative data source.
  One request returns a page of items with the fields we need; tags
  map to most of our feeds (`top`→`front_page`, `ask`→`ask_hn`,
  `show`→`show_hn`, `jobs`→`job`, `new`→`search_by_date&tags=story`).
  `best` has no direct equivalent — may need a different definition
  (e.g. "highest-voted story in the last 24h" via numericFilters).
  Worth prototyping a side-by-side to see if the order / content
  differs meaningfully from Firebase's `topstories` etc.
