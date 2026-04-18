import { useCallback } from 'react';
import type { HNItem } from '../lib/hn';
import { buildSharePayload, shareOrCopy } from '../lib/share';
import { useToast } from './useToast';

export function useShareStory() {
  const { showToast } = useToast();

  return useCallback(
    async (story: HNItem) => {
      if (typeof window === 'undefined') return;
      const payload = buildSharePayload(story, window.location.origin);
      const nav = window.navigator;
      const canShare =
        typeof nav !== 'undefined' && typeof nav.share === 'function';
      const canCopy =
        typeof nav !== 'undefined' &&
        typeof nav.clipboard?.writeText === 'function';

      const result = await shareOrCopy(payload, {
        share: canShare ? (data) => nav.share(data) : undefined,
        copy: canCopy ? (text) => nav.clipboard.writeText(text) : undefined,
      });

      if (result === 'copied') {
        showToast({ message: 'Link copied' });
      } else if (result === 'unavailable') {
        showToast({ message: 'Sharing not available' });
      }
    },
    [showToast],
  );
}
