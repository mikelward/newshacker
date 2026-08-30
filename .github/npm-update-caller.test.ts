// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The weekly npm-update workflow is the only automation left on the
// dependency path now that Renovate is disabled (AGENTS.md "Dependency
// updates"), and it runs unattended every week — a workflow that has
// silently stopped doing its job looks exactly like a week with no updates
// available.
//
// workflows/npm-update.yml is now a thin caller into
// mikelward/npm-update's reusable workflow (see AGENTS.md "Dependency
// updates"): the update/publish mechanism itself is tested in that
// repository, not here. What's left to guard here is what this repo still
// owns — the schedule, the manual trigger, the permission grant, and which
// reusable workflow it calls — since nothing in mikelward/npm-update's own
// suite can see this file.

const workflow = readFileSync(fileURLToPath(new URL('./workflows/npm-update.yml', import.meta.url)), 'utf8');
const ci = readFileSync(fileURLToPath(new URL('./workflows/ci.yml', import.meta.url)), 'utf8');
const consumerCheck = readFileSync(
  fileURLToPath(new URL('./workflows/codex-review-check.yml', import.meta.url)),
  'utf8',
);

// The `dispatch-workflows` input, as a list of file names. Accepts the
// inline form the caller uses today and a block scalar, since either is
// valid YAML for it and the contract is about the names, not the spelling.
const dispatchedWorkflows = (): string[] => {
  const inline = workflow.match(/^ *dispatch-workflows: *(?![|>])(\S.*)$/m);
  if (inline) return [inline[1].trim()];
  const block = workflow.match(/^ *dispatch-workflows: *[|>][-+]?\n((?: +\S.*\n)+)/m);
  return block ? block[1].split('\n').map((l) => l.trim()).filter(Boolean) : [];
};

describe('npm-update caller', () => {
  it('can be run by hand as well as on the schedule', () => {
    // Without workflow_dispatch the only way to run it is to wait for
    // Saturday, or push a commit editing the cron — which is how a
    // scheduled job becomes a job nobody can test.
    expect(workflow).toMatch(/^\s*workflow_dispatch:/m);
  });

  it('runs on a schedule, on Saturdays', () => {
    // The DAY is the decision and is asserted; the hour and the
    // deliberately off-the-hour minute are tuning, so they stay free.
    const cron = workflow.match(/^\s*- cron: '(.+)'/m);
    expect(cron).not.toBeNull();
    expect(cron![1].trim().split(/\s+/)[4]).toBe('6');
  });

  it('names zizmor.yml among the workflows the hub must dispatch', () => {
    // The batch's PR is opened by GITHUB_TOKEN, which starts no
    // `on: pull_request` workflow. ci.yml and codex-review-check.yml the hub
    // dispatches unconditionally; anything else this repository's ruleset
    // requires — zizmor, once it is required here — only runs because it is
    // named in this input. Dropping the line would leave the weekly PR
    // pending forever on a check nothing produces, which is not a failure
    // anyone sees.
    expect(dispatchedWorkflows()).toContain('zizmor.yml');
  });

  it('names only workflows that are actually dispatchable', () => {
    // The other half of the same contract, and the half that fails
    // silently: `gh workflow run` on a file with no `workflow_dispatch:`
    // trigger errors, the hub reports it in the PR body and carries on, and
    // the check still never reports. Derived from the caller rather than
    // hard-coded, so a workflow added to the input later is covered by this
    // the day it is added.
    const named = dispatchedWorkflows();
    expect(named.length).toBeGreaterThan(0);
    for (const file of named) {
      const text = readFileSync(
        fileURLToPath(new URL(`./workflows/${file}`, import.meta.url)),
        'utf8',
      );
      expect(text).toMatch(/^\s*workflow_dispatch:/m);
    }
  });

  it('calls the hub reusable workflow at @main', () => {
    expect(workflow).toContain(
      'uses: mikelward/npm-update/.github/workflows/npm-update.yml@main',
    );
  });

  it('grants exactly the permissions the hub jobs need, no more, no less', () => {
    // The hub's own workflow_call block carries no top-level permissions —
    // this caller's grant is the ceiling every job downscopes from. A
    // grant that's missing one of these silently breaks whichever hub job
    // needs it (the update job needs none of these; the publish job needs
    // all three); a grant that's wider than this hands the hub job more
    // than it asks for. The whole block is captured and compared, so a
    // FOURTH scope appended after `actions: write` fails here too — a plain
    // "these three lines appear somewhere, consecutively" match would still
    // pass with one added. Captured rather than anchored to end-of-file:
    // the grant is no longer the workflow's last section now that the job
    // carries a `with:` block, and an anchor that a later input breaks is
    // one that stops testing the thing it was written for.
    const jobs = workflow.slice(workflow.indexOf('\njobs:'));
    const grant = jobs.match(/permissions:\n((?: {6}[a-z-]+: \S+\n)+)/);
    expect(grant).not.toBeNull();
    expect(grant![1]).toBe(
      '      contents: write\n      pull-requests: write\n      actions: write\n',
    );
  });

  it('opens the batch PR as a real collaborator, not as GITHUB_TOKEN', () => {
    // The dispatch declaration above closes one required check at a time,
    // by name; this closes the class. A PR opened by GITHUB_TOKEN starts no
    // `on: pull_request` workflow at all, so a required check nobody
    // thought to name holds the weekly PR open forever on a status nothing
    // produces -- no red tick, no explanation, which reads as verified.
    // With this secret the ordinary round runs for the batch PR like any
    // other, covering checks added after this line was written. Losing the
    // line is silent in the worst way: the batch keeps opening PRs, they
    // just stop being checked.
    //
    // Matched under `secrets:` specifically -- the hub declares no such
    // `with:` input, so the same line one block up would fail the call
    // rather than quietly downgrade the credential.
    const secrets = workflow.match(/^ {4}secrets:\n((?: {6}.*\n?)+)/m);
    expect(secrets).not.toBeNull();
    expect(secrets![1]).toContain('token: ${{ secrets.NPM_UPDATE_PAT }}');
  });

  it('serializes runs so a slow run cannot overlap the next schedule', () => {
    expect(workflow).toMatch(/^concurrency:\n {2}group: npm-update\n {2}cancel-in-progress: false\n/m);
  });

  it("keeps ci.yml dispatchable, naming the PR the hub's publish job reports for", () => {
    // Codex review on PR #533: the deleted npm-update.test.ts asserted this
    // consumer-owned prerequisite (mikelward/npm-update's README "Wiring up
    // a consumer") and nothing replaced it. The weekly PR is opened by
    // GITHUB_TOKEN, which never fires `on: pull_request` -- the hub's
    // publish job works around that by dispatching ci.yml against the
    // pushed branch with `gh workflow run ci.yml -f pr="$pr"`, which
    // *requires* ci.yml to declare `workflow_dispatch` with a `pr` input
    // (gh rejects an -f for an input the target workflow never declared).
    // Losing either one leaves the weekly PR dispatched-but-uncovered while
    // npm test stays green, same failure shape the P1 finding on this PR
    // already fixed for the caller's own settings.
    expect(ci).toMatch(/^\s*workflow_dispatch:/m);
    expect(ci).toMatch(/^\s*inputs:\n\s*pr:/m);
  });

  it('keeps codex-review-check.yml dispatchable too', () => {
    // Same class of gap as the sibling ci.yml check above, for the other
    // workflow the hub's publish job dispatches (`gh workflow run
    // codex-review-check.yml --ref "$branch"`, no `pr` input this one --
    // `gh workflow run` itself requires the target to declare
    // workflow_dispatch at all, dispatch-with-no-inputs included). Losing
    // this trigger leaves the weekly PR's Codex pin unverified with no
    // error anywhere: the dispatch just silently has nothing to start.
    expect(consumerCheck).toMatch(/^\s*workflow_dispatch:/m);
  });
});
