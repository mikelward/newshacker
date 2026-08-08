// @vitest-environment node
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  rmSync,
  existsSync,
  chmodSync,
} from 'node:fs';
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
    // `-e` delegates to the real binary because the hook parses the release
    // index with it. A stub that swallowed `-e` would be fine while the fake
    // only ever sits in the install root, but the repoint case puts one on
    // PATH — and then "could not resolve latest Node" is what the hook reports,
    // for a reason that has nothing to do with the behavior under test.
    `#!/bin/sh
case "$1" in
  -v|--version) echo "${version}" ;;
  -p) echo "${version.replace(/^v/, '')}" ;;
  -e) shift; exec ${JSON.stringify(process.execPath)} -e "$@" ;;
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
  // A real Node tarball ships npx beside node and npm, and the hook links all
  // three when it has to fall back to symlinks — so leaving it out of the
  // fixture would make that case pass for the wrong reason.
  writeFileSync(join(binDir, 'npx'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(binDir, 'node'), 0o755);
  chmodSync(join(binDir, 'npm'), 0o755);
  chmodSync(join(binDir, 'npx'), 0o755);
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
function runHookCapturingAll(
  env: Record<string, string> = {},
  /** Variables to unset entirely — the harness always sets CLAUDE_ENV_FILE, so
   *  the unset case needs removal rather than an empty value. */
  omit: string[] = [],
): string {
  const merged = execFileSync(
    'bash',
    ['-c', `bash "${HOOK}" 2>&1`],
    {
      encoding: 'utf-8',
      env: Object.fromEntries(
        Object.entries({
          PATH: process.env.PATH ?? '',
          // HOME points into the fixture so nothing the hook does can touch the
          // developer's real home directory.
          HOME: work,
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_PROJECT_DIR: projectDir,
          CLAUDE_ENV_FILE: envFile,
          SESSION_NODE_ROOT: nodeRoot,
          SESSION_NODE_DIST_URL: `file://${distDir}`,
          ...env,
        }).filter(([key]) => !omit.includes(key)),
      ),
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

  it('reports a malformed release index distinctly from an outage', () => {
    // Both resolve to no version and both reach the same "could not resolve"
    // warning, so without its own line a parser regression — or a schema change
    // upstream — is indistinguishable from nodejs.org being down.
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.json'), '{"releases":');
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, LATEST);

    const out = runHookCapturingAll();

    expect(out).toContain('could not parse the Node release index');
    // Still fails open onto the cache, like every other failure here.
    expect(readFileSync(envFile, 'utf-8')).toContain(cacheBin);
  });

  it('does not report a parse error when the index is simply unreachable', () => {
    // The empty-stdin guard: JSON.parse('') throws too, so without it every
    // ordinary outage would also claim the index was malformed — reintroducing
    // the conflation from the other direction.
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, LATEST);

    const out = runHookCapturingAll();

    expect(out).toContain(`could not resolve latest Node ${MAJOR}.x`);
    expect(out).not.toContain('could not parse the Node release index');
  });

  it('does not activate a cached toolchain that fails its version probe', () => {
    // The cache is executable but unrunnable, and the replacement can't be
    // fetched (no dist fixture). The directory is still there and still passes
    // an `-x` test, so an executable-bit check would publish it — handing npm a
    // Node that cannot run, which fails the hook under `set -e` instead of
    // degrading to the system runtime like every other failure here does.
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    mkdirSync(cacheBin, { recursive: true });
    writeFileSync(join(cacheBin, 'node'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(cacheBin, 'node'), 0o755);

    const out = runHookCapturingAll();

    expect(readFileSync(envFile, 'utf-8')).not.toContain(cacheBin);
    expect(out).toContain('session-start: node ');
  });

  it('completes when CLAUDE_ENV_FILE is not set', () => {
    // CLAUDE_ENV_FILE is supplied by the harness, not guaranteed. Under
    // `set -u` an unguarded write to it aborts the hook mid-run — after the
    // Node provisioning but before `npm install` and the Deno section — so the
    // session ends up with neither dependencies nor an Edge runtime, and the
    // only clue is one "unbound variable" line.
    writeDistFixture([LATEST], LATEST);

    const out = runHookCapturingAll({}, ['CLAUDE_ENV_FILE']);

    expect(out).not.toContain('unbound variable');
    expect(out).toContain(`provisioned Node ${LATEST}`);
    // Printed by the shared Node block *after* the guarded write, so reaching
    // it proves the hook didn't abort there.
    expect(out).toContain('session-start: node ');
  });

  it('links the toolchain into PATH when CLAUDE_ENV_FILE is not set', () => {
    // The env file is the harness's seam and it is unset in the web sandbox
    // today, where the `export` reaches only the hook and its children — so
    // later agent shells ran the image's Node 22 against a repo pinned to 24,
    // and the suite went green on the wrong runtime with nothing to say so.
    //
    // An rc file cannot be the fallback: the harness snapshots the environment
    // before hooks run, so the edit lands a session late while looking like it
    // worked. A symlink in an earlier PATH directory wins the lookup for every
    // later shell instead, whatever that shell sources.
    writeDistFixture([LATEST], LATEST);
    const shimDir = join(work, '.local', 'bin');

    const out = runHookCapturingAll(
      { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
      ['CLAUDE_ENV_FILE'],
    );

    const provisioned = join(nodeRoot, `node${MAJOR}`, 'bin');
    // npm and npx come too, not just node: .npmrc's min-release-age cooldown
    // is silently ignored before npm 11.10.0, so a session left on the image's
    // npm resolves without the window and writes ranges CI then refuses.
    for (const tool of ['node', 'npm', 'npx']) {
      expect(realpathSync(join(shimDir, tool))).toBe(join(provisioned, tool));
    }
    expect(out).toContain(shimDir);
    expect(out).not.toContain('will not be on PATH');
  });

  it('warns rather than linking when PATH has no eligible directory under HOME', () => {
    // Only directories under $HOME are eligible — a system PATH entry belongs
    // to the image, not to us. With none of them on PATH there is nowhere safe
    // to link, and the session really does fall back to the image's Node, so
    // the warning has to survive: silence here is the exact failure the hook
    // exists to prevent.
    writeDistFixture([LATEST], LATEST);

    const out = runHookCapturingAll({}, ['CLAUDE_ENV_FILE']);

    expect(out).toContain('will not be on PATH');
    expect(existsSync(join(work, '.local', 'bin', 'node'))).toBe(false);
  });

  it('never replaces a real binary already sitting in the shim directory', () => {
    // A writable PATH directory can hold someone's own toolchain, and this
    // runs on every session. The refusal is checked across all three tools
    // before any link is written, so a blocked npm cannot leave a linked node
    // beside it — a half-applied set is a split toolchain, which is worse than
    // the fallback it was trying to fix.
    writeDistFixture([LATEST], LATEST);
    const shimDir = join(work, '.local', 'bin');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, 'npm'), '#!/bin/sh\necho real\n');

    const out = runHookCapturingAll(
      { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
      ['CLAUDE_ENV_FILE'],
    );

    expect(readFileSync(join(shimDir, 'npm'), 'utf-8')).toContain('echo real');
    expect(existsSync(join(shimDir, 'node'))).toBe(false);
    expect(out).toContain('is a real file');
  });

  it('repoints its own links on a later session rather than refusing', () => {
    // Container state survives between sessions, so from the second run on the
    // shim directory is itself what supplies `node` on the inherited PATH. An
    // implementation that stopped at whichever directory currently answers
    // would refuse to touch its own links: every later session would warn for
    // nothing, and a moved .nvmrc major would be provisioned correctly and
    // never reach a shell.
    writeDistFixture([LATEST], LATEST);
    const shimDir = join(work, '.local', 'bin');
    const stale = join(work, 'old-toolchain', 'bin');
    writeFakeToolchain(stale, OLDER);
    mkdirSync(shimDir, { recursive: true });
    for (const tool of ['node', 'npm', 'npx']) {
      symlinkSync(join(stale, tool), join(shimDir, tool));
    }

    const out = runHookCapturingAll(
      { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
      ['CLAUDE_ENV_FILE'],
    );

    const provisioned = join(nodeRoot, `node${MAJOR}`, 'bin');
    for (const tool of ['node', 'npm', 'npx']) {
      expect(realpathSync(join(shimDir, tool))).toBe(join(provisioned, tool));
    }
    expect(out).not.toContain('will not be on PATH');
  });

  it('refuses when an earlier PATH entry supplies one of the tools', () => {
    // node and npm need not come from the same directory, so a stop point
    // taken from node alone would link a set that stays split: the shim wins
    // for node while the earlier npm keeps winning for npm. Each tool is asked
    // about separately, against the PATH prefix ahead of the shim.
    writeDistFixture([LATEST], LATEST);
    const shimDir = join(work, '.local', 'bin');
    const earlier = mkdtempSync(join(tmpdir(), 'session-hook-early-'));
    writeFileSync(join(earlier, 'npm'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(earlier, 'npm'), 0o755);

    try {
      const out = runHookCapturingAll(
        { PATH: `${earlier}:${shimDir}:${process.env.PATH ?? ''}` },
        ['CLAUDE_ENV_FILE'],
      );

      expect(out).toContain('supplied earlier on PATH');
      expect(existsSync(join(shimDir, 'node'))).toBe(false);
    } finally {
      rmSync(earlier, { recursive: true, force: true });
    }
  });

  it('ignores an earlier PATH entry whose copy of a tool is not executable', () => {
    // `command -v` reports a name it finds with the execute bit cleared, but
    // command execution skips that entry and searches on — so asking it here
    // refuses to link a set that would in fact have won the lookup. The test
    // is the one execution applies: a regular file with the bit set.
    writeDistFixture([LATEST], LATEST);
    const shimDir = join(work, '.local', 'bin');
    const earlier = mkdtempSync(join(tmpdir(), 'session-hook-early-'));
    writeFileSync(join(earlier, 'npm'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(earlier, 'npm'), 0o644);

    try {
      const out = runHookCapturingAll(
        { PATH: `${earlier}:${shimDir}:${process.env.PATH ?? ''}` },
        ['CLAUDE_ENV_FILE'],
      );

      expect(out).not.toContain('supplied earlier on PATH');
      const provisioned = join(nodeRoot, `node${MAJOR}`, 'bin');
      for (const tool of ['node', 'npm', 'npx']) {
        expect(realpathSync(join(shimDir, tool))).toBe(join(provisioned, tool));
      }
    } finally {
      rmSync(earlier, { recursive: true, force: true });
    }
  });

  it('refuses when the provisioned toolchain is missing one of the tools', () => {
    // A cached toolchain with a runnable node but no npx must not produce a
    // half-linked set: later shells would pair the provisioned node with the
    // image's npx, or with a stale link from an earlier major left beside it,
    // which reads as provisioned and is a split toolchain.
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, LATEST);
    rmSync(join(cacheBin, 'npx'));
    writeDistFixture([LATEST], null);
    const shimDir = join(work, '.local', 'bin');

    const out = runHookCapturingAll(
      { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
      ['CLAUDE_ENV_FILE'],
    );

    expect(out).toContain('no runnable npx');
    expect(existsSync(join(shimDir, 'node'))).toBe(false);
  });

  it('refuses when a source tool is present but not executable', () => {
    // Command lookup skips a non-executable file and falls through to the
    // image's copy, so linking one would leave `node` provisioned and `npx`
    // effectively unchanged — the split this fallback exists to prevent,
    // wearing the right name. Presence is not the test; runnability is.
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, LATEST);
    chmodSync(join(cacheBin, 'npx'), 0o644);
    writeDistFixture([LATEST], null);
    const shimDir = join(work, '.local', 'bin');

    const out = runHookCapturingAll(
      { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
      ['CLAUDE_ENV_FILE'],
    );

    expect(out).toContain('no runnable npx');
    expect(existsSync(join(shimDir, 'node'))).toBe(false);
  });

  it('refuses when a source tool passes the mode checks but will not run', () => {
    // `-f -x` describes a file, not a working program: a missing interpreter or
    // a truncated/wrong-arch binary passes both and still cannot start. The
    // links outlive this session while that failure shows up only in the hook's
    // own `npm install`, so later shells would keep resolving a dead npm
    // instead of falling back to the image's.
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, LATEST);
    writeFileSync(join(cacheBin, 'npm'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(cacheBin, 'npm'), 0o755);
    writeDistFixture([LATEST], null);
    const shimDir = join(work, '.local', 'bin');

    // The hook goes on to run this same broken npm itself and dies under
    // `set -e`, which is the pre-existing behavior and not what's under test —
    // catch the exit so the refusal above it can be asserted.
    let out: string;
    try {
      out = runHookCapturingAll(
        { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
        ['CLAUDE_ENV_FILE'],
      );
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }

    expect(out).toContain('npm does not run');
    expect(existsSync(join(shimDir, 'node'))).toBe(false);
  });

  it('treats an empty PATH field as the current directory when checking for an earlier supplier', () => {
    // A zero-length PATH field means the CURRENT directory to the shell, so a
    // leading or doubled colon is a real entry. Dropping it would let a tool
    // sitting in the working directory keep winning the lookup while the hook
    // linked a shim behind it and reported success — the split this guard
    // exists to catch, hidden by a parsing detail.
    writeDistFixture([LATEST], LATEST);
    const shimDir = join(work, '.local', 'bin');
    // The hook cd's to CLAUDE_PROJECT_DIR, so that is what `.` resolves to.
    // A full toolchain rather than a lone `npm`: with `.` first on PATH the
    // hook's own `node -e`/`node -p` calls resolve here too.
    writeFakeToolchain(projectDir, LATEST);

    const out = runHookCapturingAll(
      { PATH: `:${shimDir}:${process.env.PATH ?? ''}` },
      ['CLAUDE_ENV_FILE'],
    );

    expect(out).toContain('supplied earlier on PATH');
    expect(existsSync(join(shimDir, 'node'))).toBe(false);
  });

  it('falls back to links when CLAUDE_ENV_FILE cannot be written', () => {
    // errexit is disabled inside the function (it is called from `if !`), so a
    // failed append would otherwise reach an unconditional `return 0` and
    // report the harness seam as taken while later shells kept the image's
    // runtime. The links reach the same shells by another route, so the
    // failure is a reason to fall through rather than to give up.
    writeDistFixture([LATEST], LATEST);
    const shimDir = join(work, '.local', 'bin');

    const out = runHookCapturingAll({
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      // Parent does not exist, so the redirect fails.
      CLAUDE_ENV_FILE: join(work, 'no-such-dir', 'env.sh'),
    });

    const provisioned = join(nodeRoot, `node${MAJOR}`, 'bin');
    expect(realpathSync(join(shimDir, 'node'))).toBe(join(provisioned, 'node'));
    expect(out).toContain('could not write');
  });

  it('refuses the env-file route too when a source tool is unusable', () => {
    // Both routes put the whole provisioned directory ahead of the image's
    // copies, so validating only on the link path would let a cached
    // toolchain with a working node and a broken npx persist through
    // CLAUDE_ENV_FILE and split exactly the same way.
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, LATEST);
    chmodSync(join(cacheBin, 'npx'), 0o644);
    writeDistFixture([LATEST], null);

    const out = runHookCapturingAll();

    expect(out).toContain('no runnable npx');
    expect(readFileSync(envFile, 'utf-8')).not.toContain(cacheBin);
  });

  it('does not treat a PATH entry that symlinks outside HOME as eligible', () => {
    // The $HOME test is lexical, but every operation after it — the writable
    // check, the links — acts on the resolved path. A `~/.local/bin` pointing
    // at a system directory would otherwise pass the boundary and then write
    // through it, which is the one thing the HOME-only rule exists to stop.
    writeDistFixture([LATEST], LATEST);
    const outside = mkdtempSync(join(tmpdir(), 'session-hook-outside-'));
    const shimDir = join(work, '.local', 'bin');
    mkdirSync(join(work, '.local'), { recursive: true });
    symlinkSync(outside, shimDir);

    try {
      const out = runHookCapturingAll(
        { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
        ['CLAUDE_ENV_FILE'],
      );

      expect(existsSync(join(outside, 'node'))).toBe(false);
      expect(out).toContain('will not be on PATH');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not create a missing candidate whose parent escapes HOME', () => {
    // The resolved check alone is not enough if `mkdir -p` runs first: with
    // `~/.local` symlinked outside and `bin` absent, creating the candidate is
    // itself the boundary violation, committed before anything is validated.
    // The nearest existing ancestor is what has to clear the way.
    writeDistFixture([LATEST], LATEST);
    const outside = mkdtempSync(join(tmpdir(), 'session-hook-escape-'));
    symlinkSync(outside, join(work, '.local'));
    const shimDir = join(work, '.local', 'bin');

    try {
      const out = runHookCapturingAll(
        { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
        ['CLAUDE_ENV_FILE'],
      );

      expect(existsSync(join(outside, 'bin'))).toBe(false);
      expect(out).toContain('will not be on PATH');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a directory masquerading as a source tool', () => {
    // `-x` is true of a directory — they are searchable — so an executability
    // check alone would link one, and command lookup would skip it and fall
    // through to the image's copy. Same split, arrived at from a direction
    // that looks like a passing check.
    const cacheBin = join(nodeRoot, `node${MAJOR}`, 'bin');
    writeFakeToolchain(cacheBin, LATEST);
    rmSync(join(cacheBin, 'npx'));
    mkdirSync(join(cacheBin, 'npx'));
    writeDistFixture([LATEST], null);
    const shimDir = join(work, '.local', 'bin');

    const out = runHookCapturingAll(
      { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
      ['CLAUDE_ENV_FILE'],
    );

    expect(out).toContain('no runnable npx');
    expect(existsSync(join(shimDir, 'node'))).toBe(false);
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
