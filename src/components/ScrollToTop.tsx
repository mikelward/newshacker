import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Scrolls to the top of the page on forward (PUSH/REPLACE) navigation.
// POP (browser back/forward) is left alone so the browser's native scroll
// restoration keeps working.
export function ScrollToTop() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType === 'POP') return;
    window.scrollTo(0, 0);
  }, [pathname, navigationType]);

  return null;
}
