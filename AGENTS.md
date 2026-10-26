---
trigger: always_on
alwaysApply: true
last_modified: 2026-10-26
---

# newshacker

An unofficial mobile reader *for* Hacker News (`newshacker.app`), not affiliated with Y
Combinator: React, TypeScript, Vite, Vercel. `SPEC.md` is the product,
`IMPLEMENTATION_PLAN.md` the phases.

## Fleet conventions

Shared by every mikelward repo and the user-level agent config; canonical in mikelward/conf
`agents/AGENTS.md`. A repo's Project section overrides it.

### This file

- **Session start**. At the start of every session, print the full absolute path of the
  `AGENTS.md` you loaded and its `last_modified` date.
- **Canonical**. AGENTS.md is canonical; `CLAUDE.md` and `GEMINI.md` point to it. Keep it
  brief, generic to all agents (noting per-agent exceptions), and under 22,000 bytes.
  Bump `last_modified` whenever you edit this file.

### Talking to the user

- **Questions**. One at a time; wait for the answer.
- **Messages**. Send one only for a question, a blocker, something to act on, or a change
  of plan. No progress reports or narrating events.
- **Claude Code**. It reliably shows only a turn's last message; put everything there.
- **Replies**. Short, key point first, ending with open PR links and any pending
  question.
- **Network access**. If you want access to a host and you can't access it or a mirror,
  ask the user to allowlist the domain(s) along with the purpose.

### Git

- **Branches**. `<agent>/<topic>` off a fresh `origin/main` (fetch by refspec). Never
  commit to `main`.
- **Your branches**. Push, force-push with lease, and delete them freely. Ask before
  touching others', `main`, settings, secrets or paid services.
- **Commits**. One per logical change; fold in review fixes.
- **Subjects**. Changelog lines: imperative, the user-visible change, ≤ 70 chars. PR
  titles match.
- **Prefixes**. `docs:`, `test:`, `build:`, `refactor:` mark what users won't notice. No
  `feat:` or `fix:`.
- **Model names**. Never in anything pushed.
- **After a merge**. Branch afresh.
- **Shallow clones**. Unshallow before trusting history or calculating a version code.
- **Language**. US English everywhere.

### Pull requests

- **Opening**. Open the PR unasked; update its title and body before each push.
- **Watching**. PR events plus one scheduled check (events miss CI success and Codex's
  👍).
- **Auto-merge**. Enable it on PRs that target `main`; stack dependent ones.
- **Base moved**. After a merge, tell open PRs on that base whose body ends with a session
  URL.
- **Merge or close**. Answer remaining threads and stop watching.

### Reviews

- **Codex**. It reviews automatically. Fix, decline with a reason, or defer to `TODO.md`
  every comment; reply citing the commit, then resolve.
- **Merit**. Codex over-reads rules, privacy especially: quote and decline rather than
  cripple the code. Design changes are the user's call.
- **Verdict**. 👍 is clean, 👀 is reviewing. Only the code review gates merging: its
  findings (review comments, PR comments, reviews) block it. Security reviews often
  hang; don't wait on them.
- **Hung review**. `@codex review` after five quiet minutes, again an hour later, then
  tell the user.
- **After a 👍**. Ask before unneeded changes.
- **Reports**. Give each review's findings in your next message.

### Autonomy

- **Fix proactively**. Lint, test, presubmit, CI and review failures, unasked.
- **Proactive refactors**. Repeated bugs in one area, duplicated code, or a change with
  twins elsewhere: suggest the redesigned or shared version.
- **Drive to merge**. Once the details are agreed, see the change through unattended:
  implement it, open the PR, keep it mergeable (fix CI, answer reviews, rebase when it
  conflicts or falls behind), and merge once CI is green and Codex 👍s, or let
  auto-merge.
- **Drive**. Take `TODO.md` items one at a time and drive each to merge, until done or
  stopped.
- **Autopilot**. Drive without asking, logging guesses in `TODO.md` under *Decisions
  needing review*. Still ask before anything irreversible, outside this repo, or private.
- **Red baseline**. Fix existing failures first, in their own commit.

### Quality

- **Tests**. Every behavior change gets one; a bug fix's fails first. Assert behavior,
  not structure. No sleeps or retries; never disable a failing check.
- **Docs**. Keep `SPEC.md` and `README.md` current.
- **CI**. Wait for it before claiming success.
- **Errors**. Never swallow one; log it with context and clean up.
- **Cost**. State the cost and reliability of new dependencies or services up front.
- **Privacy**. No user data (personal paths, hostnames, tokens, keys, private remotes)
  leaves this machine; use placeholders.
- **Portability**. Flag anything that won't run on Linux and macOS.

## Project

- **Name**. Never call it "Hacker News" or use HN's logo.
- **Scope**. No flagging, moderation or submitting.
- **Look**. Mobile-first; orange `#ef5f00` on cream `#f6f6ef`.
- **Tap targets**. At most three zones per story row (two used), each ≥ 44×44px and 8px
  apart. Push back on new tappables.
- **Pinned ≠ Favorite**. Separate stores, hooks and UI.
- **Servers**. Prefer HN's API and stateless functions; justify any store or scheduled
  job.
- **HN's cookie**. Keep it server-side.
- **Admin**. Operator data only at `/admin`, verified with HN, failing closed. `/debug`
  is public.
- **Buttons**. Use `<TooltipButton>`; icon-only ones need an `aria-label`.
- **Hover**. Styles go inside `@media (hover: hover)`.
- **Private**. The operator's HN username and cookies, `ADMIN_USERNAME`, keys, billing.

### Vercel `api/` gotchas

- **Shared modules**. `api/*.ts` share none: duplicate helpers (`api/imports.test.ts`).

### Process

- **Checks**. `npm test`, `npm run lint`, `npm run typecheck` (plus `npm run build` for
  build changes); coverage ≥ 80%.
- **Prefix**. `todo:` for `TODO.md`-only changes.
- **Drive**. Follow `IMPLEMENTATION_PLAN.md` phase order.
- **SHAs**. Report the short SHA after each push or merge.
- **Dependency updates**. They come from mikelward/npm-update.
- **Node**. `.nvmrc`, `engines.node` and `@types/node` move together; the session-start
  hook is shared with gedmap and readmo.
