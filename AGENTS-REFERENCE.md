# Agent reference

Background for the rules in `AGENTS.md`: why each exists, what it cost to learn,
and the dormant configuration it guards. `AGENTS.md` holds the rules themselves
and is what every agent loads each session (Antigravity truncates rule files past
24,000 bytes, so it stays short); this file is read on demand. When the two
disagree, `AGENTS.md` wins — fix this file.


## Vercel `api/` gotchas

- **No shared modules for `api/*.ts` — keep helpers inlined, even if
  they're duplicated across handlers.** Both obvious escape hatches
  from the duplication have been tried on Vercel and both failed
  *only at deploy time*, after every local check (`npm test`, `lint`,
  `typecheck`, `build`) had passed:
  1. Importing from outside `api/` (e.g. `src/lib/…`, a sibling
     top-level `lib/` folder). The Vercel bundler's import tracer
     inconsistently includes the files — `summary.ts` was bitten by
     this historically and carries a comment about it.
  2. Importing from a `_`-prefixed directory inside `api/`
     (e.g. `api/_lib/session.ts`). Vercel treats `_` as "don't route"
     *and* "don't ship", so the deployed Lambda errors at startup
     with `ERR_MODULE_NOT_FOUND: Cannot find module
     '/var/task/api/_lib/…' imported from /var/task/api/items.js`.
     Tests pass locally because Vite resolves the import via Node
     module resolution; Vercel's tracer is what drops it.

  A non-underscore subdirectory (`api/lib/…`) would ship, but Vercel
  would route every file in it as its own serverless function, which
  breaks in different ways. There is no currently-known way to share
  code between sibling `api/*.ts` handlers reliably on Vercel; the
  accepted pattern is to copy-paste the helper, add a comment that
  points at the siblings, and move on.

  A regression test at `api/imports.test.ts` scans every `api/*.ts`
  file and fails if it imports from a subdirectory of `api/` or from
  a parent directory. If you find yourself tempted to try this again,
  that test is the first sign it's about to fail in production.
  Delete the test only if you've actually deployed and verified the
  new approach works on a Vercel preview.

## Racy tests: the `gateFetchOn` pattern

- **Avoid racy / flaky tests.** Never paper over a timing race with
  `await new Promise(r => setTimeout(r, 500))`, a retry loop, or a bumped
  `findBy*` timeout. If a test depends on ordering (async resolution,
  render commit, effect flush, layout measurement), make the ordering
  explicit: resolve a controlled promise, advance fake timers, wrap in
  `act(...)`, or hold the in-flight fetch open behind a gate you
  release from the test (see `gateFetchOn` in `Thread.test.tsx` for the
  canonical pattern — it exists specifically so React 18's
  `useSyncExternalStore` doesn't swallow intermediate loading-state
  renders by re-reading a since-settled snapshot at commit time). A
  test that passes "most of the time" is broken; rewrite it or fix the
  underlying cause.

## Sticky `:hover` on touch devices

- **Sticky `:hover` on touch devices.** On phones and tablets, tapping a
  button leaves the `:hover` style "stuck" on it until the user taps
  somewhere else — a touch has no corresponding "leave" event, so the
  browser keeps the hovered state active. The symptom is an unwanted
  background (or color/shadow) lingering on a button after the tap
  completes. **Fix:** wrap any `:hover` rule that changes the painted
  appearance of the element in `@media (hover: hover) { … }` so it
  only applies on devices with a true pointer. Keep the matching
  `:active` rule **outside** the media query so the pressed-state
  darkening still fires on touch. Reference pattern: `.story-row__body`
  in `src/components/StoryListItem.css` — `:hover` inside the media
  query, `:active` outside. Every new tappable (button, link, icon
  button) should follow the same shape.

## `resolve_review_thread`

- **`resolve_review_thread` works — the old MCP limitation is fixed.** `mcp__github__pull_request_read` / `get_review_comments` now returns each thread's node ID (`PRRT_*`) on the `review_threads[].id` field, alongside `is_resolved` / `is_outdated` / `is_collapsed`. Pass that `PRRT_*` value straight to `mcp__github__resolve_review_thread` as `threadId` (without the MCP tools, `gh api graphql` `resolveReviewThread` takes the same ID). Do NOT pass a comment's node ID (`PRRC_*`) — that still fails with `Could not resolve to PullRequestReviewThread node`; the thread ID and the comment ID are different objects. So the full round-trip is available: reply, then resolve, with no "replied-but-unresolved, please resolve in the UI" caveat in the end-of-turn summary.

  > **History.** This was previously documented as broken: the response stripped the thread node ID, leaving no way to obtain a `threadId`. Tracked upstream as github/github-mcp-server#2331 (issue) and github/github-mcp-server#2245 (fix). Verified working against a real Codex review thread on PR #406 (2026-07-24). Kept as a note rather than deleted so the next agent that hits a resolve failure knows this was a real, since-fixed upstream bug and doesn't re-derive it.

> **History.** This was previously documented as broken: the response stripped the thread node ID, leaving no way to obtain a `threadId`. Tracked upstream as github/github-mcp-server#2331 (issue) and github/github-mcp-server#2245 (fix). Verified working against a real Codex review thread on PR #406 (2026-07-24). Kept as a note rather than deleted so the next agent that hits a resolve failure knows this was a real, since-fixed upstream bug and doesn't re-derive it.

## Why there is no `deps:` prefix

- **No `deps:` either — a dependency bump changes what the app runs, so it's
  bare like any other release-worthy change.**
  `.github/workflows/npm-update.yml` used to write a `deps:` prefix on the
  weekly batch specifically, which is how 33 of the last 50 commits ended up
  reading `deps: Update dependencies (<date>)` with nothing to say whether
  the app actually changed. That prefix is gone now: a bump taken *because*
  of the behavior it changes still says what changed; the routine weekly
  bump has nothing extra to say, but it's bare too. Renovate's old `chore:` /
  `fix(deps):` subjects were never the model here either way; that was a
  bot's convention, and Renovate is off.

## Why a merged branch name is not reset

- **After a merge, take a fresh `<agent>/<short-topic>`** — don't reset the merged name onto the new base. Its remote ref still points at the pre-merge tip, so `origin/<branch>..HEAD` keeps spanning the merged commits and unpushed-work checks report your own merged history back at you. When a sandbox pins the branch name so a fresh one isn't available, say so and ask before resetting it. No short check reliably separates "already merged" from "not yet merged" here: a rebase merge rewrites the commits, a squash merge collapses them, `main` moves on underneath so a tip-to-tip diff reports upstream drift as branch work, the remote ref can hold a commit the local one doesn't, and no tree comparison sees the uncommitted work a `--hard` reset would erase. Confirming costs one question in a rare situation; guessing costs someone their work. Don't reach for `--force-with-lease` as the safety net either — fetching updates the remote-tracking ref the lease compares against, so a commit you have already fetched passes the lease unnoticed.

## Dependency updates and dormant Renovate config

- **The weekly batch itself now lives in mikelward/npm-update.** `.github/workflows/npm-update.yml` here is a thin caller (`uses: mikelward/npm-update/.github/workflows/npm-update.yml@main`, plus the schedule and the permissions grant) — see that repo's README.md for the wiring contract and its own AGENTS.md/`check-npm-update.mjs` for the mechanism (fingerprinting, the consumer-declared lockfile-major-crossing walk, the two-job read-only/write-token split, the ci.yml dispatch). A fix to the mechanism now lands in mikelward/npm-update, not here — this file no longer duplicates that narrative, to avoid the drift a hand-synced copy would cause.
- **Cost and failure mode of that dependency:** zero dollars — it's another
  GitHub Actions job in the same free-tier budget as the old local copy, just
  hosted at `mikelward/npm-update` instead of here. If that repository ever
  goes private, is deleted, or the `@main` ref stops resolving, the scheduled
  run fails at the `uses:` step with no PR opened and no other symptom — the
  Actions run log for `npm update` is the only place that shows up, since a
  failed scheduled workflow doesn't otherwise notify anyone.
- **Renovate is off.** `"enabled": false` at the top of `renovate.json` is the
  master switch: the job still runs, logs `Repository is disabled`, and creates
  nothing — no PRs, no `renovate/*` branches, no dependency dashboard, and no
  vulnerability-alert PRs either, since a disabled repo is skipped before alerts
  are considered. It was switched off after the config kept producing PRs that
  were unmergeable or actively harmful: Node patches that could never go green,
  and — once `constraints.npm` was added — an auto-merge-eligible npm floor
  above what the pinned Node major bundles. GitHub's Dependabot **alerts** stay
  on, but its **security updates** are off too (2026-09-11): a grouped
  security update for a transitive `@vitest/mocker` advisory arrived as a
  vitest 4 → 5 major when the patched 4.1.11 sat inside the declared range,
  because grouped security updates resolve to the latest version, not the
  lowest fixed one. An advisory is therefore an alert to act on by hand — bump
  the affected package together with any peer-pinned partner
  (`@vitest/coverage-v8` for vitest) — unless the weekly npm-update batch has
  already carried the fix. Everything in the Renovate bullets below is dormant
  but retained, so re-enabling is deleting one key rather than rebuilding a config that took several rounds to
  get right; `renovate.test.ts` asserts the switch, so an accidental re-enable
  fails CI. Uninstalling the Mend app at developer.mend.io is the other half, if
  you want the jobs to stop running at all.
- **Renovate (Mend-hosted app) owns dependency bumps.** Dependabot is gone —
  `.github/dependabot.yml` was removed in `a474df7`. Config lives in
  `renovate.json` at the repo root; validate changes with
  `npx --package renovate renovate-config-validator`.
- **`mode=silent` is set on Mend's side, and it suppresses everything.** The
  Mend-hosted app injects its own config via `RENOVATE_CONFIG`, and this repo
  ran with `"mode": "silent"` for its first twelve days. The job log says it
  outright: `Repository is running with mode=silent and will not make Issues
  or PRs by default`. Renovate does the full run — clone, vulnerability
  alerts, dependency extraction — and then creates nothing: no PRs, no
  `renovate/*` branches, no Dependency Dashboard, and no onboarding PR either
  (`Silent mode enabled so repo is considered onboarded`). That gap is how the
  tree accumulated four fixable high-severity advisories unnoticed.
  `renovate.json` now states `"mode": "full"` — that's the repo-side intent
  (and what a self-hosted or CLI run honors), but the **injected value wins**,
  so it's belt-and-braces, not the fix. The authoritative switch is per-repo
  in the Mend Developer Portal (developer.mend.io → repo/org → Interactive).
- **A `DONE` job on the Mend dashboard does not mean Renovate did anything.**
  A silent-mode run completes normally and reports `DONE`. So "jobs are
  running and succeeding" and "the repo is producing nothing" look identical
  from the job list — you have to open a job's log to tell them apart.
- **Renovate silence is not success.** If no Renovate PR or Dependency
  Dashboard issue has appeared in a while, open the per-repo job log at
  developer.mend.io before assuming there's nothing to update — every failure
  mode here is silent, by construction.
- **A top-level `schedule` is a delay, not a gate — and it never applies to
  security fixes.** Renovate forces `schedule: []` and `prCreation: immediate`
  on vulnerability-alert branches, so advisories are never held back by a
  window. Worth knowing before blaming a schedule for missing PRs: this repo's
  Saturday-morning window was the first suspect and it was the wrong one.
  Noise is bounded by `prConcurrentLimit` plus the `minimumReleaseAge`
  cooldowns, which is the better lever anyway.
- **Deleting `lockFileMaintenance.schedule` does not mean "any time".** That
  option's own default is `before 4am on monday`, so dropping the key silently
  restores a weekly window instead of removing one. `renovate.test.ts` guards
  that, along with `mode` and the top-level `schedule` — all three are
  settings whose wrong value produces no error, just less output.
- **`minimumReleaseAge` is a lookup-time filter, so `.npmrc` carries the other
  half.** Renovate applies its cooldown when it *looks up* a version, which
  means it only ever governed the direct dependency a PR names. Lock file
  maintenance never does a lookup — it deletes the lockfile and lets npm
  rebuild it, taking whatever is newest — and those PRs auto-merge, so the
  highest-volume path to production was the one path with no cooldown on it.
  Transitive dependencies escaped the same way inside ordinary bumps: Renovate
  picks the direct version, npm resolves everything underneath. `.npmrc` sets
  npm's own `min-release-age` (5 days, matching the shortest Renovate cooldown;
  `renovate.test.ts` asserts they stay in step), which npm enforces while
  resolving and therefore covers both. It only affects resolution — `npm ci`
  installs from the lockfile, so CI and Vercel builds are untouched.
- **The npm that resolves is the one that has to support the window, and for
  lock file maintenance that npm is Renovate's.** `min-release-age` landed in
  **npm 11.10.0** and is silently ignored before it ("Unknown project config"),
  so the floor is declared rather than inferred from the Node major — Node
  bundles vary within one: 24.12.0 ships npm 11.6.2 (no), 24.14.1 ships 11.11.0
  (yes). `engines.npm` covers local installs and Vercel; `constraints.npm` in
  renovate.json covers the lockfile regeneration that the window exists to
  protect. Both are asserted, because an unsupported npm doesn't fail — it just
  quietly resolves without the window. If the window ever blocks an
  `npm audit fix`, npm keeps the vulnerable version and exits non-zero rather
  than failing quietly — `min-release-age-exclude` is the escape hatch for
  taking that fix immediately.
- **The npm floor is not a dependency, and Renovate must not treat it as one.**
  Adding `constraints.npm` made Renovate start managing it: within minutes it
  opened `>=11.18.0` (a minor, so auto-merge eligible) and `v12` in all three
  repos. Both sit above the npm Node 24 actually bundles — 24.18.1 ships
  11.16.0 — so either would EBADENGINE every contributor, CI runner and Vercel
  build, and the lower-bound assertion in renovate.test did **not** catch it,
  because a floor that is too high still clears a `>=` check. `npm` is now
  disabled in packageRules, and the guard pins the floor to exactly the release
  that introduced the option rather than asserting a minimum. Raise it by hand
  only if a later npm becomes genuinely required, and check what the pinned
  Node major bundles first.
- **Minors and patches auto-merge on green CI; majors always wait for review.**
  Pre-1.0 (`0.x`) packages are excluded from auto-merge — SemVer permits
  breaking changes in a 0.x minor. Auto-merge is only as safe as CI, so a red
  or skipped check is a stop sign, not noise to route around.

## Node version

- **The Node major is named in three places and they move together or not at
  all:** `.nvmrc` (CI's `setup-node` via `node-version-file`, `nvm use`, and
  the web sandbox's session-start hook), `engines.node` in `package.json`
  (Vercel's build image and function runtime, plus npm's EBADENGINE warning),
  and `@types/node` (what `tsc` believes the runtime's stdlib looks like).
  `nodeVersion.test.ts` fails CI on a mismatch.
- **A split is quiet in the worst way** — the suite goes green on one runtime
  while production serves another, or `tsc` type-checks against APIs the
  deployed Node doesn't have.
- **Not declaring `@types/node` does not mean not having it.** `vite`,
  `vitest` and `happy-dom` all depend on it with ranges permissive enough to
  resolve any newer major, and `tsconfig.node.json` doesn't narrow
  `compilerOptions.types` — so with no direct dependency, `vite.config.ts` was
  type-checked against **Node 26** types on a Node 24 runtime. It is now pinned
  directly, and `nodeVersion.test.ts` asserts the version **resolved in the
  lockfile**, not just the declared range: a declared-range check stays green
  through exactly this, because what `tsc` loads is whatever npm hoisted.
- **The web sandbox is the consumer that can't follow on its own.** Its image
  ships whatever Node it ships (22 today), so `.claude/hooks/session-start.sh`
  (auto-invoked only in Claude Code; other agents run it themselves)
  provisions the `.nvmrc` major before `npm install` — before any native dep
  builds against an ABI. It re-resolves the newest release of that major every
  run rather than trusting the container's cached copy, because container state
  survives between sessions and an existence-only check would pin the first
  version ever installed. Best-effort: an unreachable nodejs.org keeps the
  cached toolchain and says so, rather than failing session startup.
- **Provisioning the runtime and making it REACH the session are two
  problems, and the second one failed silently for a while.** The hook
  exports PATH and writes it to `$CLAUDE_ENV_FILE` — but that variable is not
  always set (it is unset in the web sandbox today), and then the export
  reaches only the hook and its children: `/opt/node24` sat there correctly
  provisioned while every agent shell ran the image's Node 22, on an npm too
  old to honor `.npmrc`'s cooldown. A shell rc file is not the fallback — the
  harness snapshots the environment before hooks run, so an rc edit lands a
  session late while looking like it worked. So the fallback changes what the
  NAME resolves to instead: symlinks for `node`/`npm`/`npx` (and `deno` where
  the hook installs one) in the first PATH directory **under `$HOME`** that
  exists — it creates only `~/.local/bin`, never another tool's missing
  directory such as `~/.nix-profile/bin` — which
  wins the lookup whatever a later shell sources. Three refusals keep that
  from being a lie: it links nothing if any tool is missing or unrunnable in the source,
  nothing if any *earlier* PATH entry still supplies one of the names (node
  and npm need not come from the same directory, so the question is asked per
  tool), and nothing over a real file — all decided before the first link,
  because a half-linked toolchain is a split one, worse than the fallback it
  replaces. It does **not** stop at whichever directory currently answers:
  from the second session on that is this shim directory itself, and refusing
  to touch its own links would strand every later `.nvmrc` major on the old
  runtime.
- **The hook is identical in all three repos, and so is its test.**
  `scripts/session-start-hook.test.ts` runs the real hook end to end against a
  temp install root and a `file://` release fixture, via the `SESSION_NODE_ROOT`
  and `SESSION_NODE_DIST_URL` seams — no network, no stubbed internals. Its
  failure mode is a *false pass*, so behavior is asserted, not structure. When
  you change the hook, change it everywhere and keep the Node block byte-identical.
- **A `@types/node` major is a runtime migration, not a dependency update.**
  Renovate is configured not to offer it, so it stops arriving as an
  unmergeable weekly PR. Move the runtime deliberately, all pins at once.
- **Renovate does not bump the Node runtime either, and can't be made to.**
  `.nvmrc` holds the bare major on purpose — every consumer resolves the newest
  release of it on its own — but Renovate's nvm manager can only write a *full*
  version, so `update node.js to v24.18.1` rewrote `.nvmrc` to `24.18.1` and
  `nodeVersion.test.ts` failed it, in all three repos, every time a Node patch
  shipped. There was never a mergeable version of that PR: the upgrade it
  offers already happens at runtime without a commit. Patches and minors are
  off; a **major** is held behind `dependencyDashboardApproval`, so a new LTS
  still shows up on the dashboard without opening a PR nobody can merge.
  Checking that box means "I am doing the migration now" — expect to restore
  the bare major in `.nvmrc` by hand in that branch.
- Currently Node **24** (the active LTS; 22 dropped to maintenance when 26
  shipped).


## Waking PRs a merge leaves behind

On receiving a "base now points at `<sha>`" message, fetch base and PR head by
refspec (unshallowing) and test that head against the fetched tip, not `<sha>`
(a later merge may have passed it): `behind` if `git merge-base --is-ancestor
<tip> <head>` exits 1, `dirty` if `git merge-tree --write-tree` (Git 2.38+)
exits 1; any other exit is a failure to report, not an answer. Your own rules
then decide the rebase. The sender names no merge and no other PR because an
older copy of these rules reads either as its own merge cue.
