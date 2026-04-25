import { describe, it, expect } from 'vitest';

// Raw-CSS guard for the per-chrome `--nh-orange` split (SPEC § Visual
// Design, AGENTS.md golden rule 4). The default `--nh-orange` shifted
// from `#ff6600` to the more accessible `#e65c00` for the mono / duo
// presets — the small orange logo tile dissolved into the cream banner
// at `#ff6600` (2.69:1 contrast). The Classic preset paints the *whole*
// banner orange with white text on top, where (a) the contrast pair is
// white-on-orange (not orange-on-cream) and (b) HN-fidelity is the
// whole reason someone opts in to Classic — so it explicitly restores
// the original `#ff6600` (and its `--nh-orange-dark: #e65c00` companion
// for the login button's hover/active state). If those overrides go
// missing from chromePreview.css, Classic silently regresses to the
// new accessible orange and stops looking like HN's actual header.

async function readCss(relPath: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, relPath), 'utf8');
}

describe('chrome variable invariants', () => {
  it('default --nh-orange is the accessible burnt orange #e65c00', async () => {
    const css = await readCss('./global.css');
    expect(css).toMatch(/:root\s*\{[^}]*--nh-orange:\s*#e65c00/s);
    expect(css).toMatch(/:root\s*\{[^}]*--nh-orange-dark:\s*#c44e00/s);
  });

  it('Classic preset restores the original HN orange #ff6600', async () => {
    const css = await readCss('./chromePreview.css');
    expect(css).toMatch(
      /:root\[data-chrome=['"]classic['"]\]\s*\{[^}]*--nh-orange:\s*#ff6600/s,
    );
    expect(css).toMatch(
      /:root\[data-chrome=['"]classic['"]\]\s*\{[^}]*--nh-orange-dark:\s*#e65c00/s,
    );
  });
});
