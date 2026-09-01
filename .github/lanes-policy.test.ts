// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDocs, parsePolicy } from '../scripts/vercel-ignore.mjs';

// Tests for this repository's lane policy, .github/lanes.conf.
//
// The engine (mikelward/lanes) is tested in its own repository; what it
// cannot test is THIS repo's policy, and the policy's failure mode is the
// quiet one: a broadened rule makes classify and gate derive the same wrong
// docs verdict, so the build skips under a green required check. So the
// rules are exercised here, both directions, with `path.matchesGlob` — the
// same standard primitive the engine matches with, so this suite cannot
// drift from the engine on glob semantics. The tiny reader below follows the
// policy format the lanes README documents (ordered rules, full-line and
// trailing comments, first match wins, no rule means code); if the engine
// ever refuses a shape this reader accepts, the gate goes red rather than
// green, which is the safe direction for a disagreement.

const text = readFileSync(fileURLToPath(new URL('./lanes.conf', import.meta.url)), 'utf8');

const lines = text
  .split('\n')
  .map((line) => {
    const comment = line.search(/\s#/);
    return (comment === -1 ? line : line.slice(0, comment)).trim();
  })
  .filter((line) => line && !line.startsWith('#'));

const rules: { verdict: string; pattern: string }[] = [];
const directives: Record<string, string[]> = {};
for (const line of lines) {
  const [word, ...rest] = line.split(/\s+/);
  if (word === 'docs' || word === 'code') rules.push({ verdict: word, pattern: rest.join(' ') });
  else directives[word] = rest;
}

const classify = (path: string): string => {
  for (const { verdict, pattern } of rules) {
    if (matchesGlob(path, pattern)) return verdict;
  }
  return 'code';
};

describe('the lane policy', () => {
  it('parses to the intended shape, nothing wider', () => {
    // A rule this suite has not vetted is a rule nothing here exercises.
    expect(rules).toEqual([
      { verdict: 'code', pattern: 'src/**' },
      { verdict: 'code', pattern: 'api/**' },
      { verdict: 'code', pattern: 'public/**' },
      { verdict: 'docs', pattern: '*.md' },
      { verdict: 'docs', pattern: 'docs/**/*.md' },
      { verdict: 'docs', pattern: 'reports/**/*.md' },
    ]);
    // The WHOLE directives object, not per-key reads: a newly added directive
    // changes classify/gate behavior, so an unexpected key fails here rather
    // than passing unexamined.
    expect(directives).toEqual({
      prefixes: ['deps', 'docs', 'todo', 'test', 'build', 'refactor'],
      // A push to main is classified from the range it added, not taken as
      // code by default. Dropping this makes every docs-only merge run the
      // full suite again, and — since scripts/vercel-ignore.mjs reads the
      // same file — deploy again.
      push: ['classify'],
      'dispatch-without-pr': ['refuse'],
      'lint-title': ['no'],
    });
  });

  it('classifies root markdown and the prose trees as docs', () => {
    for (const path of [
      'README.md',
      'SPEC.md',
      'TODO.md',
      'CRON.md',
      'reports/notes.md',
      'docs/notes.md',
      // Both tree rules use `**`, so each reaches every depth below its own
      // directory. Writing either `docs/*.md` would strand these on code.
      'docs/a/b/deep.md',
      'reports/2026/deep.md',
    ]) {
      expect(classify(path), path).toBe('docs');
    }
  });

  it('does not treat markdown as docs merely for its extension', () => {
    // The narrowed rules replaced a bare `**/*.md`, which made a markdown
    // file documentation at ANY depth. Being documentation is now a matter
    // of where a file lives: the root, or a named prose tree. Markdown
    // anywhere else can sit beside code or config that CI validates, so it
    // stays on the code lane. None of these paths exists today, which is the
    // point -- the rule has to hold for a tree nobody has added yet.
    for (const path of ['scripts/README.md', 'a/b/notes.md', 'notdocs/README.md']) {
      expect(classify(path), path).toBe('code');
    }
  });

  it('classifies every shipped tree as code, markdown included', () => {
    // The shipped trees are build inputs whatever the extension: Vite can
    // import any file, api/ deploys as functions, public/ ships verbatim.
    for (const path of ['src/App.tsx', 'src/notes.md', 'api/items.ts', 'api/README.md', 'public/manifest.webmanifest']) {
      expect(classify(path), path).toBe('code');
    }
  });

  // Vercel deploys outside GitHub Actions, so scripts/vercel-ignore.mjs is a
  // second reader of this same policy file — the deployment's half of the
  // lane. Two readers can agree with the policy and still disagree with each
  // other on a path neither was asked about, and that disagreement is exactly
  // a docs-only merge that skips CI but deploys anyway (or the reverse). So
  // every path this suite classifies is put to the script's reader too, and
  // the two must answer the same.
  it('agrees with the Vercel ignore step on every path above', () => {
    const { rules: scriptRules, unknown } = parsePolicy(text);
    expect(unknown).toEqual([]);
    expect(scriptRules).toEqual(rules);

    for (const path of [
      'README.md',
      'AGENTS.md',
      'SPEC.md',
      'CRON.md',
      'docs/notes.md',
      'docs/a/b/deep.md',
      'reports/notes.md',
      'reports/2026/deep.md',
      'scripts/README.md',
      'src/App.tsx',
      'src/notes.md',
      'api/items.ts',
      'api/README.md',
      'public/manifest.webmanifest',
      'package.json',
      'vite.config.ts',
      '.github/workflows/ci.yml',
      '.github/lanes.conf',
      '.gitignore',
    ]) {
      expect(isDocs(path, scriptRules), path).toBe(classify(path) === 'docs');
    }
  });

  it('classifies everything else that can change a build as code', () => {
    for (const path of [
      'package.json',
      'vite.config.ts',
      '.github/workflows/ci.yml',
      '.github/lanes.conf',
      '.gitignore',
    ]) {
      expect(classify(path), path).toBe('code');
    }
  });
});
