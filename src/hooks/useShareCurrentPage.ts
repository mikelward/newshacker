import { useCallback } from 'react';
import { shareOrCopy, type SharePayload } from '../lib/share';
import { useToast } from './useToast';

// Shares the *current page* via the Web Share API, falling back to
// clipboard copy. Built on top of `shareOrCopy`, the same helper that
// powers `useShareStory` — the difference is that this hook reads the
// page's title + URL from `document` / `window.location` rather than
// taking an HN item, so it works on every route (feeds, library
// pages, about/help, etc.) without each page wiring up its own data.
//
// Per-page link previews (the part that makes shared links look nice
// in iMessage / Slack / Twitter) come from server-side Open Graph
// tags in api/og.ts — see also vercel.json's crawler-UA rewrite.
export function useShareCurrentPage() {
  const { showToast } = useToast();

  return useCallback(async () => {
    if (typeof window === 'undefined') return;
    const payload: SharePayload = {
      title: document.title || 'newshacker',
      text: document.title || 'newshacker',
      url: window.location.href,
    };
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
  }, [showToast]);
}
