// @vitest-environment node
// Regression guard for a Vercel-deploy-time failure mode that has
// bitten this repo twice.
//
// The failure: handlers that `import` from either (a) a `_`-prefixed
// subdirectory inside `api/` or (b) an arbitrary path outside `api/`
// pass every local check (`npm test`, `lint`, `typecheck`, `build`)
// and then blow up at runtime on Vercel with
//
//     Error [ERR_MODULE_NOT_FOUND]:
//     Cannot find module '/var/task/api/_lib/hnFetch' imported from
//     /var/task/api/items.js
//
// Vercel's function bundler drops underscore-prefixed paths from the
// Lambda bundle, and its import tracer has historically been flaky
// about pulling in files from outside `api/`.
//
// The current (2026-04) accepted pattern is a narrow exception:
// handlers may import from `../lib/api/*` (a single top-level
// `lib/api/` directory), with `vercel.json` listing
// `functions["api/*.ts"].includeFiles = "lib/api/**"` so Vercel's
// bundler is forcibly told to ship those files into each Lambda.
// Any other relative import that walks up or into a subdirectory is
// still banned.
//
// See AGENTS.md § "Vercel `api/` gotchas" for the full rationale.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API_DIR = dirname(fileURLToPath(import.meta.url));

function handlerFiles(): string[] {
  return readdirSync(API_DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
}

// Matches both `import … from '…';` and `export … from '…';`, for
// static and dynamic forms. Not a full parser — we only care about
// the path literal. Good enough for our hand-written source.
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importPaths(source: string): string[] {
  const paths: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) paths.push(match[1]);
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) paths.push(match[1]);
  return paths;
}

// The one allowed escape hatch: `../lib/api/<file>`. Anything deeper
// (`../lib/api/sub/file`) or anywhere else is still rejected.
const ALLOWED_RE = /^\.\.\/lib\/api\/[^/]+$/;

function isDisallowedRelativeImport(p: string): boolean {
  if (!p.startsWith('.')) return false; // bare (npm) import — fine
  if (ALLOWED_RE.test(p)) return false; // the documented escape hatch
  if (p.startsWith('../')) return true; // escapes api/ to somewhere else
  // `./foo/bar` is a subdirectory (including `./_lib/foo`); `./foo` is a
  // sibling file in api/ and is fine.
  const rest = p.slice(2);
  return rest.includes('/');
}

describe('api handler imports', () => {
  it('handlers only import from siblings, npm, or ../lib/api/*', () => {
    const offenders: { file: string; bad: string[] }[] = [];
    for (const file of handlerFiles()) {
      const source = readFileSync(join(API_DIR, file), 'utf8');
      const bad = importPaths(source).filter(isDisallowedRelativeImport);
      if (bad.length > 0) offenders.push({ file, bad });
    }
    expect(
      offenders,
      `api/ handlers may only import from sibling files, npm packages, or ` +
        `the narrow \`../lib/api/<file>\` escape hatch. Vercel's function ` +
        `bundler drops underscore-prefixed paths and traces other ` +
        `outside-api/ imports inconsistently — see AGENTS.md § "Vercel ` +
        `api/ gotchas". Offenders:\n` +
        offenders
          .map((o) => `  ${o.file}: ${o.bad.join(', ')}`)
          .join('\n'),
    ).toEqual([]);
  });

  // Self-tests for the detector logic, so that a future refactor can't
  // weaken the regex and have the top-level test silently start
  // returning "all clear" on an empty offender set.
  it('rejects imports from _lib (the specific failure mode)', () => {
    expect(isDisallowedRelativeImport('./_lib/session')).toBe(true);
    expect(isDisallowedRelativeImport('./_lib/hnFetch')).toBe(true);
  });

  it('rejects imports from a non-underscore subdirectory of api/', () => {
    expect(isDisallowedRelativeImport('./lib/session')).toBe(true);
    expect(isDisallowedRelativeImport('./helpers/cookie')).toBe(true);
  });

  it('rejects imports from outside api/ other than ../lib/api/*', () => {
    expect(isDisallowedRelativeImport('../src/lib/session')).toBe(true);
    expect(isDisallowedRelativeImport('../lib/session')).toBe(true);
    expect(isDisallowedRelativeImport('../lib/api/sub/session')).toBe(true);
    expect(isDisallowedRelativeImport('../../lib/api/session')).toBe(true);
  });

  it('allows the ../lib/api/<file> escape hatch', () => {
    expect(isDisallowedRelativeImport('../lib/api/session')).toBe(false);
    expect(isDisallowedRelativeImport('../lib/api/http')).toBe(false);
  });

  it('allows sibling files in api/ and bare npm imports', () => {
    expect(isDisallowedRelativeImport('./login')).toBe(false);
    expect(isDisallowedRelativeImport('./sync')).toBe(false);
    expect(isDisallowedRelativeImport('@upstash/redis')).toBe(false);
    expect(isDisallowedRelativeImport('node:fs')).toBe(false);
  });

  it('picks up all the import syntaxes the guard relies on', () => {
    const source = [
      `import foo from './_lib/a';`,
      `import { bar } from "./sub/b";`,
      `export { baz } from '../c';`,
      `const m = await import('./_lib/d');`,
      `import ok from '../lib/api/session';`,
      `import './ok-sibling';`, // no `from` — no path captured by our regex
    ].join('\n');
    const bad = importPaths(source).filter(isDisallowedRelativeImport);
    // The four disallowed paths survive; the allowed `../lib/api/session`
    // is filtered out. The bare side-effect import is not captured, which
    // is fine — it's almost never used in this codebase, and adding it
    // would require a second regex for marginal benefit.
    expect(bad).toEqual([
      './_lib/a',
      './sub/b',
      '../c',
      './_lib/d',
    ]);
  });
});
