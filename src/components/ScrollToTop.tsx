import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Scrolls to the top of the page on forward (PUSH/REPLACE) navigation.
// POP (browser back/forward) is left alone so the browser's native scroll
// restoration keeps working.
export function ScrollToTop() {
  // `key` changes on every navigation entry — unlike `pathname`, it
  // also covers a PUSH to the page you're already on (same pathname,
  // new history entry), which must still scroll to top.
  const { key } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType === 'POP') return;
    window.scrollTo(0, 0);
  }, [key, navigationType]);

  return null;
}
