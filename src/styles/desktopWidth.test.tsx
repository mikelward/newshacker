import { describe, it, expect } from 'vitest';

// Raw-CSS guards for the desktop reading-column widening (SPEC §
// Visual Design, TODO.md § Desktop layout). jsdom/happy-dom doesn't
// evaluate `@media (min-width: …)` against a real viewport, so this is
// the most reliable way to stop the two rules from silently drifting
// back to the phone-only layout.

async function readCss(relPath: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, relPath), 'utf8');
}

describe('desktop wider-column invariants', () => {
  it('bumps .app-main to 860px at min-width: 960px', async () => {
    const css = await readCss('./global.css');
    // Phone baseline is still 720px.
    expect(css).toMatch(/\.app-main\s*\{[^}]*max-width:\s*720px/s);
    // Desktop bump: @media (min-width: 960px) { .app-main { max-width: 860px } }
    expect(css).toMatch(
      /@media\s*\(min-width:\s*960px\)\s*\{\s*\.app-main\s*\{[^}]*max-width:\s*860px/s,
    );
  });
});
