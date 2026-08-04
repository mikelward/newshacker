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
  matchDepNames?: string[];
  matchUpdateTypes?: string[];
  matchManagers?: string[];
  matchCurrentVersion?: string;
  automerge?: boolean;
  minimumReleaseAge?: string;
  enabled?: boolean;
  dependencyDashboardApproval?: boolean;
}

interface RenovateConfig {
  mode?: string;
  constraints?: { npm?: string };
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
  engines: { node: string; npm: string };
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

// Renovate's cooldowns are only half of the story, and the missing half is
// silent in the usual way: `minimumReleaseAge` is applied at *lookup* time, so
// it governs the direct dependency a PR names and nothing else. Lock file
// maintenance never does a lookup — it deletes the lockfile and lets npm
// rebuild it — and those PRs auto-merge, so the highest-volume path to
// production was also the only one with no cooldown on it. Transitive
// dependencies escaped the same way inside ordinary bumps.
//
// `.npmrc`'s `min-release-age` closes both, because npm applies it while
// resolving. The two numbers have to stay in step or the guarantee quietly
// weakens, so this reads the cooldown out of renovate.json rather than
// hard-coding it in a second place.

const npmrc = readFileSync(new URL('./.npmrc', import.meta.url), 'utf8');

const shortestRenovateCooldownDays = Math.min(
  ...(config.packageRules ?? [])
    .map((rule) => rule.minimumReleaseAge)
    .filter((age): age is string => age !== undefined)
    .map((age) => {
      const days = /^(\d+) days?$/.exec(age);
      if (!days) throw new Error(`unmodeled minimumReleaseAge: ${age}`);
      return Number(days[1]);
    }),
);

describe('npm install-time cooldown', () => {
  it('sets a min-release-age window', () => {
    expect(npmrc).toMatch(/^min-release-age=\d+$/m);
  });

  it('is at least as strict as the shortest Renovate cooldown', () => {
    // Otherwise npm would admit a version renovate.json would have held back —
    // which is the exact gap this file exists to close, reopened by a number.
    const configured = Number(/^min-release-age=(\d+)$/m.exec(npmrc)?.[1]);
    expect(configured).toBeGreaterThanOrEqual(shortestRenovateCooldownDays);
  });

  // The window is only as real as the npm that applies it. `min-release-age`
  // landed in npm 11.10.0 and is *silently ignored* before that — an
  // "Unknown project config" warning and a resolve that proceeds as if the
  // file said nothing. So the floor can't be inferred from the Node major:
  // Node 24.12.0 bundles npm 11.6.2 (ignores it), 24.14.1 bundles 11.11.0
  // (honors it). Both consumers that resolve get an explicit floor.
  // Compared as major*1000+minor, NOT as a decimal: 11.9 > 11.1 as a float,
  // but npm 11.9.0 is OLDER than 11.10.0 — a float compare here would bless
  // exactly the versions that ignore the setting.
  const npmVersionKey = (major: number, minor: number): number =>
    major * 1000 + minor;
  const MIN_NPM = npmVersionKey(11, 10); // the release that added the option

  const floorOf = (range: string): number => {
    const m = /^>=(\d+)\.(\d+)\.\d+$/.exec(range);
    if (!m) throw new Error(`unmodeled npm constraint: ${range}`);
    return npmVersionKey(Number(m[1]), Number(m[2]));
  };

  it('requires an npm that implements the option, for local and Vercel installs', () => {
    expect(floorOf(pkg.engines.npm)).toBeGreaterThanOrEqual(MIN_NPM);
  });

  it('requires the same npm of Renovate, which regenerates the lockfile', () => {
    // The path the window exists to cover. Without this, lock file
    // maintenance could keep rebuilding the lockfile with an npm that has
    // never heard of the setting — no error, just no cooldown.
    expect(floorOf(config.constraints?.npm ?? '')).toBeGreaterThanOrEqual(
      MIN_NPM,
    );
  });
});

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
  if (
    rule.matchDepNames &&
    !(q.depName && rule.matchDepNames.some((p) => matches(p, q.depName!)))
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
            ...(rule.dependencyDashboardApproval !== undefined && {
              dependencyDashboardApproval: rule.dependencyDashboardApproval,
            }),
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

  it('does not offer a typescript major on its own', () => {
    expect(
      resolve({
        updateType: 'major',
        currentVersion: '6.0.3',
        depName: 'typescript',
      }).enabled,
    ).toBe(false);
  });

  it.each(['minor', 'patch'])(
    'does not offer a Node runtime %s',
    (updateType) => {
      // `.nvmrc` deliberately holds the bare major, and the nvm manager can
      // only write a full version — so this update type has no mergeable
      // form. The runtime already picks up patches without a commit.
      expect(
        resolve({ updateType, currentVersion: '24.17.0', depName: 'node' })
          .enabled,
      ).toBe(false);
    },
  );

  it('holds a Node major on the dashboard rather than opening a PR', () => {
    // Not `enabled: false`: a new LTS is the one Node change we do want to
    // hear about. Approval is the seam between "Renovate noticed" and "a human
    // is doing the three-file migration".
    const major = resolve({
      updateType: 'major',
      currentVersion: '24.17.0',
      depName: 'node',
    });
    expect(major.enabled).not.toBe(false);
    expect(major.dependencyDashboardApproval).toBe(true);
  });

  it('leaves other packages beginning with "node" alone', () => {
    // `matchDepNames: ["node"]` is exact under minimatch, but a later edit to
    // `node*` would silently mute a whole family of real dependencies —
    // `node-html-parser` is a direct dependency here.
    expect(
      resolve({
        updateType: 'patch',
        currentVersion: '9.0.0',
        depName: 'node-html-parser',
      }).enabled,
    ).not.toBe(false);
  });

  it('still offers typescript minors', () => {
    expect(
      resolve({
        updateType: 'minor',
        currentVersion: '6.0.3',
        depName: 'typescript',
      }).enabled,
    ).not.toBe(false);
  });
});
