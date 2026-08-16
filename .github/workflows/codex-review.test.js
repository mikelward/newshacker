// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The sweep's logic and its tests live in mikelward/codex-review; what stays
// in THIS repo is the workflow that grants it a token and decides when it
// runs — and every one of these pins guards a value whose wrong setting
// produces no error, just a gate that silently stops doing its job. The
// design rationale is in the workflow's own header and, at full length, in
// the shared repo.

const dir = fileURLToPath(new URL('.', import.meta.url));
const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const workflow = read('./codex-review.yml');

describe('codex-review workflow', () => {
  it('runs the shared action, unpinned on main, with no checkout', () => {
    // @main is deliberate: the action has no build step and no dependencies,
    // so the file that runs is the file you can read, and pinning would only
    // delay gate fixes. No checkout, also deliberate: the sweep needs
    // nothing from this tree, and a checkout would put a token-bearing
    // .git/config within reach of a status-writing job.
    expect(workflow).toContain('uses: mikelward/codex-review@main');
    expect(workflow).not.toContain('actions/checkout');
  });

  it('starts on every event that can change the verdict, and no unsafe one', () => {
    // pull_request_target and the comment events take the workflow
    // definition from the default branch — a PR cannot bring its own sweep.
    // workflow_dispatch took a ref and ran the file FROM that ref, which is
    // why it must never return; a bare pull_request has the same hole via
    // the merge ref. `closed` clears a shared-head failure the moment the
    // duplicate goes away; `edited` hears a nudge edited into an old comment.
    const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('permissions:'));
    expect(on).toMatch(/pull_request_target:/);
    expect(on).toMatch(/types: \[opened, reopened, ready_for_review, synchronize, closed\]/);
    expect(on.match(/types: \[created, edited\]/g)).toHaveLength(2);
    // A verdict submitted as a review with no inline comments emits only
    // pull_request_review — neither comment event, no reaction — but that
    // event is merge-ref (the PR supplies the workflow definition), so it
    // lives on the unprivileged listener and reaches this status-writing
    // workflow via workflow_run, whose definition always comes from the
    // default branch. Both halves are asserted by name — renaming one
    // without the other severs the relay silently.
    expect(on).toMatch(/workflow_run:\n\s+workflows: \[codex-review-listener\]\n\s+types: \[completed\]/);
    expect(on).not.toMatch(/workflow_dispatch/);
    expect(on).not.toMatch(/pull_request:/);
    expect(on).not.toMatch(/pull_request_review:/);
    const listener = read('./codex-review-listener.yml');
    expect(listener).toMatch(/^name: codex-review-listener$/m);
    expect(listener).toMatch(/pull_request_review:\n\s+types: \[submitted, edited, dismissed\]/);
    expect(listener).toMatch(/^permissions: \{\}$/m);
  });

  it('keeps the backstop schedule hourly, off the hour', () => {
    // Everything the schedule alone catches fails closed and any comment
    // clears it on demand; on a private repo each idle fire bills a full
    // minute, so hourly (~720/month) is the deliberate trade against
    // `*/15`'s ~2,900. Off :00, dodging the shared scheduler's stampede.
    expect(workflow).toMatch(/cron:\s*'23 \* \* \* \*'/);
  });

  it('holds the loop envelope: one queued successor, bounded runner', () => {
    // cancel-in-progress must stay false — a canceled loop is a gate that
    // stops sweeping mid-review — and 65 minutes caps a hung API call ten
    // minutes past the action's 55-minute loop.
    expect(workflow).toMatch(/cancel-in-progress: false/);
    expect(workflow).toMatch(/timeout-minutes: 65/);
  });

  it('is the only workflow that can write commit statuses', () => {
    // A second status writer is an ordering race with the verdict — the
    // deleted codex-verdict-reset workflow was exactly that bug. The sweep
    // stays the single writer, and this scan goes red the moment any other
    // workflow acquires the scope.
    for (const name of readdirSync(dir)) {
      if (!/\.ya?ml$/.test(name)) continue;
      const text = read(`./${name}`);
      if (name === 'codex-review.yml') {
        expect(text).toMatch(/statuses: write/);
      } else {
        expect(text, `${name} must not hold statuses: write`).not.toMatch(/statuses:\s*write/);
      }
    }
  });
});
