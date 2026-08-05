// @vitest-environment node
//
// The monthly dependency update runs unattended and its PR never gets a normal
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

import {
  lockfileFailures,
  manifestFailures,
  majorOf,
  resolveEdge,
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
