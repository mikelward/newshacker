// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The weekly dependency-update workflow is the only automation left on the
// dependency path now that Renovate is disabled (AGENTS.md "Dependency
// updates"), and its failure modes are the quiet kind this repo keeps getting
// caught by: it runs unattended every week, unattended, and a workflow that has silently
// stopped doing its job looks exactly like a week with no updates available.
//
// Asserted here rather than by parsing YAML, because no YAML parser is a
// dependency and adding one to check a 100-line file is a worse trade than
// matching the two or three strings that actually carry meaning. Each assertion
// below is for something whose wrong value produces no error at all.

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const workflow = read('./dependency-update.yml');
const ci = read('./ci.yml');
const root = fileURLToPath(new URL('../../', import.meta.url));

describe('dependency-update workflow', () => {
  it('can be run by hand as well as on the schedule', () => {
    // Without workflow_dispatch the only way to run it is to wait for Saturday,
    // or to push a commit editing the cron — which is how a scheduled job becomes
    // a job nobody can test.
    expect(workflow).toMatch(/^\s*workflow_dispatch:/m);
  });

  it('runs on a schedule, on Saturdays', () => {
    // The DAY is the decision and is asserted; the hour and the deliberately
    // off-the-hour minute are tuning, so they stay free. Without this the cron
    // could drift back to a weekday — or be mistyped — with nothing red.
    const cron = workflow.match(/^\s*- cron: '(.+)'/m);
    expect(cron).not.toBeNull();
    expect(cron![1].trim().split(/\s+/)[4]).toBe('6');
  });

  it('puts the PR in front of a human', () => {
    // An unattended job that opens a PR nobody is told about is the same
    // failure as one that silently stops opening them: the repo looks fine and
    // the updates pile up unreviewed. Assign AND request review — the first
    // puts it in "Assigned", the second sends the review-request notification.
    expect(workflow).toContain('--add-assignee');
    expect(workflow).toContain('--add-reviewer');
    // Derived from the repo owner, not a hard-coded handle, so this file stays
    // identical across the three repos and survives an account rename.
    expect(workflow).toContain('github.repository_owner');
    // …and it must not be able to fail the step. The branch is already pushed
    // by then, so a refused review request would otherwise leave a pushed
    // branch with no PR — strictly worse than an unassigned one.
    expect(workflow).toMatch(/if ! gh pr edit .*--add-assignee/);
  });

  it('scopes the branch to the run date, not the month', () => {
    // The job runs weekly. A month-scoped branch name would collide with the
    // previous week's and send every run but the first down the run-scoped
    // fallback path, which exists for re-runs of one batch rather than for
    // distinct scheduled ones.
    expect(workflow).toContain('date -u +%Y-%m-%d');
    expect(workflow).not.toContain('date -u +%Y-%m)');
  });

  it('takes the Node major from .nvmrc rather than naming one', () => {
    // A hard-coded version here would drift from .nvmrc silently, and the
    // update PR would be verified on a runtime nothing else uses.
    expect(workflow).toContain('node-version-file: .nvmrc');
    expect(workflow).not.toMatch(/node-version:\s*['"]?\d/);
  });

  it('never lets npm take a major on its own', () => {
    // `npm update` is bounded by the ranges already in package.json. Anything
    // that rewrites the ranges themselves (npm-check-updates, `install
    // <pkg>@latest`) turns this into an unattended major-version bump, which is
    // the one thing an unattended job like this must not do.
    expect(workflow).toContain('npm update --save');
    expect(workflow).not.toMatch(/npm-check-updates|\bncu\b|@latest/);
  });

  it('runs every check ci.yml runs, on every runtime', () => {
    // The PR this workflow opens is authored by GITHUB_TOKEN, which by design
    // does NOT trigger `on: pull_request` workflows — so ci.yml never runs on
    // it and these are the only checks the update gets. If someone adds a step
    // to ci.yml and not here, the weekly PR is quietly verified by a weaker
    // suite than main, with a green tick either way.
    //
    // Every `run:` line in ci.yml has to be CLASSIFIED, not merely matched.
    // Extracting only the command shapes someone thought of is how ci.yml's
    // whole `edge` job (deno check + the SSRF pinning test) went missing from
    // the update job while the PR body still reported that every check
    // passed — the guard was exactly as wide as the last runtime anyone
    // remembered, which is no guard at all against the next one. So a command
    // this test cannot classify FAILS it rather than being skipped: a new
    // check in a new runtime has to be taught here, and until it is, it cannot
    // be silently absent from the weekly PR's suite.
    const INFRASTRUCTURE = /^npm (?:ci|install)$/; // sets up the tree, not a check
    const CHECK = /^(?:npm (?:run [\w:-]+|test)|deno (?:check|test)\b.*)$/;

    const ciRunLines = [...ci.matchAll(/^\s*(?:- )?run: (.+?)\s*$/gm)].map((m) => m[1]);
    expect(ciRunLines.length).toBeGreaterThan(0);

    const ciChecks = new Set<string>();
    for (const line of ciRunLines) {
      expect(
        line,
        'ci.yml uses a block scalar for a `run:` step, and this parity check ' +
          'reads only single-line commands — whatever is inside it would be ' +
          'skipped entirely',
      ).not.toMatch(/^[|>][-+]?$/);
      if (INFRASTRUCTURE.test(line)) continue;
      expect(
        CHECK.test(line),
        `ci.yml runs "${line}", which this parity check cannot classify. ` +
          'Teach it that command shape and mirror the check in ' +
          'dependency-update.yml — an unclassified check is one the weekly ' +
          'PR can omit without anything going red.',
      ).toBe(true);
      ciChecks.add(line);
    }

    // Only what the workflow actually EXECUTES — the `check '...'` calls —
    // not every occurrence of the string in the file. Scanning the whole text
    // means a command named in a comment, in the PR-body prose, or in a
    // commented-out example satisfies the parity check while the weekly run
    // never invokes it. That is the same mistake as matching a name anywhere
    // in a file and calling it a definition: the assertion passes for a
    // reason unrelated to the property it claims to prove.
    const workflowChecks = new Set(
      [...workflow.matchAll(/^\s*check '([^']+)'/gm)].map((m) => m[1].trim()),
    );
    expect(workflowChecks.size).toBeGreaterThan(0);

    for (const check of ciChecks) {
      expect(
        workflowChecks,
        `ci.yml runs "${check}" but dependency-update.yml does not — the ` +
          'weekly PR would be merged without it ever having run',
      ).toContain(check);
    }
  });

  it('always builds from the default branch, not the dispatch ref', () => {
    // `workflow_dispatch` exposes a Branch dropdown and checkout follows it, so
    // without an explicit ref a manual run from a feature branch would open a
    // PR against the default branch containing that branch's commits alongside
    // the dependency update. Manual runs are the likeliest way this workflow
    // gets used, so the guard belongs on that path.
    expect(workflow).toContain(
      'ref: ${{ github.event.repository.default_branch }}',
    );
  });

  it('holds no push credential while dependency code runs', () => {
    // `npm update` and the checks run lifecycle scripts from versions nobody
    // has reviewed. Checkout persists a push-capable credential in .git/config
    // by default, and this job has `contents: write` — so the default would put
    // a write token within reach of any postinstall in the weekly batch. The
    // token is passed explicitly at the push step instead, once the
    // third-party code has finished.
    expect(workflow).toContain('persist-credentials: false');
  });

  it('verifies the checked tree is the tree it pushes', () => {
    // Staging by name protects against a planted edit riding along, but it also
    // means the suite could pass on a tree that differs from the commit — a
    // lifecycle script edits source, the checks go green on that, and the edit
    // is dropped at commit time. The PR body would then report checks for a
    // tree nobody merges, and since this PR gets no `pull_request` CI run, that
    // report is all a reviewer has.
    expect(workflow).toContain('Verify only dependency files changed');
    // `git status --porcelain --untracked-files=all`, not `git diff`: diff sees
    // only tracked changes, so an untracked file dropped into the tree — which
    // tsc/vite/vitest would still pick up — would pass unnoticed.
    expect(workflow).toContain('git status --porcelain --untracked-files=all');
    expect(workflow).not.toMatch(/git diff --name-only \| grep -Ev/);
    // …and a SECOND pass for ignored paths, because the first structurally
    // cannot see them and the sharpest plant is an ignored file: `.env.local`
    // is gitignored (`*.local`, `.env.*`) and Vite loads it during a build, so
    // a postinstall writing one injects `VITE_*` into the shipped bundle while
    // the tree still reads as clean.
    expect(workflow).toContain("git status --porcelain --ignored");
    // The two must stay SEPARATE calls. `--ignored` together with
    // `--untracked-files=all` lists every ignored file individually, so the
    // output becomes the whole of node_modules and the check is unusable;
    // alone, `--ignored` collapses a fully-ignored directory to one entry.
    // Combining them is the obvious-looking edit that would quietly break it.
    expect(workflow).not.toMatch(/--untracked-files=all\s+--ignored/);
    expect(workflow).not.toMatch(/--ignored\s+--untracked-files=all/);
    // Build outputs are allowed through; anything else ignored is a stop.
    for (const output of ['node_modules/', 'dist/', 'coverage/', 'tsbuildinfo']) {
      expect(workflow).toContain(output);
    }
    // The filename allowlist alone lets package.json itself be rewritten —
    // `scripts.test` pointed at `true` would make the suite pass on a manifest
    // `npm update` never produced. That check, and the range comparison that
    // goes with it, now live in scripts/check-dependency-update.mjs with their
    // own tests; the assertion here is only that the workflow still runs them.
    expect(workflow).toContain('node scripts/check-dependency-update.mjs');
    // The filename allowlist alone lets package.json itself be rewritten —
    // `scripts.test` pointed at `true` would make the suite pass on a manifest
    // `npm update` never produced. That check, and the range comparison that
    // goes with it, now live in scripts/check-dependency-update.mjs with their
    // own tests; the assertion here is only that the workflow still runs them.
    expect(workflow).toContain('node scripts/check-dependency-update.mjs');
  });

  it('fingerprints the manifests somewhere dependency code cannot reach', () => {
    // The first version of this copied them to /tmp and compared with `cmp`,
    // which proves nothing: the checks run as the same user on the same disk,
    // so a lifecycle script could rewrite a manifest and its snapshot together
    // and the comparison would pass on two files it had just written. A step
    // output is captured by the runner when the step ends and lives outside the
    // workspace — nothing that runs afterwards can reach back and change it.
    expect(workflow).not.toContain('/tmp/dep-snapshot');
    expect(workflow).toMatch(/sha256sum package-lock\.json/);
    expect(workflow).toContain('steps.changed.outputs.lock_sha');
    // And the publish job re-checks the artifact against the same value, so a
    // manifest cannot be swapped in transit either.
    expect(workflow).toContain('needs.update.outputs.lock_sha');
  });

  it('validates the manifest contents from a job that ran no dependency code', () => {
    // Every assertion the update job makes about what the manifests CONTAIN is
    // made on a machine where the batch's own code has already run. The publish
    // job installs nothing, so `git show HEAD:package.json` and the downloaded
    // artifact are both out of the batch's reach — that is where the check has
    // to happen to mean anything.
    const publish = workflow.slice(workflow.indexOf('  publish:'));
    expect(publish).toContain('Re-validate the dependency diff from a clean context');
    expect(publish).toContain('node scripts/check-dependency-update.mjs');
    // The publish job must not gain an install step: the whole reason the
    // validation happens here is that no dependency code has run on this
    // runner.
    expect(publish).not.toMatch(/^\s*run: npm (ci|install)\b/m);
  });

  it('refuses a transitive major, not just a direct one', async () => {
    // package.json only governs DIRECT dependencies. A bare `npm update` also
    // moves subdependencies to whatever their own ranges allow, and a
    // transitive `*` or `>=x` permits a major — invisible in the package.json
    // diff, while the PR body still says "no majors".
    //
    // Asserted by RUNNING the delegation target rather than by matching text
    // in the YAML. A substring assertion cannot tell a working rule from a
    // commented-out one, and this file used to carry several that passed while
    // the rule they named had been narrowed. The shape-by-shape coverage lives
    // in scripts/check-dependency-update.test.ts; what this proves is that
    // the thing the workflow invokes actually rejects a crossing.
    const { lockfileFailures } = await import('../../scripts/check-dependency-update.mjs');
    const before = {
      '': { dependencies: { a: '^1.0.0' } },
      'node_modules/a': { version: '1.0.0', dependencies: { foo: '*' } },
      'node_modules/foo': { version: '1.0.0' },
    };
    const after = {
      '': { dependencies: { a: '^1.0.0' } },
      'node_modules/a': { version: '1.0.0', dependencies: { foo: '*' } },
      'node_modules/foo': { version: '2.0.0' },
    };
    expect(lockfileFailures(before, after)).not.toEqual([]);
    expect(lockfileFailures(before, before)).toEqual([]);
  });

  it('keeps the validator out of shell quoting entirely', () => {
    // This replaces a guard that asserted no apostrophe appeared between
    // `node -e '` and its closing quote. The validator was passed as a
    // SINGLE-QUOTED shell argument, so one apostrophe in a comment ended the
    // quoting and handed node a truncated script — still valid JavaScript,
    // still exit 0, silently skipping every rule below the cut. It happened:
    // `name's` and `tree's` cut the program from 7247 to 4905 characters and
    // dropped a whole major comparison, and the weekly PR would still have
    // said "no majors". The verification that missed it had the same bug,
    // recovering the program by splitting on the last quote — text the shell
    // never passes.
    //
    // A file cannot be truncated by its own punctuation, so moving the
    // validator into scripts/check-dependency-update.mjs removes the hazard
    // rather than policing it. This asserts the hazard cannot come back: no
    // inline program in this workflow at all.
    expect(workflow).not.toContain("node -e '");
    expect(workflow).toContain('node scripts/check-dependency-update.mjs');
  });

  it('keeps the validator and its tests present, since the workflow only delegates', () => {
    // The workflow now names a file. If that file or its suite disappears, the
    // weekly run either dies at the step or — worse — someone "fixes" it by
    // dropping the step, and the PR goes back to reporting checks nobody ran.
    // The rule-by-rule coverage (in-place bump, hoist, dedupe, duplicate
    // consumer swapping majors, consumer bumped and hoisted while crossing,
    // clean batch) is asserted in that suite, not here.
    expect(existsSync(resolve(root, 'scripts/check-dependency-update.mjs'))).toBe(true);
    expect(existsSync(resolve(root, 'scripts/check-dependency-update.test.ts'))).toBe(true);
  });

  it('refuses to publish onto a base that moved under it', () => {
    // Everything the publish job verifies describes the recorded base commit.
    // If the default branch moved while the checks ran, pushing three-way
    // merges tested manifests onto an untested combination — and this PR gets
    // no `pull_request` CI to notice, so it would ship looking verified.
    expect(workflow).toContain('Stop if the default branch moved while the checks ran');
    expect(workflow).toContain('moved from');
  });

  it('resolves the manifests before any updated package can run code', () => {
    // The fingerprint is what every later comparison trusts, so it has to be
    // taken from files no unreviewed lifecycle script has had a chance to
    // touch. With scripts enabled during the update, a postinstall from a
    // version this run just selected could rewrite package-lock.json — a
    // `resolved` URL, an `integrity` hash — before it is hashed, and every
    // check afterwards would be comparing a poisoned file against itself.
    expect(workflow).toContain('npm update --save --ignore-scripts');
    // Order matters as much as the flag: resolve, fingerprint, then install
    // for real so the suite still runs against the tree a consumer of this
    // lockfile would actually get.
    const resolve = workflow.indexOf('npm update --save --ignore-scripts');
    const fingerprint = workflow.indexOf('lock_sha=$(sha256sum');
    const install = workflow.indexOf("check 'npm ci'");
    expect(resolve).toBeGreaterThan(-1);
    expect(fingerprint).toBeGreaterThan(resolve);
    expect(install).toBeGreaterThan(fingerprint);
  });

  it('reports a failed install in the PR instead of killing the job', () => {
    // As a step of its own, a postinstall that exits non-zero would end the run
    // before the artifact existed — no PR, and the whole weekly batch visible
    // only as a red Actions run nobody is watching. Routed through check() it
    // lands in the body with everything else and the PR still opens, saying
    // which package broke.
    expect(workflow).toContain("check 'npm ci'");
    expect(workflow).not.toContain('Install the resolved tree');
  });

  it('clears the runner env after every step that runs dependency code', () => {
    // Not just the installs: the check step runs lint/test/build from the new
    // versions, and the step after it invokes `git` and `sha256sum` — a planted
    // pair on $GITHUB_PATH would let source edits past the check whose whole
    // job is catching them.
    const checks = workflow.slice(
      workflow.indexOf('Run the full check suite'),
      workflow.indexOf('Verify only dependency files changed'),
    );
    expect(checks).toContain(': > "$GITHUB_PATH"');
    expect(checks).toContain(': > "$GITHUB_ENV"');
  });

  it('keeps a lifecycle script inside the step that ran it', () => {
    // The runner applies $GITHUB_PATH and $GITHUB_ENV to LATER steps in the
    // same job, so a postinstall can put a fake `npm` ahead of the real one and
    // have the checks below report a suite that never ran. Truncating both
    // files at the end of the step that ran the scripts means the runner
    // applies nothing. Every step that installs has to do it, not just the
    // second one — the first install runs third-party code too.
    const installs = workflow.split('npm ci').length - 1;
    expect(installs).toBeGreaterThanOrEqual(2);
    expect(workflow.split(': > "$GITHUB_PATH"').length - 1).toBe(installs);
    expect(workflow.split(': > "$GITHUB_ENV"').length - 1).toBe(installs);
  });

  it('publishes the exact commit it tested, not the branch tip', () => {
    // If a package.json/lockfile commit lands on the default branch between the
    // two jobs, checking out the tip would overlay dependency files resolved
    // against the older base — silently reverting it, with the body reporting
    // checks from that older base.
    expect(workflow).toContain('needs.update.outputs.base');
    expect(workflow).toMatch(/base: \$\{\{ steps\.base\.outputs\.sha \}\}/);
  });

  it('commits only the dependency files, with hooks disabled', () => {
    // The push step is the one step holding the token, and everything before it
    // ran unreviewed dependency code in the same workspace. `commit -a` would
    // sweep in any tracked file a postinstall edited — buried under a lockfile
    // diff, which is where nobody looks — and a planted .git/hooks/pre-commit
    // would execute in that step.
    expect(workflow).toContain('core.hooksPath /dev/null');
    expect(workflow).toMatch(/git add -- [\w./-]*package\.json/);
    expect(workflow).not.toMatch(/git commit[^\n]*-[a-z]*a/);
  });

  it('makes the runner meet the npm floor the cooldown needs', () => {
    // `.nvmrc` is a bare major and setup-node may serve a cached Node whose
    // bundled npm predates min-release-age support, in which case .npmrc's
    // cooldown is silently ignored and this job resolves versions the repo
    // holds back. engines.npm is advisory without engine-strict, so the
    // workflow has to check the runner rather than trust the declaration.
    expect(workflow).toContain('engines.npm');
    expect(workflow).toMatch(/npm install -g[^\n]*"npm@\$floor"/);
  });

  it('never force-pushes', () => {
    // The generated PR body tells reviewers to push fixes to the branch (that
    // is also what makes CI start running on it). A re-run on the same day
    // would overwrite those commits, so the job takes a run-scoped branch when
    // today's branch already exists rather than clobbering it.
    expect(workflow).not.toMatch(/git push[^\n]*(--force|(?<!\w)-f(?!\w))/);
    expect(workflow).toContain('git ls-remote');
  });

  it('uses only first-party actions, and no new third-party one', () => {
    // Bounds the supply-chain surface of an unattended job that can push. The
    // rule was "nothing ci.yml doesn't already use", which was too tight once
    // the publish job needed upload/download-artifact — GitHub's own actions,
    // but ones ci.yml has no reason to run. So: `actions/*` is allowed (same
    // publisher as the runner itself), and anything else has to be something
    // ci.yml already runs on every PR. A genuinely new third-party action still
    // has to arrive in a change that says so, rather than first appearing in
    // the one job with push access. `gh` is preinstalled, so the PR adds none.
    const usesOf = (source: string): string[] =>
      [...source.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);

    const alreadyTrusted = new Set(usesOf(ci));
    const actions = usesOf(workflow);

    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(
        action.startsWith('actions/') || alreadyTrusted.has(action),
        `dependency-update.yml uses "${action}", which is neither first-party ` +
          'nor something ci.yml already runs',
      ).toBe(true);
    }
  });

  it('keeps the write token out of the job that runs dependency code', () => {
    // A lifecycle script can append to $GITHUB_PATH, which the runner prepends
    // for subsequent STEPS — so a planted `git`/`gh` would execute in whatever
    // step holds the token. That does not cross a JOB boundary, and the runner
    // has passwordless sudo, so no in-job PATH scrubbing is equivalent. The
    // update job is therefore read-only and publishing happens on a fresh
    // runner that installs nothing.
    const publish = workflow.slice(workflow.indexOf('  publish:'));
    expect(publish).toContain('contents: write');
    // Asserted as "installs nothing and sets up no runtime" rather than "the
    // string npm never appears" — the generated PR body quotes `npm update
    // --save` as prose, and a guard that matches documentation is a guard that
    // gets loosened the first time it cries wolf.
    expect(publish).not.toMatch(/\bnpm (?:ci|install)\b/);
    expect(publish).not.toContain('setup-node');
    expect(publish).not.toContain('setup-deno');

    const update = workflow.slice(
      workflow.indexOf('  update:'),
      workflow.indexOf('  publish:'),
    );
    expect(update).toContain('npm update --save');
    expect(update).not.toContain('contents: write');
    expect(update).not.toContain('GH_TOKEN');
  });

  it('starts CI on the branch it opens', () => {
    // A PR opened by `GITHUB_TOKEN` does not trigger `on: pull_request` — so
    // without an explicit dispatch the weekly PR carries no CI at all, and a PR
    // with no red tick is indistinguishable from one whose CI passed. Three
    // pieces have to hold together and each fails silently on its own: the
    // dispatch call, the Actions write scope it needs, and the
    // `workflow_dispatch` trigger on ci.yml that makes it dispatchable at all.
    const publish = workflow.slice(workflow.indexOf('  publish:'));
    expect(publish).toContain('gh workflow run ci.yml --ref "$branch"');
    expect(publish).toContain('actions: write');
    expect(ci).toMatch(/^\s*workflow_dispatch:/m);

    // A dispatch that fails has to say so ON THE PR, not only in the run
    // summary — the assignee reads the PR, and a body promising a CI run that
    // is never coming is the exact "no checks means it passed" reading this
    // exists to prevent. So the dispatch happens BEFORE the body is composed
    // and the body branches on the result.
    expect(publish.indexOf('gh workflow run ci.yml')).toBeLessThan(
      publish.indexOf('} > body.md'),
    );
    expect(publish).toContain('**CI could not be started on this branch');

    // The scope belongs to the publish job only. The update job runs the
    // dependency code, and dispatching a workflow from there would hand a
    // postinstall a way to start one.
    const update = workflow.slice(
      workflow.indexOf('  update:'),
      workflow.indexOf('  publish:'),
    );
    expect(update).not.toContain('actions: write');
  });

  it('dispatches CI that cannot write to the repo', () => {
    // The dispatched run executes unreviewed dependency code — `npm ci`
    // lifecycle scripts, and the suite loading the packages themselves — so a
    // write-capable token there would undo the boundary the update job is
    // built around. The repo's DEFAULT workflow permissions are a setting no
    // file here can see, so ci.yml declares read-only rather than assuming it.
    expect(ci).toContain('\npermissions:\n  contents: read\n');

    // checkout writes the token into .git/config unless told not to, which
    // puts it within reach of anything running later in the job even when the
    // env var is not. Every checkout, not just the first.
    const checkouts = (ci.match(/actions\/checkout@/g) ?? []).length;
    expect(checkouts).toBeGreaterThan(0);
    expect((ci.match(/persist-credentials: false/g) ?? []).length).toBe(
      checkouts,
    );
  });

});
