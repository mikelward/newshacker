import { useCallback } from 'react';
import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';

export function useInternalLinkClick() {
  const navigate = useNavigate();
  return useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest('a');
      if (!anchor) return;
      const anchorTarget = anchor.getAttribute('target');
      if (anchorTarget && anchorTarget !== '_self') return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      // Only intercept same-origin absolute paths we produced via rewriteHnHref.
      if (!href.startsWith('/') || href.startsWith('//')) return;
      e.preventDefault();
      navigate(href);
    },
    [navigate],
  );
}
