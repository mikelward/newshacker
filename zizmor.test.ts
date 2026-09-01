// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Tests for the advisory zizmor scan: the workflow that runs it and the
// policy it loads.
//
// The scan's failure modes are all silent: a dropped version pin floats the
// audit set, so a verdict can change with no change in this repository; a
// dropped --offline puts the GitHub API inside the scan; a widened policy
// exempts refs nobody decided to exempt; a reintroduced paths filter stops
// the (eventually required) check from reporting on PRs that don't touch
// .github/**. Every one of those leaves the rest of the suite green,
// because zizmor only runs inside its own workflow — so the contract is
// pinned here. Read with regexes like the engine repositories' own suites:
// no YAML parser, on purpose. Ported from mikelward/codex-review's own
// zizmor.test.js.

const workflow = readFileSync('.github/workflows/zizmor.yml', 'utf8');
const policy = readFileSync('.github/zizmor.yml', 'utf8');

const stripComments = (text: string) =>
  text
    .split('\n')
    // Full-comment lines are dropped BEFORE the inline-comment strip below —
    // stripping first would leave them as blank lines (the leading-whitespace
    // branch of the inline regex still matches a bare "# ..." line), which
    // then survive this filter since an empty string never starts with "#".
    // A blank line breaks any check that expects two keys to sit on
    // immediately adjacent lines.
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');

const policyRules = stripComments(policy);

// Anchored through the full mapping chain including the top-level `rules:`
// key, not just the leaf `policies:` — renaming or moving anything from
// `rules` down to `policies` must fall through to zero entries, not
// silently match whatever happens to sit at the right indentation
// elsewhere in the file. This is as deep as the anchor chases: further
// structural mutations would need a real YAML parser, which this file's
// header already accepts as a deliberate tradeoff.
const policiesBlock = (text: string) => {
  const m = text.match(/^rules:\n {2}unpinned-uses:\n {4}config:\n {6}policies:\n([\s\S]*)/);
  return m ? m[1] : '';
};

const policyEntries = (text: string) =>
  [...policiesBlock(text).matchAll(/^ {8}"?([^":\n]+?)"?: *(\S+)$/gm)].map((m) => `${m[1]}: ${m[2]}`);

// Comments stripped first, so a `# run: pipx run …` note or a step disabled
// by commenting out its `run:` line can't satisfy these checks — they
// anchor to the executable `run:` field and the live `paths:` line, not to
// matching text appearing anywhere in the file.
const workflowRun = stripComments(workflow);

describe('zizmor workflow', () => {
  it('pins the zizmor version exactly and scans offline', () => {
    // An unpinned run takes whatever release is newest, and a new release
    // adds audits — bumping the pin is a deliberate edit that re-reads the
    // findings, never a side effect. --offline means the audits that need
    // the GitHub API are skipped deterministically.
    expect(workflowRun).toMatch(/^\s*run: pipx run --spec zizmor==\d+\.\d+\.\d+ zizmor /m);
    const runs = [...workflowRun.matchAll(/^\s*run: (pipx run [^\n]+)$/gm)];
    expect(runs).toHaveLength(1);
    expect(runs[0][1]).toMatch(/ --offline /);
  });

  it('holds read-only permissions, once', () => {
    // Pins the whole grant, so the scan can never grow a scope quietly. The
    // top-level block must also be the ONLY one — a second block anywhere
    // is a widening no matter how it is scoped.
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\njobs:/);
    expect([...workflow.matchAll(/^ *permissions:/gm)]).toHaveLength(1);
  });

  it('runs on every pull request and push to main, with no paths filter', () => {
    // `zizmor` is slated for the ruleset's required set (TODO.md holds the
    // flip), and a required check must report on every pull request's
    // head: a workflow filtered out by `paths:` creates NO check run at
    // all — unlike a skipped job, which reports "skipped" and satisfies
    // the ruleset — so a filter here would leave any PR not touching the
    // filtered paths unmergeable behind a check nothing reports. Matched
    // as one contiguous block running straight from `on:` into
    // `permissions:`, so `pull_request:` provably carries no nested
    // configuration — a stray `paths:` filter under it would equally stop
    // the check reporting on opened or synchronized heads. The one nested
    // key allowed is the explicit types list, `edited` included: a
    // retarget regenerates the merge ref against the new base while the
    // head — and the green check attached to it — stays put, so the
    // default types (which lack `edited`) would let the old target's scan
    // satisfy the new one. Read from the comment-stripped text, same as
    // the run-field checks above — a commented-out line must not count as
    // live.
    //
    // `workflow_dispatch` is pinned by the same match. The weekly batch's
    // pull request is opened by `GITHUB_TOKEN`, which starts no
    // `on: pull_request` workflow, so mikelward/npm-update dispatches this
    // one by name; deleting the trigger would leave that PR pending forever
    // on a check nothing can produce, which is not a failure anyone sees.
    expect(workflowRun).toMatch(
      /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}types: \[opened, synchronize, reopened, edited\]\n {2}workflow_dispatch:\npermissions:\n/m,
    );
    expect(workflowRun).not.toMatch(/^\s*paths:/m);
  });
});

describe('zizmor policy', () => {
  it('holds the pin-policy table exact', () => {
    // `@main` is the release for the enumerated sibling actions, official
    // actions may pin tags, and the blanket hash-pin rule has to be
    // restated because supplying policies replaces zizmor's defaults.
    // Compared whole: an entry added, dropped, or widened (say,
    // mikelward/*) fails here, whichever shape it takes.
    expect(policyEntries(policyRules)).toEqual([
      'mikelward/codex-review: ref-pin',
      'mikelward/codex-review/.github/workflows/check-consumer.yml: ref-pin',
      'mikelward/lanes: ref-pin',
      'mikelward/npm-update/.github/workflows/npm-update.yml: ref-pin',
      'actions/*: ref-pin',
      '*: hash-pin',
    ]);
  });

  it("excuses this repository's own privileged triggers, nothing else", () => {
    // codex-review.yml and codex-review-check.yml both carry
    // pull_request_target deliberately and neither checks out or executes
    // pull request code with the elevated token. Compared whole, so a new
    // workflow reaching for pull_request_target is still flagged. Anchored
    // through the full mapping chain including the top-level `rules:` key —
    // a rename or move anywhere from `rules` down to `ignore` must fall
    // through to zero, not match a list-item anywhere in the file.
    const m = policyRules.match(/^rules:\n[\s\S]*? {2}dangerous-triggers:\n {4}ignore:\n([\s\S]*)/);
    const ignored = m ? [...m[1].matchAll(/^ +- (\S+)$/gm)].map((mm) => mm[1]) : [];
    expect(ignored).toEqual(['codex-review.yml', 'codex-review-check.yml']);
  });

  it('lets only the batch caller inherit secrets', () => {
    // npm-update.yml passes `secrets: inherit` on purpose: the hub's publish
    // job reads NPM_UPDATE_PAT from this repository's `npm-update`
    // environment, and an environment secret reaches a called workflow no
    // other way. Read from that rule's own block, and compared whole, so a
    // second workflow handing every secret to a called workflow is still
    // flagged.
    const m = policyRules.match(/^ {2}secrets-inherit:\n {4}ignore:\n((?: {6}- .*\n?)+)/m);
    const ignored = m ? [...m[1].matchAll(/^ +- (\S+)$/gm)].map((mm) => mm[1]) : [];
    expect(ignored).toEqual(['npm-update.yml']);
  });
});
