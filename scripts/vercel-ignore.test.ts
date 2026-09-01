// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { classify, isDocs, parsePolicy } from './vercel-ignore.mjs';

// The end-to-end cases run the REAL script inside a real git clone, shaped the
// way Vercel's is (shallow, script and policy present), and assert the exit
// code — the only thing Vercel reads. Its failure mode is a false pass: a
// script that always exits 1 is indistinguishable from a working one unless
// something asserts the skip actually happens, so every case asserts which of
// the two answers came back, never just "it ran".
//
// exit 0 = Vercel skips the build, exit 1 = Vercel builds.
const SKIP = 0;
const BUILD = 1;

const SCRIPT = new URL('./vercel-ignore.mjs', import.meta.url).pathname;
const POLICY = new URL('../.github/lanes.conf', import.meta.url).pathname;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Write a repo-relative file, creating parents. */
function write(repo: string, file: string, body: string) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), body);
}

/**
 * A repository carrying this repo's real script and real policy, plus one
 * commit per entry in `commits` (each a list of files to touch).
 * Returns the SHAs in order.
 */
function fixture(commits: string[][], { policy }: { policy?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vercel-ignore-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);

  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');

  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(SCRIPT, join(repo, 'scripts/vercel-ignore.mjs'));
  write(repo, '.github/lanes.conf', policy ?? readFileSync(POLICY, 'utf8'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'base');

  const shas = [git(repo, 'rev-parse', 'HEAD')];
  for (const [i, files] of commits.entries()) {
    for (const file of files) write(repo, file, `change ${i}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', `commit ${i}`);
    shas.push(git(repo, 'rev-parse', 'HEAD'));
  }
  return { root, repo, shas };
}

/** Run the real script the way Vercel does, and return its exit code. */
function run(repo: string, env: Record<string, string | undefined>) {
  const result = spawnSync('node', [join(repo, 'scripts/vercel-ignore.mjs')], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('the policy is read, not restated', () => {
  const policy = readFileSync(POLICY, 'utf8');
  const { rules, unknown } = parsePolicy(policy);

  it('finds this repo\'s real lane rules', () => {
    // Asserting the parse found something first: every classification below is
    // derived from these rules, and an empty list would make them all vacuous.
    expect(unknown).toEqual([]);
    expect(rules.length).toBeGreaterThan(0);
  });

  it.each([
    ['AGENTS.md', true],
    ['README.md', true],
    ['CRON.md', true],
    ['docs/SETUP.md', true],
    ['docs/deep/nested/note.md', true],
    ['reports/2026/note.md', true],
    ['src/App.tsx', false],
    ['src/components/README.md', false],
    ['api/handler.ts', false],
    ['public/manifest.json', false],
    ['docs/diagram.png', false],
    ['.gitignore', false],
    ['package.json', false],
    ['.github/workflows/ci.yml', false],
    ['.github/lanes.conf', false],
  ])('%s is documentation: %s', (file, expected) => {
    expect(isDocs(file, rules)).toBe(expected);
  });

  it('refuses a policy carrying a directive it does not know', () => {
    const verdict = classify(['AGENTS.md'], 'docs *.md\nnew-directive whatever\n');
    expect(verdict.docsOnly).toBe(false);
    expect(verdict.reason).toContain('new-directive');
  });

  it('refuses a policy with no lane rules at all', () => {
    expect(classify(['AGENTS.md'], 'lint-title no\n').docsOnly).toBe(false);
  });

  it('refuses an empty diff rather than reading it as nothing to deploy', () => {
    expect(classify([], readFileSync(POLICY, 'utf8')).docsOnly).toBe(false);
  });
});

describe('deciding from a real clone', () => {
  it('skips a docs-only range', () => {
    const { repo, shas } = fixture([['AGENTS.md'], ['docs/SETUP.md']]);
    const { code, out } = run(repo, {
      VERCEL_GIT_PREVIOUS_SHA: shas[0],
      VERCEL_GIT_COMMIT_SHA: shas[2],
    });
    expect(code).toBe(SKIP);
    expect(out).toContain('skipping');
  });

  it('builds when the range carries code', () => {
    const { repo, shas } = fixture([['src/App.tsx']]);
    expect(
      run(repo, { VERCEL_GIT_PREVIOUS_SHA: shas[0], VERCEL_GIT_COMMIT_SHA: shas[1] }).code,
    ).toBe(BUILD);
  });

  it('builds when the range mixes docs and code', () => {
    const { repo, shas } = fixture([['AGENTS.md', 'src/App.tsx']]);
    expect(
      run(repo, { VERCEL_GIT_PREVIOUS_SHA: shas[0], VERCEL_GIT_COMMIT_SHA: shas[1] }).code,
    ).toBe(BUILD);
  });

  // The reason the range is measured from the last deployment rather than
  // HEAD^: this repo rebase-merges, so one merge pushes every commit of a PR.
  it('builds when an earlier commit in the range carries code', () => {
    const { repo, shas } = fixture([['src/App.tsx'], ['AGENTS.md']]);
    const { code, out } = run(repo, {
      VERCEL_GIT_PREVIOUS_SHA: shas[0],
      VERCEL_GIT_COMMIT_SHA: shas[2],
    });
    expect(code).toBe(BUILD);
    expect(out).toContain('src/App.tsx');
  });

  it('builds when there is no previous deployment to measure from', () => {
    const { repo, shas } = fixture([['AGENTS.md']]);
    const { code, out } = run(repo, {
      VERCEL_GIT_PREVIOUS_SHA: '',
      VERCEL_GIT_COMMIT_SHA: shas[1],
    });
    expect(code).toBe(BUILD);
    expect(out).toContain('VERCEL_GIT_PREVIOUS_SHA');
  });

  it('builds when the previous SHA is outside the shallow clone', () => {
    const { repo, shas } = fixture([['AGENTS.md']]);
    const missing = 'a'.repeat(40);
    const { code, out } = run(repo, {
      VERCEL_GIT_PREVIOUS_SHA: missing,
      VERCEL_GIT_COMMIT_SHA: shas[1],
    });
    expect(code).toBe(BUILD);
    expect(out).toContain('cannot read');
    expect(out).toContain(missing);
  });

  // Every fail-open path builds either way, so the reason string is the only
  // diagnostic. Without the underlying failure traveling with it, a broken
  // checkout reads exactly like the expected shallow-clone miss.
  it('names the underlying failure when git itself cannot answer', () => {
    const { repo } = fixture([['AGENTS.md']]);
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    const { code, out } = run(repo, {
      VERCEL_GIT_PREVIOUS_SHA: 'a'.repeat(40),
      VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40),
    });
    expect(code).toBe(BUILD);
    expect(out).toMatch(/not a git repository/i);
  });

  it('names the underlying failure when the policy cannot be read', () => {
    const { repo, shas } = fixture([['AGENTS.md']]);
    rmSync(join(repo, '.github/lanes.conf'));
    mkdirSync(join(repo, '.github/lanes.conf'));
    const { code, out } = run(repo, {
      VERCEL_GIT_PREVIOUS_SHA: shas[0],
      VERCEL_GIT_COMMIT_SHA: shas[1],
    });
    expect(code).toBe(BUILD);
    expect(out).toContain('unreadable');
    expect(out).toMatch(/EISDIR|illegal operation/i);
  });

  it('builds when the policy file itself changed', () => {
    const { repo, shas } = fixture([['.github/lanes.conf']]);
    expect(
      run(repo, { VERCEL_GIT_PREVIOUS_SHA: shas[0], VERCEL_GIT_COMMIT_SHA: shas[1] }).code,
    ).toBe(BUILD);
  });
});
