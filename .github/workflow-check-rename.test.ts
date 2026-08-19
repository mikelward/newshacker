// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards the temporary state introduced while renaming the required check
// from `gate` to `lanes` (mikelward/lanes#9): a duplicate job, kept in sync
// by hand until the ruleset is flipped and `gate` is deleted. Nothing else
// pins the two jobs together, so a hand edit to one that forgets the other
// would drift silently -- exactly the false-pass failure mode this suite is
// meant to catch.
//
// Read as regexes over YAML, same tradeoff the sibling lanes-policy.test.ts
// makes: a real parser is unnecessary weight for pinning exact strings a
// human wrote and a human will edit.
//
// Delete this file along with the `gate` job once the ruleset requires only
// `lanes` -- it exists to guard the overlap window, not the steady state.

const workflow = readFileSync(fileURLToPath(new URL('./workflows/ci.yml', import.meta.url)), 'utf8');

// A job block runs from its "  <key>:" line to the line before the next
// one at the same (two-space) indent, or EOF.
function jobBlock(text: string, key: string): string {
  const start = text.indexOf(`\n  ${key}:\n`);
  expect(start, `job "${key}" not found in ci.yml`).not.toBe(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(rest.indexOf('\n') + 1).search(/\n {2}\S/);
  const end = next === -1 ? text.length : start + 1 + rest.indexOf('\n') + 1 + next;
  return text.slice(start + 1, end);
}

describe('the temporary gate/lanes duplicate', () => {
  it('both jobs exist while the rename is in flight', () => {
    expect(workflow).toMatch(/\n {2}gate:\n {4}name: gate\n/);
    expect(workflow).toMatch(/\n {2}lanes:\n {4}name: lanes\n/);
  });

  it('gate and lanes run identically apart from their own name', () => {
    const strip = (block: string) => block.replace(/^ {2}\S+:\n {4}name: \S+\n/, '');
    expect(strip(jobBlock(workflow, 'gate')), 'the gate and lanes jobs have drifted -- keep them identical until gate is deleted').toBe(
      strip(jobBlock(workflow, 'lanes')),
    );
  });
});
