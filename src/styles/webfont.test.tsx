import { describe, it, expect } from 'vitest';

// Guards for the self-hosted Roboto webfont. The bundling is purely
// declarative — a side-effect import in main.tsx plus a CSS token — so
// there's no runtime logic to exercise; these raw-source checks are what
// stop the wiring from silently regressing to system-only fonts.

async function readSource(relPath: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, relPath), 'utf8');
}

describe('bundled Roboto webfont', () => {
  it('defines --font as Roboto Variable with the system stack as fallback', async () => {
    const css = await readSource('./global.css');
    expect(css).toMatch(
      /--font:\s*'Roboto Variable',\s*var\(--font-system\)/,
    );
  });

  it('applies --font to the body', async () => {
    const css = await readSource('./global.css');
    expect(css).toMatch(/body\s*\{[^}]*font-family:\s*var\(--font\)/s);
  });

  it("imports Fontsource's variable Roboto in main.tsx", async () => {
    const main = await readSource('../main.tsx');
    expect(main).toMatch(
      /import\s+'@fontsource-variable\/roboto\/wght\.css'/,
    );
  });
});
