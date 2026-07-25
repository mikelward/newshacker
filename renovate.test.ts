// @vitest-environment node
import { readFileSync } from 'node:fs';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';

// Renovate is deliberately unscheduled and in full mode: it may open a PR the
// moment an update clears its minimumReleaseAge cooldown, instead of waiting
// for a weekly window. Every failure mode here is silent — a bot that opens
// nothing looks exactly like a repo with nothing to update, which is how this
// repo sat inert for its first twelve days and accumulated four fixable
// high-severity advisories.
//
//  - reintroducing a `schedule` string parks every cooled-down update until the
//    next window, so a patch that cleared its cooldown on Sunday sits for six
//    days;
//  - DELETING `lockFileMaintenance.schedule` does not mean "any time" — that
//    option's Renovate default is `before 4am on monday`, so dropping the key
//    silently restores a weekly window rather than removing one;
//  - `mode` defaults to "full" in Renovate itself, but the Mend-hosted app
//    defaults an "All repositories" install to "silent", which suppresses PRs
//    AND the dependency dashboard. Stating it here is the repo-side half of
//    that override; the Mend UI setting is the other half and can't be tested.
//
// "at any time" is Renovate's own spelling for an unrestricted schedule; a
// typo'd variant is rejected by the schema, not silently ignored.

interface PackageRule {
  groupName?: string;
  matchPackageNames?: string[];
  matchUpdateTypes?: string[];
  matchManagers?: string[];
  matchCurrentVersion?: string;
  automerge?: boolean;
  minimumReleaseAge?: string;
  enabled?: boolean;
}

interface RenovateConfig {
  mode?: string;
  schedule?: string[];
  lockFileMaintenance?: { enabled?: boolean; schedule?: string[] };
  packageRules?: PackageRule[];
}

const config = JSON.parse(
  readFileSync(new URL('./renovate.json', import.meta.url), 'utf8'),
) as RenovateConfig;

describe('renovate.json schedule', () => {
  it('opts out of silent mode', () => {
    expect(config.mode).toBe('full');
  });

  it('lets Renovate run at any time', () => {
    expect(config.schedule).toEqual(['at any time']);
  });

  it('lets lock file maintenance run at any time', () => {
    expect(config.lockFileMaintenance?.enabled).toBe(true);
    expect(config.lockFileMaintenance?.schedule).toEqual(['at any time']);
  });
});

// Grouping keeps peer-related packages in one PR, and a hole in it is silent
// in the same way the schedule settings are: the update still lands, just as
// its own PR, so you only notice by recognizing a name that should have
// traveled with its family. readmo's eslint group matched `eslint-**` but not
// `@eslint/**`, so `@eslint/js` opened its own PR for months.
//
// Asserting the *patterns* would only catch deletion, not the likelier
// mistake — a pattern that no longer matches anything: a typo'd scope, a
// renamed package, a newly added plugin nobody grouped. So these resolve every
// real dependency in package.json through the rules and assert where each one
// lands. (Note `@eslint/*` is NOT such a mistake: under minimatch a single star
// still matches `@eslint/js`. That's why `matches` below models the two star
// forms separately instead of treating both as "any characters".)

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const dependencyNames = Object.keys({
  ...pkg.dependencies,
  ...pkg.devDependencies,
});

// Renovate matches package names with minimatch glob semantics, so this uses
// minimatch itself rather than approximating it.
//
// Two hand-rolled attempts both got it wrong, in opposite directions, and each
// time the *test* was the thing that lied: first `*` was modeled as crossing a
// path separator (so the guard would have failed a config Renovate accepts),
// then `**` was modeled as always crossing one (so the guard reported that
// `@fontsource**` matched `@fontsource-variable/inter`, which it does not —
// minimatch treats `**` as a globstar only when it is a whole path segment, and
// an embedded one behaves like `*`). That second error would have blessed a
// rule matching nothing.
//
// A regex approximation of minimatch is exactly the kind of thing that looks
// right until it silently disagrees on one pattern, which is the failure mode
// this whole file exists to catch — so the real implementation is the ground
// truth here, and `minimatch` is a declared devDependency for that reason.
const matches = (pattern: string, name: string): boolean =>
  minimatch(name, pattern);

// Later rules win in Renovate, so the group a package ends up in is the last
// matching rule that names one — not merely some rule that matches.
const groupOf = (name: string): string | undefined =>
  config.packageRules?.reduce<string | undefined>(
    (group, rule) =>
      rule.groupName && rule.matchPackageNames?.some((p) => matches(p, name))
        ? rule.groupName
        : group,
    undefined,
  );

describe('renovate.json package grouping', () => {
  it.each([
    ['eslint', /eslint/],
    [
      'testing',
      /^(@testing-library|@vitest)\/|^(vitest|happy-dom|jsdom|msw|fake-indexeddb)$/,
    ],
    ['react', /^react(-dom|-router-dom)?$/],
    ['tanstack', /^@tanstack\//],
  ])('puts every %s package in one group', (group, family) => {
    const members = dependencyNames.filter((name) => family.test(name));
    expect(members.length).toBeGreaterThan(0);
    for (const name of members) {
      expect(groupOf(name), `${name} should be grouped as "${group}"`).toBe(
        group,
      );
    }
  });
});

// The rules above are only worth having if they actually fire, and a rule that
// matches nothing is indistinguishable from a rule that works — no error, no
// warning, `renovate-config-validator` green. Two live examples this suite now
// pins down:
//
//  - `lockFileMaintenance` used to sit in the same rule as
//    `matchCurrentVersion: "!/^0/"`. A lockFileMaintenance branch refreshes the
//    whole lockfile and has no single dependency behind it, so currentVersion
//    is null and Renovate skips any rule carrying that predicate — those PRs
//    silently never auto-merged.
//  - the github-actions rule used to repeat `minimumReleaseAge: "7 days"`.
//    Being the last matching rule, that overwrote the 14-day major cooldown for
//    actions majors, quietly halving it.
//
// Both are last-wins accidents, so the assertions below resolve a query the way
// Renovate does rather than inspecting rules individually.

interface Query {
  updateType: string;
  currentVersion?: string;
  manager?: string;
  depName?: string;
}

const ruleApplies = (rule: PackageRule, q: Query): boolean => {
  if (rule.matchUpdateTypes && !rule.matchUpdateTypes.includes(q.updateType)) {
    return false;
  }
  if (rule.matchManagers && !rule.matchManagers.includes(q.manager ?? 'npm')) {
    return false;
  }
  if (
    rule.matchPackageNames &&
    !(q.depName && rule.matchPackageNames.some((p) => matches(p, q.depName!)))
  ) {
    return false;
  }
  if (rule.matchCurrentVersion !== undefined) {
    // Only the negated-regex form this config uses is modeled. Anything else
    // would be mis-modeled silently, which is the failure this file exists to
    // prevent — so fail loudly instead.
    const negated = /^!\/(.+)\/$/.exec(rule.matchCurrentVersion);
    if (!negated) {
      throw new Error(
        `unmodeled matchCurrentVersion: ${rule.matchCurrentVersion}`,
      );
    }
    if (q.currentVersion === undefined) return false;
    if (new RegExp(negated[1]).test(q.currentVersion)) return false;
  }
  return true;
};

const resolve = (q: Query): PackageRule =>
  (config.packageRules ?? []).reduce<PackageRule>(
    (acc, rule) =>
      ruleApplies(rule, q)
        ? {
            ...acc,
            ...(rule.automerge !== undefined && { automerge: rule.automerge }),
            ...(rule.minimumReleaseAge !== undefined && {
              minimumReleaseAge: rule.minimumReleaseAge,
            }),
            ...(rule.enabled !== undefined && { enabled: rule.enabled }),
          }
        : acc,
    {},
  );

describe('renovate.json effective rules', () => {
  it('auto-merges lock file maintenance', () => {
    expect(resolve({ updateType: 'lockFileMaintenance' }).automerge).toBe(true);
  });

  it('auto-merges a minor on a 1.x dependency', () => {
    expect(
      resolve({ updateType: 'minor', currentVersion: '1.2.3', depName: 'react' })
        .automerge,
    ).toBe(true);
  });

  it('does not auto-merge a minor on a 0.x dependency', () => {
    expect(
      resolve({
        updateType: 'minor',
        currentVersion: '0.5.0',
        depName: 'some-0x-package',
      }).automerge,
    ).not.toBe(true);
  });

  it('never auto-merges a major', () => {
    expect(
      resolve({ updateType: 'major', currentVersion: '1.2.3', depName: 'react' })
        .automerge,
    ).toBe(false);
  });

  it('keeps the 14-day major cooldown for github-actions', () => {
    expect(
      resolve({
        updateType: 'major',
        manager: 'github-actions',
        currentVersion: '4.0.0',
      }).minimumReleaseAge,
    ).toBe('14 days');
  });

  it('does not offer a @types/node major on its own', () => {
    expect(
      resolve({
        updateType: 'major',
        currentVersion: '24.0.0',
        depName: '@types/node',
      }).enabled,
    ).toBe(false);
  });
});
