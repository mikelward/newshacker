// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The monthly dependency-update workflow is the only automation left on the
// dependency path now that Renovate is disabled (AGENTS.md "Dependency
// updates"), and its failure modes are the quiet kind this repo keeps getting
// caught by: it runs once a month, unattended, and a workflow that has silently
// stopped doing its job looks exactly like a month with no updates available.
//
// Asserted here rather than by parsing YAML, because no YAML parser is a
// dependency and adding one to check a 100-line file is a worse trade than
// matching the two or three strings that actually carry meaning. Each assertion
// below is for something whose wrong value produces no error at all.

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const workflow = read('./dependency-update.yml');
const ci = read('./ci.yml');

describe('dependency-update workflow', () => {
  it('can be run by hand as well as on the schedule', () => {
    // Without workflow_dispatch the only way to run it is to wait for the 1st,
    // or to push a commit editing the cron — which is how a monthly job becomes
    // a job nobody can test.
    expect(workflow).toMatch(/^\s*workflow_dispatch:/m);
  });

  it('runs on a schedule', () => {
    expect(workflow).toMatch(/^\s*- cron: '.+'/m);
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
    // the one thing a monthly unattended job must not do.
    expect(workflow).toContain('npm update --save');
    expect(workflow).not.toMatch(/npm-check-updates|\bncu\b|@latest/);
  });

  it('runs every check ci.yml runs, on every runtime', () => {
    // The PR this workflow opens is authored by GITHUB_TOKEN, which by design
    // does NOT trigger `on: pull_request` workflows — so ci.yml never runs on
    // it and these are the only checks the update gets. If someone adds a step
    // to ci.yml and not here, the monthly PR is quietly verified by a weaker
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
    // be silently absent from the monthly PR's suite.
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
          'dependency-update.yml — an unclassified check is one the monthly ' +
          'PR can omit without anything going red.',
      ).toBe(true);
      ciChecks.add(line);
    }

    // Only what the workflow actually EXECUTES — the `check '...'` calls —
    // not every occurrence of the string in the file. Scanning the whole text
    // means a command named in a comment, in the PR-body prose, or in a
    // commented-out example satisfies the parity check while the monthly run
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
          'monthly PR would be merged without it ever having run',
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
    // a write token within reach of any postinstall in the monthly batch. The
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
    // And the filename allowlist alone lets package.json itself be rewritten —
    // `scripts.test` pointed at `true` would make the suite pass on a manifest
    // `npm update` never produced.
    expect(workflow).toContain('package.json changed outside its dependency sections');
    // And within the dependency sections, only the moves `npm update` can make.
    // Stripping those sections entirely left the one place a major could be
    // introduced unchecked, which is the invariant the whole workflow sells.
    // Comparing majors is not that invariant either: `^2.17.6` -> `^2.0.0`
    // keeps the major while downgrading, and `^0.6.0` -> `^0.7.0` keeps it
    // while stepping outside what caret allows on a 0.x package. The new floor
    // has to satisfy the range that was already declared.
    expect(workflow).toContain('moved outside its existing range');
    expect(workflow).toContain('does not add packages');
    expect(workflow).toContain('not a plain X.Y.Z registry range');
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
    expect(publish).toContain('moved outside its existing range');
    expect(publish).toContain('package.json changed outside its dependency sections');
  });

  it('refuses a transitive major, not just a direct one', () => {
    // package.json only governs DIRECT dependencies. A bare `npm update` also
    // moves subdependencies to whatever their own ranges allow, and a
    // transitive `*` or `>=x` permits a major — invisible in the package.json
    // diff, while the PR body still says "no majors". The lockfile comparison
    // is what makes the headline claim true rather than nearly true.
    expect(workflow).toContain('git show HEAD:package-lock.json');
  });

  it('runs no lifecycle script before the fingerprints exist', () => {
    // Everything up to the fingerprint step is the window the publish job
    // implicitly trusts, so no dependency code may run in it — including the
    // bootstrap install, whose packages come from the CURRENT lockfile and are
    // therefore no more reviewed than the ones being added. A postinstall
    // there could rewrite a `resolved` URL or an `integrity` hash and have
    // that be the value fingerprinted and published: versions and majors would
    // be untouched, so neither the range check nor the major check would fire.
    //
    // The real install, with scripts, is the first REPORTED check, which runs
    // after the manifests are pinned.
    const fingerprint = workflow.indexOf('Stop early if nothing moved');
    const before = workflow.slice(0, fingerprint);
    // Match COMMAND lines only. The header prose says "`npm update` moves
    // each dependency ..." and a looser pattern reads that as an install.
    const installs = before
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^npm (?:ci|install|update)\b/.test(line));
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs) {
      expect(
        install,
        `"${install}" runs before the manifests are fingerprinted, so its ` +
          'lifecycle scripts could rewrite what then gets pinned',
      ).toContain('--ignore-scripts');
    }
    // And the scripts-enabled install still has to happen, as a check.
    expect(workflow).toContain("check 'npm ci'");
  });

  it('resolves dependency edges rather than trusting an aggregate', () => {
    // By-path and by-name are SUMMARIES of the tree, and a summary can hold
    // still while a consumer moves. Drop a nested foo@1, let its dependent
    // fall through to an already-hoisted foo@2, and leave some other
    // dependent on its own foo@1: no shared path changed major, and the major
    // set for foo is still {1,2}. Every aggregate is identical. Somebody
    // still crossed.
    //
    // So the third rule resolves each edge the way npm does — from the
    // dependent directory, walk up through ancestor node_modules until one
    // holds the name — and compares the major of the copy the consumer
    // actually gets. That is the invariant itself rather than a proxy for it,
    // which is why the two rules above kept being defeated one shape at a
    // time.
    expect(workflow).toContain('resolveEdge');
    // Every edge field npm records, not just `dependencies`. An optional or
    // peer edge npm actually installed is a real consumer resolving to a real
    // copy and can cross a major like any other — and because such a crossing
    // moves no shared path and need not change any major set, enumerating one
    // field would hide it from all three rules simultaneously.
    //
    // Anchored on the EDGE_FIELDS declaration itself, not on the field names:
    // `DEPS` at the top of the same validator lists those same names for an
    // unrelated purpose, so a substring assertion passed happily while
    // EDGE_FIELDS was narrowed back to `dependencies` alone. Verified by
    // making exactly that edit and watching this fail.
    expect(workflow).toMatch(
      /const EDGE_FIELDS = \["dependencies", "optionalDependencies", "peerDependencies"\]/,
    );
    expect(workflow).toContain('lastIndexOf("/node_modules/")');
    expect(workflow).toContain('crossed a major in the lockfile');
    // The walk-up is the whole point: without it this degenerates into
    // another same-path comparison.
    expect(workflow).toContain('node_modules/" + name');
  });

  it('identifies an edge by consumer NAME, so a hoist is the same edge', () => {
    // The same lesson as the by-name rule, learned twice: npm paths are
    // locations, not identities. Keyed by consumer PATH, a consumer that
    // hoists gets a brand-new edge id, its old id reads as deleted, and the
    // major it just crossed is skipped as an edge that never existed —
    // `node_modules/a/node_modules/bar -> foo` becoming `node_modules/bar ->
    // foo` while resolving foo@1 to foo@2.
    expect(workflow).toContain('const consumer = path.includes("node_modules/") ? nameOf(path) : path');
    expect(workflow).toContain('const edge = consumer + " -> " + name');
  });

  it('refuses to publish onto a base that moved under it', () => {
    // Everything the publish job verifies describes the recorded base commit.
    // If the default branch moved while the checks ran, pushing three-way
    // merges tested manifests onto an untested combination — and this PR gets
    // no `pull_request` CI to notice, so it would ship looking verified.
    expect(workflow).toContain('Stop if the default branch moved while the checks ran');
    expect(workflow).toContain('moved from');
  });

  it('never lets an apostrophe truncate the inline node program', () => {
    // The validator is passed as a SINGLE-QUOTED shell argument
    // (`node -e '...'`), so one apostrophe in a comment ends the quoting and
    // hands node everything up to that point — a truncated script. It stays
    // valid JavaScript, exits 0, and silently skips every rule below the
    // apostrophe. Nothing goes red; the run just stops checking.
    //
    // This happened: `name's` and `tree's` in a comment cut the program from
    // 7247 to 4905 characters, dropping the whole by-name major comparison,
    // and the monthly PR would still have said "no majors".
    //
    // The verification that missed it had the same bug — it recovered the
    // program by splitting on the LAST quote, reassembling text the shell
    // never passes. So this asserts the shell's own rule: between the opening
    // `node -e '` and the closing quote there must be no apostrophe at all.
    const start = workflow.indexOf("node -e '");
    expect(start).toBeGreaterThan(-1);
    const body = workflow.slice(start + "node -e '".length);
    // The closing delimiter is a line containing only the quote, at the step
    // indentation. Bounding on that rather than on the last quote in the file
    // matters: the file goes on to use quotes in later shell steps, so
    // `lastIndexOf` measures against a point well past the program and reports
    // a truncation that is not there. (It did, on the first version of this
    // test — the guard has to know where the program actually ends.)
    const close = /\n[ \t]*'[ \t]*(?:\n|$)/.exec(body);
    expect(close, 'could not find the end of the inline node program').not.toBeNull();
    const closingQuote = close.index + close[0].indexOf("'");
    const firstQuote = body.indexOf("'");
    expect(
      firstQuote,
      'an apostrophe inside the single-quoted node program truncates it at ' +
        `character ${firstQuote} of ${closingQuote}; everything after is ` +
        'dropped, and node still exits 0',
    ).toBe(closingQuote);
  });

  it('compares lockfile majors BOTH by path and by name', () => {
    // Two rules, and the reason both are asserted is that four review rounds
    // went into discovering they are complementary — each earlier version
    // replaced its predecessor when it should have joined it, and every
    // replacement reopened the hole the predecessor had closed.
    //
    // BY PATH catches a major moving under an entry that stays put, including
    // the offsetting swap where one consumer goes 1->2 while another goes
    // 2->1 and every aggregate — set, count, total — is unchanged.
    expect(workflow).toContain('crossed a major in the lockfile');
    // BY NAME catches what no path comparison can see: npm hoists and dedupes
    // as it updates, so a crossing that also relocates between
    // `node_modules/foo` and `node_modules/bar/node_modules/foo` shares no
    // path to compare against. A major DISAPPEARING counts as much as one
    // appearing — the last consumer of it went somewhere.
    expect(workflow).toContain('majorsByName');
    expect(workflow).toContain('lastIndexOf("node_modules/")');
    expect(workflow).toContain('changed which majors it resolves to');
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
    // before the artifact existed — no PR, and the whole monthly batch visible
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
    // is also what makes CI start running on it). A re-run in the same month
    // would overwrite those commits, so the job takes a run-scoped branch when
    // the month's branch already exists rather than clobbering it.
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

});
