// Regression guard for a bug that only surfaces at Vercel deploy time.
//
// On at least two occasions, a refactor has tried to de-duplicate
// helpers that are copy-pasted across `api/*.ts` (session cookie
// parsing, referer allowlist, HN item fetch) by pulling them into
// either (a) a module outside `api/` or (b) a `_`-prefixed
// subdirectory inside `api/`. Both pass `npm test`, `lint`,
// `typecheck`, and `build` — and both fail at runtime on Vercel with
//
//     Error [ERR_MODULE_NOT_FOUND]:
//     Cannot find module '/var/task/api/_lib/hnFetch' imported from
//     /var/task/api/items.js
//
// Vercel's function bundler excludes underscore-prefixed paths from
// the Lambda bundle, and its import tracer has been flaky about
// pulling in files from outside `api/`. The accepted pattern is to
// inline the duplication and leave a breadcrumb comment.
//
// This test scans every `api/*.ts` file and fails if it contains a
// relative import that either (a) walks up a directory (`../…`) or
// (b) walks into a subdirectory of `api/` (`./foo/…`). See AGENTS.md
// § "Vercel `api/` gotchas" for the full rationale.

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

function isDisallowedRelativeImport(p: string): boolean {
  if (!p.startsWith('.')) return false; // bare (npm) import — fine
  if (p.startsWith('../')) return true; // escapes api/
  // `./foo/bar` is a subdirectory (including `./_lib/foo`); `./foo` is a
  // sibling file in api/ and is fine.
  const rest = p.slice(2);
  return rest.includes('/');
}

describe('api handler imports', () => {
  it('no handler imports from a subdirectory of api/ or from outside api/', () => {
    const offenders: { file: string; bad: string[] }[] = [];
    for (const file of handlerFiles()) {
      const source = readFileSync(join(API_DIR, file), 'utf8');
      const bad = importPaths(source).filter(isDisallowedRelativeImport);
      if (bad.length > 0) offenders.push({ file, bad });
    }
    expect(
      offenders,
      `api/ handlers must not import from subdirectories of api/ or from outside api/. ` +
        `Vercel's function bundler drops underscore-prefixed paths and traces ` +
        `outside-api/ imports inconsistently — see AGENTS.md § "Vercel api/ gotchas". ` +
        `Offenders:\n` +
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

  it('rejects imports from a non-underscore subdirectory', () => {
    expect(isDisallowedRelativeImport('./lib/session')).toBe(true);
    expect(isDisallowedRelativeImport('./helpers/cookie')).toBe(true);
  });

  it('rejects imports from outside api/', () => {
    expect(isDisallowedRelativeImport('../src/lib/session')).toBe(true);
    expect(isDisallowedRelativeImport('../lib/session')).toBe(true);
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
      `import './ok-sibling';`, // no `from` — no path captured by our regex
    ].join('\n');
    const bad = importPaths(source).filter(isDisallowedRelativeImport);
    // Four disallowed paths captured across the four `from`-having lines.
    // The bare side-effect import is not captured, which is fine — it's
    // almost never used in this codebase, and adding it would require a
    // second regex for marginal benefit.
    expect(bad).toEqual([
      './_lib/a',
      './sub/b',
      '../c',
      './_lib/d',
    ]);
  });
});
