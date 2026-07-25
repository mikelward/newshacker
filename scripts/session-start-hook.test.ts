// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Regression guard for .claude/hooks/session-start.sh.
//
// The hook exists to stop web sessions running on a different Node major than
// CI and the deployed build. Its failure mode is a FALSE PASS — the suite goes green on the
// wrong runtime — so a broken hook is invisible without a test that asserts on
// which toolchain actually gets selected. It has already regressed once: the
// original existence-only cache check pinned the first version ever installed.
//
// The hook takes two test seams, SESSION_NODE_ROOT and SESSION_NODE_DIST_URL,
// so these cases run against a temp install root and a file:// release fixture
// instead of /opt and nodejs.org. Nothing here touches the network.

const HOOK = new URL('../.claude/hooks/session-start.sh', import.meta.url).pathname;

// Mirrors the hook's own `uname -m` mapping. Hard-coding x64 here would make
// every provisioning case fail on an ARM64 runner or an Apple Silicon dev box,
// because the hook would request a linux-arm64 tarball the fixture never built.
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

const LATEST = 'v24.18.0';
const OLDER = 'v24.9.0';
const MAJOR = '24';

let work: string;
let projectDir: string;
let nodeRoot: string;
let distDir: string;
let envFile: string;

/** A stand-in node/npm pair, so the hook can run end to end without a real
 *  ~50MB toolchain. Handles only the invocations the hook actually makes. */
function writeFakeToolchain(binDir: string, version: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'node'),
    // `-p` answers the hook's `node -p 'process.versions.node'`, so it reports
    // the full version the real binary would. It used to return only the major,
    // which was enough when the hook compared majors — once the hook started
    // checking the engines floor too, a fixture reporting "24" would sort below
    // any "24.x.y" floor and warn on every provisioning case.
    `#!/bin/sh
case "$1" in
  -v|--version) echo "${version}" ;;
  -p) echo "${version.replace(/^v/, '')}" ;;
  *) exit 0 ;;
esac
`,
  );
  writeFileSync(
    join(binDir, 'npm'),
    `#!/bin/sh
case "$1" in
  -v|--version) echo "11.0.0" ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(join(binDir, 'node'), 0o755);
  chmodSync(join(binDir, 'npm'), 0o755);
}

/** Build a nodejs.org-shaped release fixture: an index.json plus a real
 *  .tar.xz laid out exactly as the hook expects to extract it. */
function writeDistFixture(
  versions: string[],
  tarballFor: string | null,
  /** Build the tarball around a binary that unpacks but won't run — the shape
   *  of a wrong-arch or subtly truncated archive, which tar still exits 0 on. */
  opts: { brokenBinary?: boolean } = {},
): void {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, 'index.json'),
    JSON.stringify(versions.map((version) => ({ version, lts: 'Krypton' }))),
  );
  if (!tarballFor) return;
  const dirName = `node-${tarballFor}-linux-${ARCH}`;
  const staging = join(work, 'staging');
  rmSync(staging, { recursive: true, force: true });
  writeFakeToolchain(join(staging, dirName, 'bin'), tarballFor);
  if (opts.brokenBinary) {
    const binary = join(staging, dirName, 'bin', 'node');
    writeFileSync(binary, '#!/bin/sh\nexit 1\n');
    chmodSync(binary, 0o755);
  }
  mkdirSync(join(distDir, tarballFor), { recursive: true });
  execFileSync('tar', ['-cJf', join(distDir, tarballFor, `${dirName}.tar.xz`), '-C', staging, dirName]);
}

interface RunResult {
  stdout: string;
  status: number;
}

function runHook(env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync('bash', [HOOK], {
      encoding: 'utf-8',
      // stderr is where the hook puts its warnings; fold it in so cases can
      // assert on them.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CLAUDE_CODE_REMOTE: 'true',
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_ENV_FILE: envFile,
        SESSION_NODE_ROOT: nodeRoot,
        SESSION_NODE_DIST_URL: `file://${distDir}`,
        ...env,
      },
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`, status: e.status ?? 1 };
  }
}

// execFileSync only captures stdout on success, so run through a wrapper that
// merges both streams into stdout for assertion purposes.
function runHookCapturingAll(env: Record<string, string> = {}): string {
  const merged = execFileSync(
    'bash',
    ['-c', `bash "${HOOK}" 2>&1`],
    {
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CLAUDE_CODE_REMOTE: 'true',
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_ENV_FILE: envFile,
        SESSION_NODE_ROOT: nodeRoot,
        SESSION_NODE_DIST_URL: `file://${distDir}`,
        ...env,
      },
    },
  );
  return merged;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'session-hook-'));
  projectDir = join(work, 'project');
  nodeRoot = join(work, 'opt');
  distDir = join(work, 'dist');
  envFile = join(work, 'env.sh');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(nodeRoot, { recursive: true });
  // A minimal project: the hook reads .nvmrc, and `npm install` at the end is
  // satisfied by the fake npm on PATH once provisioning succeeds.
  writeFileSync(join(projectDir, '.nvmrc'), `${MAJOR}\n`);
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', engines: { node: '^24.11.0' } }),
  );
  writeFileSync(envFile, '');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('session-start hook: Node provisioning', () => {
  it('provisions the pinned major on a cold container and persists it to PATH', () => {
    writeDistFixture([LATEST, OLDER], LATEST);

    const out = runHookCapturingAll();

    expect(out).toContain(`provisioned Node ${LATEST}`);
    expect(existsSync(join(nodeRoot, `node${MAJOR}`, 'bin', 'node'))).toBe(true);
    // The whole point: the session inherits it.
    expect(readFileSync(envFile, 'utf-8')).toContain(join(nodeRoot, `node${MAJOR}`, 'bin'));
  });

  it('reuses a cache that already matches the latest release', () => {
    writeDistFixture([LATEST], LATEST);
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, LATEST);
    // A sentinel that only survives if the directory is left alone.
    const sentinel = join(nodeRoot, `node${MAJOR}`, 'SENTINEL');
    writeFileSync(sentinel, 'keep');

    const out = runHookCapturingAll();

    expect(out).not.toContain('provisioned Node');
    expect(existsSync(sentinel)).toBe(true);
  });

  // The regression this test file exists for: an existence-only check accepted
  // a stale cache forever, so web sessions drifted behind CI silently.
  it('replaces a cached toolchain that is behind the latest release', () => {
    writeDistFixture([LATEST, OLDER], LATEST);
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, OLDER);
    const sentinel = join(nodeRoot, `node${MAJOR}`, 'SENTINEL');
    writeFileSync(sentinel, 'should be swept');

    const out = runHookCapturingAll();

    expect(out).toContain(`provisioned Node ${LATEST}`);
    expect(out).toContain(`replacing ${OLDER}`);
    // Swapped wholesale, not merged over the top of the old install.
    expect(existsSync(sentinel)).toBe(false);
  });

  it('keeps the cached toolchain when the download fails', () => {
    // Index advertises a release whose tarball is absent — a mid-flight failure.
    writeDistFixture([LATEST], null);
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, OLDER);

    const out = runHookCapturingAll();

    expect(out).toContain(`failed to fetch Node ${LATEST}`);
    expect(out).toContain(`keeping cached ${OLDER}`);
    // Fails open: the cache is intact and still on PATH rather than half-wiped.
    expect(existsSync(join(cacheBin, 'node'))).toBe(true);
    expect(readFileSync(envFile, 'utf-8')).toContain(cacheBin);
  });

  it('falls back to the cached toolchain when the release index is unreachable', () => {
    // No fixture at all — stands in for an offline container.
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, LATEST);

    const out = runHookCapturingAll();

    expect(out).toContain(`could not resolve latest Node ${MAJOR}.x`);
    expect(out).toContain(`keeping cached ${LATEST}`);
    expect(readFileSync(envFile, 'utf-8')).toContain(cacheBin);
  });

  it('warns when the active major does not match the pin', () => {
    // Nothing provisionable and nothing cached, so the hook falls through to
    // the system node — which is not the pinned major in this fixture.
    writeFileSync(join(projectDir, '.nvmrc'), '99\n');

    const out = runHookCapturingAll();

    expect(out).toMatch(/WARNING active Node is \d+\.x but this repo pins 99\.x/);
  });

  it('keeps the cache when the extracted toolchain does not run', () => {
    // tar exiting 0 means the archive unpacked, not that the result works — a
    // wrong-arch tarball gets this far. The swap is destructive, so publishing
    // it would trade a working cache for one that cannot run npm.
    writeDistFixture([LATEST], LATEST, { brokenBinary: true });
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, OLDER);

    const out = runHookCapturingAll();

    expect(out).not.toContain(`provisioned Node ${LATEST}`);
    expect(out).toContain(`keeping cached ${OLDER}`);
    expect(readFileSync(envFile, 'utf-8')).toContain(cacheBin);
  });

  it('warns when the active version is below the engines floor', () => {
    // The case the major check cannot see, and the one that actually bit:
    // right major, below a raised minor floor. npm reports it only as an
    // EBADENGINE warning, which is easy to miss in install output.
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', engines: { node: '^24.99.0' } }),
    );
    writeDistFixture([LATEST], LATEST);

    const out = runHookCapturingAll();

    expect(out).toContain(`provisioned Node ${LATEST}`);
    expect(out).toContain('below the 24.99.0 floor in engines');
  });

  it('does not warn when the active version satisfies the engines floor', () => {
    // The floor is derived by string comparison, so the ordering has to be
    // right in both directions — a check that always warns is no check at all.
    writeDistFixture([LATEST], LATEST);

    const out = runHookCapturingAll();

    expect(out).toContain(`provisioned Node ${LATEST}`);
    expect(out).not.toContain('floor in engines');
    expect(out).not.toContain('WARNING');
  });

  it('is a no-op outside Claude Code on the web', () => {
    writeDistFixture([LATEST], LATEST);

    const res = runHook({ CLAUDE_CODE_REMOTE: 'false' });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
    expect(existsSync(join(nodeRoot, `node${MAJOR}`))).toBe(false);
    expect(readFileSync(envFile, 'utf-8')).toBe('');
  });
});
