import type { HNItem } from './hn';
import { trackedFetch } from './networkStatus';

export type SearchSort = 'relevance' | 'date';

// One Algolia page == one feed page worth of results. Keeps the
// pagination feel identical to feed views (PAGE_SIZE in useStoryList).
export const SEARCH_PAGE_SIZE = 30;

const ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';

// `(story,job)` covers everything that renders as a story row: `story`
// is Algolia's bucket for plain stories plus Ask HN / Show HN (they
// carry `story` alongside their own tag), and `job` covers HN job
// posts. Polls and bare comments are excluded — we have no row
// component for them.
const SEARCH_TAGS = '(story,job)';

export interface SearchResultsPage {
  hits: HNItem[];
  page: number;
  nbPages: number;
  hasMore: boolean;
}

export interface SearchParams {
  query: string;
  sort: SearchSort;
  page: number;
  signal?: AbortSignal;
}

interface AlgoliaHit {
  objectID: string;
  author?: string | null;
  title?: string | null;
  url?: string | null;
  story_text?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at_i?: number | null;
  _tags?: string[];
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
  page: number;
  nbPages: number;
}

export async function searchStories({
  query,
  sort,
  page,
  signal,
}: SearchParams): Promise<SearchResultsPage> {
  const path = sort === 'date' ? 'search_by_date' : 'search';
  const qs = new URLSearchParams({
    query,
    tags: SEARCH_TAGS,
    hitsPerPage: String(SEARCH_PAGE_SIZE),
    page: String(page),
  });
  const res = await trackedFetch(`${ALGOLIA_BASE}/${path}?${qs.toString()}`, {
    signal,
  });
  if (!res.ok) {
    throw new Error(`Algolia ${res.status}`);
  }
  const data = (await res.json()) as AlgoliaResponse;
  const hits = data.hits
    .map(algoliaHitToHNItem)
    .filter((it): it is HNItem => it != null);
  return {
    hits,
    page: data.page,
    nbPages: data.nbPages,
    hasMore: data.page < data.nbPages - 1,
  };
}

export function algoliaHitToHNItem(hit: AlgoliaHit): HNItem | null {
  const id = Number(hit.objectID);
  if (!Number.isFinite(id)) return null;
  const tags = hit._tags ?? [];
  // Job posts carry `job` in tags and type=job on HN; everything else
  // we search for is a story (ask_hn / show_hn are sub-tags of story).
  const type = tags.includes('job') ? 'job' : 'story';
  return {
    id,
    type,
    by: hit.author ?? undefined,
    title: hit.title ?? undefined,
    url: hit.url ?? undefined,
    text: hit.story_text ?? undefined,
    score: hit.points ?? 0,
    descendants: hit.num_comments ?? 0,
    time: hit.created_at_i ?? undefined,
  };
}
