import { describe, expect, it } from 'vitest';

// Raw-CSS guards for the list toolbar's sticky pin (SPEC §
// List toolbar). jsdom doesn't reliably evaluate `position: sticky`
// against a real scroll container, so this is the most stable way
// to stop the rule from silently regressing back to static flow —
// which would let the toolbar (and its Sweep button) scroll out of
// reach on long lists.

async function readCss(relPath: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, relPath), 'utf8');
}

describe('list toolbar sticky invariants', () => {
  it('pins .list-toolbar sticky to top: var(--app-header-height)', async () => {
    const css = await readCss('./ListToolbar.css');
    expect(css).toMatch(
      /\.list-toolbar\s*\{[^}]*position:\s*sticky[^}]*top:\s*var\(--app-header-height\)/s,
    );
  });

  it('keeps .list-toolbar below the sticky <AppHeader> in the stacking order', async () => {
    const toolbarCss = await readCss('./ListToolbar.css');
    const headerCss = await readCss('./AppHeader.css');
    const toolbarZ = toolbarCss.match(
      /\.list-toolbar\s*\{[^}]*z-index:\s*(\d+)/s,
    );
    const headerZ = headerCss.match(/\.app-header\s*\{[^}]*z-index:\s*(\d+)/s);
    expect(toolbarZ).not.toBeNull();
    expect(headerZ).not.toBeNull();
    expect(Number(toolbarZ![1])).toBeLessThan(Number(headerZ![1]));
  });

  it('exposes --app-header-height on :root in global.css', async () => {
    const css = await readCss('../styles/global.css');
    expect(css).toMatch(/--app-header-height:\s*\d+px/);
  });
});
