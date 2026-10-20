// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Pins ci.yml's workflow-level concurrency group. Its failure is silent: a
// group that cancels the wrong run leaves a required check canceled or
// missing on a head, and one that cancels nothing quietly doubles every
// push's runs; neither turns any job red.
//
// Read as regexes over YAML, the same tradeoff workflow-check-rename.test.ts
// makes: the exact lines a human wrote are pinned, after asserting the block
// is there at all.

const workflow = readFileSync(fileURLToPath(new URL('./workflows/ci.yml', import.meta.url)), 'utf8');
const MAIN =
  "(github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'))";
const block = workflow.match(/^concurrency:\n((?: {2}.*\n)+)/m);

describe('the workflow-level concurrency group', () => {
  it('is declared once', () => {
    expect(block, 'ci.yml has no workflow-level concurrency block').not.toBeNull();
    expect(workflow.match(/^concurrency:/gm)).toHaveLength(1);
  });

  it('groups a pull request by its number, a dispatch by the PR it names, and main by commit', () => {
    // A dispatch at the weekly dependency branch falls through to its ref,
    // so a re-dispatch replaces the stale run on that branch.
    expect(block[1]).toContain(
      `  group: ci-\${{ ${MAIN} && format('main-{0}', github.sha) || github.event.pull_request.number || inputs.pr || github.ref }}\n`,
    );
  });

  it('cancels on a push, open or reopen, never on main or an edit', () => {
    // An `edited` run carries the head as of the edit, and GitHub doesn't
    // promise to start runs in event order, so a canceling edit could cancel
    // the only run on a newer head; it queues instead.
    expect(block[1]).toContain(
      `  cancel-in-progress: \${{ !${MAIN} && github.event.action != 'edited' }}\n`,
    );
  });

  it('still runs on an edit, so a retarget re-runs the lane', () => {
    expect(workflow).toMatch(/types: \[opened, synchronize, reopened, edited\]/);
  });
});
