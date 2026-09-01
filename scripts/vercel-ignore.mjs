// Vercel's Ignored Build Step: decide whether this commit needs a deployment.
//
// Vercel deploys through its own GitHub integration, outside GitHub Actions,
// so nothing in .github/workflows/ci.yml can gate it — a docs-only merge still
// built and promoted a new production deployment, and a docs-only PR still
// built a preview. This is the only hook Vercel offers for that decision:
// it runs after the clone and before install, and its exit code decides.
//
//   exit 0 → skip the build (Vercel marks the deployment CANCELED)
//   exit 1 → build
//
// Wire it up with `ignoreCommand` in vercel.json.
//
// THE POLICY IS NOT DUPLICATED HERE. Which paths are documentation lives in
// .github/lanes.conf, the same file mikelward/lanes reads to skip CI's heavy
// jobs, and this script reads that file rather than restating it — a second
// copy in another language, verified by nothing, is exactly the drift the
// lanes engine exists to delete. What this does re-implement is the ~10 lines
// of matching around it, using `path.matchesGlob` for identical semantics.
//
// IT FAILS OPEN. Every uncertainty — no previous deployment, a SHA missing
// from Vercel's shallow clone, an unparseable policy, a directive this file
// does not recognize, an empty diff, any thrown error — exits 1 and builds.
// A needless build costs a few minutes; a wrongly skipped one leaves
// production behind its own main branch with nothing to say so.
//
// Cost/reliability (guardrail #5): no network and no third-party service —
// it reads one file and runs `git diff` inside a clone Vercel already made.
// Negligible, and its worst failure mode is the behavior we have today.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path, { matchesGlob } from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const POLICY_PATH = '.github/lanes.conf';

/** Directives lanes.conf may carry. An unknown one means this file is out of
 *  date with the engine and cannot be trusted to classify — see `parsePolicy`. */
const KNOWN_DIRECTIVES = new Set([
  'code',
  'docs',
  'prefixes',
  'lint-title',
  'push',
  'dispatch-without-pr',
]);

/**
 * Parse .github/lanes.conf the way mikelward/lanes parses it: a trailing
 * comment starts at whitespace-then-`#`, full-line comments and blanks are
 * dropped, and each remaining line is a directive plus its argument.
 *
 * Only `code` and `docs` decide a path. The rest are read solely to notice a
 * directive this file has never heard of, which is a signal to stop guessing.
 *
 * @param {string} text
 * @returns {{ rules: Array<{verdict: 'code'|'docs', pattern: string}>, unknown: string[] }}
 */
export function parsePolicy(text) {
  const rules = [];
  const unknown = [];

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;

    const [directive, ...rest] = line.split(/\s+/);
    const argument = rest.join(' ');

    if (directive === 'code' || directive === 'docs') {
      if (!argument) {
        unknown.push(`${directive} (no pattern)`);
        continue;
      }
      rules.push({ verdict: directive, pattern: argument });
    } else if (!KNOWN_DIRECTIVES.has(directive)) {
      unknown.push(directive);
    }
  }

  return { rules, unknown };
}

/**
 * Is one repo-relative path documentation? First matching rule wins; a path
 * matching no rule is code. The policy file itself is always code — an edit to
 * the rules is a change to what CI validates.
 *
 * @param {string} file
 * @param {Array<{verdict: string, pattern: string}>} rules
 */
export function isDocs(file, rules) {
  if (file.toLowerCase() === POLICY_PATH) return false;
  for (const { verdict, pattern } of rules) {
    if (matchesGlob(file, pattern)) return verdict === 'docs';
  }
  return false;
}

/**
 * Decide from a file list. Returns the reason too, so the build log says why.
 *
 * @param {string[]} files repo-relative paths
 * @param {string} policyText contents of .github/lanes.conf
 * @returns {{ docsOnly: boolean, reason: string }}
 */
export function classify(files, policyText) {
  const { rules, unknown } = parsePolicy(policyText);
  if (unknown.length > 0) {
    return {
      docsOnly: false,
      reason: `${POLICY_PATH} carries a directive this script does not know (${unknown.join(', ')}) — building rather than guessing`,
    };
  }
  if (rules.length === 0) {
    return { docsOnly: false, reason: `${POLICY_PATH} declares no lane rules` };
  }
  if (files.length === 0) {
    return { docsOnly: false, reason: 'the diff is empty' };
  }

  const code = files.filter((f) => !isDocs(f, rules));
  if (code.length > 0) {
    return {
      docsOnly: false,
      reason: `${code.length} of ${files.length} changed file(s) are code, first: ${code[0]}`,
    };
  }
  return { docsOnly: true, reason: `all ${files.length} changed file(s) are documentation` };
}

/**
 * One line of a thrown error, for the build log.
 *
 * Every fail-open path below builds either way, so the reason string is the
 * ONLY diagnostic this has — and without the underlying failure, a corrupt
 * object store or a permission problem is indistinguishable from the expected
 * shallow-clone miss, which is how an infrastructure fault hides for months.
 * Sanitized by construction: these are git and fs failures about paths inside
 * Vercel's own build container, never repository content.
 */
function why(error) {
  const text = String(error?.stderr || error?.message || error || '').trim();
  return text.split('\n')[0].slice(0, 200) || 'no error text';
}

/** A SHA Vercel handed us, or null if it isn't one. */
function sha(value) {
  const trimmed = (value ?? '').trim();
  return /^[0-9a-f]{7,40}$/.test(trimmed) ? trimmed : null;
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/**
 * The whole decision, from the environment Vercel provides.
 *
 * The range is `VERCEL_GIT_PREVIOUS_SHA..VERCEL_GIT_COMMIT_SHA` — the last
 * successful deployment of this project and branch, against what is being
 * deployed now. That, not `HEAD^..HEAD`: this repo rebase-merges, so one merge
 * pushes every commit of a PR and `HEAD^` would see only the last of them —
 * a PR whose final commit was docs would skip a deployment carrying code.
 * Skipping never loses a deployment this way, because the previous SHA stays
 * put until something actually deploys: the next code push is measured from
 * the same place and carries the docs commits along with it.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ docsOnly: boolean, reason: string }}
 */
export function decide(env) {
  const previous = sha(env.VERCEL_GIT_PREVIOUS_SHA);
  if (!previous) {
    // Empty on a branch's FIRST deployment, and reportedly on some projects
    // that have not enabled system environment variables. So a docs-only
    // branch still builds its first preview, once, and skips every push after
    // it; production, where the previous successful deployment always exists,
    // skips from the first docs-only merge onward. That is deliberate rather
    // than a gap to close: the only base available for a first deployment
    // would have to be fetched (this clone is `--depth=10` of one branch, so
    // `origin/<default>` is not in it), which puts a network call and a new
    // failure mode on the decision path to save a single build per branch.
    return { docsOnly: false, reason: 'VERCEL_GIT_PREVIOUS_SHA is unset — no range to measure' };
  }
  const current = sha(env.VERCEL_GIT_COMMIT_SHA) ?? 'HEAD';

  for (const rev of [previous, current]) {
    try {
      git('cat-file', '-e', `${rev}^{commit}`);
    } catch (error) {
      // Usually the expected case: Vercel clones shallow (--depth=10), so a
      // busy week can put the last deployed commit out of reach. But a corrupt
      // object store, a permission problem, or no git at all fail identically,
      // so the failure travels with the verdict rather than being asserted as
      // absence.
      return { docsOnly: false, reason: `cannot read ${rev} in this clone (${why(error)})` };
    }
  }

  const files = git('diff', '--name-only', '--no-renames', previous, current)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let policyText;
  try {
    policyText = readFileSync(path.join(ROOT, POLICY_PATH), 'utf8');
  } catch (error) {
    return { docsOnly: false, reason: `${POLICY_PATH} is unreadable (${why(error)})` };
  }

  return classify(files, policyText);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let verdict;
  try {
    verdict = decide(process.env);
  } catch (error) {
    verdict = { docsOnly: false, reason: `the check itself failed: ${why(error)}` };
  }
  console.log(`vercel-ignore: ${verdict.docsOnly ? 'skipping' : 'building'} — ${verdict.reason}`);
  process.exit(verdict.docsOnly ? 0 : 1);
}
