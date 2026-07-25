#!/bin/bash
set -euo pipefail

# Only run in Claude Code on the web. Local sessions manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# --- Node toolchain ---------------------------------------------------------
# The repo pins a Node major in .nvmrc, and package.json `engines` narrows to
# that same major — capped rather than open-ended on purpose, because moving
# the major is a runtime migration that has to move every pin at once, not a
# dependency bump. nodeVersion.test fails CI if the two ever disagree.
# The web sandbox ships its own default Node, which will not track that pin —
# so provision the pinned major and put it first on PATH.
#
# This matters beyond tidiness: without it, npm install/test/build silently run
# on a different major than CI (actions/setup-node reads the same .nvmrc) and
# Vercel (which reads `engines`). npm also emits EBADENGINE once the sandbox
# default falls outside the range. Reading the major from .nvmrc rather than
# hard-coding it means the next LTS bump needs no change here.
#
# Cost and reliability (AGENTS.md rule 11). Both requests below go to
# nodejs.org, which is free and unmetered with no account, tier, or key — so the
# project cost is $0/month at any session volume, with no paid threshold to
# cross. Per session that is one ~200 KB release-index GET; the ~50 MB tarball
# is fetched only when the cache is cold or the pinned version moved, so it is
# roughly once per container rather than once per session.
# Reliability: this adds nodejs.org as a new dependency of session startup, and
# it is on the critical path now that the hook is synchronous. Mitigated by
# failing open — an unreachable index or a failed download keeps the cached
# toolchain (or the system one) and logs a warning rather than aborting the
# session — so the worst case is a session that starts on a stale runtime and
# says so, not one that cannot start. Nothing here touches the app's runtime or
# production path; it is developer tooling only.
#
# SESSION_NODE_ROOT and SESSION_NODE_DIST_URL exist so the provisioning
# branches below can be exercised by scripts/session-start-hook.test.ts against
# a temp dir and a file:// fixture. They are test seams only — production never
# sets them. Named without a repo prefix because this hook is kept identical
# across readmo, newshacker and gedmap.
NODE_ROOT="${SESSION_NODE_ROOT:-/opt}"
DIST_URL="${SESSION_NODE_DIST_URL:-https://nodejs.org/dist}"
NODE_MAJOR="$(tr -cd '0-9' < .nvmrc)"

# Lowest version engines.node accepts ("" when it declares no floor beyond the
# major), used by the mismatch check at the end.
#
# Only the caret and bare-major forms are read as a floor (`^24.11.0`, `^24`,
# `24`) — those are the ones where "at or above this" is what the range means.
# An exact pin (`24.11.0`) or an x-range is NOT a floor, and treating it as one
# would accept 24.12.0 for a `24.11.0` pin that npm rejects: wrong in the lax
# direction, which is the direction that stays silent. nodeVersion.test.ts
# rejects those forms outright, so restricting the syntax here is what lets this
# be a string comparison rather than a semver implementation in bash.
NODE_MIN="$(node -e 'const t=(((require("./package.json").engines||{}).node)||"").trim();
  const m=/^\^(\d+(?:\.\d+){0,2})$|^(\d+)$/.exec(t);
  process.stdout.write(m ? (m[1] || m[2]) : "")' 2>/dev/null || true)"

if [ -z "$NODE_MAJOR" ]; then
  echo "session-start: could not read a Node major from .nvmrc; using system node" >&2
else
  NODE_DIR="${NODE_ROOT}/node${NODE_MAJOR}"
  CACHED_VERSION=""
  [ -x "${NODE_DIR}/bin/node" ] && CACHED_VERSION="$("${NODE_DIR}/bin/node" -v 2>/dev/null || true)"

  case "$(uname -m)" in
    x86_64) NODE_ARCH="x64" ;;
    aarch64 | arm64) NODE_ARCH="arm64" ;;
    *) NODE_ARCH="" ;;
  esac

  # Re-resolve the newest release of the pinned major on every run, rather than
  # trusting whatever is already in /opt. Container state is cached between
  # sessions, so a bare "does the directory exist" check would pin the first
  # version ever installed: a later 24.x release — or a raised `engines` minor
  # floor, as happened when Babel 8 required >=24.11 — would leave web sessions
  # on a stale or outright unsupported minor while CI, which re-resolves
  # .nvmrc every run, moved on. That is the same silent-wrong-runtime failure
  # this hook exists to prevent, so the check has to be version-aware.
  NODE_VERSION=""
  if [ -z "$NODE_ARCH" ]; then
    echo "session-start: unsupported arch $(uname -m); using system node" >&2
  else
    NODE_VERSION="$(
      curl -fsSL --retry 3 --retry-delay 2 \
        --connect-timeout 10 --max-time 60 --retry-max-time 90 \
        "${DIST_URL}/index.json" 2>/dev/null |
        node -e '
          let raw = "";
          process.stdin.on("data", (d) => (raw += d));
          process.stdin.on("end", () => {
            const major = process.argv[1];
            try {
              const hit = JSON.parse(raw).find((r) => r.version.startsWith(`v${major}.`));
              if (hit) process.stdout.write(hit.version);
            } catch {}
          });
        ' "$NODE_MAJOR" || true
    )"
  fi

  if [ -z "$NODE_VERSION" ] && [ -n "$NODE_ARCH" ]; then
    # Offline or the index was unreachable. Keep whatever is cached rather than
    # failing the session; the engines check below still reports if it's stale.
    echo "session-start: could not resolve latest Node ${NODE_MAJOR}.x${CACHED_VERSION:+; keeping cached $CACHED_VERSION}" >&2
  fi

  if [ -n "$NODE_VERSION" ] && [ "$NODE_VERSION" != "$CACHED_VERSION" ]; then
    TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
    TMP_DIR="$(mktemp -d)"
    # Stage under a temp path and swap in only on success, so an interrupted
    # download can't leave a half-populated /opt/nodeNN behind.
    if curl -fsSL --retry 3 --retry-delay 2 \
      --connect-timeout 10 --max-time 300 --retry-max-time 420 \
      "${DIST_URL}/${NODE_VERSION}/${TARBALL}" -o "${TMP_DIR}/node.tar.xz" &&
      tar -xf "${TMP_DIR}/node.tar.xz" -C "${TMP_DIR}" &&
      # Ask the extracted binary what it is before swapping it in. tar exiting 0
      # means the archive unpacked, not that the result runs: a tarball for
      # another arch, or one truncated at a boundary tar tolerates, still gets
      # here. Publishing it would replace a working cache with one that can't
      # run npm, and the swap below is destructive.
      [ "$("${TMP_DIR}/node-${NODE_VERSION}-linux-${NODE_ARCH}/bin/node" -v 2>/dev/null || true)" \
        = "$NODE_VERSION" ]; then
      rm -rf "${NODE_DIR}.tmp"
      mv "${TMP_DIR}/node-${NODE_VERSION}-linux-${NODE_ARCH}" "${NODE_DIR}.tmp"
      rm -rf "$NODE_DIR"
      mv "${NODE_DIR}.tmp" "$NODE_DIR"
      echo "session-start: provisioned Node ${NODE_VERSION} at ${NODE_DIR}${CACHED_VERSION:+ (replacing $CACHED_VERSION)}"
    else
      echo "session-start: failed to fetch Node ${NODE_VERSION}${CACHED_VERSION:+; keeping cached $CACHED_VERSION}" >&2
    fi
    rm -rf "$TMP_DIR"
  fi

  if [ -x "${NODE_DIR}/bin/node" ]; then
    export PATH="${NODE_DIR}/bin:${PATH}"
    # Persist for the rest of the session, including tools the agent shells out to.
    echo "export PATH=\"${NODE_DIR}/bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
  fi
fi

# Loud on mismatch, because running the suite on the wrong runtime yields green
# results that mean nothing — the failure mode is a false pass, not an error.
#
# The full version is checked, not just the major, because the major alone
# misses the case that actually bit: a cached toolchain on the right major but
# below a raised minor floor (Babel 8 needed >=24.11), which npm reports only as
# an EBADENGINE warning. This used to be done with `semver.satisfies` from
# node_modules, which is silent on a cold container — precisely when a stale
# cache matters most. Comparing in the shell instead means it always reports.
#
# `sort -V` orders version strings, so the floor sorts first iff the active
# version is at or above it. That works because NODE_MIN is only derived from
# ranges that genuinely denote a floor (below), rather than reimplementing
# semver here.
ACTIVE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"
ACTIVE_MAJOR="${ACTIVE_VERSION%%.*}"
if [ -n "${NODE_MAJOR:-}" ] && [ "$ACTIVE_MAJOR" != "$NODE_MAJOR" ]; then
  echo "session-start: WARNING active Node is ${ACTIVE_MAJOR:-?}.x but this repo pins ${NODE_MAJOR}.x — results will not match CI" >&2
elif [ -n "$NODE_MIN" ] && [ -n "$ACTIVE_VERSION" ] &&
  [ "$(printf '%s\n%s\n' "$NODE_MIN" "$ACTIVE_VERSION" | sort -V | head -1)" != "$NODE_MIN" ]; then
  echo "session-start: WARNING active Node ${ACTIVE_VERSION} is below the ${NODE_MIN} floor in engines — results will not match CI or Vercel" >&2
fi

echo "session-start: node $(node -v), npm $(npm -v)"

# --- Dependencies -----------------------------------------------------------
# `npm install` rather than `ci` so a warm node_modules from the cached
# container state is reused instead of being deleted and refetched.
npm install --no-audit --no-fund
