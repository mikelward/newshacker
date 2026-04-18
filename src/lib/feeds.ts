export const FEEDS = ['top', 'new', 'best', 'ask', 'show', 'jobs'] as const;

export type Feed = (typeof FEEDS)[number];

const LABELS: Record<Feed, string> = {
  top: 'Top',
  new: 'New',
  best: 'Best',
  ask: 'Ask',
  show: 'Show',
  jobs: 'Jobs',
};

export function isFeed(value: string): value is Feed {
  return (FEEDS as readonly string[]).includes(value);
}

export function feedLabel(feed: Feed): string {
  return LABELS[feed];
}

export function feedEndpoint(feed: Feed): string {
  switch (feed) {
    case 'top':
      return 'topstories';
    case 'new':
      return 'newstories';
    case 'best':
      return 'beststories';
    case 'ask':
      return 'askstories';
    case 'show':
      return 'showstories';
    case 'jobs':
      return 'jobstories';
  }
}
