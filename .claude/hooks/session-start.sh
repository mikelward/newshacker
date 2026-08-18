#!/bin/bash
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${CLAUDE_PROJECT_DIR:-$HOOK_DIR/../..}"

# Deepen the clone before anything reads history. See scripts/unshallow.sh —
# a shallow clone answers commit-count questions wrongly and silently.
#
# Above the remote-only guard on purpose: a shallow clone's wrong answers do
# not depend on which sandbox produced it, and this is a no-op on a complete
# one, so there is nothing to gain by asking first. Everything below is
# toolchain provisioning, which a local machine really does manage itself.
sh "$HOOK_DIR/../../scripts/unshallow.sh" || true

# Only run in Claude Code on the web. Local sessions manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# The PATH later agent shells start from, captured before anything below
# prepends to it. persist_on_path needs to know what the session resolves
# WITHOUT this hook's exports, which is a question the live $PATH stops being
# able to answer the moment the Node block runs.
INHERITED_PATH="$PATH"

# Make a provisioned toolchain reach the rest of the session.
#
# $CLAUDE_ENV_FILE is the harness's own seam for this and is the right answer
# whenever it exists. It is not always set, though — it is unset in this
# sandbox today — and then the caller's `export` reaches only this hook and its
# children, so every later agent shell drops back to whatever the image ships.
# That is the silent-wrong-runtime failure this whole file exists to prevent:
# the suite goes green on the image's Node while CI and Vercel run the pinned
# one, and nothing says so.
#
# A shell rc file is NOT the fallback. The harness snapshots the environment at
# session start, before hooks run, so an rc edit lands one session late —
# verified by writing one and watching a later shell not see it. That failure
# looks exactly like success.
#
# So when there is no env file, change what the NAME resolves to instead of
# changing the environment: a symlink in a PATH directory that already precedes
# the image's own copy wins the lookup for every later shell, whatever that
# shell sources.
#
# Only directories under $HOME are eligible, which is both the safe rule and
# the honest one — the sandbox's first PATH entry is ~/.local/bin, a system
# directory is the image's business rather than ours, and it keeps this
# testable without a seam (the test redirects HOME and nothing real is
# touched).
#
# Usage: persist_on_path <bin-dir> <tool>...   Returns non-zero if it could not.
persist_on_path() {
  local bin_dir="$1"
  shift

  # Every requested tool has to be RUNNABLE in the source, checked before
  # EITHER persistence route runs. Both routes put the whole of $bin_dir ahead
  # of the image's copies, so a missing or non-executable npm there means later
  # shells pair the provisioned node with the image's npm — the split this
  # function exists to prevent, and a stale link from an earlier major left
  # beside a fresh one is the same thing wearing the right name. `-x` rather
  # than `-e` because command lookup skips a non-executable file and falls
  # through, so "present" is not the question — and `-f` alongside it because
  # `-x` is true of a DIRECTORY (they are searchable), which lookup skips just
  # the same.
  #
  # The mode bits are necessary and not sufficient: a regular executable file
  # can still fail to start — a missing interpreter, a truncated or wrong-arch
  # binary — and the links outlive this session while the failure surfaces only
  # in the hook's own `npm install`. So runnability is asked by RUNNING it. That
  # adds no execution the session doesn't already do: the provisioned node has
  # been probed before we get here, and `npm install` runs this very npm seconds
  # later. It only moves the question ahead of the part that persists.
  # `--version` is the one flag node, npm, npx and deno all answer; the cost is
  # one process per tool, about a second, once per session.
  local tool
  for tool in "$@"; do
    if [ ! -f "${bin_dir}/${tool}" ] || [ ! -x "${bin_dir}/${tool}" ]; then
      echo "session-start: WARNING ${bin_dir} has no runnable ${tool}; not persisting a partial toolchain" >&2
      return 1
    fi
    if ! "${bin_dir}/${tool}" --version >/dev/null 2>&1; then
      echo "session-start: WARNING ${bin_dir}/${tool} does not run; not persisting a partial toolchain" >&2
      return 1
    fi
  done

  # The append can fail — a read-only file, a missing parent — and `errexit` is
  # no help here: this function is called from `if ! persist_on_path ...`, which
  # disables it for everything inside. An unchecked `return 0` would then report
  # the harness seam as taken while later shells kept the image's runtime, which
  # is the failure this whole function exists to remove. Fall through to the
  # links instead of failing: they reach the same shells by another route.
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    if echo "export PATH=\"${bin_dir}:\$PATH\"" >>"$CLAUDE_ENV_FILE"; then
      return 0
    fi
    echo "session-start: WARNING could not write \$CLAUDE_ENV_FILE; falling back to links" >&2
  fi

  # The first eligible directory, plus everything on PATH strictly before it.
  # Eligible means under $HOME: the sandbox's first PATH entry is ~/.local/bin,
  # a system directory belongs to the image rather than to us, and the rule
  # keeps this testable without a seam since the test redirects HOME.
  #
  # Note what this does NOT do: stop at the directory currently supplying the
  # tool. From the second session on that IS this shim directory — the links
  # are still there and still win the lookup — so stopping there would refuse
  # to refresh its own links, and a later .nvmrc major would be provisioned
  # correctly and never reach a shell. An eligible directory is a candidate
  # whether or not it is what currently answers.
  local candidate prefix='' shim_dir='' real_candidate real_home probe real_probe
  while IFS= read -r candidate; do
    # An empty PATH field means the CURRENT directory to the shell, so dropping
    # it would hide a supplier sitting in the project root and let a link be
    # written that never wins. It is never a shim candidate itself — it is not
    # under $HOME by name and it is not ours — so normalize it for the prefix
    # and fall through.
    if [ -z "$candidate" ]; then
      prefix="${prefix:+$prefix:}."
      continue
    fi
    case "$candidate" in
      *"/../"* | *"/..")
        # A `..` component defeats the ancestor walk: it climbs to something
        # that exists and IS under $HOME, and then `mkdir -p` walks back down
        # THROUGH the `..` and creates the leaf outside. Refuse rather than
        # normalize — a PATH entry with `..` in it is pathological, and
        # declining to shim there costs nothing.
        ;;
      "${HOME:-/nonexistent}"/*)
        # Resolve BEFORE creating anything. The pattern above is lexical, and a
        # `..` segment or a symlinked parent can put the real path outside
        # $HOME — so an unvalidated `mkdir -p` is how this would create a
        # directory in exactly the place it promises never to touch. The
        # nearest EXISTING ancestor is the deepest thing that can be resolved
        # yet, and it is enough: a path is outside the boundary if its closest
        # existing parent is.
        real_home="$(cd "${HOME:-/nonexistent}" 2>/dev/null && pwd -P || true)"
        probe="$candidate"
        while [ -n "$probe" ] && [ ! -d "$probe" ] && [ "$probe" != "/" ]; do
          probe="$(dirname "$probe")"
        done
        real_probe="$(cd "$probe" 2>/dev/null && pwd -P || true)"
        if [ -n "$real_home" ] && [ -n "$real_probe" ]; then
          case "$real_probe" in
            "$real_home" | "$real_home"/*)
              # A missing entry under $HOME is ours to create; the sandbox image
              # lists ~/.local/bin on PATH whether or not it exists yet.
              [ -d "$candidate" ] || mkdir -p "$candidate" 2>/dev/null || true
              if [ -d "$candidate" ] && [ -w "$candidate" ]; then
                # Re-resolve what was actually created or found: the ancestor
                # check clears the way, this one confirms the destination.
                real_candidate="$(cd "$candidate" 2>/dev/null && pwd -P || true)"
                case "$real_candidate" in
                  "$real_home"/*)
                    shim_dir="$candidate"
                    ;;
                esac
              fi
              ;;
          esac
        fi
        if [ -n "$shim_dir" ]; then
          break
        fi
        ;;
    esac
    prefix="${prefix:+$prefix:}$candidate"
  done <<EOF
$(printf '%s' "$INHERITED_PATH" | tr ':' '\n')
EOF

  [ -n "$shim_dir" ] || return 1

  # A link only wins the lookup if nothing EARLIER on PATH supplies the same
  # name, and that has to be asked per tool rather than derived from one of
  # them: node and npm can come from different directories, so a stop point
  # taken from node alone would happily link a set that stays split. Asking the
  # prefix directly is exact, where reasoning about positions re-derives it.
  #
  # Asked by walking the prefix entries rather than with `command -v`, because
  # the two disagree on exactly the file that matters: `command -v` reports a
  # name it finds with the execute bit CLEARED, while command execution skips
  # that entry and searches on. Trusting it there refuses to link a set that
  # would have won the lookup — a false split, on evidence no shell acts on.
  # The test is the one execution applies: a regular file with the bit set.
  local dir
  while IFS= read -r dir; do
    for tool in "$@"; do
      if [ -f "$dir/$tool" ] && [ -x "$dir/$tool" ]; then
        echo "session-start: WARNING ${tool} is supplied earlier on PATH than ${shim_dir}; not linking a set that would stay split" >&2
        return 1
      fi
    done
  done <<EOF
$(printf '%s' "$prefix" | tr ':' '\n')
EOF

  # Never replace a real binary: a writable PATH directory can hold someone's
  # own toolchain, and this runs on every session. Checked across ALL the tools
  # before any link is written, so a refusal can't leave the set half-applied.
  for tool in "$@"; do
    if [ -e "$shim_dir/$tool" ] && [ ! -L "$shim_dir/$tool" ]; then
      echo "session-start: WARNING $shim_dir/$tool is a real file, not a link — leaving it alone" >&2
      return 1
    fi
  done

  # `ln` can still fail after every check above — the directory can lose write
  # permission, the disk can fill — and errexit is disabled inside this function
  # (see the append above), so an unchecked failure would fall through to the
  # success message with half the set linked. Take the whole set back down
  # instead: every entry here is either ours or absent (the clobber guard just
  # proved it), and no shim at all is an honest fallback to the image's
  # toolchain, where a half-updated one is the split this function exists to
  # prevent.
  local linked
  for tool in "$@"; do
    if ! ln -sfn "${bin_dir}/${tool}" "${shim_dir}/${tool}"; then
      echo "session-start: WARNING could not link ${tool} into ${shim_dir}; removing the partial set" >&2
      for linked in "$@"; do
        if [ -L "${shim_dir}/${linked}" ]; then
          rm -f "${shim_dir}/${linked}"
        fi
      done
      return 1
    fi
  done
  echo "session-start: CLAUDE_ENV_FILE is unset; linked $* in ${shim_dir} to ${bin_dir} so later shells match CI"
}

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
            // Nothing arrived: curl already failed, and the caller warns about
            // an unresolved version. Parsing "" here would report a bogus
            // syntax error on every ordinary network outage, which is the
            // conflation the catch below exists to remove.
            if (!raw.trim()) return;
            try {
              const hit = JSON.parse(raw).find((r) => r.version.startsWith(`v${major}.`));
              if (hit) process.stdout.write(hit.version);
            } catch (err) {
              // A malformed index or a changed schema resolves to nothing, same
              // as an outage — and the caller warning reads as a network
              // problem either way, so a parser regression would be invisible.
              // Message and byte count only: never the body, which is
              // unbounded upstream text. stderr because stdout is the result.
              process.stderr.write(
                `session-start: could not parse the Node release index (${raw.length} bytes): ${err.message}\n`,
              );
            }
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

  # Probe the binary again rather than reusing the executable-bit test. The
  # cache may have been rejected above as unrunnable and the replacement may
  # then have failed to arrive, leaving the same directory in place — still
  # present, still executable, still broken. Publishing it hands `npm install` a
  # Node that cannot run, so the hook dies under `set -e` instead of degrading
  # to the system runtime the way every other failure here does.
  PROVISIONED_VERSION="$("${NODE_DIR}/bin/node" -v 2>/dev/null || true)"
  if [ -n "$PROVISIONED_VERSION" ]; then
    export PATH="${NODE_DIR}/bin:${PATH}"
    # Persist for the rest of the session, including tools the agent shells out
    # to — see persist_on_path for how, and why an unset CLAUDE_ENV_FILE is not
    # the end of it. npm and npx come along because the npm that RESOLVES
    # dependencies has to be the pinned one too: .npmrc's min-release-age
    # cooldown landed in npm 11.10.0 and is silently ignored before it, so a
    # session left on the image's older npm writes package.json ranges CI then
    # refuses to resolve.
    if ! persist_on_path "${NODE_DIR}/bin" node npm npx; then
      # Not silently: the export above reaches only this hook and its children,
      # so with nowhere to persist, every later agent shell falls back to the
      # system Node. That is the silent-wrong-runtime failure this whole block
      # exists to prevent, and staying quiet would produce it while reporting
      # success.
      echo "session-start: WARNING ${NODE_VERSION:-the provisioned Node} will not be on PATH for later commands — they will run on the system Node and may not match CI" >&2
    fi
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

echo "[session-start] Installing Node dependencies (npm install)..."
npm install --no-audit --no-fund

echo "[session-start] Ready: $(node --version)"
