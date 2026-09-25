#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# The dedicated-account Omnesis gateway, installed and administered by root.
#
#   curl -fsSL https://omnesis.dev/hardened-gateway.sh | sudo sh -s -- install --version X.Y.Z
#   sudo omnesis-gateway-admin update --version X.Y.Z
#   sudo omnesis-gateway-admin cli devices pair --kind collector
#
# The gateway runs as an account systemd allocates for it (DynamicUser=), from a
# copy of a release that root fetched and owns. Nothing the gateway runs, and
# nothing this script runs as root, is read from a login account's files, so a
# program running as that account can neither read the gateway's state nor
# change the code that reads it.
#
# How a release gets here:
#   1. Root fetches the requested ref from the repository recorded at install
#      time, with git hooks and configuration disabled. A private repository
#      takes a read token in OMNESIS_GIT_TOKEN, passed in root's environment; a
#      token that does not work only makes the fetch fail, because the address
#      is fixed and the content comes from the repository.
#   2. This script hands over to the copy of itself in that checkout, so the
#      release's own code decides how it is built and installed.
#   3. `npm ci` and the build run in a transient systemd unit, as a throwaway
#      account that can reach neither home directories nor the rest of the
#      system.
#   4. Root copies the result under /opt/omnesis-gateway/releases, restores
#      every tracked file from the fetched checkout, makes the copy root-owned
#      and unwritable by anyone else, and switches the `current` link to it.
#
# Root still runs that release's own CLI (and so its dependencies) for `cli`,
# for the backup an update takes, and to write the unit; it runs it with a
# private temporary directory and no compile cache.
#
# Environment:
#   OMNESIS_GIT_TOKEN                a read token for a private repository
#   OMNESIS_HARDENED_NPM_CACHE_SEED  an npm cache to build from, for hosts that
#                                    cannot reach the npm registry

set -eu

DEFAULT_REPO_URL="https://github.com/omnesis-dev/Omnesis"
DEFAULT_PORT=7600

ETC_DIR=/etc/omnesis-gateway
INSTALL_ENV="$ETC_DIR/install.env"
PASS_FILE="$ETC_DIR/keyring.pass"

RELEASE_ROOT=/opt/omnesis-gateway
RELEASES="$RELEASE_ROOT/releases"
CURRENT="$RELEASE_ROOT/current"
PREVIOUS="$RELEASE_ROOT/previous"
ADMIN_LINK=/usr/local/sbin/omnesis-gateway-admin

STATE_DIR=/var/lib/omnesis-gateway
UNIT_NAME=omnesis-gateway.service
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"

BUILD_NAME=omnesis-gateway-build
BUILD_DIR="/var/lib/private/$BUILD_NAME"
BUILD_VIEW="/var/lib/$BUILD_NAME"
BUILD_CACHE="/var/cache/private/$BUILD_NAME"
BUILD_CACHE_VIEW="/var/cache/$BUILD_NAME"

ADMIN_RUN_DIR=/run/omnesis-gateway-admin
LOCK_FILE=/run/omnesis-gateway-admin.lock

SCRIPT_REL=scripts/hardened-gateway.sh
LAUNCHER_REL=scripts/hardened-gateway-exec.sh
RELEASE_INFO=.omnesis-release

HEALTH_TIMEOUT_SECONDS=180
SYSTEM_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ── Output ────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  BOLD='\033[1m'; RESET='\033[0m'
else
  BOLD=''; RESET=''
fi

info() { printf '%s\n' "$*"; }
step() { printf '%b==>%b %s\n' "$BOLD" "$RESET" "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: omnesis-gateway-admin <command> [options]

Commands:
  install    Fetch a release, build it, and install the dedicated gateway
  update     Build another release beside the running one and switch to it
  rollback   Switch back to the previous release
  status     Show the running release, the previous one and the service state
  cli ARGS   Run the release's omnesis CLI against the dedicated gateway
  uninstall  Remove the service and the releases; keep the gateway's state

Options for install and update:
  --version X.Y.Z                Release to install (default: the newest stable release)
  --ref REF                      A tag, branch or commit instead of a release version
  --no-backup                    update only: switch without a backup first
  --force                        update only: switch to a release older than the running one

Options for install:
  --port N                       Port the gateway listens on (default: 7600)
  --no-keyring                   Run the gateway without encryption at rest
  --keyring-passphrase-file PATH Seal the gateway's keys with this passphrase
  --repo-url URL                 Repository to fetch releases from
                                 (default: https://github.com/omnesis-dev/Omnesis)

Environment:
  OMNESIS_GIT_TOKEN                a read token, while the repository is private
  OMNESIS_HARDENED_NPM_CACHE_SEED  an npm cache to build from, without the registry
EOF
}

# ── Options ───────────────────────────────────────────────────────────────

OPT_VERSION=""
OPT_REF=""
OPT_PORT=""
OPT_NO_KEYRING=0
OPT_PASS_FILE=""
OPT_REPO_URL=""
OPT_FROM_CHECKOUT=""
OPT_NO_BACKUP=0
OPT_FORCE=0

need_value() {
  [ $# -ge 2 ] && [ -n "$2" ] || fail "$1 needs a value."
}

parse_options() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) need_value "$@"; OPT_VERSION="$2"; shift 2 ;;
      --ref) need_value "$@"; OPT_REF="$2"; shift 2 ;;
      --port) need_value "$@"; OPT_PORT="$2"; shift 2 ;;
      --no-keyring) OPT_NO_KEYRING=1; shift ;;
      --keyring-passphrase-file) need_value "$@"; OPT_PASS_FILE="$2"; shift 2 ;;
      --repo-url) need_value "$@"; OPT_REPO_URL="$2"; shift 2 ;;
      --from-checkout) need_value "$@"; OPT_FROM_CHECKOUT="$2"; shift 2 ;;
      --no-backup) OPT_NO_BACKUP=1; shift ;;
      --force) OPT_FORCE=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) fail "Unknown option: $1. See 'omnesis-gateway-admin help'." ;;
    esac
  done
  validate_options
}

validate_options() {
  if [ -n "$OPT_VERSION" ] && [ -n "$OPT_REF" ]; then
    fail "--version and --ref both name what to install; pass one."
  fi
  if [ -n "$OPT_VERSION" ]; then
    printf '%s\n' "$OPT_VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ||
      fail "Invalid --version '$OPT_VERSION' (expected X.Y.Z)."
  fi
  if [ -n "$OPT_REF" ]; then
    valid_ref "$OPT_REF" || fail "Invalid --ref '$OPT_REF'."
  fi
  if [ -n "$OPT_PORT" ]; then
    case "$OPT_PORT" in
      ''|*[!0-9]*) fail "Invalid --port '$OPT_PORT' (expected a number)." ;;
    esac
    [ "$OPT_PORT" -ge 1 ] && [ "$OPT_PORT" -le 65535 ] || fail "Invalid --port '$OPT_PORT' (expected 1-65535)."
  fi
  if [ -n "$OPT_PASS_FILE" ]; then
    case "$OPT_PASS_FILE" in
      /*) ;;
      *) fail "--keyring-passphrase-file must be an absolute path." ;;
    esac
    [ "$OPT_NO_KEYRING" = 0 ] || fail "--no-keyring and --keyring-passphrase-file contradict each other; pass one."
  fi
  if [ -n "$OPT_REPO_URL" ]; then
    case "$OPT_REPO_URL" in
      https://*|file://*) ;;
      *) fail "--repo-url must be an https:// (or file://) address." ;;
    esac
  fi
}

# A ref is spliced into git's arguments and a directory name, so it is held to
# the characters refs actually use, and may not look like an option.
valid_ref() {
  case "$1" in
    ''|-*|*..*|*[!A-Za-z0-9._/-]*) return 1 ;;
  esac
  return 0
}

# ── Preconditions ─────────────────────────────────────────────────────────

# sudo can carry an account's environment through (-E, env_keep, a sudo that
# keeps HOME). None of it may steer what root runs, so the search path, home,
# git's and node's configuration and temporary directories are reset; the
# options this script reads, and proxy settings, are kept.
sanitize_environment() {
  PATH="$SYSTEM_PATH"
  HOME=/root
  export PATH HOME
  for env_name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do
    case "$env_name" in
      GIT_*|NODE_*|npm_config_*|NPM_CONFIG_*|XDG_*|TMPDIR|CDPATH|ENV|BASH_ENV|LD_*|TSX_*)
        unset "$env_name" 2>/dev/null || true ;;
    esac
  done
  GIT_CONFIG_GLOBAL=/dev/null
  GIT_CONFIG_NOSYSTEM=1
  export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
  umask 022
}

require_root() {
  [ "$(id -u)" = 0 ] || fail "This installs a system service; run it as root (with sudo)."
}

require_linux_systemd() {
  [ "$(uname -s)" = Linux ] ||
    fail "The dedicated-account gateway needs Linux with systemd; this host has no such service manager."
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] ||
    fail "The dedicated-account gateway is a systemd system service, and systemd is not supervising this host."
}

require_git() {
  command -v git >/dev/null 2>&1 || fail "git is required to fetch the release; install it and run this again."
}

# One admin command at a time: they share the build directory, the release
# links and the unit. The phase that a fetch hands over to inherits the lock.
hold_admin_lock() {
  require_root
  command -v flock >/dev/null 2>&1 || return 0
  if flock -n 9 2>/dev/null; then
    return 0
  fi
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "Another omnesis-gateway-admin command is running; wait for it to finish."
}

# Whether a path, and every directory above it, is owned by root and writable
# by nobody else. The dedicated gateway runs whatever these paths hold, so a
# single account that can change any of them decides what the gateway runs.
# Sets UNSAFE_PATH to the first offender.
root_controlled() {
  UNSAFE_PATH=""
  rc_path="$1"
  while :; do
    rc_owner="$(stat -c '%u' "$rc_path" 2>/dev/null)" || { UNSAFE_PATH="$rc_path"; return 1; }
    rc_mode="$(stat -c '%a' "$rc_path" 2>/dev/null)" || { UNSAFE_PATH="$rc_path"; return 1; }
    if [ "$rc_owner" != 0 ] || [ $((0$rc_mode & 022)) -ne 0 ]; then
      UNSAFE_PATH="$rc_path"
      return 1
    fi
    [ "$rc_path" != / ] || return 0
    rc_path="$(dirname "$rc_path")"
  done
}

NODE_BIN=""
NODE_DIR=""
require_node() {
  node_literal="$(command -v node 2>/dev/null)" ||
    fail "Node 24 is not on root's PATH. Install Node 24 system-wide, from your distribution or NodeSource, so it lives under /usr. A Node installed in a home directory, such as through nvm, can be changed by that account."
  NODE_BIN="$(readlink -f "$node_literal")"
  case "$NODE_BIN" in
    /home/*|/root/*)
      fail "Node resolves to $NODE_BIN, inside a home directory, where that account can change it. Install Node 24 system-wide, so it lives under /usr." ;;
  esac
  for node_path in "$(dirname "$node_literal")" "$NODE_BIN"; do
    root_controlled "$node_path" ||
      fail "Node at $NODE_BIN can be changed by an account other than root ($UNSAFE_PATH), so it could change what the gateway runs. Install Node 24 where only root can write, such as under /usr."
  done
  node_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || node_major=0
  [ "$node_major" -ge 24 ] 2>/dev/null ||
    fail "Node at $NODE_BIN is version $node_major; the gateway needs Node 24 or newer."
  NODE_DIR="$(dirname "$NODE_BIN")"
}

# The hand-over from the fetch names the checkout root fetched. Only a
# directory of that shape, owned by root and closed to everyone else, is taken,
# so the option cannot point a build at a checkout another account controls.
require_fetched_checkout() {
  case "$1" in
    "$RELEASE_ROOT"/.fetch-[0-9]*) ;;
    *) fail "--from-checkout takes only the directory this script fetched a release into." ;;
  esac
  case "${1#"$RELEASE_ROOT"/.fetch-}" in
    *[!0-9]*) fail "--from-checkout takes only the directory this script fetched a release into." ;;
  esac
  [ -d "$1" ] && [ ! -L "$1" ] && [ "$(stat -c '%u %a' "$1")" = "0 700" ] ||
    fail "$1 is not a directory root fetched a release into."
  root_controlled "$RELEASE_ROOT" ||
    fail "$RELEASE_ROOT can be changed by an account other than root ($UNSAFE_PATH)."
}

# ── Configuration recorded at install ─────────────────────────────────────

CONF_REPO_URL=""
CONF_PORT=""
CONF_KEYRING=""

read_install_env() {
  [ -f "$INSTALL_ENV" ] || return 1
  while IFS='=' read -r env_key env_value; do
    case "$env_key" in
      OMNESIS_HARDENED_REPO_URL) CONF_REPO_URL="$env_value" ;;
      OMNESIS_HARDENED_PORT) CONF_PORT="$env_value" ;;
      OMNESIS_HARDENED_KEYRING) CONF_KEYRING="$env_value" ;;
    esac
  done < "$INSTALL_ENV"
  return 0
}

write_install_env() {
  mkdir -p "$ETC_DIR"
  chmod 755 "$ETC_DIR"
  rm -f "$INSTALL_ENV.tmp"
  {
    printf 'OMNESIS_HARDENED_REPO_URL=%s\n' "$CONF_REPO_URL"
    printf 'OMNESIS_HARDENED_PORT=%s\n' "$CONF_PORT"
    printf 'OMNESIS_HARDENED_KEYRING=%s\n' "$CONF_KEYRING"
  } > "$INSTALL_ENV.tmp"
  chmod 644 "$INSTALL_ENV.tmp"
  mv -f "$INSTALL_ENV.tmp" "$INSTALL_ENV"
}

# A dedicated gateway whose unit runs code from a login account keeps its
# passphrase in that account's config directory. Its unit names both the port
# and the passphrase file, which carry over.
LEGACY_PASS=""
read_legacy_unit() {
  [ -f "$UNIT_PATH" ] || return 0
  LEGACY_PASS="$(sed -n 's/^LoadCredential=[^:]*://p' "$UNIT_PATH" | sed 's/%%/%/g' | head -n 1)"
  legacy_port="$(sed -n 's/^Environment="\{0,1\}OMNESIS_GATEWAY_PORT=\([0-9][0-9]*\)"\{0,1\}$/\1/p' "$UNIT_PATH" | head -n 1)"
  [ -z "$legacy_port" ] || CONF_PORT="$legacy_port"
}

# ── Git ───────────────────────────────────────────────────────────────────

GIT_HELPER_DIR=""

# git with hooks and credential helpers switched off. A token, when given, is
# handed to git through an askpass helper reading this process's environment,
# so it never appears on a command line another account could list.
with_git() {
  if [ -n "${OMNESIS_GIT_TOKEN:-}" ]; then
    if [ -z "$GIT_HELPER_DIR" ]; then
      GIT_HELPER_DIR="$(mktemp -d)"
      chmod 700 "$GIT_HELPER_DIR"
      cat > "$GIT_HELPER_DIR/askpass" <<'EOF'
#!/bin/sh
case "$1" in
  Username*) printf '%s\n' x-access-token ;;
  *) printf '%s\n' "$OMNESIS_GIT_TOKEN" ;;
esac
EOF
      chmod 700 "$GIT_HELPER_DIR/askpass"
    fi
    GIT_ASKPASS="$GIT_HELPER_DIR/askpass" GIT_TERMINAL_PROMPT=0 \
      git -c core.hooksPath=/dev/null -c credential.helper= "$@"
  else
    GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null -c credential.helper= "$@"
  fi
}

# The newest vX.Y.Z tag the repository serves, by numeric version.
newest_stable_tag() {
  with_git ls-remote --tags --refs "$1" 'refs/tags/v*' |
    sed -n 's#^.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p' |
    grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' |
    sort_versions |
    tail -n 1
}

sort_versions() {
  awk '{ v = $0; sub(/^v/, "", v); split(v, p, "."); printf "%09d%09d%09d %s\n", p[1], p[2], p[3], $0 }' |
    sort |
    cut -d' ' -f2
}

REF=""
resolve_ref() {
  if [ -n "$OPT_REF" ]; then
    REF="$OPT_REF"
  elif [ -n "$OPT_VERSION" ]; then
    REF="v$OPT_VERSION"
  else
    REF="$(newest_stable_tag "$REPO_URL")" || REF=""
    [ -n "$REF" ] ||
      fail "Could not read a stable release from $REPO_URL. $(private_repo_hint)"
  fi
}

private_repo_hint() {
  if [ -z "${OMNESIS_GIT_TOKEN:-}" ]; then
    printf '%s' "If the repository is private, pass a read token in OMNESIS_GIT_TOKEN."
  else
    printf '%s' "Check that the token in OMNESIS_GIT_TOKEN can read it."
  fi
}

fetch_checkout() {
  git -c init.defaultBranch=main init -q "$1"
  with_git -C "$1" fetch -q --depth 1 --no-tags "$REPO_URL" "$REF" ||
    fail "Could not fetch $REF from $REPO_URL. $(private_repo_hint)"
  git -c core.hooksPath=/dev/null -c advice.detachedHead=false -C "$1" checkout -q FETCH_HEAD
}

# ── Releases ──────────────────────────────────────────────────────────────

release_version() {
  "$NODE_BIN" -p 'require(process.argv[1]).version' "$1/packages/cli/package.json"
}

release_label() {
  printf '%s' "$1" | tr '/' '-'
}

RELEASE_DIR=""
RELEASE_VERSION=""
RELEASE_COMMIT=""

# Build the checkout in a throwaway account, then stage the result as a
# root-owned release. Reuses a release already built from the same commit.
build_release() {
  RELEASE_COMMIT="$(git -C "$CHECKOUT" rev-parse HEAD)"
  release_short="$(printf '%s' "$RELEASE_COMMIT" | cut -c1-12)"
  RELEASE_DIR="$RELEASES/$(release_label "$REF")-$release_short"
  if [ -f "$RELEASE_DIR/$RELEASE_INFO" ]; then
    RELEASE_VERSION="$(release_version "$RELEASE_DIR")"
    info "Release $(basename "$RELEASE_DIR") is already built."
    return 0
  fi

  step "Building $REF ($release_short) as a throwaway account"
  rm -rf "$BUILD_DIR"
  mkdir -p /var/lib/private /var/cache/private
  chmod 700 /var/lib/private /var/cache/private
  mkdir -p "$BUILD_DIR/src" "$BUILD_CACHE/npm"
  (cd "$CHECKOUT" && git archive --format=tar HEAD) | tar -x -C "$BUILD_DIR/src" -f -
  build_offline=""
  if [ -n "${OMNESIS_HARDENED_NPM_CACHE_SEED:-}" ]; then
    [ -d "$OMNESIS_HARDENED_NPM_CACHE_SEED" ] ||
      fail "OMNESIS_HARDENED_NPM_CACHE_SEED names $OMNESIS_HARDENED_NPM_CACHE_SEED, which is not a directory."
    cp -a "$OMNESIS_HARDENED_NPM_CACHE_SEED/." "$BUILD_CACHE/npm/"
    build_offline="--prefer-offline"
  fi
  cat > "$BUILD_DIR/build.sh" <<EOF
set -eu
cd "$BUILD_VIEW/src"
npm ci --no-audit --no-fund $build_offline
heap="\$(node_modules/.bin/tsx --eval 'import("$BUILD_VIEW/src/packages/cli/src/update/build-heap.ts").then((m) => process.stdout.write(m.buildHeapEnv()?.NODE_OPTIONS ?? ""))' 2>/dev/null || true)"
NODE_OPTIONS="\$heap" npm run build
EOF

  set -- --wait --pipe --quiet --collect --unit="$BUILD_NAME-$$" \
    -p DynamicUser=yes \
    -p StateDirectory="$BUILD_NAME" \
    -p CacheDirectory="$BUILD_NAME" \
    -p ProtectHome=yes \
    -p ProtectSystem=strict \
    -p PrivateTmp=yes \
    -p NoNewPrivileges=yes \
    -p UMask=0022 \
    -p WorkingDirectory="$BUILD_VIEW" \
    -p Environment="HOME=$BUILD_VIEW" \
    -p Environment="npm_config_cache=$BUILD_CACHE_VIEW/npm" \
    -p Environment="PATH=$NODE_DIR:$SYSTEM_PATH"
  for proxy_var in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
    eval "proxy_value=\${$proxy_var:-}"
    [ -n "$proxy_value" ] || continue
    case "$proxy_value" in
      *[[:space:]\"\'\\]*) fail "$proxy_var holds spaces, quotes or backslashes, which a unit setting cannot carry." ;;
    esac
    set -- "$@" -p Environment="$proxy_var=$proxy_value"
  done
  # Waited on in the background, so a signal to this script is handled at once
  # and its cleanup stops the build.
  systemd-run "$@" /bin/sh "$BUILD_VIEW/build.sh" &
  build_pid=$!
  if ! wait "$build_pid"; then
    fail "Building $REF failed, and nothing was changed. The build's output is above."
  fi

  stage="$RELEASES/.staging-$$"
  mkdir -p "$RELEASES"
  chmod 755 "$RELEASE_ROOT" "$RELEASES"
  rm -rf "$stage"
  cp -a "$BUILD_DIR/src" "$stage"
  # The build account could have changed any file while it ran. Every file the
  # release tracks goes back to what root fetched; what remains from the build
  # is what it produced: dependencies and compiled output.
  (cd "$CHECKOUT" && git archive --format=tar HEAD) | tar -x -C "$stage" -f -
  chown -R -h 0:0 "$stage"
  chmod -R go-w "$stage"
  RELEASE_VERSION="$(release_version "$stage")"
  {
    printf 'ref=%s\n' "$REF"
    printf 'commit=%s\n' "$RELEASE_COMMIT"
    printf 'version=%s\n' "$RELEASE_VERSION"
    printf 'built=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$stage/$RELEASE_INFO"
  chmod 644 "$stage/$RELEASE_INFO"
  rm -rf "$RELEASE_DIR"
  mv "$stage" "$RELEASE_DIR"
  rm -rf "$BUILD_DIR"
  root_controlled "$RELEASE_DIR/$LAUNCHER_REL" ||
    fail "The staged release is not root-controlled at $UNSAFE_PATH; nothing was switched."
}

# Whether version $1 is older than version $2, by their X.Y.Z. Pre-release
# suffixes are not ordered; a pre-release of the same X.Y.Z is not older.
version_older() {
  vo_a="$(printf '%s' "$1" | sed -n 's/^\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2 \3/p')"
  vo_b="$(printf '%s' "$2" | sed -n 's/^\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2 \3/p')"
  [ -n "$vo_a" ] && [ -n "$vo_b" ] || return 1
  # shellcheck disable=SC2086
  set -- $vo_a $vo_b
  [ "$1" -lt "$4" ] && return 0
  [ "$1" -gt "$4" ] && return 1
  [ "$2" -lt "$5" ] && return 0
  [ "$2" -gt "$5" ] && return 1
  [ "$3" -lt "$6" ]
}

# Point `current` at a release by renaming a new link over it, so the unit
# never starts from a half-written link. The release it replaces becomes
# `previous`.
# The release a link names, or nothing when the link or its release is missing.
# `readlink -f` would print the missing path itself and succeed.
link_target() {
  readlink -e "$1" 2>/dev/null || true
}

switch_current() {
  switch_old="$(link_target "$CURRENT")"
  ln -sfn "$1" "$RELEASE_ROOT/.current-new"
  mv -Tf "$RELEASE_ROOT/.current-new" "$CURRENT"
  if [ -n "$switch_old" ] && [ "$switch_old" != "$(readlink -f "$1")" ]; then
    set_previous "$switch_old"
  fi
}

set_previous() {
  if [ -n "$1" ]; then
    ln -sfn "$1" "$RELEASE_ROOT/.previous-new"
    mv -Tf "$RELEASE_ROOT/.previous-new" "$PREVIOUS"
  else
    rm -f "$PREVIOUS"
  fi
}

prune_releases() {
  prune_current="$(link_target "$CURRENT")"
  prune_previous="$(link_target "$PREVIOUS")"
  for prune_dir in "$RELEASES"/*; do
    [ -d "$prune_dir" ] || continue
    prune_real="$(readlink -f "$prune_dir")"
    [ "$prune_real" = "$prune_current" ] || [ "$prune_real" = "$prune_previous" ] || rm -rf "$prune_dir"
  done
}

# ── The running gateway ───────────────────────────────────────────────────

ADMIN_TMP=""

# A temporary directory only root can enter, for the CLI root runs. The shared
# /tmp would let another account plant files there that root then loads.
admin_tmp() {
  if [ -z "$ADMIN_TMP" ]; then
    mkdir -p "$ADMIN_RUN_DIR"
    chmod 700 "$ADMIN_RUN_DIR"
    ADMIN_TMP="$(mktemp -d "$ADMIN_RUN_DIR/tmp.XXXXXX")"
  fi
}

# Files root writes into the gateway's state (a recovery envelope, a model, a
# trusted certificate) would otherwise stay root's, where the gateway's own
# account cannot read them.
restore_state_ownership() {
  [ -d "$STATE_DIR" ] || return 0
  state_owner="$(stat -L -c '%u:%g' "$STATE_DIR")"
  [ "$state_owner" != "0:0" ] || return 0
  chown -R "$state_owner" "$STATE_DIR/"
}

# Run a release's CLI as root against the dedicated gateway: its state
# directory, its address, and its keyring.
run_cli() {
  cli_release="$1"
  shift
  admin_tmp
  if (
    export OMNESIS_CONFIG_DIR="$STATE_DIR"
    export OMNESIS_GATEWAY_URL="https://localhost:$CONF_PORT"
    export HOME=/root
    export PATH="$NODE_DIR:$SYSTEM_PATH"
    export TMPDIR="$ADMIN_TMP"
    export TSX_DISABLE_CACHE=1
    if [ -f "$STATE_DIR/tls/cert.pem" ]; then export NODE_EXTRA_CA_CERTS="$STATE_DIR/tls/cert.pem"; fi
    if [ "$CONF_KEYRING" = passphrase ]; then
      export OMNESIS_SECRET_STORE=passphrase
      export OMNESIS_KEYRING_PASSPHRASE_FILE="$PASS_FILE"
    fi
    "$cli_release/$LAUNCHER_REL" "$@"
  ); then
    cli_status=0
  else
    cli_status=$?
  fi
  restore_state_ownership
  return "$cli_status"
}

# Write the unit through the running release's own CLI, which renders and
# checks it. As root it applies the unit, enables it and starts it.
render_unit() {
  admin_tmp
  set -- "$CURRENT/$LAUNCHER_REL" service install gateway --hardened --exec "$CURRENT/$LAUNCHER_REL"
  [ "$CONF_PORT" = "$DEFAULT_PORT" ] || set -- "$@" --env "OMNESIS_GATEWAY_PORT=$CONF_PORT"
  if [ "$CONF_KEYRING" = passphrase ]; then
    set -- "$@" --secret-store passphrase --keyring-passphrase-credential "$PASS_FILE"
  fi
  HOME=/root PATH="$NODE_DIR:$SYSTEM_PATH" TMPDIR="$ADMIN_TMP" TSX_DISABLE_CACHE=1 "$@"
}

# The version the gateway answers on /health, or nothing while it does not.
# The answer counts only over TLS with the gateway's own certificate, so no
# other process listening on the port while the gateway restarts can give it.
served_version() {
  [ -f "$STATE_DIR/tls/cert.pem" ] || return 0
  NODE_EXTRA_CA_CERTS="$STATE_DIR/tls/cert.pem" "$NODE_BIN" -e '
    const port = process.argv[1];
    (async () => {
      try {
        const res = await fetch(`https://localhost:${port}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return;
        const body = await res.json();
        if (typeof body.version === "string") process.stdout.write(body.version);
      } catch {}
    })();
  ' "$CONF_PORT" 2>/dev/null || true
}

wait_for_version() {
  wait_deadline=$(($(date +%s) + HEALTH_TIMEOUT_SECONDS))
  while [ "$(date +%s)" -lt "$wait_deadline" ]; do
    if [ "$(served_version)" = "$1" ] && systemctl is-active --quiet "$UNIT_NAME"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# ── Commands ──────────────────────────────────────────────────────────────

CHECKOUT=""
REPO_URL=""

cleanup() {
  [ -z "$GIT_HELPER_DIR" ] || rm -rf "$GIT_HELPER_DIR"
  [ -z "$ADMIN_TMP" ] || rm -rf "$ADMIN_TMP"
  # A build the throwaway account is still running would outlive this shell;
  # its unit is named after this process.
  systemctl stop "$BUILD_NAME-$$.service" >/dev/null 2>&1 || true
  case "$CHECKOUT" in
    "$RELEASE_ROOT"/.fetch-*) rm -rf "$CHECKOUT" ;;
  esac
  rm -rf "$RELEASES/.staging-$$" "$RELEASE_ROOT/.current-new" "$RELEASE_ROOT/.previous-new"
}

# Clean up on every way out. A shell killed by a signal skips its EXIT trap, so
# the signals exit through it instead.
arm_cleanup() {
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
}

# Phase one of install and update: fetch the ref as root, then hand over to the
# script in that checkout.
fetch_and_hand_over() {
  handover_command="$1"
  require_linux_systemd
  require_git
  read_install_env || true
  # An install whose gateway never came up can be run again; one that is
  # serving is moved with update, which takes a backup and can switch back.
  if [ "$handover_command" = install ] && [ -L "$CURRENT" ] && [ -f "$INSTALL_ENV" ] &&
    systemctl is-active --quiet "$UNIT_NAME"; then
    fail "A dedicated gateway is already installed and running $(basename "$(readlink -f "$CURRENT")"). Move it to another release with: sudo omnesis-gateway-admin update --version X.Y.Z"
  fi
  if [ "$handover_command" = update ]; then
    [ -f "$INSTALL_ENV" ] ||
      fail "No dedicated gateway is installed by this script ($INSTALL_ENV is missing). Install one with the install command."
    [ -z "$OPT_REPO_URL" ] || [ "$OPT_REPO_URL" = "$CONF_REPO_URL" ] ||
      fail "update fetches from the repository recorded at install ($CONF_REPO_URL); --repo-url cannot move it."
    [ -z "$OPT_PORT$OPT_PASS_FILE" ] && [ "$OPT_NO_KEYRING" = 0 ] ||
      fail "update keeps the port and keyring chosen at install; --port, --no-keyring and --keyring-passphrase-file apply to install only."
  fi
  REPO_URL="${OPT_REPO_URL:-${CONF_REPO_URL:-$DEFAULT_REPO_URL}}"
  resolve_ref
  mkdir -p "$RELEASE_ROOT"
  chmod 755 "$RELEASE_ROOT"
  CHECKOUT="$RELEASE_ROOT/.fetch-$$"
  rm -rf "$CHECKOUT"
  mkdir -m 700 "$CHECKOUT"
  arm_cleanup
  step "Fetching $REF from $REPO_URL"
  fetch_checkout "$CHECKOUT"
  [ -f "$CHECKOUT/$SCRIPT_REL" ] ||
    fail "$REF predates the root-owned dedicated gateway ($SCRIPT_REL is missing from it). Install 0.4.9 or later."
  set -- "$handover_command" --from-checkout "$CHECKOUT" --ref "$REF" --repo-url "$REPO_URL"
  [ -z "$OPT_PORT" ] || set -- "$@" --port "$OPT_PORT"
  [ "$OPT_NO_KEYRING" = 0 ] || set -- "$@" --no-keyring
  [ -z "$OPT_PASS_FILE" ] || set -- "$@" --keyring-passphrase-file "$OPT_PASS_FILE"
  [ "$OPT_NO_BACKUP" = 0 ] || set -- "$@" --no-backup
  [ "$OPT_FORCE" = 0 ] || set -- "$@" --force
  trap - EXIT INT TERM HUP
  [ -z "$GIT_HELPER_DIR" ] || rm -rf "$GIT_HELPER_DIR"
  exec sh "$CHECKOUT/$SCRIPT_REL" "$@"
}

# Copy a passphrase into a root-only file. The source is opened without
# following a symbolic link and must be a regular file of at most 4 KiB. A file
# root owns is taken only from a directory chain root alone controls, so a path
# another account can redirect cannot hand root a copy of one of root's files.
copy_passphrase() {
  rm -f "$2.tmp"
  (umask 077 && "$NODE_BIN" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [src, dest] = process.argv.slice(1);
    const refuse = (why) => { process.stderr.write(`${why}\n`); process.exit(1); };
    let fd;
    try {
      fd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (err) {
      refuse(`cannot open it as a plain file (${err.code})`);
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size === 0 || st.size > 4096) refuse("it is not a regular file of 1 to 4096 bytes");
    if (st.uid === 0) {
      for (let dir = path.dirname(fs.readlinkSync(`/proc/self/fd/${fd}`)); ; dir = path.dirname(dir)) {
        const d = fs.statSync(dir);
        if (d.uid !== 0 || (d.mode & 0o022) !== 0) refuse(`root owns it, but ${dir} is not root-controlled`);
        if (dir === "/") break;
      }
    }
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    fs.writeFileSync(dest, buf, { mode: 0o600, flag: "wx" });
  ' "$1" "$2.tmp") || {
    rm -f "$2.tmp"
    fail "Refused the passphrase file $1: it must be a regular file of at most 4 KiB, not a link, a device or a pipe."
  }
}

prepare_keyring() {
  state_has_keys=0
  [ ! -d "$STATE_DIR/keyring" ] || state_has_keys=1
  if [ "$OPT_NO_KEYRING" = 1 ]; then
    [ "$state_has_keys" = 0 ] ||
      fail "The gateway's state in $STATE_DIR is sealed by a keyring; --no-keyring would start it without the passphrase that opens it."
    CONF_KEYRING=none
    warn "--no-keyring: the dedicated gateway runs without encryption at rest."
    return 0
  fi
  CONF_KEYRING=passphrase
  mkdir -p "$ETC_DIR"
  chmod 755 "$ETC_DIR"
  if [ -n "$OPT_PASS_FILE" ]; then
    copy_passphrase "$OPT_PASS_FILE" "$PASS_FILE.new"
    if [ -f "$PASS_FILE" ] && ! cmp -s "$PASS_FILE.new.tmp" "$PASS_FILE"; then
      rm -f "$PASS_FILE.new.tmp"
      fail "$PASS_FILE already holds a different passphrase, which the gateway's keys may be sealed with. Remove it first if it seals nothing."
    fi
    mv -f "$PASS_FILE.new.tmp" "$PASS_FILE"
    info "Copied the passphrase from $OPT_PASS_FILE into $PASS_FILE, readable by root alone."
  elif [ -f "$PASS_FILE" ]; then
    info "Using the passphrase in $PASS_FILE."
  elif [ -n "$LEGACY_PASS" ] && [ -e "$LEGACY_PASS" ]; then
    copy_passphrase "$LEGACY_PASS" "$PASS_FILE"
    mv -f "$PASS_FILE.tmp" "$PASS_FILE"
    info "Copied the passphrase the earlier unit read ($LEGACY_PASS) into $PASS_FILE, readable by root alone."
    warn "That passphrase was readable by a login account. Once the gateway runs, consider a recovery export and a new passphrase."
  elif [ "$state_has_keys" = 1 ]; then
    fail "The gateway's state in $STATE_DIR is sealed by a keyring whose passphrase is not in $PASS_FILE. Name the file that holds it with --keyring-passphrase-file; a new passphrase would not open it."
  else
    rm -f "$PASS_FILE.tmp"
    (umask 077 && "$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > "$PASS_FILE.tmp")
    [ -s "$PASS_FILE.tmp" ] || fail "Could not generate a passphrase."
    chmod 600 "$PASS_FILE.tmp"
    mv -f "$PASS_FILE.tmp" "$PASS_FILE"
    info "Wrote a new passphrase to $PASS_FILE, readable by root alone."
  fi
}

cmd_install() {
  require_linux_systemd
  require_node
  require_git
  REPO_URL="${OPT_REPO_URL:-$DEFAULT_REPO_URL}"
  CONF_REPO_URL="$REPO_URL"
  read_legacy_unit
  CONF_PORT="${OPT_PORT:-${CONF_PORT:-$DEFAULT_PORT}}"
  arm_cleanup
  prepare_keyring
  build_release
  write_install_env
  switch_current "$RELEASE_DIR"
  # An install has nothing to roll back to, even over one that never came up.
  set_previous ""
  mkdir -p "$(dirname "$ADMIN_LINK")"
  ln -sfn "$CURRENT/$SCRIPT_REL" "$ADMIN_LINK"
  step "Installing $UNIT_NAME"
  render_unit
  systemctl restart "$UNIT_NAME"
  if ! wait_for_version "$RELEASE_VERSION"; then
    systemctl stop "$UNIT_NAME" >/dev/null 2>&1 || true
    fail "$UNIT_NAME did not start serving $RELEASE_VERSION within ${HEALTH_TIMEOUT_SECONDS}s, so it was stopped. Inspect it with: journalctl -u $UNIT_NAME -n 50, then run the install again."
  fi
  prune_releases
  print_installed
}

print_installed() {
  echo ""
  printf '%bThe dedicated gateway is running%b %s (%s).\n' "$BOLD" "$RESET" "$RELEASE_VERSION" "$(basename "$RELEASE_DIR")"
  echo ""
  echo "Its state is in $STATE_DIR, readable only by its own account and root. It runs"
  echo "from $RELEASE_DIR, which only root can change."
  echo ""
  echo "Administer it as root:"
  echo ""
  if [ "$CONF_KEYRING" = passphrase ]; then
    echo "  sudo omnesis-gateway-admin cli keyring export-recovery --backend passphrase"
  fi
  echo "  sudo omnesis-gateway-admin cli tls status"
  echo "  sudo omnesis-gateway-admin cli devices pair --kind collector"
  echo ""
  if [ "$CONF_KEYRING" = passphrase ]; then
    echo "The first prints a one-time recovery code; keep it away from this machine."
    echo "$PASS_FILE seals the gateway's keys; the gateway cannot open its stores without it."
  else
    echo "It runs without encryption at rest (--no-keyring)."
  fi
  echo ""
  echo "Update it:     sudo omnesis-gateway-admin update --version X.Y.Z"
  echo "Status:        sudo omnesis-gateway-admin status"
  echo "https://omnesis.dev/docs/security#hardened-gateway"
}

migration_warning() {
  warn "A release that already ran may have applied forward-only migrations the earlier release does not know. If the gateway misbehaves, restore a backup: sudo omnesis-gateway-admin cli backup --list, then sudo omnesis-gateway-admin cli restore <backup-dir> --force"
}

roll_back_after_failure() {
  rollback_target="$1"
  rollback_previous="$2"
  rollback_reason="$3"
  warn "$rollback_reason Switching back to $(basename "$rollback_target")."
  switch_current "$rollback_target"
  # The release that failed is not one to roll back to later: `previous` goes
  # back to what it named before this update.
  set_previous "$rollback_previous"
  render_unit >/dev/null || true
  systemctl restart "$UNIT_NAME" || true
  rollback_version="$(release_version "$rollback_target")"
  if wait_for_version "$rollback_version"; then
    info "$(basename "$rollback_target") is serving again."
  else
    warn "$(basename "$rollback_target") did not come back either. Inspect it with: journalctl -u $UNIT_NAME -n 50"
  fi
  migration_warning
  exit 1
}

cmd_update() {
  require_linux_systemd
  require_node
  require_git
  read_install_env || fail "No dedicated gateway is installed by this script ($INSTALL_ENV is missing)."
  REPO_URL="$CONF_REPO_URL"
  arm_cleanup
  build_release
  update_current="$(link_target "$CURRENT")"
  if [ "$update_current" = "$(readlink -f "$RELEASE_DIR")" ]; then
    info "Already running $REF ($(basename "$RELEASE_DIR"))."
    return 0
  fi
  running_version="$(release_version "$update_current" 2>/dev/null || true)"
  if [ "$OPT_FORCE" = 0 ] && version_older "$RELEASE_VERSION" "$running_version"; then
    fail "$REF is $RELEASE_VERSION, older than the running $running_version, whose migrations it may not read. Switch back with rollback, or pass --force to update to it anyway."
  fi
  if [ "$OPT_NO_BACKUP" = 1 ]; then
    warn "--no-backup: switching without a backup."
  elif [ -n "$(served_version)" ]; then
    step "Backing up the gateway's databases through its API"
    run_cli "$update_current" backup --note "before update to $REF" ||
      fail "The backup failed, and nothing was changed. Run the update again with --no-backup to switch without one."
  else
    warn "The running gateway does not answer, so no backup is taken before switching."
  fi
  update_previous="$(link_target "$PREVIOUS")"
  trap 'roll_back_after_failure "$update_current" "$update_previous" "The update was interrupted."' INT TERM HUP
  step "Switching to $(basename "$RELEASE_DIR")"
  switch_current "$RELEASE_DIR"
  ln -sfn "$CURRENT/$SCRIPT_REL" "$ADMIN_LINK"
  render_unit >/dev/null ||
    roll_back_after_failure "$update_current" "$update_previous" "The new release could not install its unit."
  systemctl restart "$UNIT_NAME" ||
    roll_back_after_failure "$update_current" "$update_previous" "The service did not restart."
  if ! wait_for_version "$RELEASE_VERSION"; then
    roll_back_after_failure "$update_current" "$update_previous" \
      "The new release did not serve $RELEASE_VERSION within ${HEALTH_TIMEOUT_SECONDS}s."
  fi
  trap 'exit 130' INT TERM HUP
  prune_releases
  printf '%bUpdated%b to %s (%s).\n' "$BOLD" "$RESET" "$RELEASE_VERSION" "$(basename "$RELEASE_DIR")"
}

cmd_rollback() {
  require_linux_systemd
  require_node
  read_install_env || fail "No dedicated gateway is installed by this script ($INSTALL_ENV is missing)."
  arm_cleanup
  rollback_previous="$(link_target "$PREVIOUS")"
  [ -n "$rollback_previous" ] && [ -f "$rollback_previous/$RELEASE_INFO" ] ||
    fail "There is no previous release to switch back to."
  rollback_version="$(release_version "$rollback_previous")"
  step "Switching back to $(basename "$rollback_previous")"
  switch_current "$rollback_previous"
  ln -sfn "$CURRENT/$SCRIPT_REL" "$ADMIN_LINK"
  render_unit >/dev/null
  systemctl restart "$UNIT_NAME"
  wait_for_version "$rollback_version" ||
    fail "$(basename "$rollback_previous") did not serve $rollback_version within ${HEALTH_TIMEOUT_SECONDS}s. Inspect it with: journalctl -u $UNIT_NAME -n 50"
  info "Rolled back to $rollback_version ($(basename "$rollback_previous"))."
  migration_warning
}

cmd_status() {
  require_root
  read_install_env || fail "No dedicated gateway is installed by this script ($INSTALL_ENV is missing)."
  status_current="$(link_target "$CURRENT")"
  status_previous="$(link_target "$PREVIOUS")"
  info "Release:   ${status_current:-none}"
  [ -z "$status_current" ] || sed 's/^/           /' "$status_current/$RELEASE_INFO"
  info "Previous:  ${status_previous:-none}"
  info "Service:   $(systemctl is-active "$UNIT_NAME" 2>/dev/null || true)"
  info "Port:      $CONF_PORT"
  info "Keyring:   $CONF_KEYRING"
  info "Source:    $CONF_REPO_URL"
  if command -v node >/dev/null 2>&1; then
    require_node
    status_served="$(served_version)"
    info "Serving:   ${status_served:-not answering}"
  fi
}

cmd_cli() {
  require_root
  require_node
  read_install_env || fail "No dedicated gateway is installed by this script ($INSTALL_ENV is missing)."
  [ -L "$CURRENT" ] || fail "No release is installed under $RELEASE_ROOT."
  arm_cleanup
  run_cli "$CURRENT" "$@"
}

cmd_uninstall() {
  require_linux_systemd
  step "Removing $UNIT_NAME and its releases"
  systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  rm -f "$ADMIN_LINK" "$INSTALL_ENV"
  rm -rf "$RELEASE_ROOT" "$BUILD_DIR"
  info "Removed the service, $RELEASE_ROOT and $ADMIN_LINK."
  info "Kept $STATE_DIR, the gateway's corpus, and $PASS_FILE, the passphrase that opens it. Remove both yourself if you no longer need them."
}

main() {
  main_command="${1:-help}"
  [ $# -eq 0 ] || shift
  case "$main_command" in
    install|update)
      parse_options "$@"
      sanitize_environment
      hold_admin_lock
      if [ -z "$OPT_FROM_CHECKOUT" ]; then
        fetch_and_hand_over "$main_command"
      fi
      require_fetched_checkout "$OPT_FROM_CHECKOUT"
      CHECKOUT="$OPT_FROM_CHECKOUT"
      REF="$OPT_REF"
      [ -n "$REF" ] || fail "--from-checkout needs the --ref it was fetched at."
      "cmd_$main_command"
      ;;
    rollback|uninstall)
      parse_options "$@"
      sanitize_environment
      hold_admin_lock
      "cmd_$main_command"
      ;;
    status)
      parse_options "$@"
      sanitize_environment
      cmd_status
      ;;
    cli)
      sanitize_environment
      cmd_cli "$@"
      ;;
    help|-h|--help) usage ;;
    *) fail "Unknown command: $main_command. See 'omnesis-gateway-admin help'." ;;
  esac
}

# Sourced by its tests for the pure functions; run otherwise.
[ "${OMNESIS_HARDENED_SOURCE_ONLY:-0}" = 1 ] || main "$@"
