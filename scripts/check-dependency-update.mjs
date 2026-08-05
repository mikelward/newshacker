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
// touches git or the filesystem.

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

function main() {
  const show = (path) =>
    JSON.parse(execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" }));
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));

  const failures = allFailures({
    manifestBefore: show("package.json"),
    manifestAfter: read("package.json"),
    lockBefore: show("package-lock.json"),
    lockAfter: read("package-lock.json"),
  });

  for (const failure of failures) console.error(`::error::${failure}`);
  if (failures.length) process.exit(1);
  console.log("Dependency diff validated: no majors, no out-of-range moves.");
}

// Only when run directly, so importing this from a test does not shell out.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
