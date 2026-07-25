#!/bin/bash
set -euo pipefail

# Only run in Claude Code on the web. Local sessions manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# --- Node toolchain ---------------------------------------------------------
# The repo pins a Node major in .nvmrc, and package.json `engines` narrows to
# that same major (see INSTALL.md for why it's capped rather than open-ended).
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
# NH_NODE_ROOT and NH_NODE_DIST_URL exist so the provisioning branches below can
# be exercised by scripts/session-start-hook.test.ts against a temp dir and a
# file:// fixture. They are test seams only — production never sets them.
NODE_ROOT="${NH_NODE_ROOT:-/opt}"
DIST_URL="${NH_NODE_DIST_URL:-https://nodejs.org/dist}"
NODE_MAJOR="$(tr -cd '0-9' < .nvmrc)"

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
      curl -fsSL --retry 3 --retry-delay 2 "${DIST_URL}/index.json" 2>/dev/null |
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
      "${DIST_URL}/${NODE_VERSION}/${TARBALL}" -o "${TMP_DIR}/node.tar.xz" &&
      tar -xf "${TMP_DIR}/node.tar.xz" -C "${TMP_DIR}"; then
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
ACTIVE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo '?')"
if [ -n "${NODE_MAJOR:-}" ] && [ "$ACTIVE_MAJOR" != "$NODE_MAJOR" ]; then
  echo "session-start: WARNING active Node is ${ACTIVE_MAJOR}.x but this repo pins ${NODE_MAJOR}.x — results will not match CI" >&2
fi

# Also check the full version against `engines`, which catches the case the
# major check cannot: a cached toolchain that is the right major but below a
# raised minor floor (Babel 8 needs >=24.11). Best-effort — semver comes from
# node_modules, so this is silent on a cold container and reports from the
# second run onward, which is exactly when a stale cache would matter.
node -e '
  const { engines } = require("./package.json");
  const range = engines && engines.node;
  if (!range) process.exit(0);
  let semver;
  try { semver = require("semver"); } catch { process.exit(0); }
  const v = process.versions.node;
  if (!semver.satisfies(v, range)) {
    console.error(`session-start: WARNING active Node ${v} does not satisfy engines "${range}" — results will not match CI or Vercel`);
  }
' 2>&1 || true

echo "session-start: node $(node -v), npm $(npm -v)"

# --- Dependencies -----------------------------------------------------------
# `npm install` rather than `ci` so a warm node_modules from the cached
# container state is reused instead of being deleted and refetched.
npm install --no-audit --no-fund
