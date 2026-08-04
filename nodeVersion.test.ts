// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Three files can independently name the Node major, and each one is read by a
// different consumer:
//
//  - `.nvmrc` — CI (`actions/setup-node@v6` with node-version-file), `nvm use`
//    on a contributor's machine, and the web sandbox's session-start hook;
//  - `engines.node` in package.json — Vercel's build image and function
//    runtime, plus npm's EBADENGINE warning;
//  - `@types/node` — what `tsc` believes the runtime's stdlib looks like.
//    Checked at the *resolved* version, not just the declared range: it was
//    previously no direct dependency at all, and the conditional assertion that
//    fact justified returned early — while vite, vitest and happy-dom pulled
//    `@types/node` 26 in transitively and `tsconfig.node.json` (which does not
//    narrow `compilerOptions.types`) type-checked `vite.config.ts` against Node
//    26 APIs on a Node 24 runtime. A declared-range check cannot see that;
//    what tsc loads is whatever npm resolved.
//
// Nothing else cross-checks them, and a mismatch is quiet in the worst way: the
// suite goes green on one runtime while production serves another. When a bump
// arrives, move them together or none.

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8');

const pkg = JSON.parse(read('./package.json')) as {
  engines: { node: string };
  devDependencies: Record<string, string>;
};
const nvmrc = read('./.nvmrc').trim();

// Confine a range to the pinned major rather than reading its first numeral:
// `>=24` and `^24 || >=26` both start with the right number while still
// resolving to a different major, which is the drift this file exists to
// catch.
//
// Accepts `24`, `^24`, `^24.13.0`; rejects a bare `24.13.0`. That last one
// looks harmless but isn't: the session-start hook reads engines.node as a
// *floor*, which is what the caret and bare-major forms mean — an exact pin
// means only that version, so treating it as a floor would accept 24.14.0 for
// a `24.13.0` pin that npm rejects. Keeping the declared forms to the ones
// that genuinely are floors is what lets the hook stay a string comparison
// instead of a semver evaluator.
const pinnedToMajor = new RegExp(`^(${nvmrc}|\\^${nvmrc}(\\.\\d+){0,2})$`);

describe('Node version pinning', () => {
  it('pins .nvmrc to the active LTS major', () => {
    expect(nvmrc).toBe('24');
  });

  it('agrees between .nvmrc and engines.node', () => {
    expect(pkg.engines.node).toMatch(pinnedToMajor);
  });

  it('declares @types/node on the pinned major', () => {
    expect(pkg.devDependencies['@types/node']).toMatch(pinnedToMajor);
  });

  it('resolves @types/node to the pinned major', () => {
    // The installed version is what tsc actually loads. Asserting it directly
    // is what catches a transitive copy on another major — the declared range
    // above stays green through exactly that.
    const lock = JSON.parse(read('./package-lock.json')) as {
      packages: Record<string, { version?: string }>;
    };
    const resolved = lock.packages['node_modules/@types/node']?.version;
    expect(resolved).toBeDefined();
    expect(resolved).toMatch(new RegExp(`^${nvmrc}\\.`));
  });
  it('mirrors engines into the lockfile', () => {
    // npm copies the manifest's `engines` into the lockfile's root entry, so
    // adding a key to package.json alone leaves the two out of step until the
    // next install rewrites it. That shows up as an unrelated dirty lockfile
    // at the start of every fresh session — and the next lock-maintenance PR
    // quietly absorbs it. Assert them equal so the drift fails here instead.
    const lock = JSON.parse(read('./package-lock.json')) as {
      packages: Record<string, { engines?: Record<string, string> }>;
    };
    expect(lock.packages[''].engines).toEqual(pkg.engines);
  });
});
