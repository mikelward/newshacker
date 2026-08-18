// @vitest-environment node
//
// The weekly dependency update runs unattended and its PR never gets a normal
// `pull_request` CI run, so this validator is most of what stands between a
// silent transitive major and `main`. Its failure mode is a FALSE PASS, which
// is why every case below asserts behavior on a real lockfile shape rather
// than the presence of a rule.
//
// The lockfile fixtures are hand-built and deliberately small. Each one names
// the tree RESHAPE it represents, because the shape is the whole point: the
// earlier versions of this check were correct on the case in front of them and
// blind to the next one, in both directions.
//
// Several were originally found against a design that guessed which instance
// "became" which and then tested the guess. That machinery is gone — pairs now
// come from each consumer's own resolution — so those fixtures are named for
// their tree shape rather than for the vanished mechanism they once probed.
// They are kept because the shapes are real and still have to come out right.

import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'

import {
  NODE_ARCH,
  NODE_PLATFORM,
  NOT_A_NODE_TARGET,
  installedVersions,
  lockfileFailures,
  manifestFailures,
  majorOf,
  resolveEdge,
  updateSummary,
  workspacePaths,
} from './check-dependency-update.mjs'

const pkg = (version: string, deps?: Record<string, string>) => ({
  version,
  ...(deps ? { dependencies: deps } : {}),
})

const root = (deps: Record<string, string>) => ({ '': { dependencies: deps } })

describe('manifestFailures', () => {
  const base = {
    name: 'example',
    scripts: { test: 'vitest run' },
    dependencies: { alpha: '^1.2.0' },
    devDependencies: { beta: '~3.4.5' },
  }

  it('accepts a bump to a version the declared range already allowed', () => {
    const after = { ...base, dependencies: { alpha: '^1.9.9' } }
    expect(manifestFailures(base, after)).toEqual([])
  })

  it('accepts a pure key reordering outside the dependency sections', () => {
    const after = { scripts: { test: 'vitest run' }, name: 'example', ...base }
    expect(manifestFailures(base, after)).toEqual([])
  })

  it('rejects a rewritten script, which would make every reported check meaningless', () => {
    const after = { ...base, scripts: { test: 'true' } }
    expect(manifestFailures(base, after)).toEqual([
      expect.stringContaining('outside its dependency sections'),
    ])
  })

  it('rejects a major, which no declared caret range allows', () => {
    const after = { ...base, dependencies: { alpha: '^2.0.0' } }
    expect(manifestFailures(base, after)).toEqual([
      expect.stringContaining('moved outside its existing range'),
    ])
  })

  it('rejects a caret minor on a 0.x package, where caret pins the minor', () => {
    const before = { ...base, dependencies: { alpha: '^0.6.0' } }
    const after = { ...base, dependencies: { alpha: '^0.7.0' } }
    expect(manifestFailures(before, after)).toEqual([
      expect.stringContaining('moved outside its existing range'),
    ])
  })

  it('rejects a downgrade that keeps the major', () => {
    const before = { ...base, dependencies: { alpha: '^2.17.6' } }
    const after = { ...base, dependencies: { alpha: '^2.0.0' } }
    expect(manifestFailures(before, after)).toEqual([
      expect.stringContaining('moved outside its existing range'),
    ])
  })

  it('rejects an added or removed package', () => {
    expect(manifestFailures(base, { ...base, dependencies: { alpha: '^1.2.0', gamma: '^1.0.0' } }))
      .toEqual([expect.stringContaining('was ADDED')])
    expect(manifestFailures(base, { ...base, dependencies: {} })).toEqual([
      expect.stringContaining('was REMOVED'),
    ])
  })

  it('rejects a swapped range operator', () => {
    const after = { ...base, dependencies: { alpha: '~1.2.0' } }
    expect(manifestFailures(base, after)).toEqual([
      expect.stringContaining('changed its range operator'),
    ])
  })

  it('stops on a range it cannot model rather than assuming it is fine', () => {
    const after = { ...base, dependencies: { alpha: 'git+https://example.com/alpha.git' } }
    expect(manifestFailures(base, after)).toEqual([
      expect.stringContaining('not a plain X.Y.Z registry range'),
    ])
  })
})

describe('resolveEdge', () => {
  const packages = {
    'node_modules/foo': pkg('2.0.0'),
    'node_modules/a': pkg('1.0.0', { foo: '*' }),
    'node_modules/a/node_modules/foo': pkg('1.0.0'),
    'node_modules/b': pkg('1.0.0', { foo: '*' }),
  }

  it('takes the nearest copy walking up from the dependent', () => {
    expect(resolveEdge(packages, 'node_modules/a', 'foo')).toBe('1.0.0')
  })

  it('falls through to a hoisted copy when there is no nested one', () => {
    expect(resolveEdge(packages, 'node_modules/b', 'foo')).toBe('2.0.0')
    expect(resolveEdge(packages, '', 'foo')).toBe('2.0.0')
  })

  it('returns null for an edge npm did not install', () => {
    expect(resolveEdge(packages, 'node_modules/a', 'absent')).toBeNull()
  })
})

describe('lockfileFailures', () => {
  it('passes a batch where everything moved within its major', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.2.0', { foo: '^1.0.0' }),
      'node_modules/foo': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.3.0', { foo: '^1.0.0' }),
      'node_modules/foo': pkg('1.4.2'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  it('catches an in-place transitive major', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('2.0.0'),
    }
    // Asserts that it is REJECTED and which package is named, not which of the
    // three rules produced the message. More than one rule fires here, and a
    // test pinned to one rule's phrasing reports a wording change as a
    // regression while a real miss elsewhere goes unnoticed.
    expect(lockfileFailures(before, after).join('\n')).toContain('foo')
    expect(lockfileFailures(before, after)).not.toEqual([])
  })

  // Round 32. `@tailwindcss/oxide-wasm32-wasi` declares `cpu: ["wasm32"]` and
  // is optional — and `wasm32` is not a value `process.arch` ever takes, so npm
  // skips it on every platform and it is on nobody's disk. Its dependencies are
  // BUNDLED, though, and `npm update` dissolves the bundle and re-resolves them
  // from the registry, which surfaced a 1.x -> 2.x jump (and an `@emnapi`
  // prerelease, dragged in by a sibling whose `latest` had already moved to
  // 2.x) in a batch that installs none of it. A crossing nobody can experience
  // is a standing false alarm for a weekly unattended job.
  it('ignores a crossing under a package no platform can install', () => {
    const tree = (foo: string) => ({
      ...root({ gated: '^1.0.0' }),
      'node_modules/gated': {
        version: '1.0.0',
        optional: true,
        cpu: ['wasm32'],
        dependencies: { foo: '*' },
      },
      'node_modules/gated/node_modules/foo': pkg(foo),
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0'))).toEqual([])
  })

  // The other half, and the reason this is not "skip platform-gated packages".
  // arm64 IS a real Node arch, so a developer on one installs this for real — a
  // major under it has to stay caught even though CI runs linux/x64. The test
  // is "no Node target at all", not "not the runner's platform"; nothing in the
  // check knows arm64 specifically, it just appears in `process.arch`'s domain
  // where `wasm32` does not.
  it('still catches a crossing under a package some platform does install', () => {
    const tree = (foo: string) => ({
      ...root({ gated: '^1.0.0' }),
      'node_modules/gated': {
        version: '1.0.0',
        optional: true,
        cpu: ['arm64'],
        dependencies: { foo: '*' },
      },
      'node_modules/gated/node_modules/foo': pkg(foo),
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0')).join('\n')).toContain('foo')
  })

  // Codex, round 32. The consumer-level skip fired too late for the parent's
  // OWN edge: root resolves the impossible package itself, and that comparison
  // happens before the package is ever popped as a consumer. The edge has to be
  // pruned where it is resolved, not where it is walked.
  it('ignores the impossible package itself crossing a major', () => {
    const tree = (gated: string) => ({
      ...root({ gated: '*' }),
      'node_modules/gated': { version: gated, optional: true, cpu: ['wasm32'] },
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0'))).toEqual([])
  })

  // Codex, round 32. npm's own matcher treats a lone `any` as a wildcard
  // (`npm-install-checks`: `list.length === 1 && list[0] === 'any'`), so this
  // package installs everywhere and must stay fully checked. Comparing the
  // token against the arch domain alone would prune it and its whole subtree.
  it('still catches a crossing under an `any` platform token', () => {
    const tree = (foo: string) => ({
      ...root({ gated: '^1.0.0' }),
      'node_modules/gated': {
        version: '1.0.0',
        optional: true,
        cpu: ['any'],
        os: ['any'],
        dependencies: { foo: '*' },
      },
      'node_modules/gated/node_modules/foo': pkg(foo),
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0')).join('\n')).toContain('foo')
  })

  // A NON-optional package with an impossible cpu is a broken install, not one
  // npm quietly skips — worth surfacing rather than pruning.
  it('still catches a crossing under an impossible cpu that is not optional', () => {
    const tree = (foo: string) => ({
      ...root({ gated: '^1.0.0' }),
      'node_modules/gated': { version: '1.0.0', cpu: ['wasm32'], dependencies: { foo: '*' } },
      'node_modules/gated/node_modules/foo': pkg(foo),
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0')).join('\n')).toContain('foo')
  })

  // npm's negation syntax means "anything except", which is satisfiable by
  // construction — so it is never an impossible constraint.
  it('still catches a crossing under a negated cpu constraint', () => {
    const tree = (foo: string) => ({
      ...root({ gated: '^1.0.0' }),
      'node_modules/gated': {
        version: '1.0.0',
        optional: true,
        cpu: ['!arm64'],
        dependencies: { foo: '*' },
      },
      'node_modules/gated/node_modules/foo': pkg(foo),
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0')).join('\n')).toContain('foo')
  })

  // Codex, round 32. npm's checker wraps a bare string in a one-item list
  // (`typeof list === 'string'`), and a lockfile can record that shape, so
  // reading "not an array" as "unconstrained" left the false alarm in place.
  it('prunes a string cpu constraint no platform can install', () => {
    const tree = (foo: string) => ({
      ...root({ gated: '^1.0.0' }),
      'node_modules/gated': {
        version: '1.0.0',
        optional: true,
        cpu: 'wasm32',
        dependencies: { foo: '*' },
      },
      'node_modules/gated/node_modules/foo': pkg(foo),
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0'))).toEqual([])
  })

  // Codex, round 32. A negation is not automatically satisfiable: npm rejects
  // the target outright when it matches a negated entry, so a list that both
  // allows and denies the same arch installs nowhere. Treating the mere
  // PRESENCE of a `!` as installable got this backwards.
  it('prunes a contradictory negated constraint', () => {
    const tree = (foo: string) => ({
      ...root({ gated: '^1.0.0' }),
      'node_modules/gated': {
        version: '1.0.0',
        optional: true,
        cpu: ['arm64', '!arm64'],
        dependencies: { foo: '*' },
      },
      'node_modules/gated/node_modules/foo': pkg(foo),
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0'))).toEqual([])
  })

  // Codex, round 32. A package that BECOMES installable is real code entering
  // the tree, and its subtree has to be walked — so the prune needs both sides
  // uninstallable, not either. Pruning on the old side alone let a major under
  // a newly-installed package through.
  it('still catches a crossing under a package that becomes installable', () => {
    const tree = (cpu: string, foo: string) => ({
      ...root({ gated: '^1.0.0' }),
      'node_modules/gated': {
        version: '1.0.0',
        optional: true,
        cpu: [cpu],
        dependencies: { foo: '*' },
      },
      'node_modules/gated/node_modules/foo': pkg(foo),
    })
    const failures = lockfileFailures(tree('wasm32', '1.0.0'), tree('x64', '2.0.0'))
    expect(failures.join('\n')).toContain('foo')
  })

  // The same argument reversed: a package leaving the tree is still a change
  // worth stopping on, and its subtree was installed right up until now.
  it('still catches a crossing under a package that becomes uninstallable', () => {
    const tree = (cpu: string, foo: string) => ({
      ...root({ gated: '^1.0.0' }),
      'node_modules/gated': {
        version: '1.0.0',
        optional: true,
        cpu: [cpu],
        dependencies: { foo: '*' },
      },
      'node_modules/gated/node_modules/foo': pkg(foo),
    })
    const failures = lockfileFailures(tree('x64', '1.0.0'), tree('wasm32', '2.0.0'))
    expect(failures.join('\n')).toContain('foo')
  })

  // Codex, round 33. `haiku` is a real Node port and was missing from the
  // platform domain, so an optional package gated to it read as impossible and
  // was pruned along with its subtree. This is the costly direction — a missing
  // domain entry buys a missed major, where an extra one buys one comparison.
  it('still catches a crossing under a package gated to a rarely-named platform', () => {
    const tree = (foo: string) => ({
      ...root({ gated: '^1.0.0' }),
      'node_modules/gated': {
        version: '1.0.0',
        optional: true,
        os: ['haiku'],
        dependencies: { foo: '*' },
      },
      'node_modules/gated/node_modules/foo': pkg(foo),
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0')).join('\n')).toContain('foo')
  })

  // Codex, round 33 again, and the sharper half: `openharmony` is in all three
  // lockfiles TODAY and is absent from `@types/node`'s union, so the types
  // package lags what npm ships and a guard against it alone would never have
  // caught this. The lockfile guard below is the one that would.
  it('still catches a crossing under a package gated to a newer platform', () => {
    const tree = (foo: string) => ({
      ...root({ gated: '^1.0.0' }),
      'node_modules/gated': {
        version: '1.0.0',
        optional: true,
        os: ['openharmony'],
        dependencies: { foo: '*' },
      },
      'node_modules/gated/node_modules/foo': pkg(foo),
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0')).join('\n')).toContain('foo')
  })

  // Round 31's finding, and the one that retired the instance matcher. Nothing
  // is added or removed here — the same two `bar` copies exist on both sides,
  // and consumers merely REDISTRIBUTE across them: `x` stays on the nested
  // copy, `z` stays on the hoisted one, and `y` hoists out of `a` and so
  // switches from the first to the second. The two copies resolve different
  // `foo` majors, so `y`'s transitive `foo` crosses 1 -> 2.
  //
  // A matcher pairs instances one-to-one and exclusively, so both copies pair
  // with themselves, both are vouched for by the dependent that stayed, and
  // `y`'s move is not any pairing. Deriving pairs from each consumer's own
  // resolution has no such blind spot: `y` names the pair itself.
  it('catches a crossing when consumers redistribute across surviving copies', () => {
    const shared = {
      'node_modules/a': pkg('1.0.0', { x: '*', y: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/bar/node_modules/foo': pkg('1.0.0'),
      'node_modules/a/node_modules/x': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('2.0.0'),
      'node_modules/z': pkg('1.0.0', { bar: '*' }),
    }
    const before = {
      ...root({ a: '^1.0.0', z: '^1.0.0' }),
      ...shared,
      'node_modules/a/node_modules/y': pkg('1.0.0', { bar: '*' }),
    }
    const after = {
      ...root({ a: '^1.0.0', z: '^1.0.0' }),
      ...shared,
      'node_modules/y': pkg('1.0.0', { bar: '*' }),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain(
      'now resolves foo to a different major',
    )
  })

  // Round 26's finding, and a regression the previous round introduced: with
  // the two aggregate rules gone, the ONLY thing looking at a direct
  // devDependency is the root's own edge comparison — and `devDependencies`
  // was not in EDGE_FIELDS. A `*` range never changes, so the manifest check
  // is silent too, and most of what this repo declares is a devDependency.
  it('catches a direct devDependency crossing a major', () => {
    const before = {
      '': { dependencies: { keep: '^1.0.0' }, devDependencies: { beta: '*' } },
      'node_modules/beta': pkg('1.0.0'),
      'node_modules/keep': pkg('1.0.0'),
    }
    const after = {
      '': { dependencies: { keep: '^1.0.0' }, devDependencies: { beta: '*' } },
      'node_modules/beta': pkg('2.0.0'),
      'node_modules/keep': pkg('1.0.0'),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('beta')
  })

  // The same omission from the other side: a subtree reachable ONLY through
  // the root's dev dependencies. Nothing admitted `a` as a live consumer, so
  // the whole dev-tooling tree — most of what CI actually runs — was never
  // walked. The crossing here is transitive, so the by-path rule would not
  // have covered it even before it was removed.
  it('catches a major under a dev-only subtree', () => {
    const tree = (foo: string) => ({
      '': { dependencies: { keep: '^1.0.0' }, devDependencies: { a: '^1.0.0' } },
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg(foo),
      'node_modules/keep': pkg('1.0.0'),
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0')).join('\n')).toContain('foo')
  })

  // Round 28's finding, and an ordering bug inside round 25's fix rather than
  // a new blind spot. A consumer and its child relocate together, so liveness
  // has to be proven in chain order: root -> x -> a -> foo. Splitting a
  // rejected hypothesis inside the same loop that proves liveness meant
  // reaching `foo` first destroyed the pair that `a` was one pass away from
  // making live — and once split, each half falls through to its own
  // parent-local copy, so neither can see across `a`'s move and the crossing
  // between them vanishes.
  //
  // Splitting is now deferred until the liveness pass has otherwise converged.
  it('catches a crossing under a consumer and child that relocate together', () => {
    const before = {
      ...root({ x: '^1.0.0' }),
      'node_modules/x': pkg('1.0.0', { a: '*' }),
      'node_modules/x/node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/x/node_modules/a/node_modules/foo': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0'),
    }
    const after = {
      ...root({ x: '^1.0.0' }),
      'node_modules/x': pkg('1.0.0', { a: '*' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('bar')
  })

  // Round 30's finding, which refuted a claim written in the code and in
  // AGENTS.md: "containment is a partial order, so something is always
  // eligible." Containment on ONE side is a partial order; the eligibility
  // relation is a disjunction of two of them, and a union of partial orders
  // can cycle. Two wrong pairings contain each other on opposite sides here —
  // `x/nm/a` paired with `x/nm/foo/nm/a`, while its own child `x/nm/a/nm/foo`
  // is paired with `x/nm/foo` — so nothing was eligible and the outer loop
  // exited with both still pending.
  //
  // Two independent defects, both needed: the cycle stalled the split, and the
  // unpaired halves then derived their counterpart by walking up from the
  // instance's OLD directory, which is wrong precisely when the parent moved.
  it('catches a crossing where two names both relocate past unrelated newcomers', () => {
    const before = {
      ...root({ x: '^1.0.0' }),
      'node_modules/x': pkg('1.0.0', { a: '*' }),
      'node_modules/x/node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/x/node_modules/a/node_modules/foo': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('2.0.0'),
    }
    const after = {
      ...root({ x: '^1.0.0' }),
      'node_modules/x': pkg('1.0.0', { a: '*', foo: '*' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0', { bar: '*' }),
      'node_modules/x/node_modules/foo': pkg('1.0.0', { a: '*' }),
      'node_modules/x/node_modules/foo/node_modules/a': pkg('1.0.0'),
      'node_modules/bar': pkg('1.0.0'),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('bar')
  })

  // The same cycle with NO leftover instances — `p` supplies a second copy of
  // each name on both sides, so the matcher pairs everything and the correct
  // pairing is reachable only by splitting. This is the fixture that proves
  // the cycle fallback: above, the real `a` and `foo` copies were left over as
  // unpaired additions and got picked up without any split, so removing the
  // fallback did not turn it red. Two defects, two fixtures.
  it('catches the same relocation when every copy has a same-name counterpart', () => {
    const before = {
      ...root({ x: '^1.0.0', p: '^1.0.0' }),
      'node_modules/x': pkg('1.0.0', { a: '*' }),
      'node_modules/x/node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/x/node_modules/a/node_modules/foo': pkg('1.0.0', { bar: '*' }),
      'node_modules/p': pkg('1.0.0', { a: '*', foo: '*' }),
      'node_modules/p/node_modules/a': pkg('1.0.0'),
      'node_modules/p/node_modules/foo': pkg('1.0.0'),
      'node_modules/bar': pkg('2.0.0'),
    }
    const after = {
      ...root({ x: '^1.0.0', p: '^1.0.0' }),
      'node_modules/x': pkg('1.0.0', { a: '*', foo: '*' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0', { bar: '*' }),
      'node_modules/x/node_modules/foo': pkg('1.0.0', { a: '*' }),
      'node_modules/x/node_modules/foo/node_modules/a': pkg('1.0.0'),
      'node_modules/p': pkg('1.0.0', { a: '*', foo: '*' }),
      'node_modules/bar': pkg('1.0.0'),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain(
      'now resolves bar to a different major',
    )
  })

  // Round 29's finding, and the second ordering bug in the same mechanism —
  // deferring the split fixed *when* it happens, this fixes *which one*. `x`'s
  // nested `a` hoists out, but an unrelated newcomer deeper under `x` wins the
  // matcher's location affinity, so the `a` pair is a wrong guess that cannot
  // prove liveness. `foo` moved with `a` and cannot be proven until `a` is.
  // Splitting `foo` first strands both halves on parent-local copies, and the
  // crossing through the hoisted `a` is never on either side of a comparison.
  it('catches a crossing under a relocation the matcher would mis-pair', () => {
    const before = {
      ...root({ x: '^1.0.0' }),
      'node_modules/x': pkg('1.0.0', { a: '*' }),
      'node_modules/x/node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/x/node_modules/a/node_modules/foo': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0'),
    }
    const after = {
      ...root({ x: '^1.0.0' }),
      'node_modules/x': pkg('1.0.0', { a: '*', q: '*' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0', { bar: '*' }),
      'node_modules/x/node_modules/q': pkg('1.0.0', { a: '*' }),
      'node_modules/x/node_modules/q/node_modules/a': pkg('1.0.0'),
      'node_modules/bar': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('bar')
  })

  // Round 27's finding. npm splits a workspace across two lockfile entries and
  // `isPackage` rejects both: the versioned one sits at its repo path with no
  // `node_modules/` segment, and the one under `node_modules` is a bare
  // `link: true` record with no version. Nothing admitted it as a consumer, so
  // its edges — including the dev edges the previous round went to some
  // trouble to start walking — were never compared.
  //
  // These repos have no workspaces today. The fixture is here because the
  // failure mode is silence: adding one would quietly narrow what the monthly
  // job checks, with nothing red to say so.
  it('walks a workspace as a consumer', () => {
    const tree = (foo: string) => ({
      '': { workspaces: ['packages/*'], dependencies: { keep: '^1.0.0' } },
      'packages/a': { name: 'a', version: '1.0.0', devDependencies: { foo: '*' } },
      'node_modules/a': { resolved: 'packages/a', link: true },
      'node_modules/foo': pkg(foo),
      'node_modules/keep': pkg('1.0.0'),
    })
    expect(lockfileFailures(tree('1.0.0'), tree('2.0.0')).join('\n')).toContain('foo')
    // …and does not fire on the in-range move, so the assertion above cannot
    // pass just because seeding the workspace made everything look like a
    // crossing.
    expect(lockfileFailures(tree('1.0.0'), tree('1.4.0'))).toEqual([])
  })

  // Round 17's finding. Two copies of one consumer swap majors in opposite
  // directions, so every per-NAME aggregate is bit-for-bit identical.
  it('catches two copies of a consumer swapping majors in opposite directions', () => {
    const shared = {
      ...root({ a: '^1.0.0', b: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/b': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/b/node_modules/bar': pkg('1.0.0', { foo: '*' }),
    }
    const before = {
      ...shared,
      'node_modules/a/node_modules/bar/node_modules/foo': pkg('1.0.0'),
      'node_modules/b/node_modules/bar/node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...shared,
      'node_modules/a/node_modules/bar/node_modules/foo': pkg('2.0.0'),
      'node_modules/b/node_modules/bar/node_modules/foo': pkg('1.0.0'),
    }

    // The aggregate this fixture is built to defeat really is unchanged.
    const majors = (tree: Record<string, unknown>) =>
      Object.entries(tree)
        .filter(([path]) => path.endsWith('node_modules/foo'))
        .map(([, entry]) => majorOf((entry as { version: string }).version))
        .sort()
    expect(majors(before)).toEqual(majors(after))

    expect(lockfileFailures(before, after)).not.toEqual([])
  })

  // Round 16's finding, and the one that keying by path misses: the consumer
  // changes location in the same batch as it crosses, so it shares no path to
  // compare and its old id looks deleted.
  it('catches a consumer that hoists as it crosses', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('different major')
  })

  // The case neither summary rule can see: a nested foo@1 is dropped so its
  // dependent falls through to an already-hoisted foo@2, while another
  // dependent keeps its own foo@1. No shared path changed major, and the major
  // set for foo is still {1,2}. Nothing aggregate moved — but b crossed.
  it('catches a consumer falling through to a hoisted copy while the tree summary holds still', () => {
    const before = {
      ...root({ a: '^1.0.0', b: '^1.0.0' }),
      'node_modules/foo': pkg('2.0.0'),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/b': pkg('1.0.0', { foo: '*' }),
      'node_modules/b/node_modules/foo': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0', b: '^1.0.0' }),
      'node_modules/foo': pkg('2.0.0'),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/b': pkg('1.0.0', { foo: '*' }),
    }

    // Both summaries really are identical across this update — otherwise the
    // test would pass for a reason that has nothing to do with rule (3).
    const pathMajors = (tree: Record<string, { version?: string }>) =>
      Object.entries(tree)
        .filter(([path, entry]) => path.includes('node_modules/') && entry.version)
        .map(([path, entry]) => `${path}@${majorOf(entry.version as string)}`)
    const shared = pathMajors(before).filter((x) => pathMajors(after).includes(x))
    expect(pathMajors(before).filter((x) => !shared.includes(x))).toEqual([
      'node_modules/b/node_modules/foo@1',
    ])
    expect(new Set(pathMajors(after).map((x) => x.split('@').pop()))).toEqual(new Set(['1', '2']))

    const failures = lockfileFailures(before, after)
    expect(failures.join('\n')).toContain('different major')
    expect(failures.join('\n')).toContain('foo')
  })

  it('passes a dedupe that collapses two identical copies without changing what anyone resolves', () => {
    const before = {
      ...root({ a: '^1.0.0', b: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/b': pkg('1.0.0', { foo: '*' }),
      'node_modules/b/node_modules/foo': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0', b: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/b': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  // The false positive that sinks a naive `name@version` identity: the
  // consumer is bumped and hoisted in the same batch while what it resolves
  // does not move at all.
  it('passes a consumer that is itself bumped and hoisted with its dependency unchanged', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.2.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.3.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  // The other half of the same trap, and the one that actually bites: with a
  // `name@version` identity this consumer goes unmatched, so its crossing is
  // never compared and the run goes green. The failure mode is silence, not a
  // false alarm — which is why it needs its own fixture rather than being
  // assumed covered by the no-false-positive case above.
  it('catches a consumer that crosses in the same batch as it is bumped and hoisted', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.2.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/bar': pkg('1.3.0', { foo: '*' }),
      'node_modules/foo': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('different major')
  })

  // When two identical copies dedupe to one, the matcher pairs a single
  // survivor and leaves the other in `removed`. Comparing only the pairs threw
  // that report away, so if the copy that vanished resolved a different major
  // than the survivor does, whoever depended on it crossed unnoticed. Both
  // summaries hold still here: `c` keeps a foo@1 alive so the by-name set is
  // {1,2} either way, and the vanished path has no after-side entry for the
  // by-path rule to compare.
  it('catches a crossing carried by a consumer that deduped away', () => {
    const before = {
      ...root({ a: '^1.0.0', b: '^1.0.0', c: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('2.0.0'),
      'node_modules/b': pkg('1.0.0', { bar: '*' }),
      'node_modules/b/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/b/node_modules/foo': pkg('1.0.0'),
      'node_modules/c': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
    }
    // The two `bar` copies collapse to one hoisted copy, which resolves foo@1.
    // a's transitive foo therefore goes 2 -> 1.
    const after = {
      ...root({ a: '^1.0.0', b: '^1.0.0', c: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/foo': pkg('2.0.0'),
      'node_modules/b': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/c': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
    }

    const fooMajors = (tree: Record<string, { version?: string }>) =>
      new Set(
        Object.entries(tree)
          .filter(([p, e]) => p.endsWith('node_modules/foo') && e.version)
          .map(([, e]) => majorOf(e.version as string)),
      )
    expect(fooMajors(before)).toEqual(fooMajors(after))

    expect(lockfileFailures(before, after).join('\n')).toContain('different major')
  })

  // The other side of the removed-instance path, and the reason it needs a
  // live-dependent test: a copy vanishing is not by itself a fall-through. Here
  // `a` legitimately DROPS bar while a hoisted bar survives for `c`. Nobody
  // lands on that hoisted copy from a's branch, so comparing the two describes
  // a hop no consumer makes — and would reject a dropped dependency as a
  // transitive major. `d` keeps a foo@1 alive so the by-name rule stays quiet
  // and this fixture isolates exactly that path.
  it('passes when a dependency is dropped rather than crossed', () => {
    const before = {
      ...root({ a: '^1.0.0', c: '^1.0.0', d: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/c': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/d': pkg('1.0.0', { foo: '*' }),
      'node_modules/d/node_modules/foo': pkg('1.0.0'),
      'node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0', c: '^1.0.0', d: '^1.0.0' }),
      'node_modules/a': pkg('1.1.0'),
      'node_modules/c': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/d': pkg('1.0.0', { foo: '*' }),
      'node_modules/d/node_modules/foo': pkg('1.0.0'),
      'node_modules/foo': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  // The mirror of the dedupe case: a copy that APPEARS. `a` used the hoisted
  // bar@1, whose foo resolved foo@1; after the update `a` has its own nested
  // bar@1 resolving foo@2, while the hoisted copy stays for `c`. bar never
  // changes major and foo's set is {1,2} either way, so both summaries hold
  // still — but a's transitive foo went 1 -> 2.
  it('catches a crossing carried by a newly added consumer copy', () => {
    const before = {
      ...root({ a: '^1.0.0', c: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/c': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
      'node_modules/c/node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0', c: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('2.0.0'),
      'node_modules/c': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
      'node_modules/c/node_modules/foo': pkg('2.0.0'),
    }

    const fooMajors = (tree: Record<string, { version?: string }>) =>
      new Set(
        Object.entries(tree)
          .filter(([p, e]) => p.endsWith('node_modules/foo') && e.version)
          .map(([, e]) => majorOf(e.version as string)),
      )
    expect(fooMajors(before)).toEqual(fooMajors(after))

    expect(lockfileFailures(before, after).join('\n')).toContain('different major')
  })

  // And the mirror of the dropped-dependency case. `a` ADDS a dependency on
  // bar, which lands nested while a hoisted bar stays for `c`. The new copy
  // resolves a different foo than the hoisted one does, but `a` never depended
  // on bar before, so nobody crossed — there was no previous resolution to
  // cross from. Without the was-depended test this reads as a transitive major.
  it('passes when a dependency is newly added rather than crossed', () => {
    const before = {
      ...root({ a: '^1.0.0', c: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0'),
      'node_modules/c': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
      'node_modules/c/node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0', c: '^1.0.0' }),
      'node_modules/a': pkg('1.1.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('2.0.0'),
      'node_modules/c': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
      'node_modules/c/node_modules/foo': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  // Liveness chains, so the scan has to run to a fixed point. Two levels dedupe
  // in the same update — both the `a` copies and the `bar` copies collapse — so
  // the orphaned `bar` is used only by the orphaned `a`. Asking "who still
  // depends on this" against a snapshot of the MATCHED pairs answers "nobody"
  // and drops it, while x's transitive foo goes 2 -> 1 and every summary holds
  // still.
  it('catches a crossing when two levels dedupe in the same update', () => {
    const before = {
      ...root({ x: '^1.0.0', y: '^1.0.0', z: '^1.0.0' }),
      'node_modules/x': pkg('1.0.0', { a: '*' }),
      'node_modules/x/node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/x/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/x/node_modules/foo': pkg('2.0.0'),
      'node_modules/y': pkg('1.0.0', { a: '*' }),
      'node_modules/y/node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/y/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/y/node_modules/foo': pkg('1.0.0'),
      'node_modules/z': pkg('1.0.0', { foo: '*' }),
      'node_modules/z/node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...root({ x: '^1.0.0', y: '^1.0.0', z: '^1.0.0' }),
      'node_modules/x': pkg('1.0.0', { a: '*' }),
      'node_modules/y': pkg('1.0.0', { a: '*' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
      'node_modules/z': pkg('1.0.0', { foo: '*' }),
      'node_modules/z/node_modules/foo': pkg('2.0.0'),
    }

    const fooMajors = (tree: Record<string, { version?: string }>) =>
      new Set(
        Object.entries(tree)
          .filter(([p, e]) => p.endsWith('node_modules/foo') && e.version)
          .map(([, e]) => majorOf(e.version as string)),
      )
    expect(fooMajors(before)).toEqual(fooMajors(after))

    expect(lockfileFailures(before, after).join('\n')).toContain('different major')
  })

  // Resolution is positional, not declarative: a package resolves whatever
  // sits above it whether or not it asked for it. So "this instance was
  // resolvable from that consumer" is not evidence the consumer used it. Here
  // `q` drops bar (orphaning `a/node_modules/bar`, which only `q` ever used)
  // while `a` independently ADDS bar and gets the hoisted copy. Checking only
  // the far side of the pair lets a's brand-new edge supply liveness for an
  // instance it never depended on, and the batch is rejected for a crossing
  // nobody made.
  it('passes when an added edge coincidentally resolves to an orphaned copy', () => {
    const before = {
      ...root({ a: '^1.0.0', c: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { q: '*' }),
      'node_modules/a/node_modules/q': pkg('1.0.0', { bar: '*', foo: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/c': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0', c: '^1.0.0' }),
      'node_modules/a': pkg('1.1.0', { q: '*', bar: '*' }),
      'node_modules/a/node_modules/q': pkg('1.1.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/c': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  // The matcher pairs by version when locations differ, which is a hypothesis
  // rather than a fact: `q` dropping bar@1 while `p` independently adds bar@1
  // produces exactly that shape out of two copies with nothing to do with each
  // other. Comparing them describes a move no consumer made — and since they
  // were paired, they never reach the unpaired-instance path where liveness
  // was already being checked.
  it('passes when one dependency drops a copy and another adds an unrelated one', () => {
    const before = {
      ...root({ q: '^1.0.0', p: '^1.0.0', z: '^1.0.0' }),
      'node_modules/q': pkg('1.0.0', { bar: '*' }),
      'node_modules/q/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/q/node_modules/foo': pkg('1.0.0'),
      'node_modules/p': pkg('1.0.0'),
      'node_modules/z': pkg('1.0.0', { foo: '*' }),
      'node_modules/z/node_modules/foo': pkg('1.0.0'),
      'node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...root({ q: '^1.0.0', p: '^1.0.0', z: '^1.0.0' }),
      'node_modules/q': pkg('1.1.0'),
      'node_modules/p': pkg('1.1.0', { bar: '*' }),
      'node_modules/p/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/z': pkg('1.0.0', { foo: '*' }),
      'node_modules/z/node_modules/foo': pkg('1.0.0'),
      'node_modules/foo': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  // A rejected pairing must not take the instance down with it. `q`'s nested
  // bar disappears and `q` falls through to `a/node_modules/bar`, but the
  // matcher pairs the vanished copy with an unrelated newly added
  // `b/node_modules/bar`. That hypothesis fails liveness — correctly — and if
  // it is simply dropped, the vanished copy is never compared against the copy
  // `q` actually uses now, so its foo 2 -> 1 goes unreported with both
  // summaries unchanged.
  it('catches a crossing where a vanished copy is not the one a consumer moved to', () => {
    const before = {
      ...root({ a: '^1.0.0', z: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { q: '*', b: '*', bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/q': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/q/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/q/node_modules/foo': pkg('2.0.0'),
      'node_modules/a/node_modules/b': pkg('1.0.0'),
      'node_modules/z': pkg('1.0.0', { foo: '*' }),
      'node_modules/z/node_modules/foo': pkg('2.0.0'),
      'node_modules/foo': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0', z: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { q: '*', b: '*', bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/q': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/b': pkg('1.1.0', { bar: '*' }),
      'node_modules/a/node_modules/b/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/z': pkg('1.0.0', { foo: '*' }),
      'node_modules/z/node_modules/foo': pkg('2.0.0'),
      'node_modules/foo': pkg('1.0.0'),
    }

    const fooMajors = (tree: Record<string, { version?: string }>) =>
      new Set(
        Object.entries(tree)
          .filter(([p, e]) => p.endsWith('node_modules/foo') && e.version)
          .map(([, e]) => majorOf(e.version as string)),
      )
    expect(fooMajors(before)).toEqual(fooMajors(after))

    expect(lockfileFailures(before, after).join('\n')).toContain('different major')
  })

  it('passes a brand-new subdependency of something that moved in range', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.2.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.3.0', { fresh: '*' }),
      'node_modules/fresh': pkg('4.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  it('catches a major the root itself resolves, even with the range untouched', () => {
    const before = {
      ...root({ alpha: '*' }),
      'node_modules/alpha': pkg('1.0.0'),
    }
    const after = {
      ...root({ alpha: '*' }),
      'node_modules/alpha': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('alpha')
    expect(lockfileFailures(before, after)).not.toEqual([])
  })

  it('ignores link and workspace records, which carry no resolved version', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': { resolved: 'packages/a', link: true },
      'packages/a': { name: 'a' },
    }
    expect(lockfileFailures(before, { ...before })).toEqual([])
  })

  it('stops when an edge declared on both sides resolves on only one', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { opt: '*' }),
      'node_modules/opt': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { opt: '*' }),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('resolves to a copy on only one')
  })
})

// The two shapes that retired the by-path and by-name aggregate rules. Both
// are ordinary add-and-drop batches with no consumer keeping the edge across
// the update, and both were rejected as transitive majors until liveness
// became the only test.
describe('add-and-drop is not a crossing', () => {
  const pkgL = (version: string, deps?: Record<string, string>) => ({
    version,
    ...(deps ? { dependencies: deps } : {}),
  })

  it('passes when every dependent of a stable path turns over', () => {
    const before = {
      ...root({ q: '^1.0.0', p: '^1.0.0' }),
      'node_modules/q': pkgL('1.0.0', { bar: '*' }),
      'node_modules/p': pkgL('1.0.0'),
      'node_modules/bar': pkgL('1.0.0', { foo: '*' }),
      'node_modules/bar/node_modules/foo': pkgL('1.0.0'),
      'node_modules/foo': pkgL('2.0.0'),
    }
    const after = {
      ...root({ q: '^1.0.0', p: '^1.0.0' }),
      'node_modules/q': pkgL('1.1.0'),
      'node_modules/p': pkgL('1.1.0', { bar: '*' }),
      'node_modules/bar': pkgL('1.0.0', { foo: '*' }),
      'node_modules/foo': pkgL('2.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  it('passes when one package drops a major and another picks up a different one', () => {
    const before = {
      ...root({ q: '^1.0.0', p: '^1.0.0' }),
      'node_modules/q': pkgL('1.0.0', { bar: '*' }),
      'node_modules/p': pkgL('1.0.0'),
      'node_modules/bar': pkgL('1.0.0'),
    }
    const after = {
      ...root({ q: '^1.0.0', p: '^1.0.0' }),
      'node_modules/q': pkgL('1.1.0'),
      'node_modules/p': pkgL('1.1.0', { bar: '*' }),
      'node_modules/bar': pkgL('2.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })
})

// The domains in check-dependency-update.mjs decide what gets pruned, and a
// value MISSING from them prunes a real package plus its whole subtree — a
// missed major, the expensive direction. So rather than trust a hand-written
// list, assert it covers what the pinned `@types/node` says Node can report:
// a new Node port then fails CI instead of silently widening the blind spot.
describe('installability domains', () => {
  const dts = readFileSync(
    new URL('../node_modules/@types/node/process.d.ts', import.meta.url),
    'utf8',
  )

  // The parse failing open would be a false pass, so each union is checked for
  // a plausible shape before it is used as the expectation.
  const union = (name: string) => {
    const match = new RegExp(`type ${name} =([^;]*);`).exec(dts)
    if (!match) throw new Error(`could not find NodeJS.${name} in @types/node`)
    const values = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(values.length).toBeGreaterThan(5)
    return values
  }

  it('cover every platform @types/node says Node can report', () => {
    const platforms = union('Platform')
    expect(platforms).toContain('linux')
    expect(platforms).toContain('haiku')
    expect(NODE_PLATFORM).toEqual(expect.arrayContaining(platforms))
  })

  it('cover every architecture @types/node says Node can report', () => {
    const arches = union('Architecture')
    expect(arches).toContain('x64')
    expect(NODE_ARCH).toEqual(expect.arrayContaining(arches))
  })
})

// The @types/node guard above is necessary but NOT sufficient, and openharmony
// is the proof: it is in every one of these lockfiles today and is absent from
// that union, so the types package lags what npm actually ships. This guard
// asks the lockfile instead — every `cpu`/`os` value a real dependency declares
// must either be a Node target we know about, or be explicitly classified as
// not one. A new platform binding entering the tree then fails CI and gets a
// deliberate decision, rather than defaulting to "impossible" and silently
// pruning its subtree.
describe('installability domains vs. this lockfile', () => {
  const lock = JSON.parse(
    readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
  )

  // npm's syntax, read the way `checkList` reads it: a leading `!` negates a
  // target and a lone `any` is a wildcard. Both are ordinary, valid values a
  // future batch can introduce, so the raw token has to be normalized to the
  // TARGET before classifying it — comparing `!win32` against the domain would
  // fail a perfectly good lockfile and turn the weekly job red for no reason,
  // which is precisely the cry-wolf this file exists to avoid.
  const unclassified = (
    packages: Record<string, { os?: string[]; cpu?: string[] }>,
    field: 'os' | 'cpu',
    domain: string[],
  ) => {
    const targets = new Set()
    for (const entry of Object.values(packages)) {
      for (const value of [].concat(entry[field] || [])) {
        const target = String(value).replace(/^!/, '')
        if (target !== 'any') targets.add(target)
      }
    }
    return [...targets]
      .filter((t) => !domain.includes(t) && !NOT_A_NODE_TARGET.includes(t))
      .sort()
  }

  it('classify every cpu the lockfile declares', () => {
    expect(unclassified(lock.packages, 'cpu', NODE_ARCH)).toEqual([])
  })

  it('classify every os the lockfile declares', () => {
    expect(unclassified(lock.packages, 'os', NODE_PLATFORM)).toEqual([])
  })

  // The guard's own regression test: today's lockfiles carry no negation or
  // wildcard, so without this the normalization above would be unexercised.
  it('accept npm negation and wildcard syntax as classified', () => {
    const packages = {
      'node_modules/a': { version: '1.0.0', os: ['!win32'], cpu: ['!arm'] },
      'node_modules/b': { version: '1.0.0', os: ['any'], cpu: ['any'] },
    }
    expect(unclassified(packages, 'os', NODE_PLATFORM)).toEqual([])
    expect(unclassified(packages, 'cpu', NODE_ARCH)).toEqual([])
  })

  it('still reject a target that is neither known nor classified', () => {
    const packages = { 'node_modules/a': { version: '1.0.0', os: ['plan9'] } }
    expect(unclassified(packages, 'os', NODE_PLATFORM)).toEqual(['plan9'])
  })
})

// The summary is the opposite of everything above: informational, never a
// gate. Its failure mode is a MISLEADING PR body — a package that moved but
// is not listed reads as "did not move" to the reviewer the PR is assigned
// to — so the cases below pin what gets listed, under which heading, and
// what happens on input the walk cannot read.
describe('workspacePaths', () => {
  it('finds workspaces and ignores the root, installed copies, and out-of-repo paths', () => {
    expect(
      workspacePaths({
        '': {},
        'packages/a': { name: 'a', version: '1.0.0' },
        'node_modules/a': { link: true },
        'node_modules/foo': { version: '1.0.0' },
        '../sibling': { version: '1.0.0' },
      }),
    ).toEqual(['packages/a'])
  })
})

describe('installedVersions', () => {
  it('groups every installed copy by name, hoisted and nested alike', () => {
    const versions = installedVersions({
      '': { name: 'example', version: '1.0.0' },
      'node_modules/foo': pkg('2.0.0'),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/@scope/b': pkg('3.1.4'),
    })
    expect([...versions.get('foo').values()].sort()).toEqual(['1.0.0', '2.0.0'])
    expect([...versions.get('@scope/b').values()]).toEqual(['3.1.4'])
    // The root is the repo, not a dependency.
    expect(versions.get('example')).toBe(undefined)
  })

  it('skips workspace link mirrors, which carry no version', () => {
    const versions = installedVersions({
      'packages/a': { name: 'a', version: '1.0.0' },
      'node_modules/a': { link: true, resolved: 'packages/a' },
    })
    // Neither entry is an installed dependency: one is the workspace itself
    // (no node_modules/ segment), the other has no version.
    expect(versions.size).toBe(0)
  })
})

describe('updateSummary', () => {
  const lock = (packages: Record<string, object>) => ({ lockfileVersion: 3, packages })

  it('lists a direct bump with its range move and installed versions', () => {
    const out = updateSummary({
      manifestBefore: { dependencies: { alpha: '^1.2.0' } },
      manifestAfter: { dependencies: { alpha: '^1.9.9' } },
      lockBefore: lock({ '': { dependencies: { alpha: '^1.2.0' } }, 'node_modules/alpha': pkg('1.2.3') }),
      lockAfter: lock({ '': { dependencies: { alpha: '^1.9.9' } }, 'node_modules/alpha': pkg('1.9.9') }),
    })
    expect(out).toContain('### Direct')
    expect(out).toContain('- `alpha` 1.2.3 → 1.9.9 (`^1.2.0` → `^1.9.9`)')
    expect(out).toContain('Packages changed: 1 direct, 0 transitive.')
    expect(out).not.toMatch(/### Transitive/)
  })

  it('names the section for anything outside the root dependencies', () => {
    const out = updateSummary({
      manifestBefore: { devDependencies: { beta: '~3.4.5' } },
      manifestAfter: { devDependencies: { beta: '~3.4.8' } },
      lockBefore: lock({ '': { devDependencies: { beta: '~3.4.5' } }, 'node_modules/beta': pkg('3.4.5') }),
      lockAfter: lock({ '': { devDependencies: { beta: '~3.4.8' } }, 'node_modules/beta': pkg('3.4.8') }),
    })
    expect(out).toContain('- `beta` 3.4.5 → 3.4.8 (`~3.4.5` → `~3.4.8`, devDependencies)')
  })

  it('lists transitive moves the package.json diff never shows', () => {
    const manifest = { dependencies: { a: '^1.0.0' } }
    const out = updateSummary({
      manifestBefore: manifest,
      manifestAfter: manifest,
      lockBefore: lock({
        '': { dependencies: { a: '^1.0.0' } },
        'node_modules/a': pkg('1.0.0', { gamma: '^2.0.0' }),
        'node_modules/gamma': pkg('2.0.1'),
      }),
      lockAfter: lock({
        '': { dependencies: { a: '^1.0.0' } },
        'node_modules/a': pkg('1.0.0', { gamma: '^2.0.0' }),
        'node_modules/gamma': pkg('2.0.4'),
      }),
    })
    expect(out).toContain('### Transitive')
    expect(out).toContain('- `gamma` 2.0.1 → 2.0.4')
    expect(out).toContain('Packages changed: 0 direct, 1 transitive.')
    // The unmoved direct dependency earns no line at all.
    expect(out).not.toMatch(/- `a`/)
  })

  it('reports added and removed transitive copies, not just moves', () => {
    const manifest = { dependencies: { a: '^1.0.0' } }
    const out = updateSummary({
      manifestBefore: manifest,
      manifestAfter: manifest,
      lockBefore: lock({
        '': { dependencies: { a: '^1.0.0' } },
        'node_modules/a': pkg('1.0.0'),
        'node_modules/epsilon': pkg('0.9.1'),
      }),
      lockAfter: lock({
        '': { dependencies: { a: '^1.0.0' } },
        'node_modules/a': pkg('1.0.0'),
        'node_modules/delta': pkg('3.1.0'),
      }),
    })
    expect(out).toContain('- `delta` added at 3.1.0')
    expect(out).toContain('- `epsilon` removed (was 0.9.1)')
  })

  it('reports a same-version copy collapsing, which a plain version set would hide', () => {
    const manifest = { dependencies: { a: '^1.0.0' } }
    const mk = (nested) =>
      lock({
        '': { dependencies: { a: '^1.0.0' } },
        'node_modules/a': pkg('1.0.0', { foo: '^1.0.0' }),
        'node_modules/foo': pkg('1.0.0'),
        ...(nested ? { 'node_modules/a/node_modules/foo': pkg('1.0.0') } : {}),
      })
    const out = updateSummary({
      manifestBefore: manifest,
      manifestAfter: manifest,
      lockBefore: mk(true),
      lockAfter: mk(false),
    })
    expect(out).toContain('- `foo` 1.0.0 ×2 → 1.0.0')
  })

  it('keeps a nested-only move under transitive even when the name is also declared direct', () => {
    const manifest = { dependencies: { foo: '^1.0.0', b: '^1.0.0' } }
    const mk = (nestedFoo) =>
      lock({
        '': { dependencies: { foo: '^1.0.0', b: '^1.0.0' } },
        'node_modules/foo': pkg('1.0.0'),
        'node_modules/b': pkg('1.0.0', { foo: '^2.0.0' }),
        'node_modules/b/node_modules/foo': pkg(nestedFoo),
      })
    const out = updateSummary({
      manifestBefore: manifest,
      manifestAfter: manifest,
      lockBefore: mk('2.0.0'),
      lockAfter: mk('2.1.0'),
    })
    // The copy the root resolves held still at 1.0.0; only b's nested copy
    // moved, and the direct/transitive split has to say so.
    expect(out).toContain('Packages changed: 0 direct, 1 transitive.')
    expect(out).toContain('- `foo` 2.0.0 → 2.1.0')
    expect(out).not.toMatch(/### Direct/)
  })

  it('shows the whole version set when a name has several copies', () => {
    const manifest = { dependencies: { a: '^1.0.0' } }
    const out = updateSummary({
      manifestBefore: manifest,
      manifestAfter: manifest,
      lockBefore: lock({
        '': { dependencies: { a: '^1.0.0' } },
        'node_modules/a': pkg('1.0.0'),
        'node_modules/foo': pkg('9.0.0'),
      }),
      lockAfter: lock({
        '': { dependencies: { a: '^1.0.0' } },
        'node_modules/a': pkg('1.0.0'),
        'node_modules/foo': pkg('9.0.0'),
        'node_modules/a/node_modules/foo': pkg('10.0.0'),
      }),
    })
    // Numeric-aware ordering: 10.0.0 after 9.0.0, not before it.
    expect(out).toContain('- `foo` 9.0.0 → 9.0.0, 10.0.0')
  })

  it('classifies a workspace-declared package as direct', () => {
    const rootManifest = { dependencies: {} }
    const wsBefore = { name: 'a', dependencies: { zeta: '^1.0.0' } }
    const wsAfter = { name: 'a', dependencies: { zeta: '^1.1.0' } }
    const out = updateSummary({
      manifestBefore: rootManifest,
      manifestAfter: rootManifest,
      lockBefore: lock({
        '': {},
        'packages/a': wsBefore,
        'node_modules/a': { link: true },
        'node_modules/zeta': pkg('1.0.0'),
      }),
      lockAfter: lock({
        '': {},
        'packages/a': wsAfter,
        'node_modules/a': { link: true },
        'node_modules/zeta': pkg('1.1.0'),
      }),
      workspaces: { 'packages/a': { manifestBefore: wsBefore, manifestAfter: wsAfter } },
    })
    expect(out).toContain('### Direct')
    expect(out).toContain('- `zeta` 1.0.0 → 1.1.0 (`^1.0.0` → `^1.1.0`, dependencies in packages/a)')
  })

  it('omits packages npm can never install, and the bundled tree beneath them', () => {
    // gedmap's live case: `cpu: ["wasm32"]` matches no value `process.arch`
    // can take, so npm skips the package on every platform — yet `npm update`
    // dissolves its bundle and re-resolves it, moving versions nothing
    // installs. Reporting those would be a standing weekly false alarm.
    const manifest = { optionalDependencies: { impossible: '^1.0.0' } }
    const mk = (v, bundled) =>
      lock({
        '': { optionalDependencies: { impossible: '^1.0.0' } },
        'node_modules/impossible': { version: v, optional: true, cpu: ['wasm32'] },
        'node_modules/impossible/node_modules/bundle': pkg(bundled),
      })
    const out = updateSummary({
      manifestBefore: manifest,
      manifestAfter: manifest,
      lockBefore: mk('1.0.0', '1.0.0'),
      lockAfter: mk('1.1.0', '2.0.0'),
    })
    expect(out).toContain('No package changes recorded.')
  })

  it('still lists an optional platform package some machine can install', () => {
    // Deliberately narrow, like the validator: the test is "no Node target
    // at all", not "not this runner" — a darwin-arm64 binary is a real
    // install on a real machine even though CI is linux/x64.
    const manifest = { optionalDependencies: { native: '^1.0.0' } }
    const mk = (v) =>
      lock({
        '': { optionalDependencies: { native: '^1.0.0' } },
        'node_modules/native': { version: v, optional: true, cpu: ['arm64'], os: ['darwin'] },
      })
    const out = updateSummary({
      manifestBefore: manifest,
      manifestAfter: manifest,
      lockBefore: mk('1.0.0'),
      lockAfter: mk('1.1.0'),
    })
    expect(out).toContain('- `native` 1.0.0 → 1.1.0')
  })

  it('reports consumers trading versions across stable paths, which no multiset sees', () => {
    // Two surviving foo copies swap versions: every multiset holds still,
    // but the version at each path moved — a real change for both consumers,
    // listed per path.
    const manifest = { dependencies: { a: '^1.0.0', b: '^1.0.0' } }
    const mk = (hoisted, nested) =>
      lock({
        '': { dependencies: { a: '^1.0.0', b: '^1.0.0' } },
        'node_modules/a': pkg('1.0.0', { foo: '^1.0.0' }),
        'node_modules/b': pkg('1.0.0', { foo: '^1.0.0' }),
        'node_modules/foo': pkg(hoisted),
        'node_modules/b/node_modules/foo': pkg(nested),
      })
    const out = updateSummary({
      manifestBefore: manifest,
      manifestAfter: manifest,
      lockBefore: mk('1.1.0', '1.2.0'),
      lockAfter: mk('1.2.0', '1.1.0'),
    })
    expect(out).toContain(
      '- `foo` 1.1.0 → 1.2.0 (node_modules/foo), 1.2.0 → 1.1.0 (node_modules/b/node_modules/foo)',
    )
  })

  it('stays silent for a copy relocating at the same version', () => {
    // npm reshaping the tree without moving any version: nothing on disk
    // changed, so nothing is listed — the deliberate silence the doc names.
    const manifest = { dependencies: { a: '^1.0.0' } }
    const out = updateSummary({
      manifestBefore: manifest,
      manifestAfter: manifest,
      lockBefore: lock({
        '': { dependencies: { a: '^1.0.0' } },
        'node_modules/a': pkg('1.0.0', { foo: '^1.0.0' }),
        'node_modules/foo': pkg('1.0.0'),
      }),
      lockAfter: lock({
        '': { dependencies: { a: '^1.0.0' } },
        'node_modules/a': pkg('1.0.0', { foo: '^1.0.0' }),
        'node_modules/a/node_modules/foo': pkg('1.0.0'),
      }),
    })
    expect(out).toContain('No package changes recorded.')
  })

  it('stays silent when a relocation redistributes consumers across surviving copies', () => {
    // The nested 1.1.0 copy moves from under `a` to under `b`, so the two
    // consumers trade which surviving copy they resolve — while every
    // version at every surviving path, and every multiset, holds still.
    // Deliberately no line: the summary is an on-disk inventory, and
    // per-consumer resolution is the validator's walk, which hard-fails
    // this exact reshape whenever it crosses a major.
    const manifest = { dependencies: { a: '^1.0.0', b: '^1.0.0' } }
    const mk = (nestedUnder) =>
      lock({
        '': { dependencies: { a: '^1.0.0', b: '^1.0.0' } },
        'node_modules/a': pkg('1.0.0', { foo: '^1.0.0' }),
        'node_modules/b': pkg('1.0.0', { foo: '^1.0.0' }),
        'node_modules/foo': pkg('1.2.0'),
        [`node_modules/${nestedUnder}/node_modules/foo`]: pkg('1.1.0'),
      })
    const out = updateSummary({
      manifestBefore: manifest,
      manifestAfter: manifest,
      lockBefore: mk('a'),
      lockAfter: mk('b'),
    })
    expect(out).toContain('No package changes recorded.')
  })

  it('degrades to a manifest-only listing, with a note, on a lockfile it cannot read', () => {
    const out = updateSummary({
      manifestBefore: { dependencies: { alpha: '^1.2.0' } },
      manifestAfter: { dependencies: { alpha: '^1.9.9' } },
      lockBefore: { lockfileVersion: 1 },
      lockAfter: { lockfileVersion: 1 },
    })
    expect(out).toContain('- `alpha` (`^1.2.0` → `^1.9.9`)')
    expect(out).toContain('range moves are listed')
  })

  it('says so when nothing moved, rather than emitting an empty section', () => {
    const manifest = { dependencies: { a: '^1.0.0' } }
    const treeShape = lock({ '': { dependencies: { a: '^1.0.0' } }, 'node_modules/a': pkg('1.0.0') })
    const out = updateSummary({
      manifestBefore: manifest,
      manifestAfter: manifest,
      lockBefore: treeShape,
      lockAfter: treeShape,
    })
    expect(out).toContain('No package changes recorded.')
  })
})
