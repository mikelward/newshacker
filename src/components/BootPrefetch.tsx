import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getStoryIds } from '../lib/hn';

// Fires as early as possible so the top feed's id list is in flight
// (or already in cache) by the time the user lands on "/" → /top.
// Any later consumer of ['storyIds', 'top'] reuses the same query.
export function BootPrefetch() {
  const client = useQueryClient();

  useEffect(() => {
    client.prefetchQuery({
      queryKey: ['storyIds', 'top'],
      queryFn: ({ signal }) => getStoryIds('top', signal),
    });
  }, [client]);

  return null;
}
