// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards the crawler-exclusion fix: AhrefsBot was crawling /api/summary?id=N
// across the HN id space, firing a paid Gemini generation per eligible id.
// robots.txt (obeyed by compliant crawlers) keeps bots out of /api/, and the
// SPA rewrite must let the static file through rather than serving index.html.
function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('robots.txt', () => {
  it('disallows crawlers from /api/', () => {
    const robots = read('./public/robots.txt');
    expect(robots).toMatch(/^User-agent:\s*\*/m);
    expect(robots).toMatch(/^Disallow:\s*\/api\//m);
  });

  it('is not swallowed by the SPA catch-all rewrite', () => {
    const vercel = JSON.parse(read('./vercel.json')) as {
      rewrites: { source: string; destination: string }[];
    };
    const spaFallback = vercel.rewrites.find(
      (r) => r.destination === '/index.html',
    );
    expect(spaFallback).toBeDefined();
    // The catch-all must exclude robots.txt (alongside api/ and assets/) so
    // Vercel serves the static file instead of the SPA shell.
    expect(spaFallback!.source).toContain('robots.txt');
    expect(spaFallback!.source).toContain('api/');
    expect(spaFallback!.source).toContain('assets/');
    // Sanity: the exclusion really is a negative lookahead, and robots.txt
    // does not match the resulting pattern (would otherwise rewrite to /).
    const re = new RegExp(`^${spaFallback!.source}$`);
    expect(re.test('/robots.txt')).toBe(false);
    expect(re.test('/item/123')).toBe(true);
  });
});
