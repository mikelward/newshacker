import { useEffect } from 'react';

// Sets `document.title` while the calling component is mounted, then
// restores the previous title on unmount. Pass `null`/`undefined` to
// leave the title alone (e.g. while data is still loading) — the hook
// is a no-op until something concrete to render arrives, so a brief
// "loading…" flash on the way to the real title never reaches the
// browser tab.
//
// The restore-on-unmount step matters because `document.title` is
// global; without it a Thread that set the tab title would leak the
// last story's title onto whatever route the user navigates to next.
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title == null || title === '') return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
