#!/usr/bin/env node
// Validates the diff the monthly dependency update produced, from the publish
// job — a runner that installed nothing and executed no dependency code. See
// AGENTS.md "Dependency updates" for why the validation lives there rather
// than on the machine that ran the batch.
//
// This is a checked-in script, not a `node -e` string in the workflow, for two
// reasons that both cost real time before:
//
//   1. A single-quoted shell argument ends at the first apostrophe. One in a
//      comment truncated the program from 7247 to 4905 characters, and the
//      remainder was still valid JS that exited 0 — silently skipping every
//      rule below the cut, with nothing red anywhere.
//   2. A graph algorithm with no unit tests cannot be reasoned about by
//      inspection. Its blind spots were found by review rather than by the
//      suite, repeatedly, and each fix reopened the previous one.
//
// Everything here is a pure function over parsed JSON, exported for
// check-dependency-update.test.ts. The CLI at the bottom is the only part that
// touches git or the filesystem. Run with no arguments to validate; run with
// `summary` to print the PR-body section that names every package the batch
// moved — generated here, in the same clean context as the validation, so the
// body's claims are as trustworthy as the verdict rather than being whatever
// the machine that ran the batch chose to report.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

// The fields npm records for a package's own dependency edges. Listing them
// explicitly rather than walking every key keeps `engines` and friends out.
// An optional or peer edge npm DID install is a real consumer resolving to a
// real copy and can cross a major like any other, so all four count.
//
// `devDependencies` belongs here even though a dependency's dev deps are never
// installed, because npm does not record them for a dependency: it strips the
// field from an installed tarball's entry and writes it only for the root and
// for `link: true` workspace entries — exactly the places where those edges ARE
// installed and resolve to a real copy. Omitting it left the root's dev edges
// uncompared, which is most of what this repo declares.
const EDGE_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const canon = (v) =>
  v === null || typeof v !== "object"
    ? v
    : Array.isArray(v)
      ? v.map(canon)
      : Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon(v[k])]),
        );

const stripDeps = (o) =>
  canon(Object.fromEntries(Object.entries(o).filter(([k]) => !DEP_SECTIONS.includes(k))));

const parseRange = (r) => {
  const m = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(String(r));
  return m ? { op: m[1], v: [+m[2], +m[3], +m[4]] } : null;
};

const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

// Exclusive upper bound of a range, per npm caret/tilde semantics. `^0.6.0`
// allows < 0.7.0, not < 1.0.0 — caret on a 0.x package pins the minor.
const ceil = ({ op, v: [x, y, z] }) =>
  op === "^"
    ? x > 0
      ? [x + 1, 0, 0]
      : y > 0
        ? [0, y + 1, 0]
        : [0, 0, z + 1]
    : op === "~"
      ? [x, y + 1, 0]
      : [x, y, z + 1];

/**
 * What `npm update` is allowed to have done to package.json.
 *
 * Two separate claims: everything outside the dependency sections is
 * untouched, and inside them every move stays within the range that was
 * already declared. The first matters because a filename allowlist still lets
 * package.json itself be rewritten — a postinstall pointing `scripts.test` at
 * `true` would make the reported checks meaningless while the diff still read
 * as an ordinary bump.
 *
 * Comparing majors would not be enough for the second: `^2.17.6` -> `^2.0.0`
 * keeps the major while downgrading, and `^0.6.0` -> `^0.7.0` keeps it while
 * stepping outside what caret means on a 0.x package. So the test is the real
 * one — does the new floor satisfy the OLD range.
 */
export function manifestFailures(before, after) {
  const out = [];

  if (JSON.stringify(stripDeps(before)) !== JSON.stringify(stripDeps(after))) {
    out.push(
      "package.json changed outside its dependency sections. `npm update` does not do that — inspect before trusting this batch.",
    );
  }

  for (const section of DEP_SECTIONS) {
    const a = before[section] || {};
    const b = after[section] || {};
    for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!(name in a)) {
        out.push(`${section}.${name} was ADDED; npm update does not add packages.`);
        continue;
      }
      if (!(name in b)) {
        out.push(`${section}.${name} was REMOVED; npm update does not remove packages.`);
        continue;
      }
      if (a[name] === b[name]) continue;

      const from = parseRange(a[name]);
      const to = parseRange(b[name]);
      // Deliberately conservative: a prerelease or exotic range this validator
      // cannot model stops the run rather than being waved through on the
      // assumption that it is fine.
      if (!from || !to) {
        out.push(
          `${section}.${name}: ${a[name]} -> ${b[name]} is not a plain X.Y.Z registry range this job can validate.`,
        );
        continue;
      }
      if (from.op !== to.op) {
        out.push(`${section}.${name} changed its range operator: ${a[name]} -> ${b[name]}.`);
        continue;
      }
      if (cmp(to.v, from.v) < 0 || cmp(to.v, ceil(from)) >= 0) {
        out.push(
          `${section}.${name} moved outside its existing range: ${a[name]} -> ${b[name]}. npm update only bumps the floor to a version the declared range already allowed.`,
        );
      }
    }
  }

  return out;
}

const ROOT = "";

export const majorOf = (version) => {
  const m = /^\d+/.exec(String(version));
  return m ? m[0] : null;
};

/**
 * Resolve one dependency edge the way npm does: from the dependent directory,
 * walk up through each ancestor node_modules until one holds the name. That is
 * the copy the consumer actually gets.
 */
export function resolveEdgeInstance(packages, fromPath, name) {
  let prefix = fromPath;
  for (;;) {
    const candidate = (prefix ? prefix + "/" : "") + "node_modules/" + name;
    const entry = packages[candidate];
    if (entry && entry.version) return { path: candidate, name, version: entry.version, entry };
    if (!prefix) return null;
    const cut = prefix.lastIndexOf("/node_modules/");
    prefix = cut === -1 ? "" : prefix.slice(0, cut);
  }
}

export function resolveEdge(packages, fromPath, name) {
  const found = resolveEdgeInstance(packages, fromPath, name);
  return found ? found.version : null;
}

// Every value Node can report for `process.arch` / `process.platform`. A `cpu`
// or `os` constraint that no member of these satisfies can never match a
// running Node, so npm never installs that package — anywhere, for anyone.
//
// These must be SUPERSETS of what Node actually reports, and the asymmetry is
// the whole reason to say so: a MISSING entry makes a real package look
// impossible, prunes it and its whole subtree, and costs a missed major, while
// an extra one costs a single comparison. So values Node has since dropped
// (mips, ppc, s390) stay, and anything plausible is kept rather than trimmed.
// `haiku` was missing from the platform list and is exactly that failure —
// a real Node port whose optional packages would have been pruned silently.
//
// A test asserts these cover `NodeJS.Platform` / `NodeJS.Architecture` from
// the pinned `@types/node`, so a new Node port fails CI instead of quietly
// widening the blind spot. (gedmap has no `@types/node`; the script is
// byte-identical across the three repos, so the guard there is the copy.)
export const NODE_ARCH = [
  "arm", "arm64", "ia32", "loong64", "mips", "mipsel",
  "ppc", "ppc64", "riscv64", "s390", "s390x", "x64",
];
export const NODE_PLATFORM = [
  "aix", "android", "cygwin", "darwin", "freebsd", "haiku", "linux",
  "netbsd", "openbsd", "openharmony", "sunos", "win32",
];

// The one value seen in a real lockfile that is NOT a Node target: npm skips
// `@tailwindcss/oxide-wasm32-wasi` on every platform, which is the whole
// reason this file has an installability rule. Kept as an explicit list so the
// lockfile guard in the tests has something to check against — a new `cpu`/`os`
// value appearing in a batch has to be classified deliberately rather than
// silently defaulting to "impossible", which would prune it and its subtree.
export const NOT_A_NODE_TARGET = ["wasm32"];

/**
 * `checkList` from `npm-install-checks` — the matcher npm itself uses for
 * `cpu`/`os`. TRANSCRIBED, not paraphrased, and that is the whole point: three
 * separate review findings on this file were the same mistake three times over,
 * each one a plausible reading of what npm "obviously" does with a lone `any`,
 * with a negation, with a bare string. Every reading was wrong in a different
 * direction. Where npm's syntax carries its own meaning, run npm's code.
 *
 * The only divergence is `String(entry)`, which npm does not need because a
 * malformed non-string entry would throw there; here it cannot crash the job.
 */
const checkList = (value, list) => {
  if (typeof list === "string") list = [list];
  if (list.length === 1 && list[0] === "any") return true;
  // match none of the negated values, and at least one of the
  // non-negated values, if any are present.
  let negated = 0;
  let match = false;
  for (const entry of list) {
    const item = String(entry);
    const negate = item.charAt(0) === "!";
    const test = negate ? item.slice(1) : item;
    if (negate) {
      negated++;
      if (value === test) return false;
    } else {
      match = match || value === test;
    }
  }
  return match || negated === list.length;
};

/**
 * Can npm ever put this package on disk?
 *
 * Only ever false for an OPTIONAL package whose `cpu`/`os` no Node target
 * satisfies. `@tailwindcss/oxide-wasm32-wasi` is the live example: `cpu:
 * ["wasm32"]`, and `wasm32` is not a value `process.arch` takes, so it is
 * skipped on every platform. Its dependencies are BUNDLED, and `npm update`
 * dissolves that bundle and re-resolves them from the registry — which is how
 * a 1.x -> 2.x jump (and an `@emnapi` prerelease, dragged in by a sibling
 * whose `latest` tag had already moved to 2.x) appeared in a batch that
 * installs none of it. Comparing edges of a package nothing installs reports a
 * crossing nobody can experience, and for an unattended weekly job that is a
 * standing false alarm.
 *
 * Deliberately narrow. The test is "no Node target at all", NOT "not the
 * platform this runner happens to be" — `@rolldown/binding-darwin-arm64` is a
 * real install on a real machine, so a major crossing under it still has to be
 * caught here even though CI runs linux/x64. And `optional` is required: a
 * NON-optional package with an impossible `cpu` fails the install outright,
 * which is worth surfacing rather than skipping.
 *
 * `libc` is not modeled. Leaving a constraint out can only make the answer
 * *more* installable, and that is the safe direction: a wrong keep costs one
 * comparison, where a wrong prune costs a missed major.
 */
const isInstallable = (entry) => {
  if (!entry || !entry.optional) return true;
  const someTargetMatches = (field, domain) => {
    const list = entry[field];
    // npm reads this as `target.cpu ? checkList(...) : true`, so absent or
    // otherwise falsy is unconstrained. A shape npm would throw on is treated
    // as unconstrained too — the safe direction, per the note above.
    if (!list) return true;
    if (typeof list !== "string" && !Array.isArray(list)) return true;
    return domain.some((value) => checkList(value, list));
  };
  return someTargetMatches("cpu", NODE_ARCH) && someTargetMatches("os", NODE_PLATFORM);
};

const edgeNames = (entry) => {
  const names = new Set();
  for (const field of EDGE_FIELDS) {
    for (const name of Object.keys((entry && entry[field]) || {})) names.add(name);
  }
  return names;
};

const label = (instance) =>
  instance.path === ROOT
    ? "the root package"
    : `${instance.name}@${instance.version} (${instance.path})`;

/**
 * Every consumer whose resolved major for some dependency moved.
 *
 * package.json only governs DIRECT dependencies. A bare `npm update` also
 * moves subdependencies to whatever their own ranges allow, and a transitive
 * range of `*` or `>=x` permits a major — which would never show up in the
 * manifest diff.
 *
 * ONE rule, and the two that used to sit beside it are gone — which reverses a
 * decision recorded here at length, so here is the reasoning.
 *
 * They were a BY PATH comparison (an entry present before and after whose own
 * major moved) and a BY NAME one (the set of majors a package resolves to,
 * changed in either direction). Both were kept as cheap corroboration after
 * measurement showed the instance rule already rejected everything they
 * rejected, on the principle that "the new rule subsumes the old one" had been
 * wrong every previous round.
 *
 * What that principle is about is COVERAGE, and it still holds there. It says
 * nothing about correctness, and these two turned out to be unsound in a way
 * the instance rule is not: they are aggregates over the whole tree, so they
 * cannot tell a crossing from an add-and-drop. One package dropping `bar@1`
 * while an unrelated one picks up `bar@2` changes the by-name major set and
 * moves the major at a shared path, and both fire — rejecting a legitimate
 * monthly batch. Liveness is what distinguishes those cases, and an aggregate
 * has no consumer to ask, so there is no version of them that could be gated.
 *
 * Corroboration that raises false alarms is not corroboration. Keeping them
 * would trade a silent miss (which the instance rule does not have on any
 * fixture) for a noisy stop on ordinary updates, which is the worse failure
 * for an unattended job: a run that cries wolf every month gets ignored, and
 * then the real one is ignored too.
 */
export function lockfileFailures(beforePackages, afterPackages) {
  const out = [];

  // BY MATCHED INSTANCE. A summary of the tree can hold perfectly still while
  // a consumer moves underneath it — drop a nested foo@1 so its dependent
  // falls through to an already-hoisted foo@2, and as long as some other
  // dependent kept a foo@1, no path changed major and the major set for foo is
  // still {1,2}. Only the consumer's own resolution sees that.
  //
  // The root and any workspaces are seeded directly. They have a stable
  // identity — a path in the repo, which `npm update` does not move — and real
  // installed edges of their own, so pairing them with themselves is a fact
  // rather than the hypothesis the matcher produces for a resolved copy.
  //
  // A workspace needs seeding here or it is invisible: npm splits it across two
  // entries, and neither is a resolved package. The versioned one sits at its repo
  // path (`packages/a`) with no `node_modules/` segment; the one under
  // `node_modules` is a bare `link: true` record with no version. Its
  // devDependencies ARE installed — that is why `EDGE_FIELDS` includes the
  // field at all — so leaving it out would have gone on claiming a walk of the
  // dev-tooling tree that never happened for a workspace repo.
  const consumers = [];
  for (const path of Object.keys(beforePackages)) {
    // The root, plus every workspace: a `packages` key with no `node_modules/`
    // segment is one or the other. Everything else is a resolved copy and
    // belongs to the matcher.
    if (path.includes("node_modules/")) continue;
    const before = beforePackages[path];
    const after = afterPackages[path];
    if (!before || !after) continue;
    const name = path === ROOT ? ROOT : String(before.name || path);
    consumers.push({
      before: { path, name, version: before.version || "", entry: before },
      after: { path, name, version: after.version || "", entry: after },
    });
  }
  // Everything the matcher could not pair by LOCATION needs its liveness
  // established before its edges are compared. Three shapes, one question.
  //
  //   removed  — an instance vanished. When two identical copies dedupe to
  //              one, the matcher pairs a survivor and leaves the other here;
  //              if the vanished copy resolved a different major than the
  //              survivor does, whoever depended on it crossed, and both
  //              summaries can hold still through it.
  //   added    — the mirror: a package that used to fall through to a hoisted
  //              copy now has its own nested one, and its dependents moved
  //              onto it.
  //   moved    — the matcher paired two instances at different locations
  //              (same version, or same major). That pairing is a hypothesis,
  //              not a fact: one dependency dropping `bar@1` while an
  //              unrelated one adds `bar@1` produces exactly this shape out of
  //              two copies that have nothing to do with each other.
  //
  // The question in all three: did a real consumer move FROM the before
  // instance TO the after instance? It has to declare the name on BOTH sides
  // — resolution is positional, so an instance merely being reachable from a
  // consumer is not evidence it was used, and a consumer that only declares it
  // on one side is an add or a drop rather than a crossing — and its own
  // resolution has to land on this exact pair at both ends.
  //
  // TO A FIXED POINT, because liveness chains. Two levels can dedupe in the
  // same update — both the `a` copies and the `bar` copies collapse — and then
  // the orphaned `bar` is used only by the orphaned `a`. Asking against a
  // SNAPSHOT of the location-matched pairs answers "nobody" for `bar` and
  // drops it, with every summary holding still. An admitted pair is a real
  // consumer: it got in only by proving its own live dependent, so every chain
  // terminates at a location-matched pair and nothing bootstraps itself in.
  // THE TRAVERSAL. Start from the seeded consumers and follow every edge they
  // declare on BOTH sides: compare the major each side resolves, then recurse
  // into the pair that edge lands on.
  //
  // The pair comes from the CONSUMER'S OWN RESOLUTION, never from guessing
  // which instance "became" which. Earlier rounds of this check derived pairs
  // by matching instances across the two trees and then asked whether some
  // consumer had moved across each guess. That is strictly weaker, in a way
  // that is not obvious: a matcher produces an EXCLUSIVE one-to-one pairing,
  // so when consumers merely REDISTRIBUTE across copies that all survive —
  // one dependent stays on the nested copy while another moves to the hoisted
  // one — the move is not any pairing. Both copies pair with themselves, both
  // are vouched for by whichever dependent stayed, and the dependent that
  // moved is represented nowhere. Its transitive major crosses in silence.
  //
  // Asking the consumer removes the guess, and with it the entire apparatus
  // built to compensate for guessing: hypotheses, splitting a rejected
  // pairing, the order to split them in, and the cycle in that order.
  //
  // `seen` keys on the PAIR, not on either path. The same instance can be
  // reached from several consumers, and two consumers landing on different
  // after-copies of it are two different moves — both have to be walked.
  const seen = new Set();
  for (let i = 0; i < consumers.length; i++) {
    const pair = consumers[i];
    const key = pair.before.path + "\u0000" + pair.after.path;
    if (seen.has(key)) continue;
    seen.add(key);

    const declaredBefore = edgeNames(pair.before.entry);
    const declaredAfter = edgeNames(pair.after.entry);
    for (const dep of [...declaredBefore].sort()) {
      // An edge the bump added or dropped is a legitimate change of what this
      // package depends on, not a crossing. Only edges present on BOTH sides
      // have a before-and-after to compare — which is also what keeps a
      // legitimately dropped dependency from being read as one.
      if (!declaredAfter.has(dep)) continue;

      const was = resolveEdgeInstance(beforePackages, pair.before.path, dep);
      const now = resolveEdgeInstance(afterPackages, pair.after.path, dep);

      // What this edge actually puts on disk, on each side. A copy no platform
      // can install is not on disk any more than a missing one is, so the two
      // collapse into the same case.
      //
      // This has to happen HERE rather than when the package is popped as a
      // consumer: by then its own major has already been compared and reported
      // by its parent, so a consumer-level skip would suppress only the subtree
      // under a false alarm it had just emitted. Filtering the edge reaches
      // both, since the only way into that subtree is through this edge — which
      // is what matters for a bundled one, whose nested entries carry no `cpu`
      // of their own and would otherwise read as ordinary packages.
      //
      // Both sides must be uninstallable to prune. A package that BECOMES
      // installable is real code arriving in the tree, and its subtree has to
      // be walked; pruning on either side alone would let a major under it
      // through. The reverse is the same argument reversed.
      const onDisk = (resolved) => (resolved && isInstallable(resolved.entry) ? resolved : null);
      if (!onDisk(was) && !onDisk(now)) continue;

      // Neither resolves: an optional or peer edge npm declined to install on
      // both sides. Nothing to compare.
      if (!was && !now) continue;
      if (!was || !now) {
        out.push(
          `${label(pair.before)} declares ${dep} on both sides but it resolves to a copy on only one of them (${was ? was.version : "nothing"} -> ${now ? now.version : "nothing"}). This job cannot tell whether that crossed a major.`,
        );
        continue;
      }
      if (majorOf(was.version) !== majorOf(now.version)) {
        out.push(
          `${label(pair.before)} now resolves ${dep} to a different major: ${was.version} -> ${now.version}. Even a transitive major is a deliberate migration, not a monthly batch.`,
        );
      }
      // Whatever this consumer resolves to is a live pair by construction, so
      // its own edges are next.
      consumers.push({ before: was, after: now });
    }
  }

  // A replacement instance can be reached both as a matched pair and as the
  // fall-through for a deduped copy, so the same crossing can be described
  // twice. Report each distinct one once.
  return [...new Set(out)];
}

export function allFailures({ manifestBefore, manifestAfter, lockBefore, lockAfter }) {
  return [
    ...manifestFailures(manifestBefore, manifestAfter),
    ...lockfileFailures(lockBefore.packages || {}, lockAfter.packages || {}),
  ];
}

// A packages key that points outside the repository: a `file:` dependency
// on a sibling directory (`../foo`) or an absolute path. Its manifest is
// not in this tree, so nothing here can read it — it is neither a
// workspace nor a registry package. `..foo` is a legal (if odd) in-repo
// directory name, so the test is the `../` prefix, not the leading dots.
export function isOutsideRepository(path) {
  return (
    path === ".." ||
    path.startsWith("../") ||
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

// Every workspace a packages map records: a key with no node_modules/
// segment that is not the root and lies inside the repository. These are
// the entries whose manifests live in this tree rather than in a registry
// tarball — the summary treats what they declare as direct, exactly as the
// root's own declarations are.
export function workspacePaths(packages) {
  return Object.keys(packages)
    .filter(
      (path) =>
        path !== ROOT &&
        !path.includes("node_modules/") &&
        !isOutsideRepository(path),
    )
    .sort();
}

// Every installed copy the lockfile records, grouped by package name and
// keyed by the copy's lockfile path — every copy, not the distinct versions,
// so two identical copies deduping into one still reads as a change, and the
// path identity lets a caller tell a directly-resolved copy from a nested
// one. Only entries under a node_modules/ segment with a version are
// dependencies: the root, workspaces and out-of-repo file: paths have no such
// segment, and a workspace's `link: true` mirror under node_modules carries
// no version, so all of them fall out of the same two tests.
export function installedVersions(packages) {
  const byName = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    const cut = path.lastIndexOf("node_modules/");
    if (cut === -1 || !entry || !entry.version) continue;
    const name = path.slice(cut + "node_modules/".length);
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name).set(path, entry.version);
  }
  return byName;
}

/**
 * The PR-body section naming every package the batch moved. Everything above
 * decides whether the batch is acceptable; this describes what it did, for
 * the reviewer the PR is assigned to — the diffstat the body used to carry
 * says how many lockfile lines churned, which is exactly the part the body
 * itself tells reviewers not to read.
 *
 * Direct versus transitive is the split that matters to a reviewer: a direct
 * move is a range the repo declared, while a transitive one is npm exercising
 * some dependency's own range — invisible in the package.json diff, and the
 * kind of change the lockfile walk above exists to police. The bucket is
 * decided by RESOLUTION, not by name: the copies the root and workspaces
 * actually resolve (per npm's walk-up rule) compare as direct, the nested
 * rest compare separately as transitive — so a name that is both a direct
 * dependency and someone's nested copy is not mislabeled when only the
 * nested copy moves, and can honestly appear in both lists when both do.
 *
 * Versions are compared as the MULTISET of a name's installed copies, and
 * rendered with counts (`1.0.0 ×2`) when a version has several: one name can
 * legitimately have several installed copies, and a nested copy appearing or
 * collapsing is a real change worth a line, not noise to dedupe away — a
 * plain set of versions would render a same-version dedupe invisible.
 *
 * Copies at a path present on both sides also compare individually, so two
 * consumers trading versions — every multiset unchanged — still get their
 * per-path moves listed. The deliberate boundary: this is an inventory of
 * what is ON DISK, not of who resolves what. A copy relocating at the same
 * version keeps the inventory identical and gets no line, even though a
 * relocation can shuffle which surviving same-major copy each consumer
 * resolves. Re-deriving per-consumer resolution here would duplicate the
 * validator's walk above — the walk that already runs on every batch and
 * hard-fails the redistribution that carries risk, a changed major. The
 * summary states its granularity rather than pretending to more.
 *
 * Purely informational — nothing here gates anything, and a lockfile shape
 * the walk cannot read degrades to a manifest-only listing with a note
 * saying so, rather than an empty section that reads as "nothing moved".
 */
export function updateSummary({ manifestBefore, manifestAfter, lockBefore, lockAfter, workspaces = {} }) {
  const isObject = (v) => typeof v === "object" && v !== null;
  const walkable = isObject(lockBefore?.packages) && isObject(lockAfter?.packages);
  // What a side actually puts on disk: drop copies no platform can ever
  // install — an optional package whose cpu/os no Node target satisfies —
  // and everything recorded beneath them, since bundled dependencies carry
  // no cpu/os of their own and the only way to them is through the package
  // that bundles them. `npm update` dissolves and re-resolves bundles
  // nothing installs, so without this the body reports changes no user can
  // receive. Per side, not both-sides like the validator's edge prune: a
  // package BECOMING installable is real code arriving and shows as added,
  // the reverse as removed.
  const onDisk = (packages) => {
    const dead = Object.entries(packages)
      .filter(([, entry]) => !isInstallable(entry))
      .map(([path]) => path);
    if (!dead.length) return packages;
    return Object.fromEntries(
      Object.entries(packages).filter(
        ([path]) => !dead.some((d) => path === d || path.startsWith(d + "/")),
      ),
    );
  };
  const verBefore = walkable ? installedVersions(onDisk(lockBefore.packages)) : new Map();
  const verAfter = walkable ? installedVersions(onDisk(lockAfter.packages)) : new Map();

  // Range moves per declaring manifest, keyed by name. The section is named
  // only when it adds information: bare `dependencies` of the root is the
  // default reading, everything else says where the declaration lives.
  const rangeMoves = new Map();
  const recordMoves = (before, after, where) => {
    for (const section of DEP_SECTIONS) {
      const a = (before && before[section]) || {};
      const b = (after && after[section]) || {};
      for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (a[name] === b[name]) continue;
        const label =
          section === "dependencies" && !where ? "" : `, ${section}${where ? ` in ${where}` : ""}`;
        const from = name in a ? `\`${a[name]}\`` : "(absent)";
        const to = name in b ? `\`${b[name]}\`` : "(absent)";
        if (!rangeMoves.has(name)) rangeMoves.set(name, []);
        rangeMoves.get(name).push(`${from} → ${to}${label}`);
      }
    }
  };
  recordMoves(manifestBefore, manifestAfter, "");
  for (const path of Object.keys(workspaces).sort()) {
    recordMoves(workspaces[path].manifestBefore, workspaces[path].manifestAfter, path);
  }

  // Which consumers declare each name directly, per side: the root and every
  // workspace. Declaration alone does not make a copy direct — the declaring
  // consumer's own RESOLUTION does, below — but it says whose resolution to
  // ask for.
  const declarersFor = (rootManifest, side) => {
    const byName = new Map();
    const add = (manifest, path) => {
      for (const section of DEP_SECTIONS) {
        for (const name of Object.keys((manifest && manifest[section]) || {})) {
          if (!byName.has(name)) byName.set(name, new Set());
          byName.get(name).add(path);
        }
      }
    };
    add(rootManifest, ROOT);
    for (const [path, pair] of Object.entries(workspaces)) add(pair[side], path);
    return byName;
  };
  const declBefore = declarersFor(manifestBefore, "manifestBefore");
  const declAfter = declarersFor(manifestAfter, "manifestAfter");

  // Numeric-aware ordering so `10.0.0` sorts after `9.0.0`; display only, so
  // prereleases and other shapes semver orders differently are fine as-is.
  const byVersion = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
  const fmt = (versions) => {
    const counts = new Map();
    for (const v of [...(versions ?? [])].sort(byVersion)) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts].map(([v, n]) => (n > 1 ? `${v} ×${n}` : v)).join(", ");
  };

  // One name's copies, split into the instances its direct declarers resolve
  // and the nested rest — by path identity, so two declarers landing on the
  // same hoisted copy count it once. Maps keyed by path, because the paths
  // are evidence movement() needs below.
  const split = (packages, name, copies, declSet) => {
    const directPaths = new Set();
    for (const consumer of declSet ?? []) {
      const instance = resolveEdgeInstance(packages, consumer, name);
      if (instance) directPaths.add(instance.path);
    }
    const direct = new Map();
    const nested = new Map();
    for (const [path, version] of copies ?? []) {
      (directPaths.has(path) ? direct : nested).set(path, version);
    }
    return { direct, nested };
  };

  const movement = (before, after) => {
    const was = [...before.values()];
    const now = [...after.values()];
    if (fmt(was) !== fmt(now)) {
      return was.length && now.length
        ? ` ${fmt(was)} → ${fmt(now)}`
        : now.length
          ? ` added at ${fmt(now)}`
          : ` removed (was ${fmt(was)})`;
    }
    // The multiset can hold perfectly still while versions trade places —
    // one copy moving 1.1.0 -> 1.2.0 while another moves back. A version
    // changing at a path present on BOTH sides is a real move at a stable
    // location, so those compare individually, labeled by path. A copy
    // RELOCATING at the same version stays silent on purpose: the on-disk
    // inventory is identical, and the consumer-resolution shifts a
    // relocation can cause are the validator's walk — which hard-fails the
    // ones that matter, a changed major. See the doc comment's boundary.
    const moves = [];
    for (const [path, version] of before) {
      const v = after.get(path);
      if (v !== undefined && v !== version) moves.push(`${version} → ${v} (${path})`);
    }
    return moves.length ? ` ${moves.join(", ")}` : "";
  };

  const names = [...new Set([...verBefore.keys(), ...verAfter.keys(), ...rangeMoves.keys()])].sort();
  const direct = [];
  const transitive = [];
  const none = { direct: new Map(), nested: new Map() };
  for (const name of names) {
    const b = walkable ? split(lockBefore.packages, name, verBefore.get(name), declBefore.get(name)) : none;
    const a = walkable ? split(lockAfter.packages, name, verAfter.get(name), declAfter.get(name)) : none;
    const ranges = rangeMoves.get(name) ?? [];
    const directPart = movement(b.direct, a.direct);
    const nestedPart = movement(b.nested, a.nested);
    const range = ranges.length ? ` (${ranges.join("; ")})` : "";
    if (directPart || range) direct.push(`- \`${name}\`${directPart}${range}`);
    if (nestedPart) transitive.push(`- \`${name}\`${nestedPart}`);
  }

  const lines = ["## Updated packages", ""];
  if (!direct.length && !transitive.length) {
    lines.push("No package changes recorded.");
  } else {
    lines.push(`Packages changed: ${direct.length} direct, ${transitive.length} transitive.`);
    if (direct.length) lines.push("", "### Direct", "", ...direct);
    if (transitive.length) lines.push("", "### Transitive", "", ...transitive);
  }
  if (!walkable) {
    lines.push(
      "",
      "> A lockfile here has no `packages` map this summary can read, so only",
      "> `package.json` range moves are listed. The validation step fails on",
      "> the same shape, so this note should never appear on an open PR.",
    );
  }
  return lines.join("\n") + "\n";
}

function main() {
  const mode = process.argv[2];
  // A typo'd mode must not fall through to validation: the caller wanted the
  // summary, and a green validation run on stdout would be quietly embedded
  // in the PR body in its place.
  if (mode !== undefined && mode !== "summary") {
    console.error(
      `Unknown mode "${mode}". Run with no arguments to validate, or "summary" for the PR-body section.`,
    );
    process.exit(2);
  }

  const show = (path) =>
    JSON.parse(execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" }));
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));

  const lockBefore = show("package-lock.json");
  const lockAfter = read("package-lock.json");

  // Workspace manifests, discovered from the lockfiles rather than from the
  // root manifest's `workspaces` globs: the lockfile names the paths
  // directly. This repository has none today; the discovery is what keeps
  // the summary's direct/transitive split honest the day one appears,
  // instead of quietly reporting workspace-declared packages as transitive.
  const workspaces = {};
  for (const path of new Set([
    ...workspacePaths(lockBefore.packages ?? {}),
    ...workspacePaths(lockAfter.packages ?? {}),
  ])) {
    workspaces[path] = {
      manifestBefore: show(`${path}/package.json`),
      manifestAfter: read(`${path}/package.json`),
    };
  }

  const inputs = {
    manifestBefore: show("package.json"),
    manifestAfter: read("package.json"),
    lockBefore,
    lockAfter,
    workspaces,
  };

  if (mode === "summary") {
    process.stdout.write(updateSummary(inputs));
    return;
  }

  const failures = allFailures(inputs);
  for (const failure of failures) console.error(`::error::${failure}`);
  if (failures.length) process.exit(1);
  console.log("Dependency diff validated: no majors, no out-of-range moves.");
}

// Only when run directly, so importing this from a test does not shell out.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
