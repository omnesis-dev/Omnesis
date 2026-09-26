#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Omnesis installer.
#
#   curl -fsSL https://omnesis.dev/install.sh | sh
#
# What it does, in order:
#   1. Detect OS/arch (macOS + Linux; everything else gets an honest refusal).
#   2. Ensure Node >= 24 (brew on macOS, NodeSource via apt/dnf on Linux).
#   3. Install the `omnesis` CLI from the newest stable source tag. `--method
#      package` installs the published npm package instead, and `--method auto`
#      prefers the package when the registry serves it.
#   4. Provision TLS: if Tailscale is up, mint a real cert via
#      `tailscale cert` and point the gateway at it; `--mkcert` opts into a
#      local CA instead; otherwise the gateway's self-signed cert stands.
#   5. Initialize the OS keyring root key when a durable keyring is already
#      available. When it is not, ask whether to continue without encryption
#      at rest, arm the passphrase backend now, or stop.
#   6. Register + start gateway and collector as user services
#      (`omnesis service install` → launchd / systemd user units). On Linux
#      with systemd, `--hardened` instead prints the one root command that
#      installs the gateway as a dedicated account with its own state, running
#      from a copy of Omnesis only root can change; the installer never runs it.
#   7. Migrate initial credential/token files into wrapped secret files when
#      keyring init succeeded.
#   8. Download the embedding model with progress (`omnesis model install`).
#   9. On an interactive gateway install where a Codex command is already on
#      PATH, offer to sign Omnesis into Codex and assign Luna to the agent.
#  10. Print the next step (add a source), then the optional follow-ons a
#      gateway host can offer: a phone, a browser, another machine.
#
# Roles, one per invocation. With no role flag this is the gateway machine and
# every step above runs. `--client-only` installs the CLI alone. `--collector`
# installs the CLI, then pairs this machine with a gateway running elsewhere
# and registers the collector service against it. `--openclaw` and `--hermes`
# install the CLI, then connect an agent harness already installed here to a
# gateway running elsewhere. `--docker` runs the daemons as containers rather
# than as user services and takes the role flags that still mean something
# there: `--docker --collector --gateway-url … --code …` makes a container
# collector for a gateway elsewhere. The harness roles stay native — a plugin
# runs inside the harness process, so there is no container for it.
#
# Re-running on a machine this installer already set up, for the role it
# already has, updates that install in place: the installer makes the recorded
# checkout fetchable and runs the machine's own `omnesis update` (to the newest
# stable release, or --version / --edge), which rebuilds, restarts the services
# and rolls back on failure. Certificate, keyring, embedding model and pairing
# stay as they are; the update refreshes service definitions as `omnesis
# update` always does. A plain re-run updates any machine with a gateway or
# collector service, so turning a collector machine into a gateway takes
# --reconfigure. `--reconfigure`, --collector or --client-only on a machine
# with another role, a first install that never registered its services,
# --commit, --method package|auto, or a flag that sets one of the kept choices
# (--code, --gateway-url, --trust-fingerprint, --mkcert, --embedder, --port,
# --keyring-passphrase-file, --hardened) runs the full install instead. Flags
# that only skip a setup step (--no-tls, --no-service, --no-keyring,
# --no-model) have nothing to skip on an update. The harness roles already
# refresh an existing connection.
#
# A harness role on a machine that already runs Omnesis — a checkout this
# installer recorded, or a gateway or collector service registered for this
# account — installs nothing: it runs `omnesis connect` with the CLI that is
# already there, and leaves its checkout, launcher, services and keyring as
# they are. When that CLI predates the connect this installer runs, the run
# offers the machine's own `omnesis update` first (which restarts its services
# and rolls back on failure), or stops and says to run it.
#
# The two required choices (which embedding model, and what to do about a
# keyring it cannot use) are read from /dev/tty, because under `curl | sh`
# stdin is the script itself. An ordinary gateway may optionally offer Codex
# agent setup, and a self-signed or mkcert gateway may ask which
# certificate-covered address another machine should use. With no terminal,
# optional setup is skipped and the address keeps its safe default; pass flags
# for either required choice instead of accepting a silent default.
#
# Flags (env-var equivalents in parens):
#   --method auto|package|source   (OMNESIS_INSTALL_METHOD, default source;
#                                  auto prefers the package when the registry
#                                  serves it and falls back to source)
#   --channel stable|beta          (package installs) npm dist-tag to track
#   --registry <url>               (package installs) npm registry to install from
#   --version <x.y.z>              install an exact release (package, source tag,
#                                  or Docker image)
#   --commit <40-hex-sha>          install an exact pushed source commit
#                                  (source only; intentionally advanced)
#   --edge                         install the current main branch instead
#                                  (source only)
#   --force                        allow an existing checkout to move backwards
#   --replace-source-wrapper       after a healthy package install, replace a
#                                  verified installer-owned source launcher at
#                                  ~/.local/bin/omnesis without prompting
#   --source-dir <dir>             (OMNESIS_SOURCE_DIR, default ~/omnesis)
#   --port <port>                  gateway port (default 7600)
#   --mkcert                       use mkcert for TLS instead of Tailscale
#   --client-only                  install the CLI without local gateway services,
#                                 TLS provisioning, or an embedding model
#   --collector                    make this machine a collector for a gateway
#                                  running elsewhere: install the CLI, pair with
#                                  that gateway, and register the collector
#                                  service. One role per invocation.
#   --openclaw                     connect the OpenClaw installed on this machine
#   --hermes                       connect the Hermes installed on this machine.
#                                  Either one: install the CLI, then run
#                                  `omnesis connect`, which pairs an agent device
#                                  with the gateway and installs the plugin and
#                                  skill, then restarts the harness (asking
#                                  first on a terminal) and reports whether its
#                                  Omnesis skill is ready. The harness itself is
#                                  never installed here; a machine without one
#                                  is refused. Neither role touches the keyring:
#                                  the harness keeps its credentials in its own
#                                  home.
#   --gateway-url <url>            (role flags above) the gateway to pair with.
#                                  Omitted, the LAN is browsed for one and the
#                                  hit is confirmed before anything is paired.
#   --trust-fingerprint sha256:…   (role flags above) verify the gateway's
#                                  certificate against this fingerprint instead
#                                  of trusting whatever answers
#   --code <code>                  (role flags above) the pairing code, for
#                                  automation. Omitted, it is asked for on the
#                                  terminal, so a single-use code stays out of
#                                  shell history.
#   --docker                       run the gateway and collector as containers on
#                                  this machine instead of as user services. The
#                                  daemons come from published, version-tagged
#                                  images and `omnesis` becomes a wrapper that
#                                  runs the CLI inside one of them. `--version`
#                                  pins an exact released image. `--edge` is
#                                  refused because the installer resolves images
#                                  cut at releases, not branch images.
#   --build                        (--docker) build the images from the checkout
#                                  this script came from instead of pulling the
#                                  published ones
#   --tls-cert <path>              (--docker) serve this certificate from the
#                                  gateway container instead of a self-signed
#                                  one; needs --tls-key. Both files must live
#                                  inside the config directory, the one path the
#                                  containers see. The collector dials the
#                                  gateway by the certificate's DNS name.
#   --tls-key <path>               (--docker) the private key of --tls-cert
#   --tls-ca <path>                (--docker) the CA that issued --tls-cert when
#                                  it is a private one (mkcert's rootCA.pem):
#                                  the containers trust it when they dial the
#                                  gateway. Also inside the config directory.
#   --no-service                   skip service registration
#   --no-modify-path               print the line that puts the omnesis command
#                                  on PATH instead of adding it to your shell
#                                  profile
#   --hardened                     (Linux with systemd) run the gateway as a
#                                  dedicated system account instead of yours: a
#                                  fresh gateway with its own state under
#                                  /var/lib/omnesis-gateway, running from a copy
#                                  of Omnesis only root can change. The one root
#                                  command that installs it is printed, never
#                                  run. Refused while a gateway service of yours
#                                  is registered.
#   --no-hardened                  keep the gateway under your account without
#                                  being asked (the default)
#   --embedder <id>                (OMNESIS_EMBEDDER_ID) embedding model to
#                                  install; skips the question
#   --no-model                     skip the embedding-model download
#   --no-tls                       skip TLS provisioning (self-signed)
#   --no-keyring                   skip opportunistic keyring init/migrate
#   --keyring-passphrase-file <p>  arm encryption at rest from this passphrase
#                                  file (absolute path) when no OS keyring is
#                                  usable; skips the question
#   --reconfigure                  on a machine this installer already set up,
#                                  run the full install again (certificate,
#                                  keyring, model, pairing, services) instead of
#                                  updating the existing install in place
#   --dry-run                      (OMNESIS_DRY_RUN=1) validate this invocation,
#                                  print the read-only install plan, and exit
#                                  before installing or changing anything
#   --no-prompt                    (OMNESIS_NO_PROMPT=1) never ask on /dev/tty;
#                                  optional choices take their safe default and
#                                  required choices fail with the flag they need
#
# Security posture: runs as your user, except optional Linux prerequisites and
# Tailscale operator setup that need sudo/doas. `--hardened` prints the root
# command it needs and runs none. Read the script before piping it to sh; that's always
# the right instinct.
#
# Everything is wrapped in main() invoked on the last line, so a truncated
# download executes nothing.

set -eu

# Overridable for forks and local testing.
REPO_URL="${OMNESIS_REPO_URL:-https://github.com/omnesis-dev/Omnesis}"
CLI_PKG="omnesis"
ORIGINAL_PATH="${PATH:-}"
# Long downloads get one shared stall budget. Short probes (gateway health and
# registry discovery) keep their smaller, purpose-specific deadlines.
NETWORK_TIMEOUT_SECONDS="${OMNESIS_NETWORK_TIMEOUT_SECONDS:-300}"
DRY_RUN="${OMNESIS_DRY_RUN:-0}"
NO_PROMPT="${OMNESIS_NO_PROMPT:-0}"
# Fallback when the CLI's bundled catalog cannot be read (an older CLI on an
# upgrade). The catalog, not this line, is what the question offers.
EMBEDDER_ID="nomic-embed-text-v1.5.Q8_0"
CODEX_AGENT_MODEL="gpt-5.6-luna"

# Default stays `source`: a checkout works from the first tagged release on,
# with no dependency on a registry having the version. `--method auto` is the
# opt-in that prefers the package when one is actually published.
METHOD="${OMNESIS_INSTALL_METHOD:-source}"
CHANNEL="${OMNESIS_INSTALL_CHANNEL:-stable}"
REGISTRY="${OMNESIS_INSTALL_REGISTRY:-}"
PIN_VERSION=""
PIN_COMMIT=""
EDGE="${OMNESIS_INSTALL_EDGE:-0}"
FORCE=0
REPLACE_SOURCE_WRAPPER=0
# Whether this run moved an existing source checkout to a build its running
# services are not on yet.
SOURCE_MOVED=0
SOURCE_DIR="${OMNESIS_SOURCE_DIR:-$HOME/omnesis}"
# Whether this run named its checkout (--source-dir or OMNESIS_SOURCE_DIR).
# When it did not, an install an earlier run recorded is used instead.
SOURCE_DIR_EXPLICIT=0
[ -z "${OMNESIS_SOURCE_DIR:-}" ] || SOURCE_DIR_EXPLICIT=1
# A re-run on this machine's existing source install updates it in place;
# --reconfigure runs the full installer on it instead.
UPDATE_EXISTING=0
RECONFIGURE_FLAG=0
GATEWAY_PORT="7600"
GATEWAY_PORT_EXPLICIT=0
# How long to wait for the freshly registered gateway to answer /health. A
# first boot builds indexes, so a slow machine may need longer than the default.
GATEWAY_WAIT_SECONDS="${OMNESIS_GATEWAY_WAIT_SECONDS:-60}"
# How long a gateway that is up but not yet answering may keep starting. A
# first boot applies every database migration, which on a small or busy
# machine outlasts the wait above; 0 turns the extra wait off.
GATEWAY_STARTUP_MAX_SECONDS="${OMNESIS_GATEWAY_STARTUP_MAX_SECONDS:-600}"
GATEWAY_STARTUP_POLL_SECONDS="${OMNESIS_GATEWAY_STARTUP_POLL_SECONDS:-15}"
WANT_SERVICE=1
# Add the launcher's directory to the shell profile when it is not on PATH.
MODIFY_PATH=1
WANT_HARDENED=0
HARDENED_FLAG=0
NO_HARDENED_FLAG=0
ACCOUNT_CHOICE_DEFERRED=0
WANT_MODEL=1
WANT_TLS=1
WANT_KEYRING=1
CLIENT_ONLY=0
# Whether --client-only was typed, as opposed to implied by a role that already
# installs the CLI that way: only the typed flag contradicts such a role.
CLIENT_ONLY_FLAG=0
# The collector role: a client install, plus pairing and the collector service.
COLLECTOR=0
# The harness roles: a client install, plus `omnesis connect <harness>`. Empty,
# or the harness name, which is also what `connect` is invoked with.
HARNESS=""
# The harness home `connect` resolves, and what it already holds there: an
# integration, which makes this run a refresh rather than a fresh pairing, or a
# marker from a connect that did not finish, which makes it a resume.
HARNESS_HOME=""
HARNESS_REFRESH=0
HARNESS_RESUME=0
# Set when a harness role runs on a machine that already runs Omnesis: what was
# found there, the checkout this installer recorded (empty for an install it
# did not record), and that the role connects with the CLI already there.
HARNESS_EXISTING=0
HARNESS_EXISTING_WHAT=""
HARNESS_EXISTING_ROOT=""
PAIR_GATEWAY_URL=""
PAIR_GATEWAY_URL_FLAG=0
PAIR_FINGERPRINT=""
PAIR_FINGERPRINT_FLAG=0
PAIR_CODE=""
PAIR_CODE_FLAG=0
# How long to wait for the freshly registered collector to be accepted by the
# gateway. It builds nothing, so this is a network wait, not a boot wait.
COLLECTOR_WAIT_SECONDS="${OMNESIS_COLLECTOR_WAIT_SECONDS:-90}"
# How long to listen for an mDNS advertisement when no --gateway-url was given.
DISCOVER_MS="${OMNESIS_DISCOVER_MS:-4000}"
COLLECTOR_DEVICE_NAME=""
COLLECTOR_ONLINE=0
# Set when this machine has no supervisor to register the collector with, as
# opposed to a run that was told not to register one.
COLLECTOR_SERVICE_REFUSED=0
USE_MKCERT=0
MKCERT_EXPLICIT=0
NO_TLS_FLAG=0
LOG_LEVEL="${OMNESIS_LOG_LEVEL:-info}"
# The Docker role: containers instead of user services.
DOCKER=0
DOCKER_BUILD_FLAG=0
# A certificate the gateway container serves instead of minting its own, with
# its key and, for a private CA, the CA the containers verify it against.
TLS_CERT_PATH=""
# The store listing of the browser extension; the portal's Sources card and
# pairing dialog link the same address (packages/gateway/portal/js/lib/extension-links.js).
CHROME_WEB_STORE_URL="https://chromewebstore.google.com/detail/omnesis-browser-capture/akojepkcdbncipjdonhnnfmjacknplmn"
TLS_KEY_PATH=""
TLS_CA_PATH=""
TLS_FILES_FLAG=0
# What the certificate carries, once inspected: the name the collector dials
# the gateway by, every DNS name it covers (the gateway container answers to
# all of them on the compose network), and its fingerprint.
TLS_PRIMARY_NAME=""
TLS_ALIAS_NAMES=""
TLS_FINGERPRINT=""
# Without one, the host names the gateway's own certificate is to cover, and
# the one the banner's join line prints.
DOCKER_EXTRA_NAMES=""
DOCKER_JOIN_HOST=""
# A checkout to build the images from, when this script came from one. Only a
# fallback: the images are published per release and are normally pulled.
DOCKER_BUILD_CONTEXT="${OMNESIS_DOCKER_BUILD_CONTEXT:-}"
# Overridable for forks and local testing, like REPO_URL above.
IMAGE_REPO="${OMNESIS_IMAGE_REPO:-ghcr.io/omnesis-dev}"
IMAGE_TAG=""
COMPOSE_FILE=""
DOCKER_SOCKET=""
DOCKER_SOCKET_GID=""
# Which container the CLI wrapper runs in — the gateway on a full stack, the
# collector on a host that only collects.
DOCKER_CLI_SERVICE="gateway"
# The compose project every command in this install acts on. Compose commands
# name a project, not a file, so two installs sharing one name would tear each
# other's containers down; the name therefore derives from the config
# directory the install lives in.
COMPOSE_PROJECT=""
# `fixed` publishes the OAuth callback ports on the host ports the providers
# are registered against, which is the only way a redirect can come back.
# `ephemeral` publishes them on ports the kernel picks, for a host that will
# never complete an OAuth flow and only needs the containers to start.
OAUTH_HOST_PORTS="${OMNESIS_OAUTH_HOST_PORTS:-fixed}"
# Flags that only matter as "was this typed", to separate a contradiction on
# the command line from an environment variable that happens to be exported.
METHOD_FLAG=0
SOURCE_DIR_FLAG=0
NO_SERVICE_FLAG=0
CONFIG_DIR="${OMNESIS_CONFIG_DIR:-$HOME/.config/omnesis}"
KEYRING_READY=0
# Whether this host's live-storage keys exist for the process it runs; a
# collector-only install mints its own, since no gateway boots beside it.
STORAGE_KEYS_READY=0
# When set, a machine with no usable OS keyring arms the passphrase backend
# from this file so encryption at rest still works.
KEYRING_PASSPHRASE_FILE="${OMNESIS_KEYRING_PASSPHRASE_FILE:-}"
# Whether --keyring-passphrase-file was typed, as opposed to an id the
# environment happens to carry: only the flag contradicts --client-only.
KEYRING_PASSPHRASE_FLAG=0
KEYRING_BACKEND=""
KEYRING_CRED_FILE=""
# Embedding model: chosen from the CLI's bundled catalog, or named up front.
# EMBEDDER_FLAG separates "--embedder was typed" from "the environment happens
# to carry an id", so an exported id loses quietly to --no-model instead of
# turning a valid command line into an error.
EMBEDDER_EXPLICIT=0
EMBEDDER_FLAG=0
if [ -n "${OMNESIS_EMBEDDER_ID:-}" ]; then
  EMBEDDER_ID="$OMNESIS_EMBEDDER_ID"
  EMBEDDER_EXPLICIT=1
fi
EMBEDDER_CHOSEN=0
# Set when this machine already serves embeddings from something the catalog
# does not contain, so nothing is downloaded and nothing is reassigned.
EMBEDDER_KEPT=0
EXISTING_CLI=""
# Set when ~/.local/bin is missing from PATH, so the banner can repeat the fix.
PATH_HINT_DIR=""
# Set once the gateway answers /health, so the banner only claims what is true.
GATEWAY_HEALTHY=0
# A name for the gateway that resolves from OTHER machines and is covered by
# the certificate this run provisioned. Separate from PORTAL_HOST, which names
# the gateway for a browser on this machine and is better off as localhost
# whenever the certificate allows it.
BANNER_HOST=""
# A freshly minted mkcert certificate is eligible for the same address picker
# as the gateway's self-signed certificate. These carry its cert, default, and
# any selection from an earlier mkcert run into the post-start chooser.
MKCERT_ADDRESS_CERT=""
MKCERT_ADDRESS_DEFAULT=""
MKCERT_ADDRESS_PREVIOUS=""

info()  { printf '\033[0;32m[omnesis]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[omnesis]\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[0;31m[omnesis]\033[0m %s\n' "$*" >&2; exit 1; }

stage() {
  echo ""
  printf '\033[1m%s\033[0m\n' "$1"
}

show_install_plan() {
  if [ "$DOCKER" = 1 ]; then
    if [ "$COLLECTOR" = 1 ]; then PLAN_ROLE="Docker collector"
    else PLAN_ROLE="Docker gateway and collector"; fi
    if [ -n "$PIN_VERSION" ]; then PLAN_RELEASE="release $PIN_VERSION"
    else PLAN_RELEASE="newest complete stable image release (resolved during install)"; fi
    if [ "$DOCKER_BUILD_FLAG" = 1 ]; then
      PLAN_DELIVERY="containers built from $DOCKER_BUILD_CONTEXT"
    else
      PLAN_DELIVERY="published containers; $PLAN_RELEASE"
    fi
    PLAN_TARGET="$CONFIG_DIR"
  else
    if [ "$UPDATE_EXISTING" = 1 ]; then PLAN_ROLE="update of this machine's existing install"
    elif [ "$HARNESS_EXISTING" = 1 ]; then
      PLAN_ROLE="$(harness_label "$HARNESS") integration for another gateway, using this machine's existing Omnesis"
    elif [ "$COLLECTOR" = 1 ]; then PLAN_ROLE="collector for another gateway"
    elif [ -n "$HARNESS" ]; then PLAN_ROLE="$(harness_label "$HARNESS") integration for another gateway"
    elif [ "$CLIENT_ONLY" = 1 ]; then PLAN_ROLE="CLI only"
    elif [ "$WANT_HARDENED" = 1 ]; then PLAN_ROLE="dedicated-account gateway"
    elif [ "$ACCOUNT_CHOICE_DEFERRED" = 1 ]; then
      PLAN_ROLE="gateway and collector; account choice deferred to the real install"
    else PLAN_ROLE="gateway and collector"; fi
    case "$METHOD" in
      auto) PLAN_DELIVERY="auto: package when the registry serves it, otherwise source" ;;
      package)
        if [ -n "$PIN_VERSION" ]; then PLAN_DELIVERY="npm package; version $PIN_VERSION"
        else PLAN_DELIVERY="npm package; channel $(dist_tag)"; fi
        ;;
      source)
        if [ -n "$PIN_COMMIT" ]; then PLAN_RELEASE="commit $(printf '%.12s' "$PIN_COMMIT")"
        elif [ "$EDGE" = 1 ]; then PLAN_RELEASE="current main branch"
        elif [ -n "$PIN_VERSION" ]; then PLAN_RELEASE="release v$PIN_VERSION"
        else PLAN_RELEASE="newest stable source release (resolved during install)"; fi
        PLAN_DELIVERY="source; $PLAN_RELEASE"
        ;;
    esac
    if [ "$METHOD" = package ]; then PLAN_TARGET="user-writable npm prefix (resolved during install)"
    elif [ "$METHOD" = auto ]; then PLAN_TARGET="npm prefix or $SOURCE_DIR (resolved during install)"
    else PLAN_TARGET="$SOURCE_DIR"; fi
    if [ "$HARNESS_EXISTING" = 1 ]; then
      PLAN_DELIVERY="none; the CLI already installed here ($HARNESS_EXISTING_WHAT)"
      PLAN_TARGET="$OMNESIS_BIN"
    fi
  fi

  stage "Install plan"
  printf '  Platform:  %s/%s\n' "$PLATFORM" "$ARCH"
  printf '  Role:      %s\n' "$PLAN_ROLE"
  printf '  Delivery:  %s\n' "$PLAN_DELIVERY"
  printf '  Target:    %s\n' "$PLAN_TARGET"
  if [ "$CLIENT_ONLY" != 1 ] && [ "$DOCKER" != 1 ] && [ "$UPDATE_EXISTING" = 0 ]; then
    printf '  Gateway:   https://localhost:%s\n' "$GATEWAY_PORT"
  fi
  if [ "$NO_PROMPT" = 1 ]; then printf '  Prompts:   disabled\n'; fi
  if [ "$DRY_RUN" = 1 ]; then printf '  Dry run:   yes; no machine changes will be made\n'; fi
}

# ── asking the operator something ────────────────────────────────────────────
#
# Under `curl -fsSL … | sh` stdin is the script, so a prompt has to read the
# controlling terminal directly. Opening /dev/tty is also the only reliable
# test that one exists: the device node is world-readable even in a systemd
# unit or a container build, where opening it fails with ENXIO. The probe runs
# in a subshell because a failed redirection on a special built-in is fatal to
# the shell itself, which would end the install instead of answering "no".

have_tty() { ( : </dev/tty ) 2>/dev/null; }

# --no-prompt makes a terminal run take exactly the same safe branches as a
# headless one. Required choices still fail and name the explicit flag; this is
# deliberately not a blanket "yes" to security-sensitive questions.
is_promptable() {
  [ "$NO_PROMPT" = 0 ] && have_tty
}

# Write a prompt to the terminal and echo the answer on stdout. An operator
# who closes the input (Ctrl-D) gets the empty answer, which every caller
# reads as "take the offered default".
ask_tty() {
  printf '%s' "$1" >/dev/tty
  if IFS= read -r ASK_REPLY </dev/tty; then :; else ASK_REPLY=""; fi
  printf '%s' "$ASK_REPLY"
}

# The file a PATH line belongs in, for the shell this operator actually runs.
shell_profile_file() {
  case "${SHELL:-}" in
    */zsh)  printf '%s' "$HOME/.zshrc" ;;
    */bash) if [ "${PLATFORM:-}" = darwin ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi ;;
    */fish) printf '%s' "$HOME/.config/fish/config.fish" ;;
    *)      printf '%s' "$HOME/.profile" ;;
  esac
}

# The line that puts a directory on PATH, in that shell's own syntax.
path_export_line() {
  case "${SHELL:-}" in
    */fish) printf 'fish_add_path %s' "$1" ;;
    *)      printf 'export PATH="%s:$PATH"' "$1" ;;
  esac
}

# Print the exact two lines that fix a missing PATH entry.
# Print the line that would put a directory on PATH, for the operator to add.
print_manual_path_hint() {
  PATH_HINT_PROFILE="$(shell_profile_file)"
  warn "$1 is not on your PATH. Add it:"
  warn "  echo '$(path_export_line "$1")' >> $PATH_HINT_PROFILE"
}

# Append a PATH line to a shell profile under a marker, unless the profile
# already carries it. Succeeds when the profile ends up with the line.
profile_has_path_line() {
  if [ -f "$1" ] && grep -qxF "$2" "$1" 2>/dev/null; then
    return 0
  fi
  mkdir -p "$(dirname "$1")" 2>/dev/null || return 1
  { printf '\n# Added by the Omnesis installer\n%s\n' "$2" >> "$1"; } 2>/dev/null
}

# The directory holding the omnesis command is not on PATH. Put it in the
# shell profile, so every new terminal finds the command, and say how to use it
# in this one — a piped installer cannot change the shell that ran it. With
# --no-modify-path, or a profile this run cannot write, print the line instead.
print_path_hint() {
  PATH_HINT_PROFILE="$(shell_profile_file)"
  PATH_HINT_LINE="$(path_export_line "$1")"
  if [ "$MODIFY_PATH" = 1 ] && profile_has_path_line "$PATH_HINT_PROFILE" "$PATH_HINT_LINE"; then
    info "New terminals find the omnesis command: $1 is on PATH through $PATH_HINT_PROFILE."
    info "To use it in this terminal, run: $PATH_HINT_LINE"
  else
    print_manual_path_hint "$1"
  fi
}

NODESOURCE_TMP_DIR=""
REGISTRY_TMP_DIR=""
SOURCE_WRAPPER_TMP=""
SOURCE_WRAPPER_EXPECTED_TMP=""
PACKAGE_WRAPPER_TMP=""
PACKAGE_SERVICE_REBOUND=1
UPDATE_LOCK_HELPER_TMP=""
INSTALL_UPDATE_LOCK_ID=""
INSTALL_UPDATE_HEARTBEAT_PID=""
SOURCE_CHECKOUT_TMP=""

cleanup_temp_files() {
  if [ -n "${NODESOURCE_TMP_DIR:-}" ] && [ -d "$NODESOURCE_TMP_DIR" ]; then
    rm -rf "$NODESOURCE_TMP_DIR"
  fi
  # A .env rewrite interrupted between its two steps.
  if [ -n "${ENV_TMP:-}" ] && [ -f "$ENV_TMP" ]; then
    rm -f "$ENV_TMP"
  fi
  if [ -n "${REGISTRY_TMP_DIR:-}" ] && [ -d "$REGISTRY_TMP_DIR" ]; then
    rm -rf "$REGISTRY_TMP_DIR"
  fi
  if [ -n "${SOURCE_WRAPPER_TMP:-}" ] && [ -f "$SOURCE_WRAPPER_TMP" ]; then
    rm -f "$SOURCE_WRAPPER_TMP"
  fi
  if [ -n "${SOURCE_WRAPPER_EXPECTED_TMP:-}" ] && [ -f "$SOURCE_WRAPPER_EXPECTED_TMP" ]; then
    rm -f "$SOURCE_WRAPPER_EXPECTED_TMP"
  fi
  if [ -n "${PACKAGE_WRAPPER_TMP:-}" ] && [ -f "$PACKAGE_WRAPPER_TMP" ]; then
    rm -f "$PACKAGE_WRAPPER_TMP"
  fi
  if [ -n "${UPDATE_LOCK_HELPER_TMP:-}" ] && [ -f "$UPDATE_LOCK_HELPER_TMP" ]; then
    rm -f "$UPDATE_LOCK_HELPER_TMP"
  fi
  if [ -n "${SOURCE_CHECKOUT_TMP:-}" ] && [ -d "$SOURCE_CHECKOUT_TMP" ]; then
    rm -rf "$SOURCE_CHECKOUT_TMP"
  fi
  if [ -n "${INSTALL_UPDATE_HEARTBEAT_PID:-}" ]; then
    kill "$INSTALL_UPDATE_HEARTBEAT_PID" >/dev/null 2>&1 || true
    wait "$INSTALL_UPDATE_HEARTBEAT_PID" 2>/dev/null || true
    INSTALL_UPDATE_HEARTBEAT_PID=""
  fi
  if [ -n "${INSTALL_UPDATE_LOCK_ID:-}" ] && [ -f "${UPDATE_LOCK_HELPER:-}" ]; then
    node "$UPDATE_LOCK_HELPER" release "$CONFIG_DIR" "$INSTALL_UPDATE_LOCK_ID" >/dev/null 2>&1 || true
    INSTALL_UPDATE_LOCK_ID=""
  fi
}

trap cleanup_temp_files 0
trap 'cleanup_temp_files; exit 130' HUP INT TERM

# ── Step 1: platform ─────────────────────────────────────────────────────────

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  case "$OS" in
    Darwin) PLATFORM=darwin ;;
    Linux)  PLATFORM=linux ;;
    *) fail "Unsupported OS: $OS. Omnesis supports macOS and Linux (Windows is community-driven, see the docs)." ;;
  esac
  case "$ARCH" in
    x86_64|amd64)  ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) fail "Unsupported architecture: $ARCH" ;;
  esac
  info "Detected $PLATFORM/$ARCH"
}

ensure_supported_linux_libc() {
  [ "$PLATFORM" = linux ] || return 0
  LIBC_REPORT="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
  case "$LIBC_REPORT" in
    "glibc "*) ;;
    *)
      LIBC_DETAIL="$(ldd --version 2>&1 || true)"
      case "$LIBC_DETAIL" in
        *musl*|*MUSL*|*Musl*) info "musl libc found"; return 0 ;;
        *) fail "Could not determine the host libc. Omnesis requires glibc 2.35 or newer on glibc-based Linux outside Docker." ;;
      esac
      ;;
  esac

  GLIBC_VERSION="${LIBC_REPORT#glibc }"
  case "$GLIBC_VERSION" in
    *.*) ;;
    *) fail "Could not read the host glibc version ($LIBC_REPORT). Omnesis requires glibc 2.35 or newer on Linux outside Docker." ;;
  esac
  GLIBC_MAJOR="${GLIBC_VERSION%%.*}"
  GLIBC_REST="${GLIBC_VERSION#*.}"
  GLIBC_MINOR="${GLIBC_REST%%.*}"
  case "$GLIBC_MAJOR" in
    ""|*[!0-9]*) fail "Could not read the host glibc version ($LIBC_REPORT). Omnesis requires glibc 2.35 or newer on Linux outside Docker." ;;
  esac
  case "$GLIBC_MINOR" in
    ""|*[!0-9]*) fail "Could not read the host glibc version ($LIBC_REPORT). Omnesis requires glibc 2.35 or newer on Linux outside Docker." ;;
  esac
  if [ "$GLIBC_MAJOR" -lt 2 ] || { [ "$GLIBC_MAJOR" -eq 2 ] && [ "$GLIBC_MINOR" -lt 35 ]; }; then
    fail "glibc $GLIBC_VERSION is too old. Omnesis requires glibc 2.35 or newer on Linux outside Docker; use Docker or upgrade the host OS."
  fi
  info "glibc $GLIBC_VERSION found"
}

# ── Step 2: prerequisites ────────────────────────────────────────────────────

resolve_sudo() {
  SUDO=""
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then SUDO="sudo"
    elif command -v doas >/dev/null 2>&1; then SUDO="doas"
    else return 1
    fi
  fi
  return 0
}

run_privileged() {
  if [ -z "$SUDO" ]; then
    "$@"
  elif [ "$NO_PROMPT" = 1 ]; then
    "$SUDO" -n "$@"
  else
    "$SUDO" "$@"
  fi
}

# Preserve unattended apt behavior through sudo/doas, which commonly strips
# caller environment variables. We intentionally do not set NEEDRESTART_MODE:
# its non-prompting `a` mode automatically restarts unrelated services.
apt_get() {
  run_privileged env DEBIAN_FRONTEND=noninteractive apt-get "$@"
}

configure_network_budget() {
  GIT_HTTP_LOW_SPEED_LIMIT="${GIT_HTTP_LOW_SPEED_LIMIT:-1}"
  GIT_HTTP_LOW_SPEED_TIME="${GIT_HTTP_LOW_SPEED_TIME:-$NETWORK_TIMEOUT_SECONDS}"
  NPM_CONFIG_FETCH_RETRIES="${NPM_CONFIG_FETCH_RETRIES:-3}"
  NPM_CONFIG_FETCH_TIMEOUT="${NPM_CONFIG_FETCH_TIMEOUT:-$((NETWORK_TIMEOUT_SECONDS * 1000))}"
  export GIT_HTTP_LOW_SPEED_LIMIT GIT_HTTP_LOW_SPEED_TIME
  export NPM_CONFIG_FETCH_RETRIES NPM_CONFIG_FETCH_TIMEOUT
}

# Fixed executable-script endpoints may not redirect. The protocol floor and
# retry/stall budget protect the transport; the caller still validates the
# response before execution.
download_https_script() {
  DOWNLOAD_URL="$1"
  DOWNLOAD_TARGET="$2"
  curl -fsS --max-redirs 0 --proto '=https' --tlsv1.2 \
    --connect-timeout "$NETWORK_TIMEOUT_SECONDS" \
    --speed-limit 1 --speed-time "$NETWORK_TIMEOUT_SECONDS" \
    --retry 3 --retry-delay 1 --retry-connrefused \
    -o "$DOWNLOAD_TARGET" "$DOWNLOAD_URL"
}

# A source install needs git for its checkout. Published packages do not.
ensure_git() {
  command -v git >/dev/null 2>&1 && return 0
  if [ "$PLATFORM" = darwin ]; then
    fail "git is required. Run 'xcode-select --install' (or 'brew install git') and re-run."
  fi
  resolve_sudo || fail "git is required. Install it for your distro and re-run."
  if command -v apt-get >/dev/null 2>&1; then
    info "Installing git (apt)..."
    set -x; apt_get update -qq; apt_get install -y -qq git; set +x
  elif command -v dnf >/dev/null 2>&1; then
    info "Installing git (dnf)..."
    set -x; run_privileged dnf install -y git; set +x
  else
    fail "git is required. Install it for your distro and re-run."
  fi
}

# Native SQLite modules compile on platforms without a matching prebuilt
# binary. Check the C/C++ compilers, make, and Python before npm creates a partial
# dependency tree, including executables on PATH that cannot actually run.
source_build_tools_ready() {
  command -v make >/dev/null 2>&1 && make --version >/dev/null 2>&1 &&
    command -v cc >/dev/null 2>&1 && cc --version >/dev/null 2>&1 &&
    command -v c++ >/dev/null 2>&1 && c++ --version >/dev/null 2>&1 &&
    command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1
}

ensure_source_build_tools() {
  [ "$PLATFORM" = linux ] || return 0
  source_build_tools_ready && return 0
  resolve_sudo || fail "A source build needs make, C/C++ compilers, and Python 3. Install your distro's build tools and re-run."
  if command -v apt-get >/dev/null 2>&1; then
    info "Installing source build tools (apt)..."
    apt_get update -qq && apt_get install -y -qq build-essential python3 || \
      fail "Could not install build-essential and Python 3. Install them for your distro and re-run."
  elif command -v dnf >/dev/null 2>&1; then
    info "Installing source build tools (dnf)..."
    run_privileged dnf install -y gcc-c++ make python3 || \
      fail "Could not install C/C++ compilers, make, and Python 3. Install them for your distro and re-run."
  else
    fail "A source build needs make, C/C++ compilers, and Python 3. Install them for your distro and re-run."
  fi
  source_build_tools_ready || fail "Source build tools are still unavailable after installation. Check make, cc, c++, and python3 on PATH, then re-run."
}

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# Homebrew puts itself on PATH from the login shell's profile, so a shell that
# never read that profile — a command run over SSH, a scheduled job — can miss
# a Homebrew that is installed and working. HOMEBREW_PREFIX (exported by
# `brew shellenv`) and Homebrew's standard prefixes find it anyway.
find_brew() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
    return 0
  fi
  for BREW_PREFIX_CANDIDATE in "${HOMEBREW_PREFIX:-}" /opt/homebrew /usr/local; do
    if [ -n "$BREW_PREFIX_CANDIDATE" ] && [ -x "$BREW_PREFIX_CANDIDATE/bin/brew" ]; then
      printf '%s\n' "$BREW_PREFIX_CANDIDATE/bin/brew"
      return 0
    fi
  done
  return 1
}

ensure_node() {
  if [ "$(node_major)" -ge 24 ]; then
    info "Node $(node --version) found"
    return
  fi

  if [ "$PLATFORM" = darwin ]; then
    BREW="$(find_brew)" || fail "Node >= 24 is required, and Homebrew was not found on PATH, in /opt/homebrew or in /usr/local. Install Node 24 from https://nodejs.org (or Homebrew from https://brew.sh) and re-run."
    # node@24 is keg-only: an installed one is not on PATH, so look in its
    # prefix before installing it again.
    NODE_PREFIX="$("$BREW" --prefix node@24)"
    if [ -x "$NODE_PREFIX/bin/node" ] &&
       [ "$("$NODE_PREFIX/bin/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 24 ]; then
      info "Using Homebrew's node@24 at $NODE_PREFIX"
    else
      info "Installing Node 24 via Homebrew..."
      "$BREW" install node@24
      NODE_PREFIX="$("$BREW" --prefix node@24)"
    fi
    # node@24 is keg-only. This script puts it on PATH for itself; the omnesis
    # launcher and the service units find it on their own afterwards.
    PATH="$NODE_PREFIX/bin:$PATH"
    export PATH
  else
    # Linux: NodeSource repo via the native package manager (needs sudo,
    # like the git prerequisite above).
    resolve_sudo || fail "Node >= 24 is required. Install it (e.g. https://github.com/nodesource/distributions) and re-run — no sudo/doas available to do it for you."
    if command -v apt-get >/dev/null 2>&1; then
      info "Installing Node 24 via NodeSource (apt)... commands shown as they run"
      run_nodesource_setup https://deb.nodesource.com/setup_24.x
      set -x; apt_get install -y nodejs; set +x
    elif command -v dnf >/dev/null 2>&1; then
      info "Installing Node 24 via NodeSource (dnf)... commands shown as they run"
      run_nodesource_setup https://rpm.nodesource.com/setup_24.x
      set -x; run_privileged dnf install -y nodejs; set +x
    else
      fail "Node >= 24 is required. Install it for your distro (https://nodejs.org) and re-run. (Immutable/declarative distros: add nodejs_24 to your system config.)"
    fi
  fi

  [ "$(node_major)" -ge 24 ] || fail "Node install did not produce Node >= 24 on PATH."
  info "Node $(node --version) ready"
}

verify_secure_nodesource_path() {
  PATH_TO_CHECK="$1"
  EXPECTED_MODE="$2"
  STAT_VALUE="$(stat -c '%u:%a' "$PATH_TO_CHECK" 2>/dev/null || true)"
  EXPECTED_VALUE="$(id -u):$EXPECTED_MODE"
  [ "$STAT_VALUE" = "$EXPECTED_VALUE" ] || fail "Unsafe NodeSource temp path permissions for $PATH_TO_CHECK (got $STAT_VALUE, expected $EXPECTED_VALUE)."
}

run_nodesource_setup() {
  NODESOURCE_URL="$1"
  TMP_PARENT="${TMPDIR:-/tmp}"
  NODESOURCE_TMP_DIR="$(mktemp -d "$TMP_PARENT/omnesis-nodesource.XXXXXX")" || fail "Could not create a private temporary directory for NodeSource setup."
  chmod 700 "$NODESOURCE_TMP_DIR"
  verify_secure_nodesource_path "$NODESOURCE_TMP_DIR" 700

  NODESOURCE_SETUP="$NODESOURCE_TMP_DIR/setup.sh"
  download_https_script "$NODESOURCE_URL" "$NODESOURCE_SETUP" || \
    fail "Could not download the NodeSource setup script from $NODESOURCE_URL. Check your network connection and retry."
  [ -s "$NODESOURCE_SETUP" ] || fail "NodeSource returned an empty setup script. Refusing to execute it."
  NODESOURCE_MAGIC="$(od -An -tx1 -N2 "$NODESOURCE_SETUP" | tr -d '[:space:]')"
  [ "$NODESOURCE_MAGIC" = 2321 ] || \
    fail "NodeSource returned content without a shell-script shebang. Refusing to execute it."
  chmod 600 "$NODESOURCE_SETUP"
  verify_secure_nodesource_path "$NODESOURCE_SETUP" 600

  set -x; run_privileged env DEBIAN_FRONTEND=noninteractive bash "$NODESOURCE_SETUP"; set +x
  cleanup_temp_files
}

# ── Step 3: install the CLI ──────────────────────────────────────────────────

# Total memory this machine will actually let a process use, in MiB. A
# container's cgroup ceiling is the real limit and can be far below what
# /proc/meminfo reports, so the smaller of the two wins. Empty when neither
# can be read.
usable_memory_mb() {
  # A test (or an operator on a machine that misreports itself) can state the
  # number outright rather than have this derive one.
  case "${OMNESIS_BUILD_MEMORY_MB:-}" in
    ''|*[!0-9]*) ;;
    *) printf '%s' "$OMNESIS_BUILD_MEMORY_MB"; return 0 ;;
  esac
  MEM_MB=""
  if [ "$PLATFORM" = darwin ]; then
    MEM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || true)"
    case "$MEM_BYTES" in ''|*[!0-9]*) ;; *) MEM_MB=$((MEM_BYTES / 1048576)) ;; esac
  else
    MEM_KB="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo 2>/dev/null || true)"
    case "$MEM_KB" in ''|*[!0-9]*) ;; *) MEM_MB=$((MEM_KB / 1024)) ;; esac
    for LIMIT_FILE in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
      [ -r "$LIMIT_FILE" ] || continue
      LIMIT_BYTES="$(cat "$LIMIT_FILE" 2>/dev/null || true)"
      case "$LIMIT_BYTES" in ''|*[!0-9]*) continue ;; esac
      LIMIT_MB=$((LIMIT_BYTES / 1048576))
      if [ "$LIMIT_MB" -gt 0 ] && { [ -z "$MEM_MB" ] || [ "$LIMIT_MB" -lt "$MEM_MB" ]; }; then
        MEM_MB="$LIMIT_MB"
      fi
    done
  fi
  printf '%s' "$MEM_MB"
}

# NODE_OPTIONS for the workspace build. Node sizes its old-space heap from the
# memory it believes it has and settles near 2 GB on a small or containerized
# host — not enough for `tsc --build` across every project reference, which
# then dies with a heap OOM on a machine that had memory to spare. Claim half
# of what this machine can really use instead, never less than the 3 GB the
# build needs to finish, and never override a value the operator set
# themselves.
#
# This is the shell copy of the policy the managed updater applies to its own
# builds (packages/cli/src/update/build-heap.ts); a test runs the arithmetic
# of both against the same table, so a change to one has to be made to the
# other.
build_node_options() {
  case "${NODE_OPTIONS:-}" in
    *max-old-space-size*) printf '%s' "$NODE_OPTIONS"; return 0 ;;
  esac
  BUILD_MEM_MB="$(usable_memory_mb)"
  case "$BUILD_MEM_MB" in ''|*[!0-9]*) printf '%s' "${NODE_OPTIONS:-}"; return 0 ;; esac
  BUILD_HEAP_MB=$((BUILD_MEM_MB / 2))
  [ "$BUILD_HEAP_MB" -le 8192 ] || BUILD_HEAP_MB=8192
  # The build does not finish with less, so a smaller machine still gets this
  # much and lets the OS page; require_source_build_memory refuses a machine
  # too small even for that before anything is installed.
  [ "$BUILD_HEAP_MB" -ge 3072 ] || BUILD_HEAP_MB=3072
  printf '%s' "${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$BUILD_HEAP_MB"
}

# A source step the kernel killed exits 137 — 128 plus SIGKILL — and leaves no
# error of its own above: on a machine this small, almost always for want of
# memory. $1 is the step's exit status, $2 names the step, $3 is the message
# for any other failure.
source_step_failed() {
  [ "$1" != 137 ] || fail "$2 was killed, most likely because this machine ran out of memory. Stop the Omnesis collector and gateway if they run here, add swap or free memory, then re-run this installer; it continues from the checkout it already made."
  fail "$3"
}

# A source install builds the whole workspace on this machine, and that build
# needs a 3 GB heap. Refuse a machine that cannot hold it before Node, git or a
# checkout are installed, instead of failing minutes into the build with a heap
# trace. OMNESIS_BUILD_MEMORY_MB states the memory outright, for a machine with
# swap to spare or one that misreports itself.
require_source_build_memory() {
  SOURCE_BUILD_MEMORY_MB="$(usable_memory_mb)"
  case "$SOURCE_BUILD_MEMORY_MB" in ''|*[!0-9]*) return 0 ;; esac
  [ "$SOURCE_BUILD_MEMORY_MB" -lt 3584 ] || return 0
  fail "Building Omnesis from source needs about 3.5 GB of memory, and this machine can use ${SOURCE_BUILD_MEMORY_MB} MB. Install on a machine with more memory, or, if this one has swap to spare, re-run with OMNESIS_BUILD_MEMORY_MB=4096 to build anyway."
}


npm_flags() {
  # shellcheck disable=SC2086
  [ -n "$REGISTRY" ] && printf -- '--registry %s' "$REGISTRY" || true
}

registry_has_package() {
  # A probe, not an install: a registry that does not serve the CLI, or that
  # cannot be reached at all, must answer "no" quickly rather than stall the
  # installer, so retries are off and the timeout is short.
  # shellcheck disable=SC2046
  if ! PACKAGE_EXPECTED_VERSION="$(npm view "$CLI_PKG@$(dist_tag)" version \
    --fetch-retries 0 --fetch-timeout 10000 $(npm_flags) 2>/dev/null)"; then
    PACKAGE_EXPECTED_VERSION=""
    return 1
  fi
  [ -n "$PACKAGE_EXPECTED_VERSION" ]
}

dist_tag() {
  if [ -n "$PIN_VERSION" ]; then printf '%s' "$PIN_VERSION"
  elif [ "$CHANNEL" = beta ]; then printf 'beta'
  else printf 'latest'; fi
}

# Split in two on purpose. The flag combinations are rejected before anything
# is installed, so a typo costs nothing; the registry probe needs npm, so it
# runs after Node is in place.
validate_method() {
  # Edge always names the source main branch. Normalize before validation and
  # planning so `auto` cannot make package-only selectors look meaningful.
  if [ "$METHOD" = auto ] && { [ "$EDGE" = 1 ] || [ -n "$PIN_COMMIT" ]; }; then METHOD=source; fi
  case "$CHANNEL" in stable|beta) ;; *) fail "Unknown --channel: $CHANNEL (expected stable|beta)" ;; esac
  if [ -n "$PIN_VERSION" ]; then
    printf '%s\n' "$PIN_VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || \
      fail "Invalid --version '$PIN_VERSION' (expected X.Y.Z)."
  fi
  if [ -n "$PIN_COMMIT" ]; then
    case "$PIN_COMMIT" in
      *[!0-9a-f]*) fail "Invalid --commit '$PIN_COMMIT' (expected a full 40-character lowercase commit id)." ;;
    esac
    [ "${#PIN_COMMIT}" -eq 40 ] || \
      fail "Invalid --commit '$PIN_COMMIT' (expected a full 40-character lowercase commit id)."
  fi
  [ "$EDGE" = 0 ] || [ -z "$PIN_VERSION" ] || \
    fail "--edge and --version cannot be used together."
  [ -z "$PIN_COMMIT" ] || { [ "$EDGE" = 0 ] && [ -z "$PIN_VERSION" ]; } || \
    fail "--commit cannot be used with --edge or --version."
  [ "$REPLACE_SOURCE_WRAPPER" = 0 ] || [ "$METHOD" != source ] || \
    fail "--replace-source-wrapper needs a package install. Use --method package, or use --method auto without --edge."
  case "$METHOD" in
    auto) ;;
    source)
      # A dist-tag and a registry select a published package. A source install
      # resolves releases from git instead, so honoring the flag is impossible
      # and ignoring it would install something other than what was asked for.
      [ "$CHANNEL" = stable ] || \
        fail "--channel $CHANNEL selects an npm dist-tag and needs --method package. A source install has no channel; use --edge to follow the main branch."
      [ -z "$REGISTRY" ] || \
        fail "--registry selects an npm registry and needs --method package. A source install resolves releases from the git repository."
      ;;
    package)
      [ -z "$PIN_COMMIT" ] || fail "--commit is source-only; use --method source."
      if [ "$EDGE" = 1 ]; then
        fail "--edge follows the main branch and is source-only. Drop --method package or drop --edge."
      fi
      ;;
    *) fail "Unknown --method: $METHOD (expected auto|package|source)" ;;
  esac
}

resolve_method() {
  [ "$METHOD" = auto ] || return 0

  # One probe, one decision. Asking twice would let a transient failure between
  # the two answers turn the beta refusal below into a silent stable fallback.
  if registry_has_package; then HAS_PACKAGE=1; else HAS_PACKAGE=0; fi

  if [ "$HAS_PACKAGE" = 1 ]; then
    info "Registry serves $CLI_PKG@$(dist_tag) — installing the package."
    METHOD=package
  elif [ "$CHANNEL" = beta ]; then
    # A source checkout has no beta, so falling back would quietly install the
    # newest stable release under a flag that asked for a prerelease.
    fail "No published $CLI_PKG@beta on the registry, and a source install has no beta channel. Use --edge to follow the main branch."
  else
    info "No published $CLI_PKG@$(dist_tag) — installing from the tagged source instead."
    METHOD=source
  fi
}

ensure_writable_prefix() {
  # Keep the install root-free: if the global prefix isn't writable, use
  # ~/.npm-global for our packages.
  PREFIX_DIR="$(npm prefix -g 2>/dev/null || echo /usr/local)"
  package_prefix_layout_is_safe "$PREFIX_DIR" || \
    fail "npm global prefix $PREFIX_DIR contains a symlink or non-directory package path; refusing to write through it."
  if ! package_prefix_directories_are_writable "$PREFIX_DIR"; then
    NPM_CONFIG_PREFIX="$HOME/.npm-global"
    export NPM_CONFIG_PREFIX
    mkdir -p "$NPM_CONFIG_PREFIX"
    package_prefix_layout_is_safe "$NPM_CONFIG_PREFIX" || \
      fail "Fallback npm prefix $NPM_CONFIG_PREFIX contains a symlink or non-directory package path."
    warn "npm global prefix $PREFIX_DIR is not writable — installing under $NPM_CONFIG_PREFIX instead (no sudo)."
  fi
}

package_prefix_layout_is_safe() {
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const prefix = process.argv[1];
try {
  const root = fs.lstatSync(prefix);
  if (!root.isDirectory() || root.isSymbolicLink()) process.exit(1);
  for (const relative of ["bin", "lib", "lib/node_modules", "lib/node_modules/omnesis"]) {
    const candidate = path.join(prefix, relative);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) process.exit(1);
    } catch (error) {
      if (error?.code !== "ENOENT") process.exit(1);
    }
  }
} catch { process.exit(1); }
' "$1"
}

package_prefix_directories_are_writable() {
  node -e '
const fs = require("node:fs");
const path = require("node:path");
try {
  for (const relative of ["", "bin", "lib", "lib/node_modules", "lib/node_modules/omnesis"]) {
    const candidate = path.join(process.argv[1], relative);
    try { fs.accessSync(candidate, fs.constants.W_OK | fs.constants.X_OK); }
    catch (error) { if (error?.code === "ENOENT") continue; process.exit(1); }
  }
} catch { process.exit(1); }
' "$1"
}

same_path_entry() {
  node -e '
const fs = require("node:fs");
const path = require("node:path");
function canonical(candidate) {
  const absolute = path.resolve(candidate);
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), path.relative(existing, absolute));
}
process.exit(canonical(process.argv[1]) === canonical(process.argv[2]) ? 0 : 1);
' "$1" "$2"
}

package_entry_owned_by_prefix() {
  node -e '
const fs = require("node:fs");
const path = require("node:path");
try {
  const lexicalRoot = path.join(process.argv[2], "lib", "node_modules", "omnesis");
  const rootStat = fs.lstatSync(lexicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) process.exit(1);
  const lexicalModulesRoot = path.dirname(lexicalRoot);
  const modulesStat = fs.lstatSync(lexicalModulesRoot);
  if (!modulesStat.isDirectory() || modulesStat.isSymbolicLink()) process.exit(1);
  const canonicalPrefix = fs.realpathSync(process.argv[2]);
  const modulesRoot = fs.realpathSync(lexicalModulesRoot);
  if (modulesRoot !== path.join(canonicalPrefix, "lib", "node_modules")) process.exit(1);
  const packageRoot = fs.realpathSync(lexicalRoot);
  if (packageRoot !== path.join(modulesRoot, process.argv[3])) process.exit(1);
  const executable = fs.realpathSync(process.argv[1]);
  const relative = path.relative(packageRoot, executable);
  process.exit(relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? 0 : 1);
} catch { process.exit(1); }
' "$1" "$2" "$CLI_PKG"
}

package_wrapper_prefix() {
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const candidate = process.argv[1];
const sq = String.fromCharCode(39);
const escapedSq = sq + "\"" + sq + "\"" + sq;
const quote = (value) => sq + value.replaceAll(sq, escapedSq) + sq;
const unquote = (value) => {
  if (!value.startsWith(sq) || !value.endsWith(sq)) return null;
  return value.slice(1, -1).split(escapedSq).join(sq);
};
try {
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) process.exit(1);
  const content = fs.readFileSync(candidate, "utf8");
  const lines = content.split("\n");
  if (lines.length !== 5 || lines[0] !== "#!/bin/sh" || lines[2] !== "export NPM_CONFIG_PREFIX" || lines[4] !== "") process.exit(1);
  const prefixKey = "NPM_CONFIG_PREFIX=";
  const execKey = "exec ";
  if (!lines[1].startsWith(prefixKey) || !lines[3].startsWith(execKey) || !lines[3].endsWith(" \"$@\"")) process.exit(1);
  const prefix = unquote(lines[1].slice(prefixKey.length));
  const binary = unquote(lines[3].slice(execKey.length, -5));
  if (!prefix || !path.isAbsolute(prefix) || binary !== path.join(prefix, "bin", "omnesis")) process.exit(1);
  const expected = `#!/bin/sh\nNPM_CONFIG_PREFIX=${quote(prefix)}\nexport NPM_CONFIG_PREFIX\nexec ${quote(binary)} \"$@\"\n`;
  if (content !== expected) process.exit(1);
  process.stdout.write(prefix);
} catch { process.exit(1); }
' "$1"
}

install_package() {
  ensure_writable_prefix
  PACKAGE_PREFIX="$(npm prefix -g)"
  PACKAGE_BIN_DIR="$PACKAGE_PREFIX/bin"
  SOURCE_WRAPPER="$HOME/.local/bin/omnesis"
  PACKAGE_PREFIX_COLLISION=0
  PACKAGE_ENTRY_MANAGED=0
  PACKAGE_WRAPPER_MANAGED=0
  SOURCE_WRAPPER_PRESENT=0
  if [ -e "$SOURCE_WRAPPER" ] || [ -L "$SOURCE_WRAPPER" ]; then SOURCE_WRAPPER_PRESENT=1; fi
  if [ "$SOURCE_WRAPPER_PRESENT" = 1 ] &&
     EXISTING_PACKAGE_PREFIX="$(package_wrapper_prefix "$SOURCE_WRAPPER")" &&
     package_entry_owned_by_prefix "$EXISTING_PACKAGE_PREFIX/bin/omnesis" "$EXISTING_PACKAGE_PREFIX"; then
    NPM_CONFIG_PREFIX="$EXISTING_PACKAGE_PREFIX"
    export NPM_CONFIG_PREFIX
    PACKAGE_PREFIX="$(npm prefix -g)"
    PACKAGE_BIN_DIR="$PACKAGE_PREFIX/bin"
    PACKAGE_WRAPPER_MANAGED=1
  fi
  if same_path_entry "$PACKAGE_BIN_DIR/omnesis" "$SOURCE_WRAPPER"; then
    if package_entry_owned_by_prefix "$SOURCE_WRAPPER" "$PACKAGE_PREFIX"; then
      PACKAGE_ENTRY_MANAGED=1
    else
      PACKAGE_PREFIX_COLLISION=1
      NPM_CONFIG_PREFIX="$HOME/.npm-global"
      export NPM_CONFIG_PREFIX
      mkdir -p "$NPM_CONFIG_PREFIX"
      PACKAGE_PREFIX="$(npm prefix -g)"
      PACKAGE_BIN_DIR="$PACKAGE_PREFIX/bin"
      ! same_path_entry "$PACKAGE_BIN_DIR/omnesis" "$SOURCE_WRAPPER" || \
        fail "The npm package prefix would overwrite $SOURCE_WRAPPER before it can be verified. Choose a different npm prefix and retry."
      warn "npm global prefix shares the reserved source-launcher path — installing under $PACKAGE_PREFIX so that path can be activated without clobbering it."
    fi
  fi
  package_prefix_layout_is_safe "$PACKAGE_PREFIX" || \
    fail "npm package prefix $PACKAGE_PREFIX contains a symlink or non-directory package path; refusing to install."
  package_prefix_directories_are_writable "$PACKAGE_PREFIX" || \
    fail "npm package prefix $PACKAGE_PREFIX has a package directory that is not writable without root."
  SOURCE_WRAPPER_OWNED=0
  SOURCE_WRAPPER_UNSAFE=0
  if [ "$PACKAGE_ENTRY_MANAGED" = 0 ] && [ "$PACKAGE_WRAPPER_MANAGED" = 0 ] && { [ -e "$SOURCE_WRAPPER" ] || [ -L "$SOURCE_WRAPPER" ]; }; then
    if source_wrapper_is_installer_owned; then
      SOURCE_WRAPPER_OWNED=1
      warn "A verified source-install launcher is still at $SOURCE_WRAPPER and may shadow this package install."
    else
      SOURCE_WRAPPER_UNSAFE=1
    fi
  fi
  SPEC="$CLI_PKG@$(dist_tag)"
  if [ -z "${PACKAGE_EXPECTED_VERSION:-}" ]; then
    registry_has_package || fail "Could not resolve the version of $SPEC from the package registry. Check the registry, credentials, and network connection."
  fi
  info "Installing $SPEC globally (native modules fetch their own prebuilds here)..."
  # shellcheck disable=SC2046
  npm install -g "$SPEC" $(npm_flags)
  OMNESIS_BIN="$PACKAGE_BIN_DIR/omnesis"
  [ -x "$OMNESIS_BIN" ] || fail "npm install succeeded but its direct omnesis binary is missing at $OMNESIS_BIN."
  package_entry_owned_by_prefix "$OMNESIS_BIN" "$PACKAGE_PREFIX" || \
    fail "npm install did not produce a package executable owned by $PACKAGE_PREFIX. The source launcher was left unchanged."
  PACKAGE_INSTALLED_VERSION="$("$OMNESIS_BIN" --version 2>/dev/null || true)"
  [ "$PACKAGE_INSTALLED_VERSION" = "$PACKAGE_EXPECTED_VERSION" ] || \
    fail "The package registry resolved $PACKAGE_EXPECTED_VERSION, but $OMNESIS_BIN reports ${PACKAGE_INSTALLED_VERSION:-(no version)}. The source launcher was left unchanged."
  if [ "$SOURCE_WRAPPER_UNSAFE" = 1 ] && installed_package_wrapper_is_owned; then
    SOURCE_WRAPPER_UNSAFE=0
    PACKAGE_WRAPPER_MANAGED=1
  elif [ "$SOURCE_WRAPPER_UNSAFE" = 1 ]; then
    warn "$SOURCE_WRAPPER exists but is not the exact installer-owned launcher recorded by $CONFIG_DIR/update-state.json or this package prefix. It will not be replaced."
  fi
  if [ "$SOURCE_WRAPPER_PRESENT" = 0 ]; then
    write_new_package_wrapper || \
      fail "Could not create the package launcher at $SOURCE_WRAPPER without overwriting another path."
    PACKAGE_WRAPPER_MANAGED=1
  fi
  if [ "$PACKAGE_ENTRY_MANAGED" = 1 ] || [ "$PACKAGE_WRAPPER_MANAGED" = 1 ]; then
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) ;;
      *)
        PATH_HINT_DIR="$HOME/.local/bin"
        PATH="$HOME/.local/bin:$PATH"
        export PATH
        ;;
    esac
  else
    case ":$PATH:" in
      *":$PACKAGE_BIN_DIR:"*) ;;
      *) warn "$PACKAGE_BIN_DIR is not on your PATH — add it to your shell profile." ;;
    esac
  fi
}

# Atomically record the source checkout's apply transaction. The updater reads
# the same compact JSON file; keeping this in the config dir lets the stable
# launcher inspect it even when npm ci has removed the checkout's node_modules.
write_source_update_state() {
  SOURCE_STATE_PHASE="$1"
  SOURCE_STATE_ROOT="$2"
  SOURCE_STATE_COMMIT="$3"
  SOURCE_STATE_LAST="${4:-}"
  node -e '
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [configDir, phase, rootDir, commit, lastCompletedCommit] = process.argv.slice(1);
const exactCommit = /^[0-9a-f]{40}$/;
if (!["complete", "applying", "rolling-back"].includes(phase) || !exactCommit.test(commit) || (phase !== "complete" && !exactCommit.test(lastCompletedCommit))) process.exit(1);
const state = phase === "complete"
  ? { version: 1, method: "source", rootDir, phase, commit }
  : { version: 1, method: "source", rootDir, phase, targetCommit: commit, lastCompletedCommit };
const target = path.join(configDir, "update-state.json");
const scratch = path.join(configDir, `.update-state.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
fs.mkdirSync(configDir, { recursive: true });
let fd;
try {
  fd = fs.openSync(scratch, "wx", 0o600);
  fs.fchmodSync(fd, 0o600);
  fs.writeFileSync(fd, `${JSON.stringify(state)}\n`);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = undefined;
  fs.renameSync(scratch, target);
  try {
    const dirFd = fs.openSync(configDir, "r");
    try { try { fs.fsyncSync(dirFd); } catch {} } finally { fs.closeSync(dirFd); }
  } catch {}
} catch (error) {
  if (fd !== undefined) fs.closeSync(fd);
  try { fs.unlinkSync(scratch); } catch {}
  throw error;
}
' "$CONFIG_DIR" "$SOURCE_STATE_PHASE" "$SOURCE_STATE_ROOT" "$SOURCE_STATE_COMMIT" "$SOURCE_STATE_LAST" || fail "Could not durably record the source update state."
}

# Prefer the durable last-known-good build over HEAD after an interrupted
# apply. Invalid, foreign, or absent state proves nothing and falls back to the
# checkout's current commit, which is the best baseline legacy installs have.
source_last_completed_commit() {
  node -e '
const fs = require("node:fs");
const [path, rootDir, fallback] = process.argv.slice(1);
let commit = fallback;
try {
  const state = JSON.parse(fs.readFileSync(path, "utf8"));
  if (state?.version === 1 && state?.method === "source" && state?.rootDir === rootDir) {
    const candidate = state.phase === "complete"
      ? state.commit
      : ["applying", "rolling-back"].includes(state.phase)
        ? state.lastCompletedCommit
        : null;
    if (/^[0-9a-f]{40}$/.test(candidate)) commit = candidate;
  }
} catch {}
process.stdout.write(commit);
' "$CONFIG_DIR/update-state.json" "$1" "$2"
}

# The product version the source checkout records at one commit, or nothing
# when that commit's CLI manifest cannot be read.
source_version_at() {
  git -C "$SOURCE_DIR" show "$1:packages/cli/package.json" 2>/dev/null | node -e '
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const version = JSON.parse(input).version;
    if (typeof version === "string") process.stdout.write(version);
  } catch {}
});
' || true
}

# Succeeds when product version $1 is newer than $2, by the rule `omnesis
# update` applies: an optional leading "v" and pre-release suffix are accepted,
# the suffix does not change the order, and an unreadable version is never newer.
version_is_newer() {
  node -e '
const parse = (value) => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?$/.exec(
    value.trim().replace(/^v/, ""),
  );
  return match ? match.slice(1, 4).map(Number) : null;
};
const [left, right] = process.argv.slice(1).map(parse);
if (!left || !right) process.exit(1);
for (let i = 0; i < 3; i++) {
  if (left[i] !== right[i]) process.exit(left[i] > right[i] ? 0 : 1);
}
process.exit(1);
' -- "$1" "$2"
}

shell_single_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\"'\"'/g"
  printf "'"
}

write_source_update_lock_helper() {
  LOCK_LIB_DIR="$HOME/.local/lib/omnesis"
  mkdir -p "$LOCK_LIB_DIR"
  UPDATE_LOCK_HELPER="$LOCK_LIB_DIR/update-lock.cjs"
  UPDATE_LOCK_HELPER_TMP="$(mktemp "$LOCK_LIB_DIR/.update-lock.XXXXXX")" || fail "Could not create the update lock helper."
  chmod 600 "$UPDATE_LOCK_HELPER_TMP"
  cat > "$UPDATE_LOCK_HELPER_TMP" <<'EOF'
#!/usr/bin/env node
"use strict";
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [command, configDir, value, pidArg, waitArg] = process.argv.slice(2);
const lockDir = path.join(configDir || "", "update.lock");
const ownerPath = path.join(lockDir, "owner.json");
const claimPrefix = ".claim-";
const staleMs = 30000;
function processStart(pid) {
  if (process.platform === "darwin") {
    try { return childProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim(); }
    catch { return null; }
  }
  if (process.platform !== "linux") return null;
  try {
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    const start = stat.slice(close + 2).split(" ")[19];
    return bootId && start ? bootId + ":" + start : null;
  } catch { return null; }
}
function readOwner() {
  try {
    if (!fs.lstatSync(ownerPath).isFile()) return null;
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.version !== 1 || typeof owner.id !== "string" || typeof owner.owner !== "string" ||
        !Number.isInteger(owner.pid) || (typeof owner.processStart !== "string" && owner.processStart !== null) ||
        typeof owner.startedAt !== "string" || typeof owner.updatedAt !== "string" ||
        typeof owner.currentStep !== "string" ||
        (owner.processGroupPid !== undefined &&
          (!Number.isInteger(owner.processGroupPid) || owner.processGroupPid <= 0 ||
            (typeof owner.processGroupStart !== "string" && owner.processGroupStart !== null))) ||
        (owner.processGroupPid === undefined && owner.processGroupStart !== undefined) ||
        (owner.returnTo !== undefined && !validReturnOwner(owner.returnTo))) return null;
    return owner;
  } catch { return null; }
}
function validReturnOwner(owner) {
  return owner && typeof owner === "object" && typeof owner.id === "string" &&
    typeof owner.owner === "string" && Number.isInteger(owner.pid) &&
    (typeof owner.processStart === "string" || owner.processStart === null) &&
    typeof owner.startedAt === "string";
}
function alive(owner) {
  try { process.kill(owner.pid, 0); } catch (error) { if (error?.code !== "EPERM") return false; }
  return owner.processStart === null || processStart(owner.pid) === owner.processStart;
}
function groupAlive(owner) {
  if (!Number.isInteger(owner.processGroupPid) || process.platform === "win32") return false;
  try { process.kill(-owner.processGroupPid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}
function replaceJson(target, value) {
  const scratch = target + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(scratch, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(scratch, target);
  } catch (error) {
    try { fs.unlinkSync(scratch); } catch {}
    throw error;
  }
}
function readClaim(target) {
  try {
    const claim = JSON.parse(fs.readFileSync(target, "utf8"));
    if (claim.version !== 1 || !["choosing", "waiting"].includes(claim.state) ||
        !Number.isSafeInteger(claim.ticket) || claim.ticket < 0 || !Number.isInteger(claim.pid) ||
        (typeof claim.processStart !== "string" && claim.processStart !== null)) return null;
    return claim;
  } catch { return null; }
}
function claimGuard() {
  const name = claimPrefix + crypto.randomUUID();
  const claim = path.join(lockDir, name);
  const identity = { version: 1, state: "choosing", ticket: 0,
    pid: process.pid, processStart: processStart(process.pid) };
  try { fs.writeFileSync(claim, JSON.stringify(identity) + "\n", { flag: "wx", mode: 0o600 }); }
  catch { return null; }
  let ticket = 1;
  try {
    const contenders = fs.readdirSync(lockDir).filter((entry) => entry.startsWith(claimPrefix));
    for (const entry of contenders) {
      if (entry === name) continue;
      discardStaleClaim(path.join(lockDir, entry));
      const other = readClaim(path.join(lockDir, entry));
      if (other?.state === "waiting") ticket = Math.max(ticket, other.ticket + 1);
    }
    identity.state = "waiting";
    identity.ticket = ticket;
    replaceJson(claim, identity);
  } catch { releaseGuard(claim); return null; }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    let contenders;
    try {
      contenders = fs.readdirSync(lockDir).filter((entry) => entry.startsWith(claimPrefix));
      for (const entry of contenders) {
        if (entry === name) continue;
        discardStaleClaim(path.join(lockDir, entry));
      }
      contenders = fs.readdirSync(lockDir).filter((entry) => entry.startsWith(claimPrefix));
    }
    catch { releaseGuard(claim); return null; }
    if (!contenders.includes(name)) { releaseGuard(claim); return null; }
    let blocked = false;
    for (const entry of contenders) {
      if (entry === name) continue;
      const other = readClaim(path.join(lockDir, entry));
      if (!other || other.state === "choosing" || other.ticket < ticket ||
          (other.ticket === ticket && entry < name)) { blocked = true; break; }
    }
    if (!blocked) return claim;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
  releaseGuard(claim);
  return null;
}
function discardStaleClaim(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile()) return;
    const age = Date.now() - stat.mtimeMs;
    if (age < staleMs) return;
    try {
      const holder = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (alive(holder)) return;
    } catch {}
    fs.unlinkSync(candidate);
  } catch {}
}
function releaseGuard(claim) { try { fs.unlinkSync(claim); } catch {} }
function retire(expectedId, requireStale = false, observedUpdated = Number.POSITIVE_INFINITY) {
  const claim = claimGuard();
  if (!claim) return expectedId && readOwner()?.id !== expectedId ? "not-owner" : "busy";
  const owner = readOwner();
  if (expectedId && owner?.id !== expectedId) { releaseGuard(claim); return "not-owner"; }
  const updated = owner ? Date.parse(owner.updatedAt) : observedUpdated;
  const age = Date.now() - updated;
  if (requireStale && ((Number.isFinite(updated) && age < staleMs) || (owner && (alive(owner) || groupAlive(owner))))) {
    releaseGuard(claim);
    return "busy";
  }
  const retired = lockDir + ".retired-" + process.pid + "-" + crypto.randomUUID();
  try {
    if (!fs.lstatSync(lockDir).isDirectory()) {
      releaseGuard(claim);
      return expectedId && readOwner()?.id !== expectedId ? "not-owner" : "busy";
    }
    fs.renameSync(lockDir, retired);
  } catch {
    releaseGuard(claim);
    return expectedId && readOwner()?.id !== expectedId ? "not-owner" : "busy";
  }
  fs.rmSync(retired, { recursive: true, force: true });
  return "retired";
}
if (command === "adopt") {
  if (!configDir || typeof value !== "string" || !value || !/^\d+$/.test(pidArg || "")) process.exit(64);
  const claim = claimGuard();
  if (!claim) process.exit(73);
  try {
    const owner = readOwner();
    if (!owner || owner.id !== value) {
      process.stderr.write("The update lock hand-off is no longer valid; start the update again.\n");
      process.exitCode = 73;
    } else {
      const pid = Number(pidArg);
      owner.returnTo = owner.returnTo || { id: owner.id, owner: owner.owner, pid: owner.pid,
        processStart: owner.processStart, startedAt: owner.startedAt };
      owner.id = crypto.randomUUID();
      owner.owner = "source update recovery";
      owner.pid = pid;
      owner.processStart = processStart(pid);
      owner.updatedAt = new Date().toISOString();
      owner.currentStep = "restoring source dependencies";
      replaceJson(ownerPath, owner);
      process.stdout.write(owner.id);
    }
  } finally { releaseGuard(claim); }
  process.exit(process.exitCode || 0);
}
if (command === "heartbeat" || command === "heartbeat-loop") {
  function heartbeat() {
    const claim = claimGuard();
    if (!claim) return 73;
    try {
      const owner = readOwner();
      if (!owner || owner.id !== value || (command === "heartbeat-loop" && !alive(owner))) return 73;
      owner.updatedAt = new Date().toISOString();
      replaceJson(ownerPath, owner);
      return 0;
    } finally { releaseGuard(claim); }
  }
  if (command === "heartbeat") process.exit(heartbeat());
  // One owned process holds the timer, so stopping it cannot strand a sleeping
  // grandchild with the installer's output pipes open. Handle shutdown between
  // ticks, after the synchronous claim's finally block has released its guard.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => process.exit(0));
  setInterval(() => {
    const status = heartbeat();
    if (status !== 0) process.exit(status);
  }, 5000);
  return;
}
if (command === "release") {
  if (typeof value !== "string" || !value) process.exit(64);
  process.exit(retire(value) === "busy" ? 73 : 0);
}
if (command !== "acquire" || !configDir || !value || !/^\d+$/.test(pidArg || "") ||
    (waitArg !== undefined && !/^\d+$/.test(waitArg))) process.exit(64);
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
function tryAcquire() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created = false;
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      created = true;
      const now = new Date().toISOString();
      const pid = Number(pidArg);
      const owner = { version: 1, id: crypto.randomUUID(), owner: value, pid,
        processStart: processStart(pid), startedAt: now, updatedAt: now, currentStep: value };
      replaceJson(ownerPath, owner);
      process.stdout.write(owner.id);
      process.exit(0);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (created) retire();
        throw error;
      }
      const owner = readOwner();
      let updated = Number.POSITIVE_INFINITY;
      try { updated = owner ? Date.parse(owner.updatedAt) : fs.lstatSync(lockDir).mtimeMs; } catch {}
      const age = Date.now() - updated;
      if ((Number.isFinite(updated) && age < staleMs) || (owner && (alive(owner) || groupAlive(owner)))) {
        return { owner, exhausted: false };
      }
      if (retire(owner?.id, true, updated) !== "retired") continue;
    }
  }
  return { owner: null, exhausted: true };
}
// A wait polls until the holder releases the lock or is proven dead by the
// stale-lock rules above, and gives up once the requested minutes have passed.
const waitMinutes = Number(waitArg || 0);
const waitUntil = Date.now() + waitMinutes * 60000;
let waiting = false;
for (;;) {
  const busy = tryAcquire();
  const holder = busy.owner ? busy.owner.owner + " (PID " + busy.owner.pid + ")" : "another update";
  const detail = busy.owner
    ? holder + ", started " + busy.owner.startedAt + ", currently " + busy.owner.currentStep
    : "another update";
  if (Date.now() >= waitUntil) {
    if (waiting) {
      process.stderr.write("Another Omnesis update was still running on this host after waiting " +
        waitMinutes + " minute" + (waitMinutes === 1 ? "" : "s") + ": " + detail + ".\n");
    } else if (busy.exhausted) {
      process.stderr.write("Another Omnesis update holds this host lock.\n");
    } else {
      process.stderr.write("Another Omnesis update is running on this host: " + detail + ".\n");
    }
    process.exit(73);
  }
  if (!waiting) {
    waiting = true;
    process.stderr.write("Waiting for " + holder + " to finish...\n");
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.min(2000, waitUntil - Date.now())));
}
EOF
  chmod 755 "$UPDATE_LOCK_HELPER_TMP"
  node -e '
const fs = require("node:fs");
const [scratch, target, dir] = process.argv.slice(1);
const fd = fs.openSync(scratch, "r");
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.renameSync(scratch, target);
try {
  const dirFd = fs.openSync(dir, "r");
  try { try { fs.fsyncSync(dirFd); } catch {} } finally { fs.closeSync(dirFd); }
} catch {}
' "$UPDATE_LOCK_HELPER_TMP" "$UPDATE_LOCK_HELPER" "$LOCK_LIB_DIR" || fail "Could not atomically install the update lock helper."
  UPDATE_LOCK_HELPER_TMP=""
}

# Render the stable source front door. Keeping the renderer separate lets a
# package migration compare an existing launcher byte-for-byte before it
# replaces anything at the same path.
render_source_wrapper() {
  SOURCE_ROOT="$1"
  SOURCE_ROOT_LITERAL="$(shell_single_quote "$SOURCE_ROOT")"
  CONFIG_DIR_LITERAL="$(shell_single_quote "$CONFIG_DIR")"
  UPDATE_LOCK_HELPER_LITERAL="$(shell_single_quote "$UPDATE_LOCK_HELPER")"
  cat <<EOF
#!/bin/sh
SOURCE_ROOT=$SOURCE_ROOT_LITERAL
DEFAULT_CONFIG_DIR=$CONFIG_DIR_LITERAL
UPDATE_LOCK_HELPER=$UPDATE_LOCK_HELPER_LITERAL
# Homebrew installs node@24 keg-only. When the caller's PATH has no Node 24 or
# newer, run that keg instead.
case "\$(node --version 2>/dev/null)" in
  v2[4-9].*|v[3-9][0-9].*|v[1-9][0-9][0-9].*) ;;
  *)
    for HOMEBREW_NODE_PREFIX in "\${HOMEBREW_PREFIX:-}" /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew; do
      if [ -n "\$HOMEBREW_NODE_PREFIX" ] && [ -x "\$HOMEBREW_NODE_PREFIX/opt/node@24/bin/node" ]; then
        PATH="\$HOMEBREW_NODE_PREFIX/opt/node@24/bin:\$PATH"
        export PATH
        break
      fi
    done
    ;;
esac
RUNTIME_CONFIG_DIR="\${OMNESIS_CONFIG_DIR:-\$DEFAULT_CONFIG_DIR}"
UPDATE_LOCK_ACQUIRED=0
UPDATE_LOCK_HANDOFF=0
UPDATE_LOCK_HEARTBEAT_PID=""
UPDATE_COMMAND="\${1:-}"
UPDATE_LOCK_WAIT_MINUTES=""
if [ "\$UPDATE_COMMAND" = "update" ]; then
  UPDATE_PREVIOUS_ARG=""
  for UPDATE_ARG in "\$@"; do
    if [ "\$UPDATE_PREVIOUS_ARG" = "--wait-for-lock" ]; then UPDATE_LOCK_WAIT_MINUTES="\$UPDATE_ARG"; fi
    case "\$UPDATE_ARG" in
      --wait-for-lock=*) UPDATE_LOCK_WAIT_MINUTES="\${UPDATE_ARG#--wait-for-lock=}" ;;
    esac
    UPDATE_PREVIOUS_ARG="\$UPDATE_ARG"
  done
  case "\$UPDATE_LOCK_WAIT_MINUTES" in
    ''|*[!0-9]*) UPDATE_LOCK_WAIT_MINUTES="" ;;
  esac
fi
stop_update_lock_heartbeat() {
  if [ -n "\$UPDATE_LOCK_HEARTBEAT_PID" ]; then
    kill "\$UPDATE_LOCK_HEARTBEAT_PID" >/dev/null 2>&1 || true
    wait "\$UPDATE_LOCK_HEARTBEAT_PID" 2>/dev/null || true
    UPDATE_LOCK_HEARTBEAT_PID=""
  fi
}
release_update_lock() {
  stop_update_lock_heartbeat
  if [ "\$UPDATE_LOCK_ACQUIRED" = "1" ]; then
    if node "\$UPDATE_LOCK_HELPER" release "\$RUNTIME_CONFIG_DIR" "\$OMNESIS_UPDATE_LOCK_ID" >/dev/null 2>&1; then
      UPDATE_LOCK_ACQUIRED=0
    else
      return 73
    fi
  fi
}
finish_update_lock() {
  UPDATE_STATUS="\$1"
  trap - EXIT HUP INT TERM
  if ! release_update_lock; then
    printf '%s\n' "Could not release the source update lock; retry after the active lock operation finishes." >&2
    exit 73
  fi
  exit "\$UPDATE_STATUS"
}
acquire_update_lock() {
  if [ -n "\${OMNESIS_UPDATE_LOCK_ID:-}" ]; then
    OMNESIS_UPDATE_LOCK_ID="\$(node "\$UPDATE_LOCK_HELPER" adopt "\$RUNTIME_CONFIG_DIR" "\$OMNESIS_UPDATE_LOCK_ID" "\$\$")" || exit \$?
  else
    OMNESIS_UPDATE_LOCK_ID="\$(node "\$UPDATE_LOCK_HELPER" acquire "\$RUNTIME_CONFIG_DIR" "source update" "\$\$" \${UPDATE_LOCK_WAIT_MINUTES:+"\$UPDATE_LOCK_WAIT_MINUTES"})" || exit \$?
  fi
  UPDATE_LOCK_ACQUIRED=1
  if [ "\$UPDATE_COMMAND" = "update" ]; then UPDATE_LOCK_HANDOFF=1; fi
  export OMNESIS_UPDATE_LOCK_ID
  node "\$UPDATE_LOCK_HELPER" heartbeat-loop "\$RUNTIME_CONFIG_DIR" "\$OMNESIS_UPDATE_LOCK_ID" &
  UPDATE_LOCK_HEARTBEAT_PID=\$!
  trap 'finish_update_lock \$?' EXIT
  trap 'finish_update_lock 129' HUP
  trap 'finish_update_lock 130' INT
  trap 'finish_update_lock 143' TERM
}
read_update_phase() {
  UPDATE_PHASE=""
  if [ -f "\$RUNTIME_CONFIG_DIR/update-state.json" ]; then
    UPDATE_PHASE="\$(node -e '
const fs = require("node:fs");
const [path, rootDir] = process.argv.slice(1);
try {
  const state = JSON.parse(fs.readFileSync(path, "utf8"));
  const exactCommit = /^[0-9a-f]{40}$/;
  if (state?.version !== 1 || state?.method !== "source" || state?.rootDir !== rootDir) throw new Error();
  if (state.phase === "complete" && exactCommit.test(state.commit)) process.stdout.write("complete" + String.fromCharCode(10) + state.commit);
  else if (["applying", "rolling-back"].includes(state.phase) && exactCommit.test(state.targetCommit) && exactCommit.test(state.lastCompletedCommit)) {
    process.stdout.write(state.phase + String.fromCharCode(10) + state.lastCompletedCommit);
  } else throw new Error();
} catch { process.stdout.write("invalid"); }
' "\$RUNTIME_CONFIG_DIR/update-state.json" "\$SOURCE_ROOT" 2>/dev/null || true)"
  fi
  UPDATE_LAST_COMPLETED="\$(printf '%s\n' "\$UPDATE_PHASE" | sed -n '2p')"
  UPDATE_PHASE="\$(printf '%s\n' "\$UPDATE_PHASE" | sed -n '1p')"
  if [ "\$UPDATE_PHASE" = "invalid" ]; then
    printf '%s\n' "The source update state is invalid. Re-run the source installer to repair it." >&2
    exit 1
  fi
  if [ "\$UPDATE_PHASE" = "complete" ]; then
    CURRENT_COMMIT="\$(git -C "\$SOURCE_ROOT" rev-parse HEAD 2>/dev/null || true)"
    if [ "\$CURRENT_COMMIT" != "\$UPDATE_LAST_COMPLETED" ]; then UPDATE_PHASE="mismatch"; fi
  fi
}
update_unfinished() {
  [ "\$UPDATE_PHASE" = "applying" ] || [ "\$UPDATE_PHASE" = "rolling-back" ] || [ "\$UPDATE_PHASE" = "mismatch" ]
}
# npm installs over the node_modules a workspace checkout already has, and
# an install over another build's tree can fail the same way on every run.
# A failed install is retried once from an empty node_modules.
install_source_dependencies() {
  ( cd "\$SOURCE_ROOT" && npm ci ) && return 0
  printf '%s\n' "Installing dependencies failed; installing them again from an empty node_modules..." >&2
  rm -rf "\$SOURCE_ROOT/node_modules" && ( cd "\$SOURCE_ROOT" && npm ci )
}
read_update_phase
if update_unfinished; then
  if [ "\${1:-}" != "update" ]; then
    printf '%s\n' "A source update did not finish. Run 'omnesis update' before starting another command." >&2
    printf '%s\n' "If its build was killed for lack of memory, first stop the collector and gateway (systemctl --user stop omnesis-collector omnesis-gateway on Linux, launchctl bootout on macOS)." >&2
    exit 1
  fi
  acquire_update_lock
  # An update this one waited for may have finished in the meantime.
  read_update_phase
fi
if update_unfinished; then
  if [ -n "\$(git -C "\$SOURCE_ROOT" status --porcelain)" ]; then
    printf '%s\n' "The source checkout has local changes after the interrupted update. Preserve or discard them explicitly before retrying." >&2
    exit 1
  fi
  printf '%s\n' "Source update recovery: restoring the last completed CLI before retrying..." >&2
  git -C "\$SOURCE_ROOT" checkout --detach "\$UPDATE_LAST_COMPLETED" >/dev/null || {
    printf '%s\n' "Could not restore the last completed source commit. Re-run the source installer." >&2
    exit 1
  }
  install_source_dependencies || {
    printf '%s\n' "Could not restore source dependencies. Re-run this command or the source installer." >&2
    exit 1
  }
elif [ ! -x "\$SOURCE_ROOT/node_modules/.bin/tsx" ]; then
  if [ "\$UPDATE_LOCK_ACQUIRED" != "1" ]; then acquire_update_lock; fi
  if [ ! -x "\$SOURCE_ROOT/node_modules/.bin/tsx" ]; then
    printf '%s\n' "Source recovery: restoring missing CLI dependencies before continuing..." >&2
    install_source_dependencies || {
      printf '%s\n' "Could not restore source dependencies. Re-run this command or the source installer." >&2
      exit 1
    }
  fi
fi
if [ "\$UPDATE_LOCK_HANDOFF" = "1" ]; then
  "\$SOURCE_ROOT/node_modules/.bin/tsx" "\$SOURCE_ROOT/packages/cli/src/index.ts" "\$@"
  UPDATE_STATUS=\$?
  finish_update_lock "\$UPDATE_STATUS"
fi
if [ "\$UPDATE_LOCK_ACQUIRED" = "1" ]; then
  if ! release_update_lock; then
    printf '%s\n' "Could not release the source recovery lock; retry after the active lock operation finishes." >&2
    trap - EXIT HUP INT TERM
    exit 73
  fi
  trap - EXIT HUP INT TERM
fi
exec "\$SOURCE_ROOT/node_modules/.bin/tsx" "\$SOURCE_ROOT/packages/cli/src/index.ts" "\$@"
EOF
}

# Install the stable front door before mutating an existing checkout. Paths
# are data, not shell source: single-quote them so every valid local path stays
# literal when the generated launcher is invoked later.
write_source_wrapper() {
  SOURCE_ROOT="$1"
  write_source_update_lock_helper
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
  OMNESIS_BIN="$BIN_DIR/omnesis"
  SOURCE_WRAPPER_TMP="$(mktemp "$BIN_DIR/.omnesis.XXXXXX")" || fail "Could not create a private temporary source launcher."
  chmod 600 "$SOURCE_WRAPPER_TMP"
  render_source_wrapper "$SOURCE_ROOT" > "$SOURCE_WRAPPER_TMP"
  chmod 755 "$SOURCE_WRAPPER_TMP"
  node -e '
const fs = require("node:fs");
const [scratch, target, dir] = process.argv.slice(1);
const fd = fs.openSync(scratch, "r");
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.renameSync(scratch, target);
try {
  const dirFd = fs.openSync(dir, "r");
  try { try { fs.fsyncSync(dirFd); } catch {} } finally { fs.closeSync(dirFd); }
} catch {}
' "$SOURCE_WRAPPER_TMP" "$OMNESIS_BIN" "$BIN_DIR" || fail "Could not atomically install the source recovery launcher."
  SOURCE_WRAPPER_TMP=""
  info "Wrote $OMNESIS_BIN"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      PATH_HINT_DIR="$BIN_DIR"
      print_path_hint "$BIN_DIR"
      PATH="$BIN_DIR:$PATH"
      export PATH
      ;;
  esac
}

# A pathname under ~/.local/bin is not evidence that this installer owns it.
# Recognition requires all three records to agree: the managed git checkout,
# the durable completed source-update state, and the exact launcher bytes this
# installer renders for that checkout and config directory. lstat rejects a
# symlink before any content comparison, so a user-managed target is never
# followed and replaced by accident.
source_wrapper_is_installer_owned() {
  [ -n "${SOURCE_WRAPPER:-}" ] && { [ -e "$SOURCE_WRAPPER" ] || [ -L "$SOURCE_WRAPPER" ]; } || return 1
  SOURCE_WRAPPER_ROOT="$(node -e '
const fs = require("node:fs");
try {
  const stat = fs.lstatSync(process.argv[1]);
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!stat.isFile() || stat.isSymbolicLink() || state?.version !== 1 ||
      state?.method !== "source" || state?.phase !== "complete" ||
      typeof state.rootDir !== "string" || !state.rootDir.startsWith("/")) process.exit(1);
  process.stdout.write(state.rootDir);
} catch { process.exit(1); }
' "$CONFIG_DIR/update-state.json")" || return 1
  [ -d "$SOURCE_WRAPPER_ROOT" ] || return 1
  SOURCE_WRAPPER_ROOT="$(cd "$SOURCE_WRAPPER_ROOT" 2>/dev/null && pwd -P)" || return 1
  [ "$(git -C "$SOURCE_WRAPPER_ROOT" config --local --no-includes --get omnesis.install 2>/dev/null || true)" = managed ] || return 1
  SOURCE_WRAPPER_COMMIT="$(git -C "$SOURCE_WRAPPER_ROOT" rev-parse HEAD 2>/dev/null || true)"
  node -e '
const fs = require("node:fs");
const [statePath, rootDir, commit] = process.argv.slice(1);
try {
  const stateStat = fs.lstatSync(statePath);
  if (!stateStat.isFile() || stateStat.isSymbolicLink()) process.exit(1);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (state?.version !== 1 || state?.method !== "source" || state?.phase !== "complete" ||
      state?.rootDir !== rootDir || state?.commit !== commit || !/^[0-9a-f]{40}$/.test(commit)) process.exit(1);
} catch { process.exit(1); }
' "$CONFIG_DIR/update-state.json" "$SOURCE_WRAPPER_ROOT" "$SOURCE_WRAPPER_COMMIT" || return 1

  if [ -n "${SOURCE_WRAPPER_EXPECTED_TMP:-}" ] && [ -f "$SOURCE_WRAPPER_EXPECTED_TMP" ]; then
    rm -f "$SOURCE_WRAPPER_EXPECTED_TMP"
  fi
  UPDATE_LOCK_HELPER="$HOME/.local/lib/omnesis/update-lock.cjs"
  SOURCE_WRAPPER_EXPECTED_TMP="$(mktemp "$HOME/.local/bin/.omnesis-source-expected.XXXXXX")" || return 1
  chmod 600 "$SOURCE_WRAPPER_EXPECTED_TMP"
  render_source_wrapper "$SOURCE_WRAPPER_ROOT" > "$SOURCE_WRAPPER_EXPECTED_TMP"
  node -e '
const fs = require("node:fs");
const [candidate, expected] = process.argv.slice(1);
try {
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) process.exit(1);
  if (!fs.readFileSync(candidate).equals(fs.readFileSync(expected))) process.exit(1);
} catch { process.exit(1); }
' "$SOURCE_WRAPPER" "$SOURCE_WRAPPER_EXPECTED_TMP"
}

package_wrapper_parent_is_safe() {
  node -e '
const fs = require("node:fs");
const path = require("node:path");
for (const candidate of [path.join(process.argv[1], ".local"), path.join(process.argv[1], ".local", "bin")]) {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) process.exit(1);
  } catch (error) {
    if (error?.code !== "ENOENT") process.exit(1);
  }
}
' "$HOME"
}

prepare_package_wrapper() {
  package_wrapper_parent_is_safe || {
    warn "$HOME/.local/bin contains a symlink or non-directory path; $SOURCE_WRAPPER was left unchanged."
    return 1
  }
  mkdir -p "$HOME/.local/bin" || {
    warn "Could not create $HOME/.local/bin; $SOURCE_WRAPPER was left unchanged."
    return 1
  }
  package_wrapper_parent_is_safe || {
    warn "$HOME/.local/bin changed while preparing the launcher; $SOURCE_WRAPPER was left unchanged."
    return 1
  }
  PACKAGE_PREFIX_LITERAL="$(shell_single_quote "$PACKAGE_PREFIX")"
  PACKAGE_BIN_LITERAL="$(shell_single_quote "$OMNESIS_BIN")"
  PACKAGE_WRAPPER_TMP="$(mktemp "$HOME/.local/bin/.omnesis-package.XXXXXX")" || {
    warn "Could not create a private temporary package launcher; $SOURCE_WRAPPER was left unchanged."
    return 1
  }
  chmod 600 "$PACKAGE_WRAPPER_TMP"
  cat > "$PACKAGE_WRAPPER_TMP" <<EOF
#!/bin/sh
NPM_CONFIG_PREFIX=$PACKAGE_PREFIX_LITERAL
export NPM_CONFIG_PREFIX
exec $PACKAGE_BIN_LITERAL "\$@"
EOF
  chmod 755 "$PACKAGE_WRAPPER_TMP"
  PACKAGE_WRAPPER_VERSION="$("$PACKAGE_WRAPPER_TMP" --version 2>/dev/null || true)"
  if [ "$PACKAGE_WRAPPER_VERSION" != "$PACKAGE_INSTALLED_VERSION" ]; then
    warn "The prospective package launcher did not report $PACKAGE_INSTALLED_VERSION; $SOURCE_WRAPPER was left unchanged."
    return 1
  fi
}

write_new_package_wrapper() {
  prepare_package_wrapper || return 1
  node -e '
const fs = require("node:fs");
const [candidate, replacement, dir] = process.argv.slice(1);
try {
  const fd = fs.openSync(replacement, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.linkSync(replacement, candidate);
  try {
    const dirFd = fs.openSync(dir, "r");
    try { try { fs.fsyncSync(dirFd); } catch {} } finally { fs.closeSync(dirFd); }
  } catch {}
  fs.unlinkSync(replacement);
} catch { process.exit(1); }
' "$SOURCE_WRAPPER" "$PACKAGE_WRAPPER_TMP" "$HOME/.local/bin" || return 1
  PACKAGE_WRAPPER_TMP=""
  info "Wrote package launcher $SOURCE_WRAPPER"
}

installed_package_wrapper_is_owned() {
  prepare_package_wrapper || return 1
  if node -e '
const fs = require("node:fs");
const [candidate, expected] = process.argv.slice(1);
try {
  const stat = fs.lstatSync(candidate);
  process.exit(stat.isFile() && !stat.isSymbolicLink() && fs.readFileSync(candidate).equals(fs.readFileSync(expected)) ? 0 : 1);
} catch { process.exit(1); }
' "$SOURCE_WRAPPER" "$PACKAGE_WRAPPER_TMP"; then
    rm -f "$PACKAGE_WRAPPER_TMP"
    PACKAGE_WRAPPER_TMP=""
    return 0
  fi
  rm -f "$PACKAGE_WRAPPER_TMP"
  PACKAGE_WRAPPER_TMP=""
  return 1
}

write_package_wrapper() {
  # Recheck immediately before replacement. A changed file is foreign, even if
  # it occupied an installer-owned path when package installation began.
  if ! source_wrapper_is_installer_owned; then
    warn "$SOURCE_WRAPPER changed or no longer matches its source-install record. It was left unchanged."
    return 1
  fi
  prepare_package_wrapper || return 1

  node -e '
const crypto = require("node:crypto");
const fs = require("node:fs");
const [candidate, expected, replacement, dir] = process.argv.slice(1);
const previous = candidate + ".omnesis-migration-" + crypto.randomUUID() + ".previous";
let moved = false;
let linked = false;
try {
  const before = fs.lstatSync(candidate);
  if (!before.isFile() || before.isSymbolicLink() ||
      !fs.readFileSync(candidate).equals(fs.readFileSync(expected))) throw new Error();
  const fd = fs.openSync(replacement, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(candidate, previous);
  moved = true;
  const after = fs.lstatSync(previous);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error();
  if (!fs.readFileSync(previous).equals(fs.readFileSync(expected))) throw new Error();
  fs.linkSync(replacement, candidate);
  linked = true;
  try {
    const dirFd = fs.openSync(dir, "r");
    try { try { fs.fsyncSync(dirFd); } catch {} } finally { fs.closeSync(dirFd); }
  } catch {}
  try { fs.unlinkSync(replacement); } catch {}
  try { fs.unlinkSync(previous); moved = false; } catch {}
} catch {
  if (!linked && moved) {
    try { fs.linkSync(previous, candidate); fs.unlinkSync(previous); moved = false; } catch {}
  }
  if (moved) process.stderr.write("The original source launcher is preserved at " + previous + ".\n");
  process.exitCode = 1;
}
' "$SOURCE_WRAPPER" "$SOURCE_WRAPPER_EXPECTED_TMP" "$PACKAGE_WRAPPER_TMP" "$HOME/.local/bin" || {
    warn "The package launcher was not activated at $SOURCE_WRAPPER; no concurrent path was overwritten."
    return 1
  }
  PACKAGE_WRAPPER_TMP=""
  rm -f "$SOURCE_WRAPPER_EXPECTED_TMP"
  SOURCE_WRAPPER_EXPECTED_TMP=""
  info "Replaced the source launcher at $SOURCE_WRAPPER with a package launcher."
}

finalize_package_source_wrapper() {
  [ "$METHOD" = package ] || return 0
  if [ "${SOURCE_WRAPPER_UNSAFE:-0}" = 1 ]; then
    warn "Use 'omnesis update migrate-to-package' to inspect the existing launcher before changing delivery methods."
    [ "$REPLACE_SOURCE_WRAPPER" = 0 ] || \
      fail "--replace-source-wrapper cannot replace an unverified file. The existing launcher was retained."
    return 0
  fi
  [ "${SOURCE_WRAPPER_OWNED:-0}" = 1 ] || return 0
  if [ "${1:-}" != healthy ]; then
    warn "Keeping the source launcher at $SOURCE_WRAPPER because this package flow did not verify a replacement service."
    warn "Use 'omnesis update migrate-to-package' for the checked source-to-package migration."
    [ "$REPLACE_SOURCE_WRAPPER" = 0 ] || \
      fail "--replace-source-wrapper was requested, but the package-backed service was not verified. The source launcher was retained."
    return 0
  fi

  REPLACE_NOW=0
  if [ "$REPLACE_SOURCE_WRAPPER" = 1 ]; then
    REPLACE_NOW=1
  elif is_promptable; then
    ANSWER="$(ask_tty "Replace $SOURCE_WRAPPER with a launcher for the verified package build? [y/N] ")"
    case "$ANSWER" in y|Y|yes|YES|Yes) REPLACE_NOW=1 ;; esac
  else
    warn "Keeping the source launcher because this non-interactive run did not authorize replacing it."
    warn "Re-run with --replace-source-wrapper, or use 'omnesis update migrate-to-package'."
  fi
  if [ "$REPLACE_NOW" != 1 ]; then
    warn "The package is installed at $OMNESIS_BIN, but $SOURCE_WRAPPER remains the active PATH front door."
    return 0
  fi
  write_package_wrapper || fail "The verified source launcher could not be replaced. Inspect the warning above before retrying."
}

install_source() {
  EXISTING_CHECKOUT=0
  SOURCE_CHECKOUT_REF=""
  if [ -e "$SOURCE_DIR/.git" ]; then EXISTING_CHECKOUT=1; fi
  write_source_update_lock_helper
  INSTALL_UPDATE_LOCK_ID="$(node "$UPDATE_LOCK_HELPER" acquire "$CONFIG_DIR" "source installer" "$$")" || \
    fail "Could not acquire the source update lock."
  node "$UPDATE_LOCK_HELPER" heartbeat-loop "$CONFIG_DIR" "$INSTALL_UPDATE_LOCK_ID" &
  INSTALL_UPDATE_HEARTBEAT_PID=$!
  if [ "$EXISTING_CHECKOUT" = 1 ]; then
    [ -z "$(git -C "$SOURCE_DIR" status --porcelain)" ] || \
      fail "The source checkout at $SOURCE_DIR has local changes. Commit or stash them before updating."
  fi

  if [ -n "$PIN_COMMIT" ]; then
    SOURCE_REF="$PIN_COMMIT"
    SOURCE_LABEL="commit $(printf '%.12s' "$PIN_COMMIT")"
  elif [ "$EDGE" = 1 ]; then
    SOURCE_REF="main"
    SOURCE_LABEL="the current main branch"
  else
    if [ -n "$PIN_VERSION" ]; then
      printf '%s\n' "$PIN_VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || \
        fail "Invalid --version '$PIN_VERSION' (expected X.Y.Z)."
      SOURCE_REF="v$PIN_VERSION"
      if [ "$EXISTING_CHECKOUT" = 1 ]; then
        EXACT_TAG="$(git -C "$SOURCE_DIR" ls-remote --tags --refs origin "refs/tags/$SOURCE_REF")" || \
          fail "Could not read release tags from the checkout's origin. Check repository access and your network connection."
      else
        EXACT_TAG="$(git ls-remote --tags --refs "$REPO_URL" "refs/tags/$SOURCE_REF")" || \
          fail "Could not read release tags from $REPO_URL. Check repository access and your network connection."
      fi
      [ -n "$EXACT_TAG" ] || fail "Stable source release $SOURCE_REF does not exist."
    else
      info "Resolving the newest stable source release..."
      if [ "$EXISTING_CHECKOUT" = 1 ]; then
        REMOTE_TAGS="$(git -C "$SOURCE_DIR" ls-remote --tags --refs origin 'refs/tags/v*')" || \
          fail "Could not read release tags from the checkout's origin. Check repository access and your network connection."
      else
        REMOTE_TAGS="$(git ls-remote --tags --refs "$REPO_URL" 'refs/tags/v*')" || \
          fail "Could not read release tags from $REPO_URL. Check repository access and your network connection."
      fi
      SOURCE_REF="$(printf '%s\n' "$REMOTE_TAGS" | node -e '
        let input = "";
        process.stdin.on("data", (chunk) => (input += chunk));
        process.stdin.on("end", () => {
          const tags = input.split(/\r?\n/)
            .map((line) => line.match(/refs\/tags\/(v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/))
            .filter(Boolean)
            .sort((a, b) => {
              for (let i = 2; i <= 4; i++) {
                if (a[i].length !== b[i].length) return b[i].length - a[i].length;
                if (a[i] !== b[i]) return b[i].localeCompare(a[i]);
              }
              return 0;
            });
          if (tags[0]) process.stdout.write(tags[0][1]);
        });
      ')"
      [ -n "$SOURCE_REF" ] || fail "No stable source release exists yet (expected a vX.Y.Z tag)."
    fi
    SOURCE_LABEL="stable release $SOURCE_REF"
  fi

  if [ "$EXISTING_CHECKOUT" = 1 ]; then
    info "Updating existing checkout at $SOURCE_DIR to $SOURCE_LABEL..."
    if [ -n "$PIN_COMMIT" ]; then
      git -C "$SOURCE_DIR" fetch origin "$PIN_COMMIT"
      TARGET_REF="$(git -C "$SOURCE_DIR" rev-parse --verify 'FETCH_HEAD^{commit}')" || \
        fail "Could not resolve commit $PIN_COMMIT from the checkout's origin."
      [ "$TARGET_REF" = "$PIN_COMMIT" ] || \
        fail "Origin resolved $PIN_COMMIT to $TARGET_REF. Refusing to install a different commit."
    elif [ "$EDGE" = 1 ]; then
      # Forced: origin/main must follow main even when it no longer descends
      # from what was fetched before; the checks below decide whether to move.
      git -C "$SOURCE_DIR" fetch origin +main:refs/remotes/origin/main
      TARGET_REF="origin/main"
    else
      # Name the release tag explicitly: a checkout cloned from one tag is
      # configured to fetch that tag, which origin may no longer have.
      git -C "$SOURCE_DIR" fetch --no-tags origin "refs/tags/$SOURCE_REF:refs/tags/$SOURCE_REF"
      git -C "$SOURCE_DIR" rev-parse --verify --quiet "refs/tags/$SOURCE_REF" >/dev/null || \
        fail "Stable source release $SOURCE_REF was not found after fetching origin."
      TARGET_REF="$SOURCE_REF"
      CHECKED_VERSION="$(git -C "$SOURCE_DIR" show "$TARGET_REF:packages/cli/package.json" | node -e '
        let input = ""; process.stdin.on("data", (chunk) => (input += chunk));
        process.stdin.on("end", () => process.stdout.write(JSON.parse(input).version));
      ')" || fail "Could not read the CLI version from release $SOURCE_REF."
      [ "v$CHECKED_VERSION" = "$SOURCE_REF" ] || \
        fail "Release tag $SOURCE_REF contains CLI version $CHECKED_VERSION. Refusing an inconsistent release."
    fi
    SOURCE_ROOT="$(cd "$SOURCE_DIR" && pwd -P)"
    SOURCE_HEAD="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
    # The commit, not an annotated tag's own object: it is compared with the
    # commit the last completed build recorded.
    SOURCE_TARGET="$(git -C "$SOURCE_DIR" rev-parse "$TARGET_REF^{commit}")"
    SOURCE_LAST_COMPLETED="$(source_last_completed_commit "$SOURCE_ROOT" "$SOURCE_HEAD")"
    [ "$SOURCE_LAST_COMPLETED" = "$SOURCE_TARGET" ] || SOURCE_MOVED=1
    if git -C "$SOURCE_DIR" merge-base --is-ancestor "$SOURCE_LAST_COMPLETED" "$TARGET_REF"; then
      ANCESTRY_STATUS=0
    else
      ANCESTRY_STATUS=$?
    fi
    if [ "$ANCESTRY_STATUS" -gt 1 ]; then
      fail "Could not compare the installed commit with $SOURCE_LABEL. The checkout may be incomplete or corrupt."
    fi
    if [ "$ANCESTRY_STATUS" = 1 ]; then
      # Not a descendant: a newer release cut without the installed commit, or
      # a repository whose history was replaced by a new root. A higher product
      # version is still a forward update, as `omnesis update` judges it.
      INSTALLED_VERSION="$(source_version_at "$SOURCE_LAST_COMPLETED")"
      TARGET_VERSION="$(source_version_at "$SOURCE_TARGET")"
      if version_is_newer "$TARGET_VERSION" "$INSTALLED_VERSION"; then
        # No merge base in a full clone means the history was replaced; a
        # shallow exact-commit checkout lacks one for an ordinary reason.
        if git -C "$SOURCE_DIR" merge-base "$SOURCE_TARGET" "$SOURCE_LAST_COMPLETED" >/dev/null 2>&1; then
          MERGE_BASE_STATUS=0
        else
          MERGE_BASE_STATUS=$?
        fi
        if [ "$MERGE_BASE_STATUS" = 1 ] && \
          [ "$(git -C "$SOURCE_DIR" rev-parse --is-shallow-repository 2>/dev/null || true)" = false ]; then
          warn "$SOURCE_LABEL shares no history with the installed build ($INSTALLED_VERSION): the repository's history was replaced. Moving forward to $TARGET_VERSION."
        else
          warn "$SOURCE_LABEL ($TARGET_VERSION) is newer than the installed build ($INSTALLED_VERSION) but does not contain all of it."
        fi
      else
        [ "$FORCE" = 1 ] || \
          fail "$SOURCE_LABEL is not a forward update from the installed commit. Re-run with --force only if moving backwards is intentional."
      fi
    fi
    SOURCE_CHECKOUT_REF="$TARGET_REF"
  else
    [ ! -e "$SOURCE_DIR" ] || fail "$SOURCE_DIR already exists but is not a git checkout. Choose another --source-dir."
    info "Cloning $SOURCE_LABEL from $REPO_URL to $SOURCE_DIR..."
    if [ -n "$PIN_COMMIT" ]; then
      mkdir -p "$(dirname "$SOURCE_DIR")"
      SOURCE_CHECKOUT_TMP="$(mktemp -d "${SOURCE_DIR}.tmp.XXXXXX")" || \
        fail "Could not create a temporary source checkout beside $SOURCE_DIR."
      git init "$SOURCE_CHECKOUT_TMP"
      git -C "$SOURCE_CHECKOUT_TMP" remote add origin "$REPO_URL"
      git -C "$SOURCE_CHECKOUT_TMP" fetch --depth 1 --no-tags origin "$PIN_COMMIT"
      TARGET_REF="$(git -C "$SOURCE_CHECKOUT_TMP" rev-parse --verify 'FETCH_HEAD^{commit}')" || \
        fail "Could not resolve commit $PIN_COMMIT from $REPO_URL."
      [ "$TARGET_REF" = "$PIN_COMMIT" ] || \
        fail "The repository resolved $PIN_COMMIT to $TARGET_REF. Refusing to install a different commit."
      git -C "$SOURCE_CHECKOUT_TMP" checkout --detach "$TARGET_REF"
      mv "$SOURCE_CHECKOUT_TMP" "$SOURCE_DIR"
      SOURCE_CHECKOUT_TMP=""
    else
      git clone --branch "$SOURCE_REF" --single-branch "$REPO_URL" "$SOURCE_DIR"
    fi
    SOURCE_ROOT="$(cd "$SOURCE_DIR" && pwd -P)"
    SOURCE_TARGET="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
    SOURCE_LAST_COMPLETED="$SOURCE_TARGET"
  fi
  if [ "$EDGE" != 1 ] && [ -z "$PIN_COMMIT" ] && [ "$EXISTING_CHECKOUT" != 1 ]; then
    CHECKED_VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$SOURCE_DIR/packages/cli/package.json")"
    [ "v$CHECKED_VERSION" = "$SOURCE_REF" ] || \
      fail "Release tag $SOURCE_REF contains CLI version $CHECKED_VERSION. Refusing an inconsistent release."
  fi
  git -C "$SOURCE_DIR" config --local omnesis.install managed
  write_source_wrapper "$SOURCE_ROOT"
  write_source_update_state "applying" "$SOURCE_ROOT" "$SOURCE_TARGET" "$SOURCE_LAST_COMPLETED"
  if [ -n "$SOURCE_CHECKOUT_REF" ]; then
    git -C "$SOURCE_DIR" checkout --detach "$SOURCE_CHECKOUT_REF"
  fi
  info "Installing dependencies (compiles native modules — a few minutes on first run)..."
  BUILD_NODE_OPTIONS="$(build_node_options)"
  # npm's downloads and install scripts fail now and then on their own (a
  # dropped connection, an install-script binary still open for writing), so
  # one failure earns a second attempt. The checkout and the update state are
  # already recorded, so a re-run after a second failure resumes from here.
  #
  # The retry starts from an empty node_modules. A first attempt that died
  # part-way -- an install script killed by the kernel, or one that crashed
  # mid-write -- leaves a tree that a second `npm ci` does not fully replace:
  # it reports success while packages are left without the declaration files
  # their tarballs ship, so the build below fails TS7016 and fails the same
  # way on every later run. Removing the tree is what the build-failure
  # message already tells the operator to do by hand; the retry should not
  # need to be told.
  DEPS_INSTALLED_CLEAN=0
  if ! ( cd "$SOURCE_DIR" && npm ci ); then
    warn "Installing dependencies failed (npm's error is above); trying once more..."
    rm -rf "$SOURCE_DIR/node_modules"
    ( cd "$SOURCE_DIR" && npm ci ) || \
      source_step_failed "$?" "Installing dependencies" "Installing dependencies failed twice — npm's error is above; a network problem or a busy file is the usual cause. Nothing is lost: re-run this installer and it continues from the checkout it already made."
    DEPS_INSTALLED_CLEAN=1
  fi
  BUILD_STATUS=0
  ( cd "$SOURCE_DIR" && NODE_OPTIONS="$BUILD_NODE_OPTIONS" npm run build ) || BUILD_STATUS=$?
  # A build that fails on a tree this run did not install from scratch is the
  # signature of an *earlier* run that was interrupted: the tree it left behind
  # is complete enough that `npm ci` leaves it alone, and incomplete enough
  # that packages are missing the declaration files their tarballs ship, so
  # the build fails TS7016 here and on every later run. That is exactly the
  # repair this message used to ask the operator to perform by hand, which
  # made "re-run this installer" advice rather than a recovery. Do it once.
  if [ "$BUILD_STATUS" != 0 ] && [ "$DEPS_INSTALLED_CLEAN" = 0 ]; then
    warn "The build failed. An interrupted earlier run can leave dependencies without the files their tarballs ship, which fails the build this way every time; reinstalling them from scratch and building once more..."
    rm -rf "$SOURCE_DIR/node_modules"
    ( cd "$SOURCE_DIR" && npm ci ) || \
      source_step_failed "$?" "Installing dependencies" "Reinstalling dependencies after a failed build did not succeed — npm's error is above. Nothing is lost: re-run this installer and it continues from the checkout it already made."
    DEPS_INSTALLED_CLEAN=1
    BUILD_STATUS=0
    ( cd "$SOURCE_DIR" && NODE_OPTIONS="$BUILD_NODE_OPTIONS" npm run build ) || BUILD_STATUS=$?
  fi
  [ "$BUILD_STATUS" = 0 ] || \
    source_step_failed "$BUILD_STATUS" "The build" "The build failed — its error is above. Its dependencies were reinstalled from scratch first, so this is the code or this machine, not a half-finished earlier run. Fix the error above and re-run; it continues from the checkout it already made."
  SOURCE_ROOT="$(cd "$SOURCE_DIR" && pwd -P)"
  SOURCE_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
  write_source_update_state "complete" "$SOURCE_ROOT" "$SOURCE_COMMIT"
  kill "$INSTALL_UPDATE_HEARTBEAT_PID" >/dev/null 2>&1 || true
  wait "$INSTALL_UPDATE_HEARTBEAT_PID" 2>/dev/null || true
  INSTALL_UPDATE_HEARTBEAT_PID=""
  node "$UPDATE_LOCK_HELPER" release "$CONFIG_DIR" "$INSTALL_UPDATE_LOCK_ID" || \
    fail "Could not release the source update lock."
  INSTALL_UPDATE_LOCK_ID=""
}

# ── The embedding model question ─────────────────────────────────────────────

# An `omnesis` this machine can already run, if there is one. On a re-run or an
# upgrade that is the wrapper from the previous install, which is what lets the
# model question be asked before the clone and build rather than after them.
resolve_existing_cli() {
  EXISTING_CLI=""
  if [ -n "${OMNESIS_BIN:-}" ] && [ -x "${OMNESIS_BIN:-}" ]; then
    EXISTING_CLI="$OMNESIS_BIN"
  elif command -v omnesis >/dev/null 2>&1; then
    EXISTING_CLI="$(command -v omnesis)"
  elif [ -x "$HOME/.local/bin/omnesis" ]; then
    EXISTING_CLI="$HOME/.local/bin/omnesis"
  fi
}

# The catalog entries that can serve the embed role, as `id|label` lines with
# the id to preselect on the first line. `model catalog` answers from the
# catalog compiled into the CLI, so this works with no gateway running.
read_embedder_catalog() {
  EMBEDDER_MENU=""
  [ -n "$EXISTING_CLI" ] || return 1
  # Closed stdin on purpose: a CLI predating this command runs its gateway
  # trust preflight first, which would otherwise sit waiting for an answer on
  # a prompt this pipeline has already discarded.
  CATALOG_JSON="$("$EXISTING_CLI" model catalog --role embed --json 2>/dev/null </dev/null || true)"
  [ -n "$CATALOG_JSON" ] || return 1
  EMBEDDER_MENU="$(printf '%s' "$CATALOG_JSON" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        const entries = Array.isArray(j.entries) ? j.entries : [];
        if (entries.length === 0) return;
        const lines = [String(j.default || entries[0].id), String(j.assignedId || "")];
        for (const e of entries) {
          const size = e.sizeBytes
            ? ` — ${e.sizeBytes >= 1e9 ? `${(e.sizeBytes / 1e9).toFixed(1)} GB` : `${Math.round(e.sizeBytes / 1e6)} MB`}`
            : "";
          const dim = e.embedDim ? `, ${e.embedDim}-dim` : "";
          lines.push(`${e.id}|${e.name}${size}${dim}`);
        }
        process.stdout.write(lines.join("\n"));
      } catch { /* an older CLI without the command */ }
    });' 2>/dev/null || true)"
  [ -n "$EMBEDDER_MENU" ] || return 1
  return 0
}

# Refuse a run that has a model to choose and no way to ask. Named flags only:
# a silent default here is a corpus indexed by a model the operator never chose.
no_embedder_terminal() {
  if is_promptable; then return 0; fi
  fail "No terminal to ask which embedding model to install. Re-run with --embedder <id> (or OMNESIS_EMBEDDER_ID=<id>) to name one, or --no-model to install none."
}

# Ask which embedding model to install. Called twice: once up front, and again
# once the CLI exists, because a first install has no catalog to offer until
# then. The second call passes "final" — there will be no third chance, so a
# catalog that still cannot be read is announced rather than defaulted past.
# Either way the question comes before the download, and before anything is
# registered or started.
choose_embedder() {
  if [ "$EMBEDDER_CHOSEN" = 1 ]; then return 0; fi
  # --no-model and --client-only both clear WANT_MODEL: no model, no question.
  if [ "$WANT_MODEL" != 1 ]; then EMBEDDER_CHOSEN=1; return 0; fi
  if [ "$EMBEDDER_EXPLICIT" = 1 ]; then
    EMBEDDER_CHOSEN=1
    info "Embedding model: $EMBEDDER_ID"
    return 0
  fi
  resolve_existing_cli
  if ! read_embedder_catalog; then
    # No CLI yet, or one too old to know the command. Refuse a run that could
    # never answer now, before it spends minutes cloning and building; ask
    # again once the CLI exists.
    no_embedder_terminal
    [ "${1:-}" = final ] || return 0
    EMBEDDER_CHOSEN=1
    warn "Could not read the model catalog from $EXISTING_CLI — installing the default embedding model $EMBEDDER_ID."
    warn "Choose another with: omnesis model catalog --role embed, then omnesis model install <id>"
    return 0
  fi

  EMBEDDER_DEFAULT="$(printf '%s\n' "$EMBEDDER_MENU" | sed -n '1p')"
  EMBEDDER_ASSIGNED="$(printf '%s\n' "$EMBEDDER_MENU" | sed -n '2p')"
  EMBEDDER_OPTIONS="$(printf '%s\n' "$EMBEDDER_MENU" | sed -n '3,$p')"

  # An assignment the catalog does not contain is a model served from
  # somewhere else — an HTTP backend, or a file dropped in by hand. It already
  # works, and no download would change it, so there is nothing to ask, with or
  # without a terminal.
  if [ -n "$EMBEDDER_ASSIGNED" ] &&
     ! printf '%s\n' "$EMBEDDER_OPTIONS" | cut -d'|' -f1 | grep -qxF -- "$EMBEDDER_ASSIGNED"; then
    info "Embedding model: $EMBEDDER_ASSIGNED is already assigned on this machine — leaving it alone."
    EMBEDDER_CHOSEN=1
    EMBEDDER_KEPT=1
    WANT_MODEL=0
    return 0
  fi

  no_embedder_terminal

  echo "" >/dev/tty
  printf 'Which embedding model should power semantic search?\n' >/dev/tty
  EMBEDDER_COUNT=0
  EMBEDDER_DEFAULT_NUM=1
  while IFS='|' read -r OPT_ID OPT_LABEL; do
    [ -n "$OPT_ID" ] || continue
    EMBEDDER_COUNT=$((EMBEDDER_COUNT + 1))
    if [ "$OPT_ID" = "$EMBEDDER_DEFAULT" ]; then
      EMBEDDER_DEFAULT_NUM="$EMBEDDER_COUNT"
      OPT_MARK="*"
    else
      OPT_MARK=" "
    fi
    printf '  %s %2s) %s\n' "$OPT_MARK" "$EMBEDDER_COUNT" "$OPT_LABEL" >/dev/tty
  done <<EOF
$EMBEDDER_OPTIONS
EOF
  printf '  (* is the default; it downloads after the install)\n' >/dev/tty

  EMBEDDER_TRIES=0
  while [ "$EMBEDDER_TRIES" -lt 5 ]; do
    EMBEDDER_TRIES=$((EMBEDDER_TRIES + 1))
    ANSWER="$(ask_tty "Model [$EMBEDDER_DEFAULT_NUM]: ")"
    if [ -z "$ANSWER" ]; then
      EMBEDDER_ID="$EMBEDDER_DEFAULT"
      EMBEDDER_CHOSEN=1
      break
    fi
    case "$ANSWER" in
      *[!0-9]*|??????*) warn "Enter a number between 1 and $EMBEDDER_COUNT."; continue ;;
    esac
    if [ "$ANSWER" -ge 1 ] && [ "$ANSWER" -le "$EMBEDDER_COUNT" ]; then
      EMBEDDER_ID="$(printf '%s\n' "$EMBEDDER_OPTIONS" | sed -n "${ANSWER}p" | cut -d'|' -f1)"
      EMBEDDER_CHOSEN=1
      break
    fi
    warn "Enter a number between 1 and $EMBEDDER_COUNT."
  done
  [ "$EMBEDDER_CHOSEN" = 1 ] || fail "No valid model choice after $EMBEDDER_TRIES attempts. Re-run with --embedder <id>."

  info "Embedding model: $EMBEDDER_ID"
}

# ── Step 4: TLS ───────────────────────────────────────────────────────

env_key_set() {
  # Whether KEY already has a line in the config dir's .env.
  [ -f "$CONFIG_DIR/.env" ] || return 1
  grep -Eq "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$CONFIG_DIR/.env" 2>/dev/null
}

dotenv_value() {
  # Read one value with the daemon's deliberately small dotenv grammar. The
  # first duplicate wins, just as it does when the runtime fills process.env.
  [ -f "$CONFIG_DIR/.env" ] || return 1
  # A Docker host has no working Node; the lines this script writes itself
  # are plain KEY=value, and that is what the fallback reads.
  if ! DOTENV_VIA_NODE="$(dotenv_value_node "$1" 2>/dev/null)"; then
    DOTENV_PLAIN="$(sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$1[[:space:]]*=//p" "$CONFIG_DIR/.env" | head -n 1)"
    [ -n "$DOTENV_PLAIN" ] || return 1
    DOTENV_PLAIN="$(printf '%s' "$DOTENV_PLAIN" | sed "s/^[[:space:]]*//; s/[[:space:]]*\$//; s/^\"\(.*\)\"\$/\1/; s/^'\(.*\)'\$/\1/")"
    [ -n "$DOTENV_PLAIN" ] || return 1
    printf '%s' "$DOTENV_PLAIN"
    return 0
  fi
  printf '%s' "$DOTENV_VIA_NODE"
}

# The full grammar, through Node: exits non-zero when Node is missing or
# broken, or the key is absent.
dotenv_value_node() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
const { readFileSync } = require("node:fs");
const parsed = Object.create(null);
for (const line of readFileSync(process.argv[1], "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const assignment = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trimStart()
    : trimmed;
  const equals = assignment.indexOf("=");
  if (equals <= 0) continue;
  const key = assignment.slice(0, equals).trim();
  if (!key || Object.hasOwn(parsed, key)) continue;
  let value = assignment.slice(equals + 1).trim();
  if (value.length >= 2 && (value[0] === "\"" || value[0] === "\x27") && value.at(-1) === value[0]) {
    value = value.slice(1, -1);
  }
  parsed[key] = value;
}
const value = parsed[process.argv[2]];
if (typeof value !== "string") process.exit(1);
process.stdout.write(value);
' "$CONFIG_DIR/.env" "$1" 2>/dev/null
}

valid_gateway_port() {
  case "$1" in ""|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null
}

local_gateway_health_origin() {
  node -e '
const { isIP } = require("node:net");
const [bind, port] = process.argv.slice(1);
try {
  const host = bind === "0.0.0.0" ? "127.0.0.1" : bind === "::" ? "::1" : bind;
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  const url = new URL(`https://${authority}`);
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) process.exit(1);
  url.port = port;
  process.stdout.write(url.origin);
} catch { process.exit(1); }
' "$1" "$2"
}

align_configured_gateway_url_port() {
  # `--port` is an explicit move of this local gateway. Keep an already chosen
  # remote host, but move its client URL with the listener before any CLI call
  # can be redirected to the stale port.
  [ "$GATEWAY_PORT_EXPLICIT" = 1 ] || return 0
  ENV_URL="$(dotenv_value OMNESIS_GATEWAY_URL)" || return 0
  ALIGNED_URL="$(node -e '
try {
  const url = new URL(process.argv[1]);
  if (url.protocol !== "https:") process.exit(1);
  url.port = process.argv[2];
  process.stdout.write(url.origin);
} catch {
  process.exit(1);
}
' "$ENV_URL" "$GATEWAY_PORT" 2>/dev/null)" || return 0
  if [ "$ALIGNED_URL" != "$ENV_URL" ]; then
    TRUST_ORIGIN="$(dotenv_value OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN || true)"
    set_env OMNESIS_GATEWAY_URL "$ALIGNED_URL"
    if [ "$TRUST_ORIGIN" = "$ENV_URL" ]; then
      set_env OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN "$ALIGNED_URL"
    fi
  fi
}

custom_tls_configured() {
  # Automatic Tailscale detection may renew or replace certificates this
  # installer owns, but it must not seize an operator-managed cert/key pair.
  CONFIGURED_TLS_CERT="$(dotenv_value OMNESIS_TLS_CERT)" || CONFIGURED_TLS_CERT=""
  CONFIGURED_TLS_KEY="$(dotenv_value OMNESIS_TLS_KEY)" || CONFIGURED_TLS_KEY=""
  [ -n "$CONFIGURED_TLS_CERT" ] || [ -n "$CONFIGURED_TLS_KEY" ] || return 1
  case "$CONFIGURED_TLS_CERT|$CONFIGURED_TLS_KEY" in
    "$CONFIG_DIR/tls/mkcert.crt|$CONFIG_DIR/tls/mkcert.key"|\
    "$CONFIG_DIR/tls/tailscale.crt|$CONFIG_DIR/tls/tailscale.key") return 1 ;;
    *) return 0 ;;
  esac
}

installer_tailscale_tls_configured() {
  CONFIGURED_TLS_CERT="$(dotenv_value OMNESIS_TLS_CERT || true)"
  CONFIGURED_TLS_KEY="$(dotenv_value OMNESIS_TLS_KEY || true)"
  [ "$CONFIGURED_TLS_CERT" = "$CONFIG_DIR/tls/tailscale.crt" ] && \
    [ "$CONFIGURED_TLS_KEY" = "$CONFIG_DIR/tls/tailscale.key" ]
}

# Make what was just written survive a power cut. These files are small and
# written once, and a crash seconds after an install left the service units,
# .env and keyring.pass empty on ext4 (commit=30): systemd reported the units
# masked, nothing started at boot, and an empty keyring.pass leaves the index
# openable only with the recovery code. `sync FILE` is coreutils; where it is
# not understood, syncing everything is the honest fallback.
sync_path() {
  [ -e "$1" ] || return 0
  sync "$1" 2>/dev/null || sync 2>/dev/null || true
}

set_env() {
  # Write KEY=value in the config dir's .env, replacing any existing line.
  # For values the installer owns outright — a gateway URL has to name the
  # certificate this run just minted, and a stale one from an earlier run is
  # a handshake failure, not a preference to preserve.
  KEY="$1"; VALUE="$2"
  mkdir -p "$CONFIG_DIR"
  ( umask 077; touch "$CONFIG_DIR/.env" )
  chmod 600 "$CONFIG_DIR/.env" 2>/dev/null || true
  if env_key_set "$KEY"; then
    ENV_TMP="$CONFIG_DIR/.env.$$"
    ( umask 077; grep -Ev "^[[:space:]]*(export[[:space:]]+)?$KEY[[:space:]]*=" "$CONFIG_DIR/.env" > "$ENV_TMP" || true )
    printf '%s=%s\n' "$KEY" "$VALUE" >> "$ENV_TMP"
    mv "$ENV_TMP" "$CONFIG_DIR/.env"
  else
    printf '%s=%s\n' "$KEY" "$VALUE" >> "$CONFIG_DIR/.env"
  fi
  sync_path "$CONFIG_DIR/.env"
  sync_path "$CONFIG_DIR"
}

unset_env() {
  KEY="$1"
  [ -f "$CONFIG_DIR/.env" ] || return 0
  env_key_set "$KEY" || return 0
  ENV_TMP="$CONFIG_DIR/.env.$$"
  ( umask 077; grep -Ev "^[[:space:]]*(export[[:space:]]+)?$KEY[[:space:]]*=" "$CONFIG_DIR/.env" > "$ENV_TMP" || true )
  mv "$ENV_TMP" "$CONFIG_DIR/.env"
  sync_path "$CONFIG_DIR/.env"
  sync_path "$CONFIG_DIR"
}

append_env() {
  # Append KEY=value to the config dir's .env unless the key is already set.
  KEY="$1"; VALUE="$2"
  mkdir -p "$CONFIG_DIR"
  touch "$CONFIG_DIR/.env"
  # It carries the path to the passphrase that unseals the index, among other
  # things a neighbouring account has no business reading.
  chmod 600 "$CONFIG_DIR/.env" 2>/dev/null || true
  if env_key_set "$KEY"; then
    warn "$KEY already set in $CONFIG_DIR/.env — leaving it alone."
  else
    printf '%s=%s\n' "$KEY" "$VALUE" >> "$CONFIG_DIR/.env"
    sync_path "$CONFIG_DIR/.env"
    sync_path "$CONFIG_DIR"
  fi
}

tailscale_cli() {
  if [ "${TAILSCALE_CLI_BUNDLED:-0}" = 1 ]; then
    TAILSCALE_BE_CLI=1 "$TAILSCALE_CLI" "$@"
  else
    "$TAILSCALE_CLI" "$@"
  fi
}

# Run a command for at most $1 seconds: macOS has no timeout(1). The command
# runs in the background (so "$@" must be a program, not a shell function, for
# the kill to reach it) and a watchdog kills it when the time is up; the
# watchdog's own output goes nowhere, so a caller reading the command's output
# through a pipe is not held open by it.
run_bounded() {
  RB_LIMIT="$1"
  shift
  "$@" &
  RB_PID=$!
  (
    trap 'kill "${RB_SLEEP:-}" 2>/dev/null; exit 0' TERM
    sleep "$RB_LIMIT" &
    RB_SLEEP=$!
    wait "$RB_SLEEP" && kill "$RB_PID" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  RB_WATCHDOG=$!
  RB_STATUS=0
  wait "$RB_PID" || RB_STATUS=$?
  kill "$RB_WATCHDOG" 2>/dev/null || true
  wait "$RB_WATCHDOG" 2>/dev/null || true
  if [ "$RB_STATUS" = 143 ]; then echo "no answer within ${RB_LIMIT}s" >&2; fi
  return "$RB_STATUS"
}

# tailscale_cli, bounded to $1 seconds: a CLI that hangs (a wedged daemon, an
# app waiting on its GUI) must not stall the installer.
tailscale_cli_bounded() {
  TS_LIMIT="$1"
  shift
  if [ "${TAILSCALE_CLI_BUNDLED:-0}" = 1 ]; then
    run_bounded "$TS_LIMIT" env TAILSCALE_BE_CLI=1 "$TAILSCALE_CLI" "$@"
  else
    run_bounded "$TS_LIMIT" "$TAILSCALE_CLI" "$@"
  fi
}

tailscale_cli_ready() {
  TAILSCALE_CLI="$1"
  TAILSCALE_CLI_BUNDLED="$2"
  TS_BACKEND_STATE="$(tailscale_cli_bounded 10 status --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try { process.stdout.write(JSON.parse(s).BackendState || ""); }
      catch { /* unavailable */ }
    });' 2>/dev/null || true)"
  [ "$TS_BACKEND_STATE" = Running ]
}

find_tailscale_cli() {
  TS_PATH_CLI="$(command -v tailscale 2>/dev/null || true)"
  if [ -n "$TS_PATH_CLI" ] && tailscale_cli_ready "$TS_PATH_CLI" 0; then return 0; fi
  if [ "$PLATFORM" = darwin ]; then
    # The installer's tests point this at a scratch directory, so a developer's
    # own Tailscale is never asked for its tailnet, let alone a certificate.
    TS_ROOT="${OMNESIS_TEST_TAILSCALE_ROOT:-}"
    # Homebrew's CLI where PATH does not reach it (a non-login shell); the
    # gateway's launchd PATH gets the same fallback (tailscale-cli.ts).
    for TS_BREW_CLI in "$TS_ROOT/opt/homebrew/bin/tailscale" "$TS_ROOT/usr/local/bin/tailscale"; do
      case ":$PATH:" in *":${TS_BREW_CLI%/*}:"*) continue ;; esac
      if [ -x "$TS_BREW_CLI" ] && tailscale_cli_ready "$TS_BREW_CLI" 0; then return 0; fi
    done
    if [ -x "$TS_ROOT/Applications/Tailscale.app/Contents/MacOS/Tailscale" ] && \
       tailscale_cli_ready "$TS_ROOT/Applications/Tailscale.app/Contents/MacOS/Tailscale" 1; then return 0; fi
    if [ -x "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale" ] && \
       tailscale_cli_ready "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale" 1; then return 0; fi
  fi
  return 1
}

provision_tls() {
  PORTAL_HOST="localhost"
  [ "$WANT_TLS" = 1 ] || return 0

  if [ "$USE_MKCERT" = 1 ]; then
    if command -v mkcert >/dev/null 2>&1; then
      info "Provisioning a mkcert certificate (you may be prompted to trust the local CA)..."
      mkdir -p "$CONFIG_DIR/tls"
      HOST_VALUE="$(hostname -s 2>/dev/null || hostname)"
      HOSTLOCAL="$(node -e '
const value = process.argv[1].trim().replace(/\.$/, "").toLowerCase();
const withoutLocal = value.replace(/\.local$/i, "");
const short = withoutLocal.split(".")[0] || "";
const valid =
  short !== "localhost" &&
  short.length <= 63 &&
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(short);
process.stdout.write(valid ? `${short}.local` : "omnesis.local");
' "$HOST_VALUE")"
      PREVIOUS_TLS_CERT="$(dotenv_value OMNESIS_TLS_CERT || true)"
      PREVIOUS_TLS_KEY="$(dotenv_value OMNESIS_TLS_KEY || true)"
      if [ "$PREVIOUS_TLS_CERT" = "$CONFIG_DIR/tls/mkcert.crt" ] && \
         [ "$PREVIOUS_TLS_KEY" = "$CONFIG_DIR/tls/mkcert.key" ]; then
        MKCERT_ADDRESS_PREVIOUS="$(configured_remote_gateway_url || true)"
      fi
      mkcert -install
      # Node is already a hard installer dependency. Use an argv array so an
      # interface value can never become shell syntax, and degrade to the four
      # fixed names if this host cannot enumerate its interfaces.
      node -e '
const { execFileSync } = require("node:child_process");
const { BlockList, isIP } = require("node:net");
const { networkInterfaces } = require("node:os");

let interfaces = {};
try {
  interfaces = networkInterfaces();
} catch {
  // The fixed names still make a useful local certificate.
}

const addresses = new Set();
const blocked = new BlockList();
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addAddress("0.0.0.0", "ipv4");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
blocked.addAddress("::ffff:0.0.0.0", "ipv6");
for (const list of Object.values(interfaces || {})) {
  if (!list) continue;
  for (const entry of list) {
    if (entry.internal) continue;
    if (entry.address.includes("%")) continue;
    const family = isIP(entry.address);
    if (family === 0) continue;
    if (blocked.check(entry.address, family === 4 ? "ipv4" : "ipv6")) continue;
    addresses.add(entry.address);
  }
}

try {
  execFileSync(
    process.argv[1],
    [
      "-cert-file",
      process.argv[2],
      "-key-file",
      process.argv[3],
      "localhost",
      "127.0.0.1",
      "::1",
      process.argv[4],
      ...[...addresses].sort(),
    ],
    { stdio: "inherit" },
  );
} catch (error) {
  process.exit(typeof error.status === "number" && error.status > 0 ? error.status : 1);
}
' "$(command -v mkcert)" "$CONFIG_DIR/tls/mkcert.crt" "$CONFIG_DIR/tls/mkcert.key" "$HOSTLOCAL"
      set_env OMNESIS_TLS_CERT "$CONFIG_DIR/tls/mkcert.crt"
      set_env OMNESIS_TLS_KEY "$CONFIG_DIR/tls/mkcert.key"
      unset_env OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN
      # The local hostname is the default for another machine, but an
      # interactive install may choose any remote address in the cert below.
      MKCERT_ADDRESS_CERT="$CONFIG_DIR/tls/mkcert.crt"
      MKCERT_ADDRESS_DEFAULT="https://$HOSTLOCAL:$GATEWAY_PORT"
      # Restore a still-covered non-default choice before starting services,
      # so a startup failure cannot erase it. Defaults carry no provenance:
      # a later interactive rerun should still get the address picker.
      MKCERT_ADDRESS_PREVIOUS="$(canonical_gateway_url "$MKCERT_ADDRESS_PREVIOUS" || true)"
      MKCERT_ADDRESS_OPTIONS="$(certificate_gateway_urls "$MKCERT_ADDRESS_CERT" || true)"
      MKCERT_ADDRESS_DEFAULT="$(resolvable_gateway_url_default "$MKCERT_ADDRESS_DEFAULT" "$MKCERT_ADDRESS_OPTIONS")"
      if [ -n "$MKCERT_ADDRESS_PREVIOUS" ] && \
         [ "$MKCERT_ADDRESS_PREVIOUS" != "$MKCERT_ADDRESS_DEFAULT" ] && \
         printf '%s\n' "$MKCERT_ADDRESS_OPTIONS" | grep -Fqx "$MKCERT_ADDRESS_PREVIOUS"; then
        set_env OMNESIS_GATEWAY_URL "$MKCERT_ADDRESS_PREVIOUS"
      else
        MKCERT_ADDRESS_PREVIOUS=""
        set_env OMNESIS_GATEWAY_URL "$MKCERT_ADDRESS_DEFAULT"
      fi
      BANNER_HOST="$HOSTLOCAL"
      info "mkcert certificate installed — the portal will load without warnings."
    else
      warn "--mkcert requested but mkcert is not installed (https://mkcert.dev). Continuing with the self-signed cert."
    fi
    return 0
  fi

  if custom_tls_configured; then
    unset_env OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN
    info "Existing operator-managed TLS configuration left unchanged."
    return 0
  fi

  if find_tailscale_cli; then
    TS_NAME="$(tailscale_cli_bounded 10 status --json 2>/dev/null | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => {
        try {
          const dns = JSON.parse(s).Self.DNSName || "";
          process.stdout.write(dns.replace(/\.$/, ""));
        } catch { /* no name */ }
      });' 2>/dev/null || true)"
    if [ -n "$TS_NAME" ]; then
      info "Tailscale detected — minting a real certificate for $TS_NAME..."
      mkdir -p "$CONFIG_DIR/tls"
      if mint_tailscale_cert "$CONFIG_DIR/tls/tailscale.crt" \
                             "$CONFIG_DIR/tls/tailscale.key" "$TS_NAME"; then
        TAILSCALE_GATEWAY_URL="$(node -e 'process.stdout.write(new URL(process.argv[1]).origin)' \
          "https://$TS_NAME:$GATEWAY_PORT")"
        set_env OMNESIS_TLS_CERT "$CONFIG_DIR/tls/tailscale.crt"
        set_env OMNESIS_TLS_KEY "$CONFIG_DIR/tls/tailscale.key"
        # The cert only covers the MagicDNS name, so every local client
        # addresses the gateway by that name from now on — including a re-run
        # whose .env still carries the localhost URL of an untrusted-cert
        # install, which this certificate would reject.
        set_env OMNESIS_GATEWAY_URL "$TAILSCALE_GATEWAY_URL"
        set_env OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN "$TAILSCALE_GATEWAY_URL"
        PORTAL_HOST="$TS_NAME"
        info "Certificate installed — the portal will load without warnings at $TAILSCALE_GATEWAY_URL/portal/"
      else
        if installer_tailscale_tls_configured; then
          warn "tailscale cert renewal failed: $(tailscale_cert_reason). Keeping the existing Tailscale certificate."
        else
          unset_env OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN
          warn "tailscale cert failed: $(tailscale_cert_reason). Continuing with the self-signed cert."
        fi
        print_tailscale_cert_fix
      fi
    elif installer_tailscale_tls_configured; then
      info "Tailscale reported no MagicDNS name — keeping the existing Tailscale certificate."
      print_tailscale_magicdns_fix
    else
      unset_env OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN
      warn "Tailscale reported no MagicDNS name — continuing with the self-signed certificate."
      print_tailscale_magicdns_fix
    fi
    return 0
  fi

  # Preserve the proof from an earlier installer-owned Tailscale certificate
  # when tailscaled is temporarily unavailable. Any other TLS setup must opt
  # into system trust explicitly through gateway configuration.
  if installer_tailscale_tls_configured; then
    info "Tailscale is unavailable — keeping the existing Tailscale certificate."
    return 0
  fi
  unset_env OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN
  info "No Tailscale detected — the gateway will use its self-signed certificate."
  info "Your browser will warn once; see the docs for trusted-cert options (Tailscale or mkcert)."
  info "For Tailscale: install it, join your tailnet with 'tailscale up', enable HTTPS certificates and MagicDNS in its admin console, then run: omnesis tls provision"
  info "The installer never joins a network or changes tailnet settings for you."
}

# tailscaled answers an account that is neither root nor this machine's
# Tailscale operator with "Access denied: cert access denied". That permission
# is local to the machine — it decides which account may ask tailscaled for a
# certificate, and changes nothing on the tailnet — so an account that already
# holds sudo gains no authority it lacked by being granted it. Taking it matters
# beyond this install: the gateway runs as this same account and re-mints the
# certificate itself before it expires, so minting once through `sudo` would
# leave a certificate that nothing can renew. Any other failure is the
# operator's to resolve, and is reported rather than worked around.
# `tailscale cert` orders from Let's Encrypt, which takes seconds, so its bound
# is generous: it only keeps a hung daemon from stalling the install for good.
TS_CERT_ERROR=""
mint_tailscale_cert() {
  TS_CERT_ERROR="$(tailscale_cli_bounded 300 cert --cert-file "$1" --key-file "$2" "$3" 2>&1 >/dev/null)" && return 0
  case "$TS_CERT_ERROR" in
    *"cert access denied"*) ;;
    *) return 1 ;;
  esac
  # The dedicated-account gateway runs as an account this one does not choose
  # here, so the permission it needs is not this account's to take.
  [ "${WANT_HARDENED:-0}" = 0 ] || return 1
  [ "$PLATFORM" = linux ] || return 1
  resolve_sudo || return 1
  TS_OPERATOR="$(id -un)"
  info "tailscaled will not issue a certificate to $TS_OPERATOR — asking for the Tailscale operator permission on this machine, which the gateway needs too (it renews the certificate as $TS_OPERATOR)..."
  # Only stdout is quiet: sudo writes its password prompt and its refusals to
  # stderr, and an installer that hides those looks hung on any machine whose
  # sudo asks for a password.
  run_privileged tailscale set --operator="$TS_OPERATOR" >/dev/null || {
    warn "Could not take the Tailscale operator permission on this machine."
    return 1
  }
  TS_CERT_ERROR="$(tailscale_cli_bounded 300 cert --cert-file "$1" --key-file "$2" "$3" 2>&1 >/dev/null)" || return 1
  info "Granted on this machine only — nothing on your tailnet changed."
  return 0
}

# The first line of what tailscaled actually said, for a message that names the
# reason instead of guessing at one.
tailscale_cert_reason() {
  printf '%s\n' "$TS_CERT_ERROR" | sed -n '1p' | sed 's/[[:space:]]*$//' | grep . || printf 'no reason given'
}

# What a failed `tailscale cert` needs from the operator. The installer only
# asks tailscaled for a certificate; the tailnet settings and the permission
# to ask are the operator's, so it names them instead of changing anything.
print_tailscale_magicdns_fix() {
  info "A Tailscale certificate needs MagicDNS: enable it for the tailnet in the Tailscale admin console, then run: omnesis tls provision"
}

print_tailscale_cert_fix() {
  info "Nothing on your tailnet was changed. Enable HTTPS certificates and MagicDNS for the tailnet in the Tailscale admin console: https://tailscale.com/kb/1153/enabling-https"
  if [ "$PLATFORM" = linux ]; then
    info "On Linux, tailscale cert also needs your user to be the Tailscale operator: sudo tailscale set --operator=\$USER"
  fi
  info "Then run: omnesis tls provision"
}

# ── Step 5: opportunistic keyring setup ──────────────────────────────────────

keyring_available() {
  STATUS_JSON="$("$OMNESIS_BIN" keyring status --json 2>/dev/null || true)"
  [ -n "$STATUS_JSON" ] || return 1
  printf '%s' "$STATUS_JSON" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s);
    process.exit(j.store?.available === true && j.store?.secure === true ? 0 : 1);
  } catch {
    process.exit(1);
  }
});' >/dev/null 2>&1
}

# Whether this run leaves behind a secret the keyring would seal. A gateway has
# its index and admin token; a collector has its device token. A plain CLI host
# has neither, so it is not offered the passphrase flag, nor told to re-run with
# one. A harness host never reaches the keyring at all: the harness keeps its
# credentials in its own home.
seals_secrets() { [ "$CLIENT_ONLY_FLAG" = 0 ]; }

setup_keyring_init() {
  [ "$WANT_KEYRING" = 1 ] || { warn "Skipping keyring setup (--no-keyring) — no encryption at rest. Arm it later with: omnesis secure"; return 0; }
  if [ "$DOCKER" = 1 ]; then
    # A container has no OS keyring to open, so there is nothing to probe:
    # encryption at rest here is the passphrase backend or nothing.
    info "A container has no OS keyring — encryption at rest uses the passphrase backend."
  else
    info "Checking OS keyring availability..."
    if keyring_available; then
      if "$OMNESIS_BIN" keyring init; then
        KEYRING_READY=1
        info "Keyring root key ready."
        return 0
      fi
      # The keyring looked usable but refused the root key — a macOS keychain
      # reached from outside the login session, over SSH for instance. Going on
      # would install without encryption at rest behind a warning, so the run
      # faces the same choice as a machine with no usable keyring.
      warn "The OS keyring refused to store the install root key."
    fi
  fi

  # No usable OS keyring — a headless Linux box, or a login keychain nobody
  # unlocked. A passphrase file supplied up front answers the question; without
  # one, ask, because both answers are defensible and neither is safe to guess.
  if [ -n "$KEYRING_PASSPHRASE_FILE" ]; then
    arm_passphrase_keyring "$KEYRING_PASSPHRASE_FILE"
    return 0
  fi

  if ! is_promptable; then
    # --keyring-passphrase-file is refused by every role that seals nothing, so
    # such a run is only ever offered the flag it can actually accept.
    if seals_secrets; then
      KEYRING_REMEDY="--keyring-passphrase-file <abs-path> to arm encryption at rest from that passphrase, or --no-keyring to install without it"
    else
      KEYRING_REMEDY="--no-keyring to install without encryption at rest"
    fi
    fail "This machine has no usable OS keyring, and no terminal to ask what to do about it. Re-run with $KEYRING_REMEDY (you can arm it later with: omnesis secure)."
  fi

  echo "" >/dev/tty
  printf 'This machine has no usable OS keyring, so Omnesis cannot encrypt your\n' >/dev/tty
  printf 'index at rest yet. How would you like to proceed?\n' >/dev/tty
  printf '\n' >/dev/tty
  printf '   1) Continue without encryption at rest (arm it later: omnesis secure)\n' >/dev/tty
  printf '   2) Arm a passphrase keyring now (a generated passphrase file, readable\n' >/dev/tty
  printf '      only by you, that the service reads at start)\n' >/dev/tty
  printf '   3) Stop, so you can unlock a keyring first\n' >/dev/tty
  printf '\n' >/dev/tty

  KEYRING_TRIES=0
  while [ "$KEYRING_TRIES" -lt 5 ]; do
    KEYRING_TRIES=$((KEYRING_TRIES + 1))
    ANSWER="$(ask_tty "Choice [1]: ")"
    case "${ANSWER:-1}" in
      1)
        warn "Continuing without encryption at rest. Secret files stay owner-only."
        warn "Arm it later with: omnesis secure"
        return 0
        ;;
      2)
        generate_keyring_passphrase_file
        arm_passphrase_keyring "$KEYRING_PASSPHRASE_FILE"
        if [ "$KEYRING_READY" = 1 ]; then print_recovery_code; fi
        return 0
        ;;
      3)
        if [ "$PLATFORM" = darwin ]; then
          warn "Unlock your login keychain and re-run: open Keychain Access, unlock the"
          warn "\"login\" keychain, and install from a graphical session — a keychain is not"
          warn "unlocked for an SSH login."
        else
          warn "Install and unlock a login keyring (gnome-keyring or KWallet) in a desktop"
          warn "session and re-run, or on a headless box re-run with:"
          warn "  --keyring-passphrase-file <abs-path>"
        fi
        fail "Stopped before registering services. Nothing was started; re-run when the keyring is ready."
        ;;
      *) warn "Enter 1, 2, or 3." ;;
    esac
  done
  fail "No valid answer after $KEYRING_TRIES attempts. Re-run with --keyring-passphrase-file <abs-path> or --no-keyring."
}

# Mint the passphrase the keyring backend will be sealed with. Written before
# anything reads it, with a umask that keeps it owner-only from creation —
# never a world-readable window, however brief.
generate_keyring_passphrase_file() {
  KEYRING_PASSPHRASE_FILE="$CONFIG_DIR/keyring.pass"
  [ ! -e "$KEYRING_PASSPHRASE_FILE" ] || \
    fail "$KEYRING_PASSPHRASE_FILE already exists. Re-run with --keyring-passphrase-file $KEYRING_PASSPHRASE_FILE to use it, or move it aside."
  write_passphrase_file "$KEYRING_PASSPHRASE_FILE"
  info "Wrote $KEYRING_PASSPHRASE_FILE (owner-only)."
}

# A fresh random passphrase at $1, owner-only from the moment it exists.
write_passphrase_file() {
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR" 2>/dev/null || true
  # Node is the first choice and `/dev/urandom` the fallback, because the
  # Docker role deliberately leaves this host without a Node of its own.
  if command -v node >/dev/null 2>&1; then
    ( umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' \
        > "$1" ) || fail "Could not generate a keyring passphrase file."
  else
    ( umask 077; LC_ALL=C tr -dc 'A-Za-z0-9_-' < /dev/urandom | head -c 43 \
        > "$1" ) || fail "Could not generate a keyring passphrase file."
  fi
  [ -s "$1" ] || fail "Generated an empty keyring passphrase file."
  chmod 600 "$1"
  sync_path "$1"
  sync_path "$(dirname "$1")"
}

# Create the root key in the passphrase backend from $1 and remember how the
# service unit will have to reach the same passphrase.
arm_passphrase_keyring() {
  PASS_FILE="$1"
  # Encryption at rest was asked for, with this passphrase. When it cannot be
  # armed, stop: carrying on would leave the index unencrypted on a machine
  # whose operator chose otherwise.
  if [ ! -r "$PASS_FILE" ]; then
    fail "Keyring passphrase file not readable: $PASS_FILE. Make it readable by this account and re-run, or re-run with --no-keyring to install without encryption at rest."
  fi
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR" 2>/dev/null || true
  chmod 600 "$PASS_FILE" 2>/dev/null || true
  PASS_MODE="$(stat -c '%a' "$PASS_FILE" 2>/dev/null || stat -f '%Lp' "$PASS_FILE" 2>/dev/null || echo '')"
  if [ -n "$PASS_MODE" ] && [ "$PASS_MODE" != 600 ]; then
    warn "$PASS_FILE is mode $PASS_MODE — every local account can read the passphrase that unseals your index. Restrict it (chmod 600) and re-run."
  fi
  if OMNESIS_SECRET_STORE=passphrase OMNESIS_KEYRING_PASSPHRASE_FILE="$PASS_FILE" \
       "$OMNESIS_BIN" keyring init --backend passphrase; then
    KEYRING_READY=1
    KEYRING_BACKEND=passphrase
    KEYRING_CRED_FILE="$PASS_FILE"
    # The operator's own `omnesis` commands read the same sealed secrets the
    # daemon does, so record how to reach the passphrase. A real environment
    # variable always wins over .env, so the service unit's own credential
    # path still takes precedence inside the daemon.
    append_env OMNESIS_SECRET_STORE passphrase
    append_env OMNESIS_KEYRING_PASSPHRASE_FILE "$PASS_FILE"
    info "Passphrase keyring armed — encryption at rest is on."
  else
    fail "The passphrase keyring could not be armed with $PASS_FILE (see the error above). Fix it and re-run, or re-run with --no-keyring to install without encryption at rest."
  fi
}

# The recovery code is printed exactly once, by the command that mints it.
print_recovery_code() {
  if ! OMNESIS_SECRET_STORE=passphrase OMNESIS_KEYRING_PASSPHRASE_FILE="$KEYRING_CRED_FILE" \
         "$OMNESIS_BIN" keyring export-recovery --backend passphrase; then
    warn "Could not write a recovery envelope. Create one later with: omnesis keyring export-recovery"
  fi
}

setup_keyring_migrate() {
  [ "$WANT_KEYRING" = 1 ] || return 0
  [ "$KEYRING_READY" = 1 ] || return 0
  if [ "$KEYRING_BACKEND" = passphrase ]; then
    if OMNESIS_SECRET_STORE=passphrase OMNESIS_KEYRING_PASSPHRASE_FILE="$KEYRING_CRED_FILE" \
         "$OMNESIS_BIN" keyring migrate --backend passphrase; then
      info "Credential/token files migrated to keyring-wrapped storage."
    else
      warn "Keyring migration failed. Retry later with: OMNESIS_SECRET_STORE=passphrase OMNESIS_KEYRING_PASSPHRASE_FILE=$KEYRING_CRED_FILE omnesis keyring migrate"
    fi
    return 0
  fi
  if "$OMNESIS_BIN" keyring migrate; then
    info "Credential/token files migrated to keyring-wrapped storage."
  else
    warn "Keyring migration failed. Existing files remain owner-only; retry later with: omnesis keyring migrate"
  fi
}

# ── Steps 6-8: services + model ──────────────────────────────────────────────

# Register service units. Any arguments are the role-specific part of the
# command line (a component to install, extra unit environment); the wrapper
# path and this run's keyring wiring are the same for every role and are
# appended here.
#
# --exec pins the unit to the wrapper this install wrote. Service managers
# start daemons with a minimal environment, and ~/.local/bin is not on PATH by
# default on macOS, so resolving `omnesis` at registration time is the
# difference between a registered service and a manual "start it yourself".
service_install() {
  set -- service install "$@" --exec "$OMNESIS_BIN"
  if [ "$KEYRING_BACKEND" = passphrase ]; then
    set -- "$@" --secret-store passphrase
    if [ "$PLATFORM" = linux ]; then
      # systemd reads the file once at start and exposes it to this unit alone,
      # rather than leaving the path in the unit's environment.
      set -- "$@" --keyring-passphrase-credential "$KEYRING_CRED_FILE"
    else
      set -- "$@" --keyring-passphrase-file "$KEYRING_CRED_FILE"
    fi
  fi
  "$OMNESIS_BIN" "$@"
}

start_services() {
  if [ "$WANT_SERVICE" != 1 ]; then
    warn "Skipping service registration (--no-service). Start manually: omnesis gateway serve / omnesis collector run"
    return 0
  fi
  info "Registering gateway + collector services..."
  if ! service_install; then
    # No supervisor available (e.g. a container without systemd) — degrade
    # honestly instead of aborting the install.
    warn "Service registration failed — start the daemons manually:"
    warn "  omnesis gateway serve    # terminal 1"
    warn "  omnesis collector run    # terminal 2"
    warn "Check 'omnesis service status' first: a config directory belongs to one gateway at a time."
    WANT_SERVICE=0
  fi
}

# systemd's `enable --now` leaves an already-active unit running. An explicit
# restart proves that the package executable in the current unit actually
# started, both for delivery migrations and ordinary package upgrades.
package_service_is_running() {
  PACKAGE_SERVICE_STATUS="$("$OMNESIS_BIN" service status "$1" --json 2>/dev/null || true)"
  printf '%s' "$PACKAGE_SERVICE_STATUS" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const body = JSON.parse(raw);
    process.exit(body?.items?.some((item) => item?.component === process.argv[1] && item?.state === "running") ? 0 : 1);
  } catch { process.exit(1); }
});
' "$1"
}

restart_package_service_for_wrapper() {
  [ "$METHOD" = package ] || return 0
  info "Restarting the $1 from the verified package executable..."
  if ! "$OMNESIS_BIN" service restart "$1"; then
    warn "The $1 service did not restart from the package executable. The source launcher will be retained."
    return 1
  fi
  PACKAGE_SERVICE_STABLE=0
  PACKAGE_SERVICE_POLLS=0
  while [ "$PACKAGE_SERVICE_POLLS" -lt 10 ]; do
    if package_service_is_running "$1"; then
      PACKAGE_SERVICE_STABLE=$((PACKAGE_SERVICE_STABLE + 1))
      [ "$PACKAGE_SERVICE_STABLE" -ge 2 ] && return 0
    else
      PACKAGE_SERVICE_STABLE=0
    fi
    PACKAGE_SERVICE_POLLS=$((PACKAGE_SERVICE_POLLS + 1))
    sleep 1
  done
  warn "The $1 service did not remain running from the package executable. The source launcher will be retained."
  return 1
}

# Registering a service does not restart one that is already running: systemd's
# `enable --now` leaves an active unit on the build and definition it started
# with. A re-run restarts each source-install service that moved onto a new
# build, or that existed before this run and so may have a rewritten definition.
restart_moved_source_service() {
  [ "$METHOD" = source ] || return 0
  if [ "$SOURCE_MOVED" = 1 ]; then
    info "Restarting the $1 on the build this run installed..."
  elif registered_before_run "$1"; then
    info "Restarting the $1 on its refreshed service definition..."
  else
    return 0
  fi
  "$OMNESIS_BIN" service restart "$1" && return 0
  warn "The $1 service did not restart. Restart it with: omnesis service restart $1"
  return 1
}

# A registered gateway that never became healthy is a failed install, not a
# success: nothing is serving, even though a re-run resumes from what is in
# place. Show the gateway's own last log lines, so the cause is on screen,
# then stop with a non-zero exit instead of the welcome banner.
fail_unhealthy_gateway() {
  echo "" >&2
  warn "The gateway is not running, so Omnesis is not ready. Its last log lines:"
  if [ "$DOCKER" = 1 ]; then
    docker compose -f "$COMPOSE_FILE" logs --no-color --tail 20 gateway 2>&1 | sed 's/^/    /' >&2
    GATEWAY_LOGS_HINT="docker compose -f $COMPOSE_FILE logs gateway"
  else
    "$OMNESIS_BIN" service logs gateway --lines 20 2>&1 | sed 's/^/    /' >&2
    GATEWAY_LOGS_HINT="omnesis service logs gateway"
    print_path_hints >&2
  fi
  if [ "$WANT_MODEL" = 1 ]; then
    warn "Once the gateway runs, install the embedding model with: omnesis model install $EMBEDDER_ID"
  fi
  fail "Fix what the gateway reports above, then re-run this installer; it keeps what is already installed. Full log: $GATEWAY_LOGS_HINT"
}

# One window of /health polling: 0 as soon as the gateway answers as the
# version this run installed, 1 when the window passes without it. A window that
# heard an answer of another version sets GATEWAY_ANSWERED, which tells the wait
# below that the gateway is up rather than silent.
gateway_health_window() {
  i=0
  while [ "$i" -lt "$1" ]; do
    if GATEWAY_HEALTH_BODY="$(curl -skf "$GATEWAY_WAIT_ORIGIN/health" 2>/dev/null)"; then
      if { [ "$METHOD" = package ] || [ -n "$GATEWAY_EXPECTED_VERSION" ]; } &&
         ! printf '%s' "$GATEWAY_HEALTH_BODY" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try { process.exit(JSON.parse(raw)?.version === process.argv[1] ? 0 : 1); }
  catch { process.exit(1); }
});
' "$GATEWAY_EXPECTED_VERSION"; then
        # It answers, just not as the version this run installed: a gateway that
        # is up and serving an older build, not one that is still starting.
        # Recorded so the wait below does not treat it as silent.
        GATEWAY_ANSWERED=1
        i=$((i + 1))
        sleep 1
        continue
      fi
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# Is the gateway running under its supervisor? One that is up but silent is
# still starting, not broken, and failing the install there tells an operator to
# fix something that is not wrong.
gateway_is_supervised_and_running() {
  if [ "$DOCKER" = 1 ]; then
    docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -qx gateway
  else
    [ "$WANT_SERVICE" = 1 ] && package_service_is_running gateway
  fi
}

wait_for_gateway() {
  info "Waiting for the gateway to come up..."
  GATEWAY_WAIT_ORIGIN="${GATEWAY_HEALTH_ORIGIN:-https://localhost:$GATEWAY_PORT}"
  # A gateway still on the previous build answers /health too; after a package
  # install or a re-run that moved the checkout, only the new version counts.
  GATEWAY_EXPECTED_VERSION=""
  if [ "$METHOD" = package ]; then
    GATEWAY_EXPECTED_VERSION="$PACKAGE_INSTALLED_VERSION"
  elif [ "$SOURCE_MOVED" = 1 ]; then
    GATEWAY_EXPECTED_VERSION="$("$OMNESIS_BIN" --version 2>/dev/null || true)"
  fi
  GATEWAY_TOTAL_WAIT="$GATEWAY_WAIT_SECONDS"
  GATEWAY_ANSWERED=0
  if gateway_health_window "$GATEWAY_WAIT_SECONDS"; then
    info "Gateway is healthy."
    return 0
  fi
  # Long enough for a machine that answers quickly. Before calling this a failed
  # install, ask the supervisor: while the gateway is running, keep waiting.
  while [ "$GATEWAY_ANSWERED" = 0 ] &&
        [ "$GATEWAY_TOTAL_WAIT" -lt $((GATEWAY_WAIT_SECONDS + GATEWAY_STARTUP_MAX_SECONDS)) ] &&
        gateway_is_supervised_and_running; do
    if [ "$GATEWAY_TOTAL_WAIT" = "$GATEWAY_WAIT_SECONDS" ]; then
      info "The gateway is running but has not answered /health yet — it is still starting (a first boot applies every database migration). Waiting up to ${GATEWAY_STARTUP_MAX_SECONDS}s more."
    fi
    GATEWAY_TOTAL_WAIT=$((GATEWAY_TOTAL_WAIT + GATEWAY_STARTUP_POLL_SECONDS))
    if gateway_health_window "$GATEWAY_STARTUP_POLL_SECONDS"; then
      info "Gateway is healthy."
      return 0
    fi
  done
  if [ "$GATEWAY_ANSWERED" = 1 ]; then
    GATEWAY_ANSWERED_VERSION="$(printf '%s' "$GATEWAY_HEALTH_BODY" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try { process.stdout.write(String(JSON.parse(raw)?.version ?? "")); } catch { /* no version */ }
});' 2>/dev/null || true)"
    warn "The gateway answered as ${GATEWAY_ANSWERED_VERSION:-another version}, not ${GATEWAY_EXPECTED_VERSION:-the version this run installed} — it is serving an older build, not starting up."
  fi
  if [ "$DOCKER" = 1 ]; then
    warn "Gateway did not answer /health within ${GATEWAY_TOTAL_WAIT}s — check: docker compose -f $COMPOSE_FILE ps && docker compose -f $COMPOSE_FILE logs gateway"
  else
    warn "Gateway did not answer /health within ${GATEWAY_TOTAL_WAIT}s — check: omnesis service status && omnesis service logs gateway"
  fi
  return 1
}

install_model() {
  [ "$EMBEDDER_KEPT" = 0 ] || return 0
  [ "$WANT_MODEL" = 1 ] || { warn "Skipping embedding model (--no-model) — search runs keyword-only until you install one."; return 0; }
  info "Downloading the embedding model ($EMBEDDER_ID)..."
  if "$OMNESIS_BIN" model install "$EMBEDDER_ID"; then
    info "Embedding model installed — semantic search is live."
  else
    warn "Model download failed. Retry later with: omnesis model install $EMBEDDER_ID"
  fi
}

# ── Optional Codex-backed agent setup ────────────────────────────────────────

# Read the assignment from the healthy gateway's authoritative config. This
# preserves custom backends and avoids trusting an external file edit the
# running ConfigStore rejected.
read_agent_assignment() {
  AGENT_CONFIG_JSON="$("$OMNESIS_BIN" config get --json 2>/dev/null </dev/null)" || return 1
  AGENT_ASSIGNMENT="$(printf '%s' "$AGENT_CONFIG_JSON" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(raw)?.inference?.assignments?.agent;
    if (value !== null && value !== undefined && typeof value !== "string") process.exit(2);
    process.stdout.write(value || "");
  } catch { process.exit(2); }
});
' 2>/dev/null)" || return 1
}

# Refresh the isolated, gateway-owned Codex login and reduce its JSON status to
# four newline-delimited fields the POSIX shell can consume safely. The system
# Codex executable is never invoked; its presence only decides whether to make
# the offer.
read_codex_backend_status() {
  CODEX_STATUS_JSON="$("$OMNESIS_BIN" codex refresh --json 2>/dev/null)" || return 1
  CODEX_STATUS_SUMMARY="$(printf '%s' "$CODEX_STATUS_JSON" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(raw);
    const models = Array.isArray(value?.models) ? value.models : [];
    const reason = typeof value?.reason === "string" ? value.reason.replace(/\s+/g, " ") : "";
    process.stdout.write([
      value?.loggedIn === true ? "1" : "0",
      value?.status === "ok" && models.length > 0 ? "1" : "0",
      models.includes(process.argv[1]) ? "1" : "0",
      reason,
    ].join("\n"));
  } catch { process.exit(2); }
});
' "$CODEX_AGENT_MODEL" 2>/dev/null)" || return 1
  CODEX_LOGGED_IN="$(printf '%s\n' "$CODEX_STATUS_SUMMARY" | sed -n '1p')"
  CODEX_READY="$(printf '%s\n' "$CODEX_STATUS_SUMMARY" | sed -n '2p')"
  CODEX_HAS_AGENT_MODEL="$(printf '%s\n' "$CODEX_STATUS_SUMMARY" | sed -n '3p')"
  CODEX_STATUS_REASON="$(printf '%s\n' "$CODEX_STATUS_SUMMARY" | sed -n '4p')"
}

ask_codex_agent_setup() {
  echo "" >/dev/tty
  printf 'Codex is installed on this machine. Set up Omnesis Agent with your ChatGPT Codex login?\n' >/dev/tty
  printf '  This sends conversation context and relevant Omnesis data and tool results to OpenAI.\n' >/dev/tty
  printf '  It also enables this gateway to use explicitly configured remote inference backends.\n' >/dev/tty
  CODEX_ASK_ATTEMPTS=0
  while [ "$CODEX_ASK_ATTEMPTS" -lt 5 ]; do
    CODEX_ANSWER="$(ask_tty 'Set up the agent with Codex Luna? [y/N] ')"
    CODEX_ANSWER="$(printf '%s' "$CODEX_ANSWER" | tr '[:upper:]' '[:lower:]')"
    case "$CODEX_ANSWER" in
      y|yes) return 0 ;;
      ''|n|no) return 1 ;;
      *)
        printf 'Please answer y or n.\n' >/dev/tty
        CODEX_ASK_ATTEMPTS=$((CODEX_ASK_ATTEMPTS + 1))
        ;;
    esac
  done
  warn "No valid Codex setup choice was entered — leaving the agent unconfigured."
  return 1
}

codex_agent_setup_supported() {
  CODEX_LOGIN_HELP="$("$OMNESIS_BIN" codex login --help 2>/dev/null </dev/null)" || return 1
  printf '%s\n' "$CODEX_LOGIN_HELP" | grep -q -- '--wait' || return 1
  CODEX_SETUP_HELP="$("$OMNESIS_BIN" codex setup-agent --help 2>/dev/null </dev/null)" || return 1
  printf '%s\n' "$CODEX_SETUP_HELP" | grep -q -- 'setup-agent' || return 1
}

setup_codex_agent() {
  # This is an optional finish for a healthy ordinary gateway. Every other
  # role returns before here, while no-service and hardened installs never set
  # GATEWAY_HEALTHY. A headless install must not fail for declining an offer it
  # cannot answer.
  [ "$GATEWAY_HEALTHY" = 1 ] || return 0
  is_promptable || return 0
  command -v codex >/dev/null 2>&1 || return 0

  if ! read_agent_assignment; then
    warn "Could not inspect the current agent assignment — preserving it and skipping Codex setup."
    return 0
  fi
  [ -z "$AGENT_ASSIGNMENT" ] || return 0
  if ! codex_agent_setup_supported; then
    info "Codex detected; assisted Agent setup needs a newer Omnesis release. Run 'omnesis update', then rerun the installer."
    return 0
  fi
  ask_codex_agent_setup || return 0

  CODEX_STATUS_READ=0
  if read_codex_backend_status; then CODEX_STATUS_READ=1; fi
  if [ "$CODEX_STATUS_READ" != 1 ] || [ "$CODEX_LOGGED_IN" != 1 ]; then
    info "Starting the isolated Codex login used by Omnesis..."
    if ! "$OMNESIS_BIN" codex login --wait </dev/tty >/dev/tty; then
      warn "Codex login did not complete — the agent remains unconfigured. Retry this installer or use the manual Agent setup commands in the docs."
      return 0
    fi
    if ! read_codex_backend_status; then
      warn "Codex login completed, but its model catalog could not be refreshed. The agent remains unconfigured."
      warn "Retry this installer or use the manual Agent setup commands in the docs."
      return 0
    fi
  fi

  if [ "$CODEX_LOGGED_IN" != 1 ] || [ "$CODEX_READY" != 1 ]; then
    warn "Codex is not ready${CODEX_STATUS_REASON:+: $CODEX_STATUS_REASON}"
    warn "The agent remains unconfigured. Retry this installer or use the manual Agent setup commands in the docs."
    return 0
  fi
  if [ "$CODEX_HAS_AGENT_MODEL" != 1 ]; then
    warn "Codex login succeeded, but $CODEX_AGENT_MODEL is not available to this account."
    warn "The agent remains unconfigured. Retry with an available model using: omnesis codex setup-agent MODEL_ID"
    return 0
  fi

  # Login can take several minutes. Preserve an assignment made by another
  # terminal while the browser flow was open rather than replacing it.
  if ! read_agent_assignment; then
    warn "Could not re-check the agent assignment — preserving it and skipping Codex setup."
    return 0
  fi
  if [ -n "$AGENT_ASSIGNMENT" ]; then
    warn "The agent was assigned to $AGENT_ASSIGNMENT while Codex login was in progress — leaving it unchanged."
    return 0
  fi

  # The gateway performs the final still-unassigned check and config mutation
  # under one mutex, so a concurrent administrator's assignment always wins.
  if "$OMNESIS_BIN" codex setup-agent "$CODEX_AGENT_MODEL"; then
    info "Omnesis Agent is ready with Codex $CODEX_AGENT_MODEL."
  else
    warn "Codex is logged in, but the agent assignment was not saved."
    warn "Retry this installer or use the manual Agent setup commands in the docs."
  fi
}

# ── The collector role ───────────────────────────────────────────────────────
#
# One line turns a bare machine into a collector for a gateway running
# somewhere else: the CLI is installed exactly as `--client-only` installs it,
# then this section pairs with the gateway, registers the collector service,
# and waits for the gateway to accept it.
#
# Nothing here guesses which gateway to pair with: it is either named on the
# command line or discovered and then confirmed, and the pairing code is asked
# for on the terminal rather than defaulted from anywhere. A fingerprint —
# given or advertised — is verified against the certificate that answers. With
# no fingerprint at all the redeem falls back to the CLI's ordinary trust flow,
# which is first-sight trust, so the role passes one whenever it has one.

# The SHA-256 of the first certificate in a PEM file, as bare hex. Node rather
# than `openssl`+`sha256sum`, because the digest tool is named differently on
# macOS and Node is a hard dependency of the install anyway.
cert_fingerprint() {
  [ -f "$1" ] || return 1
  node -e '
const { createHash } = require("node:crypto");
const pem = require("node:fs").readFileSync(process.argv[1], "utf8");
const block = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
if (!block) process.exit(1);
const der = Buffer.from(block[1].replace(/\s+/g, ""), "base64");
if (der.length === 0) process.exit(1);
process.stdout.write(createHash("sha256").update(der).digest("hex"));
' "$1" 2>/dev/null
}

# Canonicalize an HTTPS URL's host while retaining an explicit port.
# Certificate-derived candidates use the same representation below.
canonical_gateway_url() {
  [ -n "$1" ] || return 1
  node -e '
try {
  const url = new URL(process.argv[1]);
  if (url.protocol !== "https:" || url.username || url.password) process.exit(1);
  let host = url.hostname.toLowerCase();
  if (!host.startsWith("[") && host.endsWith(".")) host = host.slice(0, -1);
  process.stdout.write(`https://${host}:${url.port || "443"}`);
} catch {
  process.exit(1);
}
' "$1" 2>/dev/null
}

# Read the addresses another machine can safely use from the certificate the
# gateway is actually serving. The certificate is the authority: rescanning
# interfaces here could offer a fresh address that the already-minted cert does
# not cover. Node is already required by the installer, and avoids depending
# on OpenSSL/LibreSSL's different human-readable SAN output.
# Whether this machine resolves the host in gateway URL $1. The URL an install
# records in OMNESIS_GATEWAY_URL is also where `omnesis` on this machine reaches
# the gateway, so a name only other machines resolve would cut the CLI off from
# its own gateway. A stock Linux server resolves no `.local` name (that takes
# nss-mdns), which getent reports the way the CLI's own lookups would see it;
# macOS resolves `.local` names itself. IP literals need no lookup.
gateway_url_resolves_here() {
  { [ "$PLATFORM" = linux ] && command -v getent >/dev/null 2>&1; } || return 0
  GATEWAY_URL_HOST="$(node -e '
let host = new URL(process.argv[1]).hostname;
if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
process.stdout.write(require("node:net").isIP(host) ? "" : host);
' "$1" 2>/dev/null)" || return 0
  [ -n "$GATEWAY_URL_HOST" ] || return 0
  host_resolves_here "$GATEWAY_URL_HOST"
}

# Whether this machine resolves host name $1, without Node (a Docker host has
# none). Only a Linux host with getent is asked; macOS resolves `.local` itself.
host_resolves_here() {
  { [ "$PLATFORM" = linux ] && command -v getent >/dev/null 2>&1; } || return 0
  getent hosts "$1" >/dev/null 2>&1
}

# The address an empty answer records: $1 when this machine resolves it,
# otherwise the first direct IPv4, then IPv6, among the certificate-covered
# options in $2, which list names before addresses.
resolvable_gateway_url_default() {
  if gateway_url_resolves_here "$1"; then
    printf '%s' "$1"
    return 0
  fi
  RESOLVABLE_DEFAULT="$(printf '%s\n' "$2" | grep -E '^https://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:' | head -n 1)"
  [ -n "$RESOLVABLE_DEFAULT" ] || RESOLVABLE_DEFAULT="$(printf '%s\n' "$2" | grep -E '^https://\[' | head -n 1)"
  printf '%s' "${RESOLVABLE_DEFAULT:-$1}"
}

certificate_gateway_urls() {
  [ -f "$1" ] || return 1
  node -e '
const { readFileSync } = require("node:fs");
const { X509Certificate } = require("node:crypto");
const { BlockList, isIP } = require("node:net");

const cert = new X509Certificate(readFileSync(process.argv[1], "utf8"));
const port = process.argv[2];
if (!/^\d+$/.test(port)) process.exit(1);

const blocked = new BlockList();
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addAddress("0.0.0.0", "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
blocked.addAddress("::ffff:0.0.0.0", "ipv6");

const hosts = [];
for (const entry of (cert.subjectAltName || "").split(/,\s*/)) {
  if (entry.startsWith("DNS:")) {
    const host = entry.slice(4).toLowerCase();
    const labels = host.split(".");
    const valid =
      host.length <= 253 &&
      labels.every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      );
    const localOnly = host === "localhost" || host.endsWith(".localhost");
    if (valid && !localOnly && host !== "gateway") hosts.push(host);
    continue;
  }
  if (!entry.startsWith("IP Address:")) continue;
  const host = entry.slice("IP Address:".length);
  const family = isIP(host);
  if (family === 0) continue;
  const type = family === 4 ? "ipv4" : "ipv6";
  if (!blocked.check(host, type)) hosts.push(host);
}

const unique = [...new Set(hosts)];
const rank = (host) => {
  if (host === "omnesis.local") return 0;
  const family = isIP(host);
  if (family === 0) return 1;
  return family === 4 ? 2 : 3;
};
unique.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));

for (const host of unique) {
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  const canonicalAuthority = new URL(`https://${authority}`).hostname.toLowerCase();
  process.stdout.write(`https://${canonicalAuthority}:${port}\n`);
}
' "$1" "$GATEWAY_PORT" 2>/dev/null
}

# Once the gateway has booted, let an interactive operator choose which covered
# address the printed join commands should carry. A headless install keeps the
# certificate's default, and a rerun preserves a still-covered earlier choice.
choose_certificate_gateway_url() {
  [ "$GATEWAY_HEALTHY" = 1 ] || return 0
  if [ -n "$MKCERT_ADDRESS_CERT" ]; then
    ADDRESS_CERT="$MKCERT_ADDRESS_CERT"
    ADDRESS_DEFAULT="$MKCERT_ADDRESS_DEFAULT"
    ADDRESS_PREVIOUS="$MKCERT_ADDRESS_PREVIOUS"
  else
    [ -z "${OMNESIS_TLS_CERT:-}" ] || return 0
    env_key_set OMNESIS_TLS_CERT && return 0
    configured_remote_gateway_url >/dev/null && return 0
    ADDRESS_CERT="$CONFIG_DIR/tls/cert.pem"
    ADDRESS_DEFAULT="https://omnesis.local:$GATEWAY_PORT"
    ADDRESS_PREVIOUS=""
  fi

  ADDRESS_OPTIONS="$(certificate_gateway_urls "$ADDRESS_CERT" || true)"
  [ -n "$ADDRESS_OPTIONS" ] || return 0
  printf '%s\n' "$ADDRESS_OPTIONS" | grep -Fqx "$ADDRESS_DEFAULT" || return 0
  ADDRESS_DEFAULT="$(resolvable_gateway_url_default "$ADDRESS_DEFAULT" "$ADDRESS_OPTIONS")"

  if [ -n "$ADDRESS_PREVIOUS" ] && \
     printf '%s\n' "$ADDRESS_OPTIONS" | grep -Fqx "$ADDRESS_PREVIOUS"; then
    set_env OMNESIS_GATEWAY_URL "$ADDRESS_PREVIOUS"
    return 0
  fi

  is_promptable || return 0
  ADDRESS_COUNT="$(printf '%s\n' "$ADDRESS_OPTIONS" | wc -l | tr -d ' ')"

  printf '\nWhich address should another machine use to reach this gateway?\n' >/dev/tty
  printf '  Every option is covered by the gateway certificate; choose one that resolves or routes from that machine.\n' >/dev/tty
  ADDRESS_NUM=0
  while IFS= read -r ADDRESS_URL; do
    [ -n "$ADDRESS_URL" ] || continue
    ADDRESS_NUM=$((ADDRESS_NUM + 1))
    if [ "$ADDRESS_URL" = "$ADDRESS_DEFAULT" ]; then ADDRESS_MARK="*"; else ADDRESS_MARK=" "; fi
    printf '  %s %2s) %s\n' "$ADDRESS_MARK" "$ADDRESS_NUM" "$ADDRESS_URL" >/dev/tty
  done <<EOF
$ADDRESS_OPTIONS
EOF
  # Offer IPs as the way around mDNS only when the certificate names one:
  # pairing by an address it does not cover fails the certificate check.
  if printf '%s\n' "$ADDRESS_OPTIONS" | grep -Eq '^https://([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|\[[0-9A-Fa-f:]+\])(:|/|$)'; then
    printf '  (* is the default; direct IPs also work where mDNS does not)\n' >/dev/tty
  else
    printf '  (* is the default)\n' >/dev/tty
  fi

  ADDRESS_SELECTED=""
  ADDRESS_TRIES=0
  while [ "$ADDRESS_TRIES" -lt 5 ]; do
    ADDRESS_TRIES=$((ADDRESS_TRIES + 1))
    ANSWER="$(ask_tty 'Address [1]: ')"
    if [ -z "$ANSWER" ]; then
      ADDRESS_SELECTED="$ADDRESS_DEFAULT"
      break
    fi
    case "$ANSWER" in
      *[!0-9]*|??????*) warn "Enter a number between 1 and $ADDRESS_COUNT."; continue ;;
    esac
    if [ "$ANSWER" -ge 1 ] && [ "$ANSWER" -le "$ADDRESS_COUNT" ]; then
      ADDRESS_SELECTED="$(printf '%s\n' "$ADDRESS_OPTIONS" | sed -n "${ANSWER}p")"
      break
    fi
    warn "Enter a number between 1 and $ADDRESS_COUNT."
  done
  if [ -z "$ADDRESS_SELECTED" ]; then
    warn "No valid address choice after $ADDRESS_TRIES attempts — using $ADDRESS_DEFAULT."
    ADDRESS_SELECTED="$ADDRESS_DEFAULT"
  fi
  set_env OMNESIS_GATEWAY_URL "$ADDRESS_SELECTED"
  info "Second-machine address: $ADDRESS_SELECTED"
  if ! gateway_url_resolves_here "$ADDRESS_SELECTED"; then
    warn "This machine cannot resolve $GATEWAY_URL_HOST, so omnesis commands on it will not reach the gateway at $ADDRESS_SELECTED."
    warn "Re-run the installer and choose a direct address, or make $GATEWAY_URL_HOST resolve here (for a .local name, install avahi-daemon and libnss-mdns)."
  fi
}

# Decide which gateway this machine pairs with, into PAIR_GATEWAY_URL, for
# whichever role is pairing. A named URL is taken as given. Without one, the LAN
# is browsed — the gateway advertises itself with its certificate fingerprint —
# and the hit has to be confirmed on the terminal before anything is paired.
resolve_gateway() {
  if [ -n "$PAIR_GATEWAY_URL" ]; then
    # Trailing slashes would end up in every URL the CLI builds from this.
    PAIR_GATEWAY_URL="$(printf '%s' "$PAIR_GATEWAY_URL" | sed 's#/*$##')"
    info "Gateway: $PAIR_GATEWAY_URL"
    return 0
  fi

  info "No --gateway-url given — browsing the LAN for a gateway..."
  DISCOVERED="$("$OMNESIS_BIN" devices discover --json --timeout "$DISCOVER_MS" 2>/dev/null </dev/null || true)"
  DISCOVERED_URL="$(printf '%s' "$DISCOVERED" | discover_field url)"
  if [ -z "$DISCOVERED_URL" ]; then
    fail "No gateway answered on this LAN. Multicast does not cross subnets or a VPN, so name the gateway instead: re-run with --gateway-url https://<gateway-host>:$GATEWAY_PORT (the gateway's own install printed the exact line)."
  fi
  DISCOVERED_NAME="$(printf '%s' "$DISCOVERED" | discover_field name)"
  DISCOVERED_FP="$(printf '%s' "$DISCOVERED" | discover_field fingerprint)"

  if ! is_promptable; then
    fail "Found ${DISCOVERED_NAME:-a gateway} at $DISCOVERED_URL, but there is no terminal to confirm it. Re-run with --gateway-url $DISCOVERED_URL to accept it."
  fi
  echo "" >/dev/tty
  ANSWER="$(ask_tty "Found ${DISCOVERED_NAME:-a gateway} at $DISCOVERED_URL, fingerprint ${DISCOVERED_FP:-(none advertised)} — use it? [y/N] ")"
  case "$ANSWER" in
    y|Y|yes|YES|Yes) ;;
    *) fail "Stopped without pairing. Name the gateway you meant with --gateway-url <url>." ;;
  esac

  PAIR_GATEWAY_URL="$DISCOVERED_URL"
  # An advertised fingerprint verifies the certificate that answers, which is
  # strictly better than trusting it on sight — but only when the operator did
  # not bring a fingerprint of their own, which outranks anything on the wire.
  if [ -z "$PAIR_FINGERPRINT" ] && [ -n "$DISCOVERED_FP" ]; then
    PAIR_FINGERPRINT="$DISCOVERED_FP"
  fi
}

# One string field out of the discovery JSON on stdin; empty when absent.
discover_field() {
  node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s);
    const v = j && j.found === true ? j[process.argv[1]] : undefined;
    if (typeof v === "string") process.stdout.write(v);
  } catch { /* no gateway, or a CLI too old to know the command */ }
});' "$1" 2>/dev/null || true
}

# The single-use pairing code, into PAIR_CODE, for a device of the kind named
# in $1. Read from the terminal by default: under `curl | sh` stdin is the
# script, and a code passed on the command line lands in shell history, which
# is the wrong default for a credential.
read_pairing_code() {
  PAIR_KIND="$1"
  if [ -n "$PAIR_CODE" ]; then return 0; fi
  if ! is_promptable; then
    fail "No terminal to ask for the pairing code. Mint one on the gateway host with \`omnesis devices pair --kind $PAIR_KIND\` and re-run with --code <code>."
  fi
  echo "" >/dev/tty
  printf 'Mint a pairing code on the gateway host:\n' >/dev/tty
  printf '\n    omnesis devices pair --kind %s\n\n' "$PAIR_KIND" >/dev/tty
  printf '(or in the portal: Settings → Devices)\n\n' >/dev/tty
  PAIR_CODE="$(ask_tty 'Pairing code: ')"
  [ -n "$PAIR_CODE" ] || fail "No pairing code entered. Re-run once you have one."
}

# Redeem the code and save the device token. The token file is what the
# collector daemon authenticates with from here on.
collector_pair() {
  set -- pair "$PAIR_CODE" --gateway-url "$PAIR_GATEWAY_URL"
  if [ -n "$PAIR_FINGERPRINT" ]; then
    set -- "$@" --trust-fingerprint "$PAIR_FINGERPRINT"
  fi
  set -- "$@" --save "$CONFIG_DIR/collector-token"
  info "Pairing with $PAIR_GATEWAY_URL..."
  # The redeem may have a question of its own: with no fingerprint to verify
  # against, it shows the certificate it was offered and asks. Under
  # `curl | sh` this process's stdin is the script, so hand the CLI the
  # terminal directly or it would refuse a prompt it cannot ask.
  PAIR_STATUS=0
  if is_promptable; then
    "$OMNESIS_BIN" "$@" </dev/tty || PAIR_STATUS=$?
  else
    "$OMNESIS_BIN" "$@" </dev/null || PAIR_STATUS=$?
  fi
  PAIR_OK=0; [ "$PAIR_STATUS" = 0 ] && PAIR_OK=1
  if [ "$PAIR_OK" = 0 ]; then
    RETRY_FLAGS="--gateway-url $PAIR_GATEWAY_URL"
    # Without this the retry drops the pin and silently falls back to
    # first-sight trust, which is a weaker install than the one that failed.
    if [ -n "$PAIR_FINGERPRINT" ]; then
      RETRY_FLAGS="$RETRY_FLAGS --trust-fingerprint $PAIR_FINGERPRINT"
    fi
    # 64 is EXIT_GATEWAY_DOWN: the redeem never reached the gateway, so the code
    # was not consumed and is still good. Telling the operator to mint a fresh
    # one sends them round in a circle, re-minting codes while the port stays
    # shut. The CLI has already named the address and the likely cause.
    if [ "$PAIR_STATUS" = 64 ]; then
      fail "Pairing failed — the gateway could not be reached, so nothing was registered and your code was not used. Fix reachability (see the address above), then re-run with $RETRY_FLAGS --code <code>."
    fi
    fail "Pairing failed — nothing was registered. A code is single-use and short-lived: mint a fresh one on the gateway host (omnesis devices pair --kind collector) and re-run with $RETRY_FLAGS --code <code>."
  fi
}

collector_register_service() {
  # A pairing record left by an earlier install of this machine would satisfy
  # the wait below on its first poll, and would say "online" about a daemon
  # this run never started. Only a record written after this point is evidence.
  rm -f "$CONFIG_DIR/collector-pairing-state.json"
  if [ "$WANT_SERVICE" != 1 ]; then
    warn "Skipping service registration (--no-service). Start the collector manually:"
    warn "  OMNESIS_GATEWAY_URL=$PAIR_GATEWAY_URL omnesis collector run"
    return 0
  fi
  info "Registering the collector service..."
  # The unit carries the gateway URL because a daemon starts with a minimal
  # environment: without it the collector would browse the LAN on every start
  # and could settle on a different gateway than the one it is paired with.
  if ! service_install collector --env "OMNESIS_GATEWAY_URL=$PAIR_GATEWAY_URL"; then
    warn "Service registration failed — start the collector manually:"
    warn "  OMNESIS_GATEWAY_URL=$PAIR_GATEWAY_URL omnesis collector run"
    WANT_SERVICE=0
    COLLECTOR_SERVICE_REFUSED=1
  fi
}

# The device name from the collector's own pairing record, but only once that
# record says this gateway accepted this install. The daemon writes the file
# after the gateway answers its first authenticated request, so its presence is
# the collector's own evidence that the pairing reaches all the way to the
# gateway — not merely that a unit was registered.
collector_paired_name() {
  [ -f "$CONFIG_DIR/collector-pairing-state.json" ] || return 0
  node -e '
try {
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (j.state === "paired" && j.lastAuthenticatedAt !== null && j.gatewayUrl === process.argv[2]) {
    process.stdout.write(String(j.deviceName || ""));
  }
} catch { /* not written yet, or half-written */ }
' "$CONFIG_DIR/collector-pairing-state.json" "$PAIR_GATEWAY_URL" 2>/dev/null || true
}

# Wait for the daemon this run registered to be accepted by the gateway. A run
# that registered no daemon has nothing to wait for and says nothing.
# A collector keeps provider archives and caches on this host, sealed by this
# host's root key; pairing hands it a gateway credential, never the gateway's
# storage keys. So once the root key exists, the keys those stores open with
# are minted here, before the daemon's first sync, and their state is what
# the banner reports. The daemon mints them itself at every boot as well, so a
# failure here delays encryption readiness rather than deciding it.
setup_collector_storage_keys() {
  [ "$KEYRING_READY" = 1 ] || return 0
  info "Preparing this collector's live-storage keys..."
  if [ "$KEYRING_BACKEND" = passphrase ]; then
    if OMNESIS_SECRET_STORE=passphrase OMNESIS_KEYRING_PASSPHRASE_FILE="$KEYRING_CRED_FILE" \
         "$OMNESIS_BIN" keyring storage-init --host collector --backend passphrase; then
      STORAGE_KEYS_READY=1
    fi
  elif "$OMNESIS_BIN" keyring storage-init --host collector; then
    STORAGE_KEYS_READY=1
  fi
  if [ "$STORAGE_KEYS_READY" = 1 ]; then
    info "Collector storage keys ready — provider stores are encrypted at rest."
  else
    warn "Could not prepare the collector's storage keys; the daemon creates them at start once the root key is readable. Check: omnesis keyring status"
  fi
}

collector_wait_online() {
  [ "$WANT_SERVICE" = 1 ] || return 0
  info "Waiting for the gateway to accept this collector..."
  i=0
  while [ "$i" -lt "$COLLECTOR_WAIT_SECONDS" ]; do
    COLLECTOR_DEVICE_NAME="$(collector_paired_name)"
    if [ -n "$COLLECTOR_DEVICE_NAME" ]; then
      COLLECTOR_ONLINE=1
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  warn "The gateway has not accepted this collector yet — the pairing is saved, so this is usually the daemon still starting."
  return 0
}

# What this collector's provider stores are protected by, stated where the
# operator reads the outcome of the install rather than left to scrollback.
print_collector_encryption_line() {
  if [ "$STORAGE_KEYS_READY" = 1 ]; then
    echo "  Storage:  encrypted at rest (this collector's own keys)"
  elif [ "$KEYRING_READY" = 1 ]; then
    echo "  Storage:  keys not prepared yet — the daemon mints them at start; check: omnesis keyring storage-status --host collector"
  else
    echo "  Storage:  plaintext (no keyring) — arm it later with: omnesis secure"
  fi
}

print_collector_banner() {
  echo ""
  if [ "$COLLECTOR_ONLINE" = 1 ]; then
    printf '\033[1m\033[0;32mCollector %s is online.\033[0m\n' "$COLLECTOR_DEVICE_NAME"
    echo ""
    printf '\033[1mAdd a source\033[0m — on the gateway host, or in the portal:\n'
    echo ""
    # Quoted: a device name is a hostname plus a suffix, and a hostname with a
    # space in it would otherwise print a command that cannot be pasted.
    echo "    omnesis sources add --device '$COLLECTOR_DEVICE_NAME'"
  elif [ "$WANT_SERVICE" = 1 ]; then
    printf '\033[1m\033[0;33mCollector is paired\033[0m (the service is registered but has not reached the gateway yet):\n'
    echo ""
    echo "    omnesis service status collector"
    echo "    omnesis service logs collector"
  elif [ "$COLLECTOR_SERVICE_REFUSED" = 1 ]; then
    printf '\033[1m\033[0;33mCollector is paired\033[0m (this machine refused the service — start the daemon yourself):\n'
    echo ""
    echo "    OMNESIS_GATEWAY_URL=$PAIR_GATEWAY_URL omnesis collector run"
  else
    printf '\033[1m\033[0;32mCollector is paired\033[0m (no service registered — start the daemon yourself):\n'
    echo ""
    echo "    OMNESIS_GATEWAY_URL=$PAIR_GATEWAY_URL omnesis collector run"
  fi
  echo ""
  echo "  Gateway:  $PAIR_GATEWAY_URL"
  echo "  Token:    $CONFIG_DIR/collector-token"
  print_collector_encryption_line
  echo ""
  print_full_disk_access_hint
  echo "  Manage services:  omnesis service status|logs|restart"
  echo "  Update later:     omnesis update"
  print_path_hints
  echo ""
}

# ── The harness roles ────────────────────────────────────────────────────────
#
# One line connects an agent harness — OpenClaw or Hermes — that is already
# installed on this machine to a gateway running somewhere else: the CLI is
# installed exactly as `--client-only` installs it, then `omnesis connect`
# pairs an agent device, installs the harness plugin and skill, and authorizes
# the separate OAuth principal that reads the corpus.
#
# The harness itself is never installed here. A machine that does not have one
# is refused before anything else happens — before Node, before the CLI, and
# above all before a single-use pairing code is asked for and spent, which is
# what a run on the wrong machine would otherwise burn.

# Display name for one harness, for the banner and the refusals.
harness_label() {
  case "$1" in
    openclaw) printf 'OpenClaw' ;;
    hermes)   printf 'Hermes' ;;
    *)        printf '%s' "$1" ;;
  esac
}

# The Hermes state directory, honoring the same env override the CLI reads.
hermes_home() { printf '%s' "${HERMES_HOME:-$HOME/.hermes}"; }

# Where an ordinary OpenClaw keeps its state, honoring the env overrides and the
# legacy directory the CLI reads. `connect --print-home` is the authority — this
# only has to be right often enough to refuse the wrong machine before the CLI
# is installed, and to name a directory the operator recognizes when it does.
openclaw_home() {
  if [ -n "${OPENCLAW_STATE_DIR:-}" ]; then printf '%s' "$OPENCLAW_STATE_DIR"; return 0; fi
  if [ -n "${OPENCLAW_PROFILE:-}" ] && [ "$OPENCLAW_PROFILE" != default ]; then
    printf '%s' "$HOME/.openclaw-$OPENCLAW_PROFILE"; return 0
  fi
  if [ -d "$HOME/.openclaw" ]; then printf '%s' "$HOME/.openclaw"; return 0; fi
  if [ -d "$HOME/.clawdbot" ]; then printf '%s' "$HOME/.clawdbot"; return 0; fi
  printf '%s' "$HOME/.openclaw"
}

# Refuse a machine that does not have the harness this run means to connect.
#
# Deliberately cheap and deliberately first: it looks only where an ordinary
# installation puts things, and `omnesis connect` does the authoritative
# resolution later. What it buys is the ordering — an operator who typed the
# role on the wrong machine learns it here, rather than after the install and
# after spending a code.
harness_preflight() {
  [ -n "$HARNESS" ] || return 0
  case "$HARNESS" in
    openclaw)
      OPENCLAW_DIR="$(openclaw_home)"
      if command -v openclaw >/dev/null 2>&1 || [ -d "$OPENCLAW_DIR" ]; then return 0; fi
      fail "No OpenClaw on this machine: no \`openclaw\` on PATH, and no $OPENCLAW_DIR. Install OpenClaw first — this installer never installs it — then re-run this line on the machine OpenClaw runs on."
      ;;
    hermes)
      HERMES_DIR="$(hermes_home)"
      if [ -d "$HERMES_DIR" ]; then
        # The same three candidates, in the same order, that the plugin loader
        # tries: a venv install, a checkout beside it, then PATH.
        if [ -e "$HERMES_DIR/hermes-agent/venv/bin/hermes" ] \
          || [ -e "$HERMES_DIR/hermes-agent/hermes" ] \
          || command -v hermes >/dev/null 2>&1; then
          return 0
        fi
        fail "Hermes is at $HERMES_DIR, but its executable is not: looked for $HERMES_DIR/hermes-agent/venv/bin/hermes, $HERMES_DIR/hermes-agent/hermes, and \`hermes\` on PATH. Finish the Hermes install (its venv) before connecting it."
      fi
      fail "No Hermes on this machine: no $HERMES_DIR. Install Hermes first — this installer never installs it — then re-run this line on the machine Hermes runs on."
      ;;
  esac
}

# Ask the CLI where this harness lives and what it already holds there.
#
# `connect --print-home` is the authority on the location: it applies the
# harness's own profile and legacy-directory rules, which is why this asks
# rather than guessing. What it finds there decides how `connect` is invoked:
# a connect that did not finish is resumed, an installation that already holds
# an integration is refreshed, and anything else is a fresh pairing.
harness_resolve_home() {
  HARNESS_HOME="$("$OMNESIS_BIN" connect "$HARNESS" --print-home </dev/null || true)"
  [ -n "$HARNESS_HOME" ] || fail "The installed CLI could not say where $(harness_label "$HARNESS") lives on this machine. Connect it by hand with: omnesis connect $HARNESS"
  # `connect` refuses a home that is not there, and it refuses it after the
  # code has been asked for. Refusing here instead is the whole point of
  # resolving the home before the prompt.
  [ -d "$HARNESS_HOME" ] || fail "$(harness_label "$HARNESS") is not installed at $HARNESS_HOME. Install it there first — this installer never installs it — or connect it by hand with: omnesis connect $HARNESS --dir <its home>"

  # A connect that got as far as minting a code left a journal, and one that
  # got as far as redeeming it left a recovery marker. Either is resumed with
  # the code it already holds, so asking for a fresh one would spend a second
  # code to finish work the first one already paid for.
  if [ -f "$HARNESS_HOME/omnesis/connect-redemption.json" ] \
    || [ -f "$HARNESS_HOME/omnesis/connect-recovery.json" ]; then
    HARNESS_RESUME=1
    info "$(harness_label "$HARNESS") has an unfinished connect — resuming it; no new pairing code is needed."
    # The journal carries both, and connect resumes from it. Saying so beats
    # letting the operator believe the values they typed were the ones used.
    [ "$PAIR_CODE_FLAG" = 0 ] || warn "The --code you gave is not used: the pending connect carries its own."
    [ "$PAIR_GATEWAY_URL_FLAG" = 0 ] || warn "The --gateway-url you gave is not used: the pending connect names its own."
    return 0
  fi
  if [ -f "$HARNESS_HOME/omnesis/integration.json" ] \
    && [ "$PAIR_CODE_FLAG" = 0 ] && [ "$PAIR_GATEWAY_URL_FLAG" = 0 ]; then
    HARNESS_REFRESH=1
    info "$(harness_label "$HARNESS") is already connected — refreshing its plugin and skill, keeping its pairing."
  fi
}

# Run `omnesis connect` to the end.
#
# It blocks for up to ten minutes waiting for the OAuth grant to be approved in
# a browser or the portal, so the installer stays in the foreground for it: a
# run that printed the URL and exited would leave the harness with a pairing it
# cannot read the corpus with.
harness_connect() {
  set -- connect "$HARNESS"
  if [ "$HARNESS_RESUME" = 1 ]; then
    # A bare connect picks the markers up. `--refresh` would discard them.
    :
  elif [ "$HARNESS_REFRESH" = 1 ]; then
    # --refresh reuses the recorded gateway and pairing, and connect refuses to
    # be told a different one alongside it.
    set -- "$@" --refresh
  else
    set -- "$@" --gateway-url "$PAIR_GATEWAY_URL" --code "$PAIR_CODE"
  fi
  if [ -n "$PAIR_FINGERPRINT" ]; then
    set -- "$@" --trust-fingerprint "$PAIR_FINGERPRINT"
  fi
  echo ""
  info "Connecting $(harness_label "$HARNESS")..."
  info "It will print a link to approve in your browser or the portal, and waits"
  info "up to ten minutes for that approval. Leave this running until it finishes."
  echo ""
  # Under `curl | sh` this process's stdin is the script, so hand the CLI the
  # terminal directly or it would refuse a question it cannot ask. On that
  # terminal connect asks before restarting the harness; with nobody to ask,
  # it restarts it, because the plugin it just installed loads no other way.
  if is_promptable; then
    CONNECT_OK=0; "$OMNESIS_BIN" "$@" </dev/tty && CONNECT_OK=1
  else
    CONNECT_OK=0; "$OMNESIS_BIN" "$@" --yes </dev/null && CONNECT_OK=1
  fi
  [ "$CONNECT_OK" = 1 ] || fail "Connecting $(harness_label "$HARNESS") failed — see what it reported above. A run that got as far as redeeming the code records that, so re-running \`omnesis connect $HARNESS\` resumes it without a fresh code."
}

# Resolve the harness home, find the gateway and the code when this is a fresh
# pairing, and connect.
harness_pair_and_connect() {
  harness_resolve_home
  # A refresh and a resume both already know their gateway and hold their
  # own credential; only a fresh pairing needs a gateway and a code.
  if [ "$HARNESS_REFRESH" = 0 ] && [ "$HARNESS_RESUME" = 0 ]; then
    resolve_gateway
    read_pairing_code agent
  fi
  harness_connect
}

# A harness role on a machine that already runs Omnesis connects with the CLI
# that install put there. Installing over it would move the checkout its
# gateway or collector runs from, rewrite the launcher their services start
# through, and rebuild both under the running daemons — with none of the
# restart, health check or rollback `omnesis update` wraps around that work.
# The install is present when this installer recorded a checkout, or when a
# gateway or collector service of this account is registered.
plan_existing_harness() {
  [ -n "$HARNESS" ] || return 0
  HARNESS_EXISTING_CLI=""
  if HARNESS_EXISTING_ROOT="$(recorded_source_root)"; then
    HARNESS_EXISTING_WHAT="the checkout at $HARNESS_EXISTING_ROOT"
    # The source launcher is the one entry point such an install has.
    [ ! -x "$HOME/.local/bin/omnesis" ] || HARNESS_EXISTING_CLI="$HOME/.local/bin/omnesis"
  else
    HARNESS_EXISTING_ROOT=""
  fi
  case "$REGISTERED_BEFORE_RUN" in
    " gateway collector") SERVICES_FOUND="its gateway and collector services" ;;
    " gateway") SERVICES_FOUND="its gateway service" ;;
    " collector") SERVICES_FOUND="its collector service" ;;
    *) SERVICES_FOUND="" ;;
  esac
  if [ -n "$SERVICES_FOUND" ]; then
    if [ -n "$HARNESS_EXISTING_WHAT" ]; then
      HARNESS_EXISTING_WHAT="$HARNESS_EXISTING_WHAT and $SERVICES_FOUND"
    else
      HARNESS_EXISTING_WHAT="$SERVICES_FOUND"
    fi
  fi
  [ -n "$HARNESS_EXISTING_WHAT" ] || return 0
  if [ -z "$HARNESS_EXISTING_CLI" ]; then
    resolve_existing_cli
    HARNESS_EXISTING_CLI="$EXISTING_CLI"
  fi
  [ -n "$HARNESS_EXISTING_CLI" ] || \
    fail "This machine already runs Omnesis ($HARNESS_EXISTING_WHAT), but no omnesis command was found to connect $(harness_label "$HARNESS") with. Installing another one here would replace what those services run, so nothing was changed. Repair that install first — re-run this installer without --$HARNESS — then run this line again."
  OMNESIS_BIN="$HARNESS_EXISTING_CLI"
  HARNESS_EXISTING=1
}

# Whether the CLI at $OMNESIS_BIN runs the connect this installer asks for: one
# that restarts the harness and reports on its skill. Read from its own help,
# which names every flag it accepts, so a build between releases answers for
# what it is rather than for a version number.
existing_cli_connects() {
  "$OMNESIS_BIN" connect --help </dev/null 2>/dev/null | grep -q -- '--no-restart'
}

# Make sure the CLI already here can run this role's connect. One that
# predates it is brought up to date by the machine's own updater — the one path
# that moves an install under running services with a restart, a health check
# and a rollback — after asking; with nobody to ask, the run stops and names it.
harness_require_connect_support() {
  existing_cli_connects && return 0
  EXISTING_VERSION="$("$OMNESIS_BIN" --version </dev/null 2>/dev/null || true)"
  warn "This machine's Omnesis (${EXISTING_VERSION:-version unknown}) predates the connect this role runs, which restarts $(harness_label "$HARNESS") and reports whether its skill is ready."
  is_promptable || \
    fail "Update it first with its own updater — omnesis update — then run this line again. Nothing was changed."
  ANSWER="$(ask_tty "Update this machine's Omnesis now with omnesis update? It restarts its services and rolls back on failure. [Y/n] ")"
  case "$ANSWER" in
    n|N|no|No|NO) fail "Nothing was changed. Update with: omnesis update — then run this line again." ;;
  esac
  ensure_node
  [ -z "$HARNESS_EXISTING_ROOT" ] || ensure_git
  run_machine_update "$HARNESS_EXISTING_ROOT"
  existing_cli_connects || \
    fail "The update finished, but this machine's omnesis still cannot run this connect. Run: omnesis connect $HARNESS — it prints what to do next."
}

# The harness role on a machine that already runs Omnesis: no Node, no
# checkout, no build and no keyring — only the connect, with the CLI there.
harness_on_existing_install() {
  show_install_plan
  configure_network_budget
  stage "Connecting with this machine's Omnesis"
  info "This machine already runs Omnesis ($HARNESS_EXISTING_WHAT). It is left as it is:"
  info "nothing is checked out, rebuilt or re-sealed."
  if [ -n "$PIN_VERSION$PIN_COMMIT" ] || [ "$EDGE" = 1 ] || [ "$METHOD_FLAG" = 1 ]; then
    warn "--version, --commit, --edge and --method choose what to install, and this run installs nothing. To move this machine's Omnesis, run: omnesis update"
  fi
  harness_require_connect_support
  info "Using: $OMNESIS_BIN ($("$OMNESIS_BIN" --version </dev/null 2>/dev/null || echo 'version unavailable'))"
  harness_pair_and_connect
  print_harness_banner
}

print_harness_banner() {
  echo ""
  if [ "$HARNESS_REFRESH" = 1 ]; then
    printf '\033[1m\033[0;32m%s is refreshed.\033[0m\n' "$(harness_label "$HARNESS")"
  else
    printf '\033[1m\033[0;32m%s is connected to Omnesis.\033[0m\n' "$(harness_label "$HARNESS")"
  fi
  echo ""
  echo "  Connect said above whether $(harness_label "$HARNESS") restarted with its plugin"
  echo "  and whether it reports the Omnesis skill ready, with the next step if not."
  echo ""
  echo "  Harness home:  $HARNESS_HOME"
  # A refresh and a resume both take the gateway from what is already recorded,
  # so this run has no URL of its own to name.
  if [ -n "$PAIR_GATEWAY_URL" ]; then
    echo "  Gateway:       $PAIR_GATEWAY_URL"
  fi
  echo ""
  echo "  Update later:  omnesis update"
  print_path_hints
  echo ""
}

# ── The Docker role ──────────────────────────────────────────────────────────
#
# `--docker` runs the daemons as containers instead of as user services. This
# host needs Docker and nothing else: the CLI, the gateway and the collector
# all live in published, version-tagged images, and the `omnesis` this mode
# writes is a wrapper that runs the CLI inside one of them.
#
# Everything the mode writes goes in the config directory, which is
# bind-mounted into the containers AT THE SAME ABSOLUTE PATH. That is what
# makes one set of paths true on both sides of the container boundary: the
# compose file, the keyring passphrase file and the token mean the same thing
# whether an operator or a container reads them.
#
# Four things are different in a container, and this mode says so rather than
# letting an operator discover them:
#
#   - Multicast does not cross the Docker bridge, so `--docker --collector`
#     cannot browse the LAN for a gateway and requires --gateway-url.
#   - A container has no OS keyring, so encryption at rest uses the passphrase
#     backend, armed from a mode-0600 file in the config directory.
#   - The Apple sources read macOS databases that do not exist inside a Linux
#     container, so the headline topology is a Docker gateway plus a native
#     collector on the Mac.
#   - The OAuth callback ports stay published, or no provider can redirect a
#     browser back to the collector that started the flow.

ensure_docker() {
  command -v docker >/dev/null 2>&1 || \
    fail "--docker needs Docker, which is not installed. Install it from https://docs.docker.com/get-docker/ and re-run."
  docker compose version >/dev/null 2>&1 || \
    fail "--docker needs Docker Compose v2 (the 'docker compose' subcommand). Update Docker or install the compose plugin."
  docker info >/dev/null 2>&1 || \
    fail "The Docker daemon is not reachable. Start Docker and re-run."
}

# The Unix socket this host's Docker client talks to, and the group that owns
# it. The one-shot update container needs that group to reach the daemon while
# still running as this account rather than as root.
docker_socket_facts() {
  DOCKER_SOCKET="/var/run/docker.sock"
  DOCKER_ENDPOINT="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
  case "$DOCKER_ENDPOINT" in
    ''|unix://*) ;;
    # A remote daemon has no socket to hand the update container, and bind
    # mounting the default path would make Docker create an empty directory
    # there. Say so rather than produce that.
    *) fail "This Docker context talks to $DOCKER_ENDPOINT. --docker needs a daemon on a local unix socket, because the update runs as a container that is handed that socket. Switch contexts (docker context use default) and re-run." ;;
  esac
  case "$DOCKER_ENDPOINT" in
    unix://*) DOCKER_SOCKET="${DOCKER_ENDPOINT#unix://}" ;;
  esac
  DOCKER_SOCKET_GID="$(stat -c '%g' "$DOCKER_SOCKET" 2>/dev/null || stat -f '%g' "$DOCKER_SOCKET" 2>/dev/null || true)"
  case "$DOCKER_SOCKET_GID" in ''|*[!0-9]*) DOCKER_SOCKET_GID="" ;; esac
}

# Every value this role writes into the compose file or into the wrapper,
# checked before either is written. A newline in any of them injects arbitrary
# YAML; a quote in the config directory produces a wrapper that parses and does
# nothing. The class is deliberately narrower than what a path may contain,
# because an operator meets it here, where the message can still say what to do
# about it.
docker_validate_values() {
  case "$CONFIG_DIR" in
    /*) ;;
    *) fail "--docker needs an absolute config directory; this run has '$CONFIG_DIR'. Set OMNESIS_CONFIG_DIR to an absolute path and re-run." ;;
  esac
  # The path is written into a compose file and into the wrapper, so it has to
  # survive both. A home directory outside this class needs an explicit one.
  case "$CONFIG_DIR" in
    *[!A-Za-z0-9/:._@+-]*)
      fail "The config directory $CONFIG_DIR contains a character --docker cannot put in a compose file. Point it somewhere plain: OMNESIS_CONFIG_DIR=/an/ascii/path sh install.sh --docker" ;;
  esac
  case "$IMAGE_REPO" in
    *'@'*) fail "Invalid image repository '$IMAGE_REPO': registry references cannot contain userinfo (@)." ;;
  esac
  docker_plain_value "$IMAGE_REPO" "the image repository (OMNESIS_IMAGE_REPO)"
  [ -z "$PAIR_GATEWAY_URL" ] || docker_plain_value "$PAIR_GATEWAY_URL" "--gateway-url"
  [ -z "$PAIR_FINGERPRINT" ] || docker_plain_value "$PAIR_FINGERPRINT" "--trust-fingerprint"
  [ -z "$TLS_CERT_PATH" ] || docker_plain_value "$TLS_CERT_PATH" "--tls-cert"
  [ -z "$TLS_KEY_PATH" ] || docker_plain_value "$TLS_KEY_PATH" "--tls-key"
  [ -z "$TLS_CA_PATH" ] || docker_plain_value "$TLS_CA_PATH" "--tls-ca"
}

# The certificate flags, before anything is written: a gateway host names a
# pair (and a private CA when there is one); a host that only collects can
# only name the CA it verifies the gateway with. Every file has to sit inside
# the config directory, the one path the containers are given.
docker_validate_tls_flags() {
  [ "$TLS_FILES_FLAG" = 1 ] || return 0
  if [ "$COLLECTOR" = 1 ]; then
    [ -z "$TLS_CERT_PATH$TLS_KEY_PATH" ] || \
      fail "--tls-cert and --tls-key name the certificate a gateway container serves; this host only collects. To trust a gateway behind a private CA from here, pass --tls-ca alone (or pin its fingerprint with --trust-fingerprint)."
  else
    if [ -n "$TLS_CA_PATH" ] && [ -z "$TLS_CERT_PATH$TLS_KEY_PATH" ]; then
      fail "--tls-ca names the CA that issued --tls-cert; on its own there is nothing for it to vouch for. Re-run naming all three: --tls-cert, --tls-key and --tls-ca."
    fi
    if [ -z "$TLS_CERT_PATH" ] || [ -z "$TLS_KEY_PATH" ]; then
      fail "--tls-cert and --tls-key go together: the gateway container needs the certificate and the key that belongs to it."
    fi
  fi
  docker_validate_tls_files
}

# Every file the containers are handed: inside the config directory (the one
# path they see), a regular file rather than a link to somewhere they cannot
# follow, readable, and not the gateway's own self-signed pair, which it
# renews over.
docker_validate_tls_files() {
  for TLS_FILE in "$TLS_CERT_PATH" "$TLS_KEY_PATH" "$TLS_CA_PATH"; do
    [ -n "$TLS_FILE" ] || continue
    case "$TLS_FILE" in
      */../*|*/..) fail "$TLS_FILE steps out of its directory with '..'; name the file by its plain path inside $CONFIG_DIR." ;;
      "$CONFIG_DIR"/*) ;;
      /*) fail "$TLS_FILE is outside $CONFIG_DIR. The containers see that directory and nothing else on this host, so a certificate they serve or verify has to live inside it — $CONFIG_DIR/tls/ is the usual place." ;;
      *) fail "$TLS_FILE is not an absolute path; name the file by its full path inside $CONFIG_DIR." ;;
    esac
    [ ! -L "$TLS_FILE" ] || \
      fail "$TLS_FILE is a symbolic link; the containers cannot follow it to wherever it points. Copy the file into $CONFIG_DIR/tls/ instead."
    [ -r "$TLS_FILE" ] || fail "$TLS_FILE does not exist or cannot be read. (A key written by tailscale cert under sudo belongs to root: chown it to your user.)"
  done
  case "$TLS_CERT_PATH|$TLS_KEY_PATH" in
    "$CONFIG_DIR/tls/cert.pem"|*"|$CONFIG_DIR/tls/key.pem"|"$CONFIG_DIR/tls/cert.pem|"*)
      fail "$CONFIG_DIR/tls/cert.pem and key.pem are the gateway's own self-signed pair, which it renews over. Put your certificate at another name — $CONFIG_DIR/tls/tailscale.crt, mkcert.crt, or gateway.crt — and re-run." ;;
  esac
}

docker_plain_value() {
  case "$1" in
    # Brackets are here for an IPv6 gateway URL, which is a plain scalar
    # everywhere this emits one.
    *[!A-Za-z0-9/:._@+[]-]*)
      fail "$2 contains a character --docker cannot put in a compose file: $1 — use only letters, digits and / : . _ @ + - [ ]" ;;
  esac
}

# Resolve the exact OCI repository used by this role. Image references keep
# the operator's prefix; only Docker Hub's API hostname differs from it.
docker_registry_facts() {
  case "$IMAGE_REPO" in
    */) fail "Invalid image repository '$IMAGE_REPO': remove the trailing slash." ;;
  esac
  REGISTRY_FIRST="${IMAGE_REPO%%/*}"
  case "$REGISTRY_FIRST" in
    *'['*|*']'*)
      printf '%s\n' "$REGISTRY_FIRST" | grep -Eq '^\[[0-9A-Fa-f:]*:[0-9A-Fa-f:]*\](:[0-9]+)?$' || fail "Invalid image repository '$IMAGE_REPO': use a complete bracketed IPv6 registry host, optionally followed by a numeric port."
      ;;
    *:*)
      printf '%s\n' "$REGISTRY_FIRST" | grep -Eq '^[A-Za-z0-9.-]+:[0-9]+$' || fail "Invalid image repository '$IMAGE_REPO': bracket IPv6 hosts and use a numeric registry port."
      ;;
  esac
  case "$REGISTRY_FIRST" in
    *.*|*:*|localhost)
      REGISTRY_HOST="$REGISTRY_FIRST"
      if [ "$IMAGE_REPO" = "$REGISTRY_FIRST" ]; then
        REGISTRY_NAMESPACE=""
      else
        REGISTRY_NAMESPACE="${IMAGE_REPO#*/}"
      fi
      ;;
    *)
      REGISTRY_HOST="docker.io"
      REGISTRY_NAMESPACE="$IMAGE_REPO"
      ;;
  esac
  REGISTRY_API_HOST="$REGISTRY_HOST"
  case "$REGISTRY_HOST" in
    docker.io|index.docker.io)
      REGISTRY_API_HOST="registry-1.docker.io"
      [ -n "$REGISTRY_NAMESPACE" ] || REGISTRY_NAMESPACE="library"
      REGISTRY_LOGIN_COMMAND="docker login"
      ;;
    *'['*) REGISTRY_LOGIN_COMMAND="docker login '$REGISTRY_HOST'" ;;
    *) REGISTRY_LOGIN_COMMAND="docker login $REGISTRY_HOST" ;;
  esac
  REGISTRY_SCHEME="https"
  case "$REGISTRY_API_HOST" in
    localhost|localhost:*|127.0.0.1|127.0.0.1:*|'[::1]'|'[::1]':*) REGISTRY_SCHEME="http" ;;
  esac
}

docker_registry_prepare() {
  docker_registry_facts
  TMP_PARENT="${TMPDIR:-/tmp}"
  REGISTRY_TMP_DIR="$(mktemp -d "$TMP_PARENT/omnesis-registry.XXXXXX")" || fail "Could not create a private temporary directory for registry checks."
  chmod 700 "$REGISTRY_TMP_DIR"
  if [ "$COLLECTOR" = 1 ]; then
    REGISTRY_REQUIRED_IMAGES="omnesis-collector omnesis-updater"
  else
    REGISTRY_REQUIRED_IMAGES="omnesis-gateway omnesis-collector omnesis-updater"
  fi
}

docker_registry_auth_failure() {
  REGISTRY_AUTH_STAGE="${1:-discovery}"
  REGISTRY_AUTH_TARGET="${2:-$IMAGE_REPO/$REGISTRY_IMAGE}"
  if [ "$REGISTRY_AUTH_STAGE" = discovery ]; then
    REGISTRY_AUTH_RETRY="Then re-run this installer with an exact published tag: --version X.Y.Z."
  else
    REGISTRY_AUTH_RETRY="Then re-run the same installer command."
  fi
  fail "The registry denied access while reading $REGISTRY_AUTH_TARGET. Log in first:
  $REGISTRY_LOGIN_COMMAND
Follow Docker's prompt using credentials or a token with permission to read the package. Never pass the token to this installer.
$REGISTRY_AUTH_RETRY"
}

docker_registry_failure() {
  fail "Could not resolve the newest release from $IMAGE_REPO/$REGISTRY_IMAGE. Check the registry or network connection and confirm it lists a stable X.Y.Z tag, or skip discovery with --version X.Y.Z."
}

docker_registry_request() {
  REGISTRY_URL="$1"
  REGISTRY_TOKEN="${2:-}"
  : > "$REGISTRY_TMP_DIR/headers"
  : > "$REGISTRY_TMP_DIR/body"
  if [ -n "$REGISTRY_TOKEN" ]; then
    if ! REGISTRY_STATUS="$(curl -sS --max-time 10 --max-filesize 1048576 --config "$REGISTRY_TMP_DIR/curl-auth" -D "$REGISTRY_TMP_DIR/headers" -o "$REGISTRY_TMP_DIR/body" -w '%{http_code}' "$REGISTRY_URL" 2>/dev/null)"; then docker_registry_failure; fi
  elif ! REGISTRY_STATUS="$(curl -sS --max-time 10 --max-filesize 1048576 -D "$REGISTRY_TMP_DIR/headers" -o "$REGISTRY_TMP_DIR/body" -w '%{http_code}' "$REGISTRY_URL" 2>/dev/null)"; then
    docker_registry_failure
  fi
}

# Extract one quoted parameter from the leading Bearer challenge. Commas in a
# quoted value stay inside that value; a later auth scheme ends the challenge,
# so its realm can never replace the registry's token realm.
docker_registry_auth_param() {
  printf '%s\n' "$AUTH_CHALLENGE" | awk -v wanted="$1" '
    function trim(value) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      return value
    }
    function consider(part, equals, key, value) {
      part = trim(part)
      equals = index(part, "=")
      if (equals == 0) return 1
      key = tolower(trim(substr(part, 1, equals - 1)))
      if (key !~ /^[a-z][a-z0-9._~-]*$/) return 1
      if (key != wanted) return 0
      value = trim(substr(part, equals + 1))
      if (value ~ /^"[^"]*"$/) print substr(value, 2, length(value) - 2)
      return 1
    }
    {
      line = $0
      sub(/^[^:]*:[[:space:]]*[Bb][Ee][Aa][Rr][Ee][Rr][[:space:]]+/, "", line)
      part = ""
      quoted = 0
      escaped = 0
      for (i = 1; i <= length(line); i++) {
        character = substr(line, i, 1)
        if (escaped) {
          part = part character
          escaped = 0
        } else if (quoted && character == "\\") {
          part = part character
          escaped = 1
        } else if (character == "\"") {
          part = part character
          quoted = !quoted
        } else if (character == "," && !quoted) {
          if (consider(part)) exit
          part = ""
        } else {
          part = part character
        }
      }
      consider(part)
    }
  '
}

docker_registry_token() {
  AUTH_CHALLENGE="$(tr -d '\r' < "$REGISTRY_TMP_DIR/headers" | grep -i '^www-authenticate:[[:space:]]*bearer[[:space:]]' | head -1 || true)"
  TOKEN_REALM="$(docker_registry_auth_param realm)"
  TOKEN_SERVICE="$(docker_registry_auth_param service)"
  case "$TOKEN_REALM" in
    https://*|http://localhost/*|http://localhost:*/*|http://127.0.0.1/*|http://127.0.0.1:*/*|http://\[::1\]/*|http://\[::1\]:*/*) ;;
    *) docker_registry_failure ;;
  esac
  : > "$REGISTRY_TMP_DIR/token"
  if [ -n "$TOKEN_SERVICE" ]; then
    if ! TOKEN_STATUS="$(curl -sS --max-time 10 --max-filesize 65536 --get --data-urlencode "service=$TOKEN_SERVICE" --data-urlencode "scope=repository:$REGISTRY_REPOSITORY:pull" -o "$REGISTRY_TMP_DIR/token" -w '%{http_code}' "$TOKEN_REALM" 2>/dev/null)"; then docker_registry_failure; fi
  else
    if ! TOKEN_STATUS="$(curl -sS --max-time 10 --max-filesize 65536 --get --data-urlencode "scope=repository:$REGISTRY_REPOSITORY:pull" -o "$REGISTRY_TMP_DIR/token" -w '%{http_code}' "$TOKEN_REALM" 2>/dev/null)"; then docker_registry_failure; fi
  fi
  case "$TOKEN_STATUS" in 401|403) docker_registry_auth_failure ;; 200) ;; *) docker_registry_failure ;; esac
  REGISTRY_TOKEN="$(tr -d '\r\n' < "$REGISTRY_TMP_DIR/token" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$REGISTRY_TOKEN" ] || REGISTRY_TOKEN="$(tr -d '\r\n' < "$REGISTRY_TMP_DIR/token" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  case "$REGISTRY_TOKEN" in ''|*[!A-Za-z0-9._~+/=-]*) docker_registry_failure ;; esac
  (umask 077; printf 'header = "Authorization: Bearer %s"\n' "$REGISTRY_TOKEN" > "$REGISTRY_TMP_DIR/curl-auth") || docker_registry_failure
}

docker_registry_next_url() {
  REGISTRY_LINK_HEADER="$(tr -d '\r' < "$REGISTRY_TMP_DIR/headers" | grep -i '^link:' | head -1 || true)"
  [ -n "$REGISTRY_LINK_HEADER" ] || return 1
  printf '%s\n' "$REGISTRY_LINK_HEADER" | grep -Eiq ';[[:space:]]*rel=("next"|next)([[:space:]]*;|[[:space:]]*$)' || docker_registry_failure
  REGISTRY_NEXT_LINK="$(printf '%s\n' "$REGISTRY_LINK_HEADER" | sed -n 's/^[^<]*<\([^>]*\)>.*/\1/p')"
  [ -n "$REGISTRY_NEXT_LINK" ] || docker_registry_failure
  REGISTRY_TAGS_PATH="/v2/$REGISTRY_REPOSITORY/tags/list"
  case "$REGISTRY_NEXT_LINK" in
    "$REGISTRY_TAGS_PATH"\?*)
      REGISTRY_NEXT_QUERY="${REGISTRY_NEXT_LINK#"$REGISTRY_TAGS_PATH"}"
      REGISTRY_NEXT_URL="$REGISTRY_SCHEME://$REGISTRY_API_HOST$REGISTRY_NEXT_LINK"
      ;;
    "$REGISTRY_TAGS_BASE"\?*)
      REGISTRY_NEXT_QUERY="${REGISTRY_NEXT_LINK#"$REGISTRY_TAGS_BASE"}"
      REGISTRY_NEXT_URL="$REGISTRY_NEXT_LINK"
      ;;
    *) docker_registry_failure ;;
  esac
  printf '%s\n' "$REGISTRY_NEXT_QUERY" | grep -Eq '^\?[A-Za-z0-9._~%=&+/:,-]+$' || docker_registry_failure
}

docker_registry_stable_tags() {
  tr '\r\n\t' '   ' < "$REGISTRY_TMP_DIR/body" |
    sed -n 's/^[[:space:]]*{.*"tags"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*}[[:space:]]*$/\1/p' |
    tr ',' '\n' |
    sed -n 's/^[[:space:]]*"\([^"]*\)"[[:space:]]*$/\1/p' |
    grep -E '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || true
}

# List every stable concrete tag for one repository. The OCI Distribution API
# may paginate even when no limit was requested, so each page is bounded and a
# same-origin next link is followed with repeat and page-count guards.
docker_registry_list_tags() {
  REGISTRY_IMAGE="$1"
  REGISTRY_TAG_OUTPUT="$2"
  if [ -n "$REGISTRY_NAMESPACE" ]; then
    REGISTRY_REPOSITORY="$REGISTRY_NAMESPACE/$REGISTRY_IMAGE"
  else
    REGISTRY_REPOSITORY="$REGISTRY_IMAGE"
  fi
  REGISTRY_TAGS_BASE="$REGISTRY_SCHEME://$REGISTRY_API_HOST/v2/$REGISTRY_REPOSITORY/tags/list"
  REGISTRY_URL="$REGISTRY_TAGS_BASE?n=1000"
  REGISTRY_TOKEN=""
  REGISTRY_PAGE=1
  : > "$REGISTRY_TAG_OUTPUT"
  : > "$REGISTRY_TMP_DIR/seen-urls"
  printf '%s\n' "$REGISTRY_URL" >> "$REGISTRY_TMP_DIR/seen-urls"

  while :; do
    docker_registry_request "$REGISTRY_URL" "$REGISTRY_TOKEN"
    if [ "$REGISTRY_STATUS" = 401 ] && [ -z "$REGISTRY_TOKEN" ]; then
      grep -Eiq '^www-authenticate:[[:space:]]*bearer[[:space:]]' "$REGISTRY_TMP_DIR/headers" || docker_registry_auth_failure
      docker_registry_token
      docker_registry_request "$REGISTRY_URL" "$REGISTRY_TOKEN"
    fi
    case "$REGISTRY_STATUS" in 401|403) docker_registry_auth_failure ;; esac
    [ "$REGISTRY_STATUS" = 200 ] || docker_registry_failure
    docker_registry_stable_tags >> "$REGISTRY_TAG_OUTPUT"
    docker_registry_next_url || break
    REGISTRY_PAGE=$((REGISTRY_PAGE + 1))
    [ "$REGISTRY_PAGE" -le 10 ] || docker_registry_failure
    grep -Fqx "$REGISTRY_NEXT_URL" "$REGISTRY_TMP_DIR/seen-urls" && docker_registry_failure
    printf '%s\n' "$REGISTRY_NEXT_URL" >> "$REGISTRY_TMP_DIR/seen-urls"
    REGISTRY_URL="$REGISTRY_NEXT_URL"
  done

  REGISTRY_TAG_BYTES="$(wc -c < "$REGISTRY_TAG_OUTPUT" | tr -d '[:space:]')"
  REGISTRY_TAG_COUNT="$(wc -l < "$REGISTRY_TAG_OUTPUT" | tr -d '[:space:]')"
  [ "$REGISTRY_TAG_BYTES" -le 1048576 ] && [ "$REGISTRY_TAG_COUNT" -le 10000 ] || docker_registry_failure
  LC_ALL=C sort -u -o "$REGISTRY_TAG_OUTPUT" "$REGISTRY_TAG_OUTPUT"
  [ -s "$REGISTRY_TAG_OUTPUT" ] || docker_registry_failure
}

# The image tag this install runs. A named --version is exact; otherwise the
# registry being pulled from chooses the newest concrete stable release.
docker_resolve_tag() {
  if [ -n "$PIN_VERSION" ]; then
    IMAGE_TAG="$PIN_VERSION"
    info "Image tag: $IMAGE_TAG"
    return 0
  fi
  info "Resolving the newest published release..."
  REGISTRY_IMAGE_NUMBER=0
  for REGISTRY_IMAGE in $REGISTRY_REQUIRED_IMAGES; do
    REGISTRY_IMAGE_NUMBER=$((REGISTRY_IMAGE_NUMBER + 1))
    REGISTRY_TAG_OUTPUT="$REGISTRY_TMP_DIR/tags-$REGISTRY_IMAGE_NUMBER"
    docker_registry_list_tags "$REGISTRY_IMAGE" "$REGISTRY_TAG_OUTPUT"
    if [ "$REGISTRY_IMAGE_NUMBER" = 1 ]; then
      cp "$REGISTRY_TAG_OUTPUT" "$REGISTRY_TMP_DIR/common-tags"
    else
      awk 'NR == FNR { available[$0] = 1; next } available[$0]' "$REGISTRY_TAG_OUTPUT" "$REGISTRY_TMP_DIR/common-tags" > "$REGISTRY_TMP_DIR/common-tags-next"
      mv "$REGISTRY_TMP_DIR/common-tags-next" "$REGISTRY_TMP_DIR/common-tags"
    fi
  done

  if sort -V </dev/null >/dev/null 2>&1; then
    IMAGE_TAG="$(LC_ALL=C sort -V "$REGISTRY_TMP_DIR/common-tags" | tail -1)"
  else
    IMAGE_TAG="$(LC_ALL=C sort -t. -k1,1n -k2,2n -k3,3n "$REGISTRY_TMP_DIR/common-tags" | tail -1)"
  fi
  [ -n "$IMAGE_TAG" ] || fail "Could not find a stable X.Y.Z tag shared by every required image under $IMAGE_REPO. Check that the release finished publishing, or skip discovery with --version X.Y.Z."
  info "Image tag: $IMAGE_TAG"
}

docker_diagnostic_is_auth() {
  grep -Eiq 'unauthorized|authentication required|no basic auth credentials|pull access denied|requested access.*denied|insufficient scope|(^|[^[:alpha:]])forbidden([^[:alpha:]]|$)|denied:[[:space:]]*denied' "$1"
}

docker_diagnostic_is_missing() {
  grep -Eiq 'manifest unknown|no such manifest|manifest[^:]*: not found' "$1"
}

docker_image_missing_failure() {
  REGISTRY_MISSING_TARGET="${1:-$IMAGE_REPO/$REGISTRY_IMAGE:$IMAGE_TAG}"
  fail "Could not find $REGISTRY_MISSING_TARGET. Check that the tag exists for every required image."
}

# Ask Docker itself before writing compose state. Unlike anonymous tag
# discovery, this reads the credentials saved by `docker login`. Older Docker
# releases may not support manifest inspection; an unclassified failure falls
# through to the authoritative compose pull below.
docker_preflight_images() {
  [ "$DOCKER_BUILD_FLAG" = 0 ] || return 0
  REGISTRY_IMAGE_NUMBER=0
  for REGISTRY_IMAGE in $REGISTRY_REQUIRED_IMAGES; do
    REGISTRY_IMAGE_NUMBER=$((REGISTRY_IMAGE_NUMBER + 1))
    REGISTRY_DIAGNOSTIC="$REGISTRY_TMP_DIR/manifest-$REGISTRY_IMAGE_NUMBER.err"
    set -- docker manifest inspect
    [ "$REGISTRY_SCHEME" = https ] || set -- "$@" --insecure
    set -- "$@" "$IMAGE_REPO/$REGISTRY_IMAGE:$IMAGE_TAG"
    if "$@" >/dev/null 2>"$REGISTRY_DIAGNOSTIC"; then
      continue
    fi
    if docker_diagnostic_is_auth "$REGISTRY_DIAGNOSTIC"; then
      cat "$REGISTRY_DIAGNOSTIC" >&2
      docker_registry_auth_failure resolved "$IMAGE_REPO/$REGISTRY_IMAGE:$IMAGE_TAG"
    fi
  done
}

# The checkout to build images from, when there is one. `--build` demands it;
# without the flag it is only what the pull's failure message names, because a
# build section left in the compose file would let a later `docker compose up`
# silently compile the daemons from whatever is in that checkout by then.
docker_resolve_build_context() {
  if [ -n "$DOCKER_BUILD_CONTEXT" ]; then
    [ -f "$DOCKER_BUILD_CONTEXT/Dockerfile" ] || \
      fail "No Dockerfile in $DOCKER_BUILD_CONTEXT — OMNESIS_DOCKER_BUILD_CONTEXT must name an Omnesis checkout."
    return 0
  fi
  case "${0:-}" in
    */*)
      BUILD_CANDIDATE="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd || true)"
      if [ -n "$BUILD_CANDIDATE" ] && [ -f "$BUILD_CANDIDATE/Dockerfile" ]; then
        DOCKER_BUILD_CONTEXT="$BUILD_CANDIDATE"
      fi
      ;;
  esac
  if [ "$DOCKER_BUILD_FLAG" = 1 ] && [ -z "$DOCKER_BUILD_CONTEXT" ]; then
    fail "--build needs the checkout this script came from, and a piped install is only the script. Clone the repository and run scripts/install.sh --docker --build from it, or drop --build to pull the published images."
  fi
}

# Create the directories the containers mount, before they are mounted. Docker
# would otherwise create a missing one itself, owned by root, and every write
# from the container's unprivileged account into it would fail.
docker_prepare_dirs() {
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR" 2>/dev/null || true
  if [ "$COLLECTOR" = 1 ]; then
    mkdir -p "$CONFIG_DIR/collector"
    chmod 700 "$CONFIG_DIR/collector" 2>/dev/null || true
  fi
  # The gateway mints its certificate here on first boot; the directory has to
  # exist before it is mounted or Docker creates it as root. A host that only
  # collects has no gateway and mints nothing.
  [ "$COLLECTOR" = 1 ] || mkdir -p "$CONFIG_DIR/tls"
}

# The directory the collector container calls its own. On a gateway host that
# is the gateway's, exactly as it is for the collector service of a native
# gateway install: the bootstrap token it self-pairs with, the certificate it
# verifies and the keyring wiring are all already there. A host that only
# collects has no gateway beside it, so it keeps a directory of its own.
docker_collector_config_dir() {
  if [ "$COLLECTOR" = 1 ]; then
    printf '%s/collector' "$CONFIG_DIR"
  else
    printf '%s' "$CONFIG_DIR"
  fi
}

# What the collector container dials. In a full stack that is the gateway
# beside it on the compose network, whose self-signed certificate carries
# `DNS:gateway`; on a collector-only host it is the gateway named on the
# command line.
docker_collector_gateway_url() {
  if [ "$COLLECTOR" = 1 ]; then
    printf '%s' "$PAIR_GATEWAY_URL"
  elif [ -n "$TLS_PRIMARY_NAME" ]; then
    # A certificate the operator supplied covers its own names, not the
    # service name; the gateway answers to them on the compose network.
    printf 'https://%s:7600' "$TLS_PRIMARY_NAME"
  else
    printf 'https://gateway:7600'
  fi
}

# The CA line a container gets when the gateway's certificate chains to a
# private one, so verification stays on and the name is checked as usual.
docker_compose_ca_env() {
  [ -z "$TLS_CA_PATH" ] || printf '      - NODE_EXTRA_CA_CERTS=%s\n' "$TLS_CA_PATH"
}

# The compose project this install's containers belong to. Every compose
# command names a project rather than a file, so a `down` in one install would
# tear down another that shared the name. The default config directory keeps
# the plain name an operator expects to see in `docker ps` — there is one of
# those per account, and two accounts running gateways on one host would
# already be fighting over the same ports. Anywhere else — a second instance, a
# test rig — derives a name from the path, so the two never meet.
docker_project_name() {
  if [ "$CONFIG_DIR" = "$HOME/.config/omnesis" ]; then
    printf 'omnesis'
    return 0
  fi
  printf 'omnesis-%s' "$(printf '%s' "$CONFIG_DIR" | cksum | cut -d' ' -f1)"
}

docker_compose_gateway_service() {
  printf '  gateway:\n'
  printf '    image: "%s/omnesis-gateway:${OMNESIS_IMAGE_TAG}"\n' "$IMAGE_REPO"
  if [ "$DOCKER_BUILD_FLAG" = 1 ]; then
    printf '    build:\n      context: %s\n      target: gateway-runtime\n' "$DOCKER_BUILD_CONTEXT"
  fi
  # The certificate the gateway mints for itself carries `DNS:gateway`, so the
  # collector verifies the name it dials instead of waving the check through.
  printf '    hostname: gateway\n'
  if [ -n "$TLS_ALIAS_NAMES" ]; then
    # A supplied certificate covers the operator's names instead; the gateway
    # answers to every one of them on the compose network, so the collector
    # dials one and verifies it against the certificate as any client would.
    printf '    networks:\n      default:\n        aliases:\n'
    for TLS_ALIAS in $TLS_ALIAS_NAMES; do
      printf '          - %s\n' "$TLS_ALIAS"
    done
  fi
  printf '    user: "%s:%s"\n' "$HOST_UID" "$HOST_GID"
  printf '    ports:\n      - "%s:7600"\n' "$GATEWAY_PORT"
  printf '    volumes:\n'
  printf '      # Mounted at the same absolute path it has on this host, so every path\n'
  printf '      # this install records means the same thing on both sides of the\n'
  printf '      # container boundary.\n'
  printf '      - %s:%s\n' "$CONFIG_DIR" "$CONFIG_DIR"
  printf '    environment:\n'
  printf '      - OMNESIS_CONFIG_DIR=%s\n' "$CONFIG_DIR"
  printf '      - OMNESIS_LOG_LEVEL=%s\n' "$LOG_LEVEL"
  if [ -n "$DOCKER_EXTRA_NAMES" ]; then
    # The host's own names, which the container cannot see, for the
    # certificate the gateway mints for itself: another machine dials those.
    printf '      - OMNESIS_TLS_EXTRA_NAMES=%s\n' "$DOCKER_EXTRA_NAMES"
  fi
  # The CLI that runs in this container dials the gateway by its own name.
  docker_compose_ca_env
  # A first boot builds indexes, so the start period is generous: a check that
  # fails inside it does not count against the retries.
  printf '    healthcheck:\n'
  printf '      test: ["CMD", "curl", "-sfk", "https://localhost:7600/health"]\n'
  printf '      interval: 5s\n      timeout: 3s\n      retries: 5\n      start_period: 120s\n'
  # The gateway drains and closes its stores on SIGTERM within its own budget;
  # Docker's default 10 s grace would SIGKILL it mid-close.
  printf '    stop_grace_period: 90s\n'
  printf '    restart: unless-stopped\n'
}

docker_compose_collector_service() {
  printf '  collector:\n'
  printf '    image: "%s/omnesis-collector:${OMNESIS_IMAGE_TAG}"\n' "$IMAGE_REPO"
  if [ "$DOCKER_BUILD_FLAG" = 1 ]; then
    printf '    build:\n      context: %s\n      target: collector-runtime\n' "$DOCKER_BUILD_CONTEXT"
  fi
  printf '    user: "%s:%s"\n' "$HOST_UID" "$HOST_GID"
  printf '    ports:\n'
  printf '      # OAuth callback ports. A provider redirects the browser to\n'
  printf '      # http://localhost:<port>, so the host side has to be the port that\n'
  printf '      # provider is registered against, and cannot be moved without\n'
  printf '      # re-registering every OAuth client.\n'
  for OAUTH_PORT in 3000 3001 3002 3003; do
    if [ "$OAUTH_HOST_PORTS" = ephemeral ]; then
      printf '      - "0:%s"\n' "$OAUTH_PORT"
    else
      printf '      - "%s:%s"\n' "$OAUTH_PORT" "$OAUTH_PORT"
    fi
  done
  printf '    volumes:\n'
  printf '      # The whole config directory, even when this collector keeps its own\n'
  printf '      # subdirectory: the passphrase that unseals its secrets lives beside\n'
  printf '      # it, and a bind mount cannot reach outside itself.\n'
  printf '      - %s:%s\n' "$CONFIG_DIR" "$CONFIG_DIR"
  printf '    environment:\n'
  printf '      - OMNESIS_CONFIG_DIR=%s\n' "$(docker_collector_config_dir)"
  printf '      - OMNESIS_GATEWAY_URL=%s\n' "$(docker_collector_gateway_url)"
  printf '      - OMNESIS_LOG_LEVEL=%s\n' "$LOG_LEVEL"
  docker_compose_ca_env
  if [ -n "$PAIR_FINGERPRINT" ]; then
    printf '      - OMNESIS_TRUST_FINGERPRINT=%s\n' "$PAIR_FINGERPRINT"
  fi
  if [ "$COLLECTOR" = 0 ]; then
    printf '    depends_on:\n      gateway:\n        condition: service_healthy\n'
  fi
  printf '    restart: unless-stopped\n'
}

docker_compose_updater_service() {
  printf '  updater:\n'
  printf '    # Never started by `up`: `omnesis update` runs it as a one-shot container,\n'
  printf '    # and it is the only place this host Docker socket is ever mounted. A\n'
  printf '    # container can neither pull the image it is running from nor restart\n'
  printf '    # itself, and the long-running daemons must not hold a client for the\n'
  printf '    # daemon that supervises them.\n'
  printf '    profiles: ["update"]\n'
  printf '    image: "%s/omnesis-updater:${OMNESIS_IMAGE_TAG}"\n' "$IMAGE_REPO"
  if [ "$DOCKER_BUILD_FLAG" = 1 ]; then
    printf '    build:\n      context: %s\n      target: updater\n' "$DOCKER_BUILD_CONTEXT"
  fi
  printf '    user: "%s:%s"\n' "$HOST_UID" "$HOST_GID"
  if [ -n "$DOCKER_SOCKET_GID" ]; then
    printf '    group_add:\n      - "%s"\n' "$DOCKER_SOCKET_GID"
  fi
  printf '    volumes:\n'
  printf '      - %s:/var/run/docker.sock\n' "$DOCKER_SOCKET"
  printf '      - %s:%s\n' "$CONFIG_DIR" "$CONFIG_DIR"
  printf '    environment:\n'
  printf '      - OMNESIS_CONFIG_DIR=%s\n' "$CONFIG_DIR"
  printf '      - OMNESIS_GATEWAY_URL=%s\n' "$(docker_collector_gateway_url)"
  docker_compose_ca_env
}

# ── the certificate the gateway mints for itself ────────────────────────────

# This host's names, one per line: its short hostname, `<short>.local`, then
# the addresses another machine can reach it at. Inside the container the
# gateway sees only its own name and bridge address, so these are handed to it.
# No Node here: a Docker host needs none.
docker_host_names() {
  DOCKER_SHORT_HOST="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"
  DOCKER_SHORT_HOST="$(printf '%s' "${DOCKER_SHORT_HOST%%.*}" | tr 'A-Z' 'a-z')"
  case "$DOCKER_SHORT_HOST" in
    ''|localhost|-*|*-|*[!a-z0-9-]*) ;;
    *)
      if [ "${#DOCKER_SHORT_HOST}" -le 63 ]; then
        printf '%s\n%s.local\n' "$DOCKER_SHORT_HOST" "$DOCKER_SHORT_HOST"
      fi ;;
  esac
  docker_host_addresses
}

# The IPv4 and global IPv6 addresses on this host's own interfaces: never a
# loopback, link-local, temporary or container-bridge address.
docker_host_addresses() {
  if [ "$PLATFORM" = linux ] && command -v ip >/dev/null 2>&1; then
    ip -o addr show scope global 2>/dev/null | awk '
      $2 ~ /^(docker|br-|veth|virbr)/ { next }
      /temporary|deprecated|tentative/ { next }
      $3 == "inet" || $3 == "inet6" { sub(/\/.*/, "", $4); print $4 }'
  else
    ifconfig 2>/dev/null | awk '
      /^[^ \t]/ { iface = $1; sub(/:$/, "", iface) }
      iface ~ /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|bridge)/ { next }
      /temporary|deprecated|tentative/ { next }
      $1 == "inet" || $1 == "inet6" { a = $2; sub(/^addr:/, "", a); sub(/\/.*/, "", a); print a }'
  fi | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$|^[0-9A-Fa-f:]+$' \
     | grep -Ev '^(127\.|169\.254\.|0\.0\.0\.0$|::1?$|[Ff][Ee]80:)' \
     | awk '!seen[$0]++' || true
}

# For a gateway on its own certificate: the names it is to cover
# (DOCKER_EXTRA_NAMES, comma-separated), and the one the join line prints
# (DOCKER_JOIN_HOST) — `<short>.local` where mDNS names resolve, as the native
# installer decides, else the first IPv4 address. A Linux host that resolves
# `.local` names runs the mDNS stack that advertises its own.
docker_self_signed_names() {
  [ "$COLLECTOR" = 0 ] && [ -z "$TLS_CERT_PATH" ] || return 0
  DOCKER_HOST_NAME_LIST="$(docker_host_names)"
  DOCKER_EXTRA_NAMES="$(printf '%s\n' "$DOCKER_HOST_NAME_LIST" | sed '/^$/d' | tr '\n' ',' | sed 's/,$//')"
  DOCKER_LOCAL_NAME="$(printf '%s\n' "$DOCKER_HOST_NAME_LIST" | grep '\.local$' | head -n 1 || true)"
  DOCKER_FIRST_IPV4="$(printf '%s\n' "$DOCKER_HOST_NAME_LIST" | grep -E '^[0-9.]+$' | head -n 1 || true)"
  if [ -n "$DOCKER_LOCAL_NAME" ] && { [ -z "$DOCKER_FIRST_IPV4" ] || host_resolves_here "$DOCKER_LOCAL_NAME"; }; then
    DOCKER_JOIN_HOST="$DOCKER_LOCAL_NAME"
  else
    DOCKER_JOIN_HOST="$DOCKER_FIRST_IPV4"
  fi
  [ -n "$DOCKER_EXTRA_NAMES" ] && info "The gateway's own certificate will cover this host as: $DOCKER_EXTRA_NAMES"
  return 0
}

# The SHA-256 of a certificate, as bare hex: openssl where there is one,
# otherwise Node.
docker_cert_fingerprint() {
  [ -f "$1" ] || return 1
  if command -v openssl >/dev/null 2>&1 && openssl version >/dev/null 2>&1; then
    openssl x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//; s/://g' | tr 'A-F' 'a-f'
    return 0
  fi
  cert_fingerprint "$1"
}

# Whether the certificate at $1 covers the DNS name or IPv4 address $2. When
# neither openssl nor Node can read it, nothing is claimed about it.
docker_cert_covers() {
  if command -v openssl >/dev/null 2>&1 && openssl version >/dev/null 2>&1; then
    openssl x509 -in "$1" -noout -text 2>/dev/null \
      | sed -n '/Subject Alternative Name/{n;p;}' | tr ',' '\n' \
      | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr 'A-Z' 'a-z' \
      | grep -Fqx -e "dns:$2" -e "ip address:$2"
    return
  fi
  command -v node >/dev/null 2>&1 || return 0
  certificate_gateway_urls "$1" | grep -Fqx "https://$2:$GATEWAY_PORT"
}

# The line another machine's collector joins by, for a gateway on its own
# certificate: a name that certificate covers, and the fingerprint to pin.
print_docker_self_signed_join() {
  DOCKER_CERT="$CONFIG_DIR/tls/cert.pem"
  DOCKER_JOIN_URL="https://${DOCKER_JOIN_HOST:-<this-host>}:$GATEWAY_PORT"
  DOCKER_FP=""
  if [ "$GATEWAY_HEALTHY" = 1 ]; then
    DOCKER_FP="$(docker_cert_fingerprint "$DOCKER_CERT" || true)"
  fi
  if [ -n "$DOCKER_FP" ]; then
    echo "        --gateway-url $DOCKER_JOIN_URL \\"
    echo "        --trust-fingerprint sha256:$DOCKER_FP"
  else
    echo "        --gateway-url $DOCKER_JOIN_URL"
  fi
  [ -n "$DOCKER_FP" ] && [ -n "$DOCKER_JOIN_HOST" ] || return 0
  docker_cert_covers "$DOCKER_CERT" "$DOCKER_JOIN_HOST" && return 0
  # A certificate minted before the gateway was told this host's names is
  # kept: phones and collectors paired with it pin its fingerprint.
  echo ""
  echo "    The gateway's certificate ($DOCKER_CERT) does not cover $DOCKER_JOIN_HOST,"
  echo "    so that line fails its name check. It was minted without this host's current"
  echo "    names, and is kept because the phones and collectors paired with it pin it."
  echo "    To mint one that covers them: omnesis tls renew --force — then re-pair every"
  echo "    phone and collector already paired with this gateway."
}

# ── a certificate the operator supplies ─────────────────────────────────────

# A re-run that names no certificate keeps the one an earlier run recorded, the
# way a native re-run keeps operator-managed material: a gateway that served a
# trusted certificate must not fall back to a self-signed one because a flag
# was left off.
docker_tls_adopt() {
  [ "$TLS_FILES_FLAG" = 0 ] || return 0
  RECORDED_CA="$(dotenv_value OMNESIS_TLS_CA)" || RECORDED_CA=""
  if [ "$COLLECTOR" = 1 ]; then
    # A host that only collects recorded the CA it verifies the gateway with.
    [ -n "$RECORDED_CA" ] || return 0
    TLS_CA_PATH="$RECORDED_CA"
    docker_validate_tls_files
    info "Keeping the CA at $TLS_CA_PATH from the earlier install."
    return 0
  fi
  RECORDED_CERT="$(dotenv_value OMNESIS_TLS_CERT)" || RECORDED_CERT=""
  RECORDED_KEY="$(dotenv_value OMNESIS_TLS_KEY)" || RECORDED_KEY=""
  if [ -z "$RECORDED_CERT" ] || [ -z "$RECORDED_KEY" ]; then
    # Nothing recorded: the gateway mints its own, and the lines only a
    # supplied certificate needs must not outlive it.
    unset_env OMNESIS_TLS_CA
    unset_env OMNESIS_GATEWAY_URL
    unset_env OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN
    return 0
  fi
  if [ ! -r "$RECORDED_CERT" ] || [ ! -r "$RECORDED_KEY" ]; then
    fail "$CONFIG_DIR/.env names a certificate at $RECORDED_CERT that is no longer readable. Put it back, re-run with --tls-cert and --tls-key naming its replacement, or remove OMNESIS_TLS_CERT and OMNESIS_TLS_KEY from that file to go back to a self-signed certificate (the next run then clears the lines that went with them)."
  fi
  TLS_CERT_PATH="$RECORDED_CERT"
  TLS_KEY_PATH="$RECORDED_KEY"
  TLS_CA_PATH="$RECORDED_CA"
  # A record left by a native install on the same directory can name files
  # the containers would not see; it is held to the same rules as the flags.
  docker_validate_tls_files
  info "Keeping the certificate at $TLS_CERT_PATH from the earlier install."
}

# One line per DNS name the certificate covers, then its fingerprint. Refuses
# a pair that does not belong together and a certificate already past its
# end: the gateway would refuse to start, or serve something no client takes.
# Read with openssl on this host when there is one, and otherwise with the
# gateway image's own runtime, which is pulled for that purpose.
docker_tls_read_certificate() {
  if command -v openssl >/dev/null 2>&1 && openssl version >/dev/null 2>&1; then
    CERT_PUBKEY="$(openssl x509 -in "$TLS_CERT_PATH" -noout -pubkey 2>/dev/null)" || \
      fail "$TLS_CERT_PATH could not be read as a PEM certificate."
    # An encrypted key would make openssl ask for its passphrase on the
    # terminal; the gateway cannot use one, so an empty passphrase makes it a
    # plain refusal instead of a hidden prompt.
    KEY_PUBKEY="$(openssl pkey -in "$TLS_KEY_PATH" -passin pass: -pubout 2>/dev/null)" || \
      fail "$TLS_KEY_PATH could not be read as an unencrypted PEM private key."
    [ "$CERT_PUBKEY" = "$KEY_PUBKEY" ] || \
      fail "$TLS_KEY_PATH is not the key of $TLS_CERT_PATH: the pair does not belong together."
    openssl x509 -in "$TLS_CERT_PATH" -noout -checkend 0 >/dev/null 2>&1 || \
      fail "$TLS_CERT_PATH has already expired; renew it before handing it to the gateway container."
    # The chain, with the name check every client makes: a private CA has to
    # be named so the containers can verify it, and a certificate nobody on
    # this host trusts is not passed off as publicly chained.
    if [ -n "$TLS_CA_PATH" ]; then
      openssl verify -CAfile "$TLS_CA_PATH" -untrusted "$TLS_CERT_PATH" "$TLS_CERT_PATH" >/dev/null 2>&1 || \
        fail "$TLS_CA_PATH did not issue $TLS_CERT_PATH: the containers could not verify the gateway with it. Pass the CA that issued the certificate (for a self-signed certificate, the certificate itself)."
    else
      openssl verify -untrusted "$TLS_CERT_PATH" "$TLS_CERT_PATH" >/dev/null 2>&1 || \
        fail "$TLS_CERT_PATH chains to no root this host trusts, so the containers could not verify it either. Pass --tls-ca naming the CA that issued it (for a self-signed certificate, the certificate itself); a publicly chained certificate, such as Tailscale's, needs no --tls-ca."
    fi
    openssl x509 -in "$TLS_CERT_PATH" -noout -text 2>/dev/null \
      | sed -n '/Subject Alternative Name/{n;p;}' | tr ',' '\n' \
      | sed -n 's/^[[:space:]]*DNS:\([^[:space:]]*\).*$/\1/p' | tr 'A-Z' 'a-z' | sed 's/^/DNS:/'
    TLS_FP_LINE="$(openssl x509 -in "$TLS_CERT_PATH" -noout -fingerprint -sha256 2>/dev/null \
      | sed 's/^.*=//; s/://g' | tr 'A-F' 'a-f')"
    [ -n "$TLS_FP_LINE" ] || fail "$TLS_CERT_PATH gave no fingerprint; it could not be read as a certificate."
    printf 'FP:%s\n' "$TLS_FP_LINE"
    return 0
  fi
  if [ "$DOCKER_BUILD_FLAG" = 1 ]; then
    fail "Reading $TLS_CERT_PATH needs openssl on this host when the images are built rather than pulled. Install openssl and re-run."
  fi
  # Without openssl there is no way to check a chain against this host's
  # roots; a private CA can still be named and checked directly.
  [ -n "$TLS_CA_PATH" ] || \
    fail "Reading $TLS_CERT_PATH needs openssl on this host to check what it chains to. Install openssl, or pass --tls-ca naming the CA that issued it (for a self-signed certificate, the certificate itself)."
  docker pull -q "$IMAGE_REPO/omnesis-gateway:$IMAGE_TAG" >/dev/null 2>&1 || \
    fail "Could not pull $IMAGE_REPO/omnesis-gateway:$IMAGE_TAG to read $TLS_CERT_PATH with. Install openssl on this host, or log Docker in to $IMAGE_REPO first."
  # The image's own uid cannot read a key the operator keeps owner-only; the
  # containers run as this user, and so does this read.
  docker run --rm --user "$(id -u):$(id -g)" --entrypoint node -v "$CONFIG_DIR:$CONFIG_DIR:ro" \
    "$IMAGE_REPO/omnesis-gateway:$IMAGE_TAG" -e '
      const { X509Certificate, createPrivateKey } = require("node:crypto");
      const { readFileSync } = require("node:fs");
      const [certPath, keyPath, caPath] = process.argv.slice(1);
      const refuse = (message) => { console.error(message); process.exit(2); };
      let cert;
      try { cert = new X509Certificate(readFileSync(certPath)); }
      catch { refuse(`${certPath} could not be read as a PEM certificate.`); }
      let key;
      try { key = createPrivateKey(readFileSync(keyPath)); }
      catch { refuse(`${keyPath} could not be read as an unencrypted PEM private key.`); }
      if (!cert.checkPrivateKey(key)) refuse(`${keyPath} is not the key of ${certPath}: the pair does not belong together.`);
      if (Date.parse(cert.validTo) <= Date.now()) refuse(`${certPath} has already expired; renew it before handing it to the gateway container.`);
      let ca;
      try { ca = new X509Certificate(readFileSync(caPath)); }
      catch { refuse(`${caPath} could not be read as a PEM certificate.`); }
      if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) refuse(`${caPath} did not issue ${certPath}: the containers could not verify the gateway with it.`);
      for (const entry of (cert.subjectAltName ?? "").split(",")) {
        const m = /^\s*DNS:(\S+)/.exec(entry);
        if (m) console.log(`DNS:${m[1].toLowerCase()}`);
      }
      console.log(`FP:${cert.fingerprint256.replace(/:/g, "").toLowerCase()}`);
    ' "$TLS_CERT_PATH" "$TLS_KEY_PATH" "$TLS_CA_PATH" || fail "The certificate at $TLS_CERT_PATH was refused (see above), or the image could not read the config directory."
}

# Read the certificate, decide the name the collector dials, and record the
# arrangement in the config directory's .env — which the gateway container
# reads at boot and again on every certificate check.
docker_tls_prepare() {
  if [ "$COLLECTOR" = 1 ]; then
    # The CA a collector-only host verifies the gateway with, kept for re-runs.
    if [ -n "$TLS_CA_PATH" ]; then set_env OMNESIS_TLS_CA "$TLS_CA_PATH"; else unset_env OMNESIS_TLS_CA; fi
    return 0
  fi
  [ -n "$TLS_CERT_PATH" ] || return 0
  TLS_READ="$(docker_tls_read_certificate)" || exit 1
  TLS_ALIAS_NAMES=""
  TLS_PRIMARY_NAME=""
  TLS_WILDCARD_SEEN=0
  # No pathname expansion: a wildcard name is a line of text, not a glob.
  set -f
  for TLS_LINE in $TLS_READ; do
    case "$TLS_LINE" in
      DNS:*)
        TLS_NAME="${TLS_LINE#DNS:}"
        case "$TLS_NAME" in
          localhost) continue ;;
          '*'*) TLS_WILDCARD_SEEN=1; continue ;;
        esac
        [ -n "$TLS_PRIMARY_NAME" ] || TLS_PRIMARY_NAME="$TLS_NAME"
        TLS_ALIAS_NAMES="$TLS_ALIAS_NAMES $TLS_NAME" ;;
      FP:*) TLS_FINGERPRINT="${TLS_LINE#FP:}" ;;
    esac
  done
  set +f
  TLS_ALIAS_NAMES="${TLS_ALIAS_NAMES# }"
  if [ -z "$TLS_PRIMARY_NAME" ]; then
    if [ "$TLS_WILDCARD_SEEN" = 1 ]; then
      fail "$TLS_CERT_PATH covers only a wildcard name, which gives the collector container nothing concrete to dial the gateway by. Issue it for a specific hostname as well and re-run."
    fi
    fail "$TLS_CERT_PATH covers no DNS name other than localhost, so the collector container has no name it can dial the gateway by and verify. Issue the certificate for a hostname (a Tailscale MagicDNS name, or a name mkcert is given) and re-run."
  fi
  for TLS_ALIAS in $TLS_ALIAS_NAMES; do
    docker_plain_value "$TLS_ALIAS" "a DNS name in $TLS_CERT_PATH"
  done
  set_env OMNESIS_TLS_CERT "$TLS_CERT_PATH"
  set_env OMNESIS_TLS_KEY "$TLS_KEY_PATH"
  # The CLI inside the gateway container, and the gateway's own view of the
  # names it is addressed by: the container port, on the compose network.
  set_env OMNESIS_GATEWAY_URL "https://$TLS_PRIMARY_NAME:7600"
  if [ -n "$TLS_CA_PATH" ]; then
    # A private CA: phones verify by fingerprint at pairing, as with the
    # self-signed default; only a publicly chained certificate earns the
    # renewal-safe system-trust origin.
    set_env OMNESIS_TLS_CA "$TLS_CA_PATH"
    unset_env OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN
  else
    unset_env OMNESIS_TLS_CA
    # An exact origin, as the gateway compares them: no default port spelled out.
    if [ "$GATEWAY_PORT" = 443 ]; then
      set_env OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN "https://$TLS_PRIMARY_NAME"
    else
      set_env OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN "https://$TLS_PRIMARY_NAME:$GATEWAY_PORT"
    fi
  fi
  PORTAL_HOST="$TLS_PRIMARY_NAME"
  info "The gateway container will serve $TLS_CERT_PATH (sha256:$TLS_FINGERPRINT) for $TLS_ALIAS_NAMES; the collector dials https://$TLS_PRIMARY_NAME:7600."
}

# Write the compose file, and the image tag beside it. The tag lives in its own
# key in .env rather than inside the compose file because `omnesis update`
# moves it, pulls, and writes it back when the new gateway does not return.
docker_write_compose() {
  COMPOSE_FILE="$CONFIG_DIR/docker-compose.yml"
  COMPOSE_PROJECT="$(docker_project_name)"
  HOST_UID="$(id -u)"
  HOST_GID="$(id -g)"
  {
    printf '# Generated by the Omnesis installer (install.sh --docker). Re-running the\n'
    printf '# installer rewrites it.\n'
    printf '#\n'
    printf '# The image tag is OMNESIS_IMAGE_TAG in the .env file beside this one.\n'
    printf 'name: %s\n' "$COMPOSE_PROJECT"
    printf 'services:\n'
    [ "$COLLECTOR" = 1 ] || docker_compose_gateway_service
    docker_compose_collector_service
    docker_compose_updater_service
  } > "$COMPOSE_FILE"
  set_env OMNESIS_IMAGE_TAG "$IMAGE_TAG"
  info "Wrote $COMPOSE_FILE"
}

# How this config directory's install runs, for `omnesis update` to read. A
# source or package install is recognisable from the CLI's own path; a Docker
# install is not — the CLI it runs lives inside an image — so it is recorded.
docker_record_method() {
  printf 'docker\n' > "$CONFIG_DIR/install-method"
}

# The `omnesis` this host gets: a wrapper that runs the CLI in a container.
#
# It runs in the long-running container when there is one, so a command sees
# the same config directory and the same corpus the daemon does; a throwaway
# container answers when it is down, so a command that needs no daemon — the
# model catalog, arming the keyring before the first boot — still works.
#
# `update` is the exception. It moves the containers themselves, which no
# container can do to itself, so it runs in the one-shot updater container that
# holds this host's Docker socket for that invocation alone.
docker_write_wrapper() {
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR" || \
    fail "Could not create $BIN_DIR, which is where the omnesis command goes. Create it yourself (or free the path if something else is there) and re-run."
  OMNESIS_BIN="$BIN_DIR/omnesis"
  cat > "$OMNESIS_BIN" <<EOF || fail "Could not write $OMNESIS_BIN. Check that $BIN_DIR is writable and re-run."
#!/bin/sh
# Omnesis in Docker — written by install.sh --docker.
COMPOSE_FILE='$COMPOSE_FILE'
SERVICE='$DOCKER_CLI_SERVICE'
EOF
  cat >> "$OMNESIS_BIN" <<'WRAPPER_EOF' || fail "Could not write $OMNESIS_BIN. Check that $BIN_DIR is writable and re-run."
set -eu

[ -f "$COMPOSE_FILE" ] || {
  printf 'omnesis: %s is gone — this host no longer has a Docker install.\n' "$COMPOSE_FILE" >&2
  exit 1
}

# `update` moves the containers themselves, which no container can do to
# itself, so it runs in the one-shot updater container that holds this host's
# Docker socket for that invocation alone.
UPDATE=0
if [ "${1:-}" = update ]; then UPDATE=1; fi

# Docker allocates a pseudo-terminal by default, which corrupts output the
# moment a command is piped or captured. Ask for one only when there is one.
TTY_FLAG=""
[ -t 0 ] || TTY_FLAG="-T"

# The command line is assembled in the positional parameters, because a POSIX
# shell has exactly one argument list and this needs the flags before the
# service name and the caller's own arguments after the command. Everything is
# appended, then the caller's arguments are rotated to the back — which keeps
# every argument one word, whatever whitespace it contains.
ARG_COUNT=$#

# OMNESIS_* variables the caller exported have to cross into the container: the
# installer arms the keyring by setting two of them, and an operator raising
# the log level for one command expects the same. The names come from the
# environment and match a fixed shape, so nothing a value contains can become
# another argument.
for NAME in $(env | sed -n 's/^\(OMNESIS_[A-Za-z0-9_]*\)=.*/\1/p' | sort -u); do
  case "$NAME" in
    # The container's own paths, port and gateway URL come from the compose
    # file. A host value for one of them names something that does not exist
    # inside the container — a path that is not mounted, or a loopback address
    # where nothing listens — so forwarding it would break every command
    # instead of configuring one.
    OMNESIS_CONFIG_DIR|OMNESIS_GATEWAY_URL|OMNESIS_GATEWAY_PORT) continue ;;
    OMNESIS_DB_PATH|OMNESIS_INDEX_DB_PATH|OMNESIS_ANALYTICS_DB_PATH) continue ;;
    OMNESIS_LOG_FILE|OMNESIS_TLS_CERT|OMNESIS_TLS_KEY) continue ;;
  esac
  # A value containing a newline makes `env` look like it listed another
  # variable; the default keeps that from ending the run under `set -u`.
  eval "VALUE=\${$NAME-}"
  set -- "$@" --env "$NAME=$VALUE"
done

if [ "$UPDATE" = 1 ]; then
  set -- "$@" updater
else
  set -- "$@" "$SERVICE" omnesis
fi
while [ "$ARG_COUNT" -gt 0 ]; do
  ARG="$1"; shift; set -- "$@" "$ARG"
  ARG_COUNT=$((ARG_COUNT - 1))
done

if [ "$UPDATE" = 1 ]; then
  exec docker compose -f "$COMPOSE_FILE" --profile update run --rm --no-deps $TTY_FLAG "$@"
fi
if docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -qx "$SERVICE"; then
  exec docker compose -f "$COMPOSE_FILE" exec $TTY_FLAG "$@"
fi
exec docker compose -f "$COMPOSE_FILE" run --rm --no-deps $TTY_FLAG "$@"
WRAPPER_EOF
  chmod +x "$OMNESIS_BIN"
  info "Wrote $OMNESIS_BIN"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      PATH_HINT_DIR="$BIN_DIR"
      print_path_hint "$BIN_DIR"
      PATH="$BIN_DIR:$PATH"
      export PATH
      ;;
  esac
}

# Bring the images onto this host. Pulling is the normal path — they are built
# and published per release, so nothing here compiles anything. A pull the
# registry refuses stops the install and names `--build`, rather than silently
# starting a ten-minute compile the operator did not ask for.
docker_fetch_images() {
  if [ "$DOCKER_BUILD_FLAG" = 1 ]; then
    info "Building the images from $DOCKER_BUILD_CONTEXT (a few minutes on first run)..."
    docker compose -f "$COMPOSE_FILE" --profile update build || \
      fail "Building the images failed. Read the output above; the compose file is $COMPOSE_FILE."
    return 0
  fi
  info "Pulling the $IMAGE_TAG images..."
  REGISTRY_DIAGNOSTIC="$REGISTRY_TMP_DIR/pull.err"
  REGISTRY_PULL_PIPE="$REGISTRY_TMP_DIR/pull.pipe"
  REGISTRY_PULL_STATUS=0
  if command -v mkfifo >/dev/null 2>&1 && command -v tee >/dev/null 2>&1 && mkfifo "$REGISTRY_PULL_PIPE" 2>/dev/null; then
    tee "$REGISTRY_DIAGNOSTIC" < "$REGISTRY_PULL_PIPE" >&2 &
    REGISTRY_TEE_PID=$!
    docker compose -f "$COMPOSE_FILE" --profile update pull 2>"$REGISTRY_PULL_PIPE" || REGISTRY_PULL_STATUS=$?
    wait "$REGISTRY_TEE_PID" || true
    rm -f "$REGISTRY_PULL_PIPE"
  else
    docker compose -f "$COMPOSE_FILE" --profile update pull 2>"$REGISTRY_DIAGNOSTIC" || REGISTRY_PULL_STATUS=$?
    cat "$REGISTRY_DIAGNOSTIC" >&2
  fi
  if [ "$REGISTRY_PULL_STATUS" = 0 ]; then
    return 0
  fi
  docker_diagnostic_is_auth "$REGISTRY_DIAGNOSTIC" && docker_registry_auth_failure resolved "the required $IMAGE_REPO images at tag $IMAGE_TAG"
  docker_diagnostic_is_missing "$REGISTRY_DIAGNOSTIC" && docker_image_missing_failure "the required $IMAGE_REPO images at tag $IMAGE_TAG"
  if [ -n "$DOCKER_BUILD_CONTEXT" ]; then
    fail "Could not pull the required $IMAGE_REPO images at tag $IMAGE_TAG. Check the tag and your network connection, or build the images from $DOCKER_BUILD_CONTEXT instead by re-running with --build."
  fi
  fail "Could not pull the required $IMAGE_REPO images at tag $IMAGE_TAG. Check the tag and your network connection. A checkout of the repository can build the images itself: scripts/install.sh --docker --build."
}

docker_up() {
  info "Starting the $1 container..."
  docker compose -f "$COMPOSE_FILE" up -d "$1" && return 0
  if [ "$1" = collector ] && [ "$OAUTH_HOST_PORTS" != ephemeral ]; then
    fail "Could not start the collector container. It publishes the OAuth callback ports 3000-3003, which a provider redirects a browser to, so they cannot be moved without re-registering every OAuth client. Free them, or re-run with OMNESIS_OAUTH_HOST_PORTS=ephemeral if this host will never complete an OAuth flow. Logs: docker compose -f $COMPOSE_FILE logs collector"
  fi
  fail "Could not start the $1 container. Check: docker compose -f $COMPOSE_FILE logs $1"
}

# Redeem the pairing code from a throwaway collector container, so the device
# token lands in the collector's own config directory — the one the daemon
# reads when it starts.
docker_collector_pair() {
  set -- pair "$PAIR_CODE" --gateway-url "$PAIR_GATEWAY_URL"
  if [ -n "$PAIR_FINGERPRINT" ]; then
    set -- "$@" --trust-fingerprint "$PAIR_FINGERPRINT"
  fi
  set -- "$@" --save "$CONFIG_DIR/collector/collector-token"
  info "Pairing with $PAIR_GATEWAY_URL..."
  PAIR_STATUS=0
  if is_promptable; then
    "$OMNESIS_BIN" "$@" </dev/tty || PAIR_STATUS=$?
  else
    "$OMNESIS_BIN" "$@" </dev/null || PAIR_STATUS=$?
  fi
  PAIR_OK=0; [ "$PAIR_STATUS" = 0 ] && PAIR_OK=1
  if [ "$PAIR_OK" = 0 ]; then
    RETRY_FLAGS="--docker --collector --gateway-url $PAIR_GATEWAY_URL"
    if [ -n "$PAIR_FINGERPRINT" ]; then
      RETRY_FLAGS="$RETRY_FLAGS --trust-fingerprint $PAIR_FINGERPRINT"
    fi
    # 64 is EXIT_GATEWAY_DOWN: the redeem never reached the gateway, so the code
    # was not consumed. Same reasoning as the non-Docker collector path.
    if [ "$PAIR_STATUS" = 64 ]; then
      fail "Pairing failed — the gateway could not be reached, so no container was started and your code was not used. Fix reachability (see the address above), then re-run with $RETRY_FLAGS --code <code>."
    fi
    fail "Pairing failed — no container was started. A code is single-use and short-lived: mint a fresh one on the gateway host (omnesis devices pair --kind collector) and re-run with $RETRY_FLAGS --code <code>."
  fi
}

# A collector-only host reads the .env in its own config directory, while the
# compose project's .env sits beside the compose file one level up. So the
# keyring wiring this run armed is written to the collector's too — without it
# the daemon would open plaintext secret files beside sealed ones. A gateway
# host needs none of this: its collector shares the gateway's directory.
docker_propagate_keyring() {
  [ "$COLLECTOR" = 1 ] || return 0
  [ "$KEYRING_READY" = 1 ] || return 0
  [ "$KEYRING_BACKEND" = passphrase ] || return 0
  COLLECTOR_ENV="$CONFIG_DIR/collector/.env"
  ( umask 077; touch "$COLLECTOR_ENV" )
  chmod 600 "$COLLECTOR_ENV" 2>/dev/null || true
  grep -q '^OMNESIS_SECRET_STORE=' "$COLLECTOR_ENV" 2>/dev/null || \
    printf 'OMNESIS_SECRET_STORE=passphrase\n' >> "$COLLECTOR_ENV"
  grep -q '^OMNESIS_KEYRING_PASSPHRASE_FILE=' "$COLLECTOR_ENV" 2>/dev/null || \
    printf 'OMNESIS_KEYRING_PASSPHRASE_FILE=%s\n' "$KEYRING_CRED_FILE" >> "$COLLECTOR_ENV"
}

print_docker_banner() {
  echo ""
  if [ "$COLLECTOR" = 1 ]; then
    printf '\033[1m\033[0;32mCollector container is running.\033[0m\n'
    echo ""
    echo "  Gateway:  $PAIR_GATEWAY_URL"
    echo "  Token:    $CONFIG_DIR/collector/collector-token"
    print_collector_encryption_line
  else
    printf '\033[1m\033[0;32mOmnesis is running in Docker.\033[0m\n'
    echo ""
    echo "  Portal:  https://$PORTAL_HOST:$GATEWAY_PORT/portal/"
    echo "           (login: run 'omnesis devices pair --kind portal' and paste the code)"
    if [ -n "$TLS_CERT_PATH" ]; then
      echo "  Certificate: $TLS_CERT_PATH (sha256:$TLS_FINGERPRINT)"
      echo "           Renew it in place with the tool that issued it; the gateway picks the"
      echo "           renewal up within the hour, or at once with: omnesis tls reload"
    fi
  fi
  echo ""
  printf '\033[1mThe CLI runs in the containers:\033[0m\n'
  echo ""
  echo "    omnesis sources add gmail"
  echo "    omnesis status"
  echo ""
  if [ "$COLLECTOR" != 1 ]; then
    print_phone_lines
    print_browser_lines
  fi
  echo "  Compose file:  $COMPOSE_FILE  (image tag: $IMAGE_TAG)"
  echo "  Stop:          docker compose -f $COMPOSE_FILE down"
  echo "  Logs:          docker compose -f $COMPOSE_FILE logs -f"
  echo "  Update later:  omnesis update"
  echo ""
  printf '\033[1mWhat a container cannot do:\033[0m\n'
  echo ""
  echo "  - The Apple sources (Notes, Messages, Calendar, ...) read macOS databases"
  echo "    that do not exist in a Linux container. Run a native collector on the Mac"
  echo "    and pair it with this gateway:"
  echo ""
  echo "      curl -fsSL https://omnesis.dev/install.sh | sh -s -- --collector \\"
  if [ -n "$TLS_PRIMARY_NAME" ]; then
    echo "        --gateway-url https://$TLS_PRIMARY_NAME:$GATEWAY_PORT"
  else
    print_docker_self_signed_join
  fi
  echo ""
  echo "  - Multicast does not cross the Docker bridge, so a container collector"
  echo "    cannot discover a gateway; name it with --gateway-url."
  if [ "$KEYRING_READY" = 1 ]; then
    echo "  - A container has no OS keyring: encryption at rest runs on the passphrase"
    echo "    backend, sealed by $KEYRING_CRED_FILE (keep it, and keep it mode 0600)."
  else
    echo "  - A container has no OS keyring, so nothing is encrypted at rest yet. Arm"
    echo "    the passphrase backend with: omnesis secure"
  fi
  print_path_hints
  echo ""
}

# A native install in this config directory does not go away because a Docker
# one arrives on top of it: its service units keep running and keep the gateway
# port, and this run is about to replace the wrapper that could stop them. Say
# so while the operator can still act on it.
docker_warn_native_install() {
  [ -f "$CONFIG_DIR/omnesis.db" ] || return 0
  [ ! -f "$CONFIG_DIR/install-method" ] || return 0
  warn "$CONFIG_DIR already holds a native install's corpus. Its services keep running and hold port $GATEWAY_PORT, and this run replaces the omnesis command they were registered with."
  warn "Stop them first if that is not what you meant: omnesis service status, then omnesis service uninstall"
}

# One line turns this host into an Omnesis machine running in containers.
docker_install() {
  ensure_docker
  docker_socket_facts
  docker_validate_values
  docker_registry_prepare
  docker_warn_native_install
  docker_resolve_tag
  docker_resolve_build_context
  docker_preflight_images
  docker_prepare_dirs
  docker_tls_adopt
  docker_tls_prepare
  docker_self_signed_names
  docker_write_compose
  docker_write_wrapper
  docker_record_method
  docker_fetch_images
  INSTALLED_VERSION="$("$OMNESIS_BIN" --version 2>/dev/null || true)"
  info "Installed: ${INSTALLED_VERSION:-(version unavailable)}"
  # The catalog answers from the image, so the question can be asked — and
  # answered — before anything is started.
  choose_embedder final
  # Before the first boot, so a corpus that is going to be encrypted is born
  # that way rather than migrated into it.
  setup_keyring_init
  setup_keyring_migrate
  docker_propagate_keyring
  if [ "$COLLECTOR" = 1 ]; then
    setup_collector_storage_keys
    read_pairing_code collector
    docker_collector_pair
    docker_up collector
    print_docker_banner
    return 0
  fi
  docker_up gateway
  if wait_for_gateway; then
    GATEWAY_HEALTHY=1
    docker_up collector
    install_model
  else
    # Compose holds the collector until the gateway is healthy, so starting it
    # now lets it follow the gateway once that recovers.
    docker_up collector
    fail_unhealthy_gateway
  fi
  print_docker_banner
}

# ── Step 7: the next step, then the optional follow-ons ──────────────────────

# Every banner closes with the same PATH advice: whatever this run had to put
# on PATH itself will not be there in the operator's next shell.
print_path_hints() {
  warn_path_shadow
  if [ -n "$PATH_HINT_DIR" ]; then
    echo ""
    print_path_hint "$PATH_HINT_DIR"
  fi
}

# Check the path inherited from the invoking shell, not the temporary PATH this
# process extended for itself. An earlier stale command can otherwise make a
# successful install look like it did not update.
warn_path_shadow() {
  [ -n "${OMNESIS_BIN:-}" ] || return 0
  PATH_COMMAND="$(PATH="$ORIGINAL_PATH" command -v omnesis 2>/dev/null || true)"
  [ -n "$PATH_COMMAND" ] || return 0
  case "$PATH_COMMAND" in
    "$OMNESIS_BIN"|"$HOME/.local/bin/omnesis") return 0 ;;
  esac
  if [ -x "$HOME/.local/bin/omnesis" ]; then FRESH_COMMAND="$HOME/.local/bin/omnesis"
  else FRESH_COMMAND="$OMNESIS_BIN"; fi
  warn "Your shell resolves 'omnesis' to $PATH_COMMAND, ahead of the freshly installed command at $FRESH_COMMAND."
  warn "Put $(dirname "$FRESH_COMMAND") before $(dirname "$PATH_COMMAND") on PATH, or remove the stale command."
}

# The grant the Apple sources need, on the platform that has it. Printed by
# every banner whose machine will run a collector.
print_full_disk_access_hint() {
  [ "$PLATFORM" = darwin ] || return 0
  echo "  Apple sources (Notes, Messages, ...) need Full Disk Access for the"
  echo "  collector — System Settings → Privacy & Security → Full Disk Access."
  echo ""
}

# ── The gateway account ──────────────────────────────────────────────────────
#
# A gateway runs as the login account by default. On Linux with systemd it can
# run as a dedicated account instead (`omnesis service install gateway
# --hardened`), with its state where the login account cannot read it. That is
# a different gateway with fresh state, not this account's gateway moved, so it
# is offered only where there is no gateway of this account's to leave behind,
# and chosen deliberately everywhere else.

# The user-level gateway unit this account registers.
user_gateway_unit() {
  printf '%s' "$HOME/.config/systemd/user/omnesis-gateway.service"
}

# Whether systemd supervises this host, which a dedicated account needs: its
# unit is a system service. A container or a shell without systemd answers no.
systemd_available() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --version >/dev/null 2>&1 || return 1
  [ -d /run/systemd/system ]
}

# The flag combinations a dedicated-account gateway cannot honour, refused
# before anything is installed.
validate_hardened_flags() {
  if [ "$HARDENED_FLAG" = 1 ] && [ "$NO_HARDENED_FLAG" = 1 ]; then
    fail "--hardened and --no-hardened answer the same question two ways; pass one."
  fi
  [ "$HARDENED_FLAG" = 1 ] || return 0
  [ "$DOCKER" = 0 ] || \
    fail "--hardened runs the gateway as a dedicated system account through systemd; --docker runs it in a container. They are different boundaries, not two spellings of one: pick one."
  [ "$CLIENT_ONLY_FLAG" = 0 ] || fail "--hardened applies to a gateway, and --client-only installs none."
  [ "$COLLECTOR" = 0 ] || \
    fail "--hardened applies to the gateway alone: a collector stays under the account whose data it reads. Install the dedicated gateway first, then pair this machine's collector with --collector."
  [ -z "$HARNESS" ] || fail "--hardened applies to a gateway; --$HARNESS connects an agent harness and installs none."
  [ "$NO_SERVICE_FLAG" = 0 ] || fail "--hardened installs the gateway as a system service; --no-service registers none."
  if [ "$KEYRING_PASSPHRASE_FLAG" = 1 ]; then
    case "$KEYRING_PASSPHRASE_FILE" in
      /*) ;;
      *) fail "--keyring-passphrase-file must be an absolute path under --hardened: root copies the passphrase from that path into /etc/omnesis-gateway." ;;
    esac
  fi
  [ "$MKCERT_EXPLICIT" = 0 ] || \
    fail "--mkcert provisions a certificate under your account, which the dedicated gateway account cannot read. A hardened gateway serves its own certificate; for a browser-trusted address, put a reverse proxy in front of it: https://omnesis.dev/docs/setup#public-domain"
}

# Whether a dedicated-account gateway unit is installed on this host. Listed
# through systemd, which sees the root-owned unit a login account cannot read.
dedicated_gateway_installed() {
  systemctl --system list-unit-files omnesis-gateway.service --no-legend 2>/dev/null | grep -q 'omnesis-gateway\.service'
}

hardened_platform_refusal() {
  if [ "$PLATFORM" = darwin ]; then
    fail "--hardened needs Linux with systemd; macOS has no dedicated-account gateway service. Install without it to run the gateway as your user, or use --docker, where the container rather than a separate account separates the gateway from your other programs — a different boundary, not the same protection. See https://omnesis.dev/docs/security#hardened-gateway"
  fi
  fail "--hardened needs systemd supervising this host, and it is not: the dedicated account is a systemd system service. Install without --hardened to run the gateway as your user."
}

choose_gateway_account() {
  DEDICATED_GATEWAY_PRESENT=0
  if [ "$PLATFORM" = linux ] && systemd_available && dedicated_gateway_installed; then
    DEDICATED_GATEWAY_PRESENT=1
    [ "$HARDENED_FLAG" = 1 ] || \
      fail "A dedicated-account gateway is installed on this host (omnesis-gateway.service). A gateway under your account beside it would contend for its port and its devices. Re-run with --hardened to print the command that moves it to this release, or remove it first with 'sudo omnesis-gateway-admin uninstall'; its state stays in /var/lib/omnesis-gateway."
  fi
  if [ "$HARDENED_FLAG" = 1 ]; then
    { [ "$PLATFORM" = linux ] && systemd_available; } || hardened_platform_refusal
    if [ -f "$(user_gateway_unit)" ]; then
      fail "A gateway service of this account is registered ($(user_gateway_unit)). --hardened installs a separate gateway with fresh state under /var/lib/omnesis-gateway: nothing is moved, devices pair again and sources sync again. Keep the current gateway by re-running without --hardened, or remove its service first with 'omnesis service uninstall gateway' and re-run."
    fi
    if [ -f "$CONFIG_DIR/omnesis.db" ]; then
      warn "$CONFIG_DIR holds an earlier gateway's data. The dedicated gateway starts fresh and does not read it; it stays where it is."
    fi
    if [ "$DEDICATED_GATEWAY_PRESENT" = 1 ]; then
      info "A dedicated gateway is already installed here; the command below moves it to this release and keeps its state."
    fi
    WANT_HARDENED=1
  elif [ "$NO_HARDENED_FLAG" = 0 ] && [ "$PLATFORM" = linux ] && [ "$WANT_SERVICE" = 1 ] &&
       [ ! -f "$(user_gateway_unit)" ] && [ ! -f "$CONFIG_DIR/omnesis.db" ] &&
       [ ! -f "$CONFIG_DIR/install-method" ] && is_promptable && systemd_available; then
    # Offered, never assumed: only where it is supported, with a terminal to
    # answer, and with no gateway of this account's (native or Docker) already
    # installed here. A dry-run preview records the unresolved choice without
    # asking or guessing.
    if [ "${1:-}" = preview ]; then ACCOUNT_CHOICE_DEFERRED=1
    else ask_gateway_account; fi
  fi
  if [ "$WANT_HARDENED" = 1 ]; then
    # The dedicated gateway downloads its model into its own state; this
    # account's copy would sit where that gateway cannot read it, so no model
    # is chosen or downloaded here.
    WANT_MODEL=0
  fi
}

ask_gateway_account() {
  echo "" >/dev/tty
  printf 'Which account should run the gateway?\n' >/dev/tty
  printf '\n' >/dev/tty
  printf '   1) Yours (default). Its files are owner-only, so other accounts cannot read\n' >/dev/tty
  printf '      them, but any program you run can.\n' >/dev/tty
  printf '   2) A dedicated system account. A fresh gateway whose state lives under\n' >/dev/tty
  printf '      /var/lib/omnesis-gateway, unreadable by your account, running from a copy\n' >/dev/tty
  printf '      of Omnesis that only root can change. One sudo command installs it; this\n' >/dev/tty
  printf '      installer prints it and runs none. Your collector then pairs with a code\n' >/dev/tty
  printf '      and keeps reading your data as you. It does not protect against root, or\n' >/dev/tty
  printf '      against a compromised gateway.\n' >/dev/tty
  printf '\n' >/dev/tty
  ACCOUNT_TRIES=0
  while [ "$ACCOUNT_TRIES" -lt 5 ]; do
    ACCOUNT_TRIES=$((ACCOUNT_TRIES + 1))
    ANSWER="$(ask_tty "Choice [1]: ")"
    case "${ANSWER:-1}" in
      1) return 0 ;;
      2) WANT_HARDENED=1; return 0 ;;
      *) warn "Enter 1 or 2." ;;
    esac
  done
  fail "No valid answer after $ACCOUNT_TRIES attempts. Re-run with --hardened or --no-hardened."
}

# Print the root command that installs the dedicated-account gateway. That
# gateway runs from a release root fetches and owns, never from this account's
# files, so this account's part is the command, which the CLI renders for the
# release this installer installed; the installer runs no sudo. Nothing is
# registered for this account, and a collector cannot pair itself with a gateway
# whose admin token this account cannot read.
hardened_install() {
  set -- service install gateway --hardened
  if [ "$GATEWAY_PORT" != 7600 ]; then
    set -- "$@" --env "OMNESIS_GATEWAY_PORT=$GATEWAY_PORT"
  fi
  if [ "$WANT_KEYRING" != 1 ]; then
    set -- "$@" --no-keyring
  elif [ "$KEYRING_PASSPHRASE_FLAG" = 1 ]; then
    set -- "$@" --keyring-passphrase-file "$KEYRING_PASSPHRASE_FILE"
  fi
  echo ""
  "$OMNESIS_BIN" "$@" || \
    fail "Could not print the dedicated gateway's install command. The message above names the cause."
}

# The dedicated gateway is administered as root through its admin command, and
# this account's collector joins it with a code like a collector on any other
# machine.
print_hardened_banner() {
  echo ""
  printf '\033[1m\033[0;33mOmnesis is installed\033[0m (the dedicated gateway waits for the root command above):\n'
  echo ""
  echo "  1. Run the command printed above. As root, it fetches this release from the"
  echo "     repository, builds it as a throwaway account, installs it under"
  echo "     /opt/omnesis-gateway where only root can change it, and starts the gateway as a"
  echo "     dedicated account whose state, under /var/lib/omnesis-gateway, this account"
  echo "     cannot read."
  if [ "$WANT_KEYRING" = 1 ]; then
    echo "     Its keys are sealed by a passphrase in /etc/omnesis-gateway, readable by root alone."
  else
    echo "     It runs without encryption at rest (--no-keyring)."
  fi
  echo "  2. Administer that gateway as root:"
  echo ""
  if [ "$WANT_KEYRING" = 1 ]; then
    echo "    sudo omnesis-gateway-admin cli keyring export-recovery --backend passphrase"
  fi
  echo "    sudo omnesis-gateway-admin cli model install $EMBEDDER_ID"
  echo "    sudo omnesis-gateway-admin cli tls status"
  echo "    sudo omnesis-gateway-admin cli devices pair --kind collector"
  echo ""
  if [ "$WANT_KEYRING" = 1 ]; then
    echo "     The first prints a one-time recovery code; store it away from this machine."
  fi
  echo "     'tls status' shows the certificate fingerprint the collector confirms below."
  echo ""
  echo "  3. Pair this account's collector with that code; it keeps reading your data as you:"
  echo ""
  echo "    curl -fsSL https://omnesis.dev/install.sh | sh -s -- --collector --gateway-url https://localhost:$GATEWAY_PORT --trust-fingerprint sha256:<fingerprint> --code <code>"
  echo ""
  echo "  Status:        sudo omnesis-gateway-admin status"
  echo "  Update later:  omnesis update (it prints the root command that moves the dedicated gateway)"
  echo "  https://omnesis.dev/docs/security#hardened-gateway"
  print_path_hints
  echo ""
}

print_banner() {
  PORTAL_URL="https://$PORTAL_HOST:$GATEWAY_PORT/portal/"
  echo ""
  if [ "$WANT_SERVICE" = 1 ]; then
    printf '\033[1m\033[0;32mOmnesis is running.\033[0m\n'
  else
    printf '\033[1m\033[0;32mOmnesis is installed\033[0m (services not registered — start the daemons yourself):\n'
    echo ""
    echo "    omnesis gateway serve    # terminal 1"
    echo "    omnesis collector run    # terminal 2"
  fi
  echo ""
  echo "  Portal:  $PORTAL_URL"
  echo "           (login: run 'omnesis devices pair --kind portal' and paste the code)"
  echo ""
  printf '\033[1mAdd your first source:\033[0m\n'
  echo ""
  echo "    omnesis sources add gmail"
  echo ""
  print_full_disk_access_hint
  print_phone_lines
  print_browser_lines
  print_second_machine_lines
  echo "  Manage services:  omnesis service status|logs|restart"
  echo "  Update later:     omnesis update"
  print_path_hints
  echo ""
}

# Where the phone apps come in. Printed only where a gateway was installed,
# since only the gateway host mints the codes. Nothing here asks for Apple or
# Google credentials: an official app wakes through the hosted relay once its
# owner approves that on the phone, and only a self-built app needs its own.
print_phone_lines() {
  printf '\033[1mPair a phone (optional):\033[0m\n'
  echo ""
  echo "    omnesis devices pair --kind ios       # or --kind android; scan the code in the app"
  echo ""
  echo "  The official apps wake through the hosted relay once you approve it on the phone;"
  echo "  a self-built app needs your own APNs or FCM credentials: omnesis push setup"
  echo "  https://omnesis.dev/docs/apps · https://omnesis.dev/docs/notifications"
  echo ""
}

# The browser extension, from the store. Printed only where a gateway was
# installed, since only the gateway host mints the code. The extension's
# service worker cannot click through a certificate warning, so a gateway on
# its self-signed certificate is told how a trusted one is provisioned: on the
# host for a native install, or issued on the host and handed to a Docker
# gateway, whose CLI cannot provision one from inside the container.
print_browser_lines() {
  printf '\033[1mConnect your browser (optional):\033[0m\n'
  echo ""
  echo "    Install Omnesis Browser Capture from the Chrome Web Store:"
  echo "    $CHROME_WEB_STORE_URL"
  echo "    omnesis devices pair --kind browser    # then enter the gateway URL and code in its Options page"
  echo ""
  if browser_trusted_certificate; then
    echo "  Pair it by the name the certificate covers; the extension needs a browser-trusted HTTPS gateway."
    if [ -n "$TLS_CA_PATH" ]; then
      echo "  A browser trusts this certificate once its issuing CA is installed in it: $TLS_CA_PATH"
    fi
  elif [ "$DOCKER" = 1 ]; then
    echo "  The extension needs a browser-trusted HTTPS gateway, and this one serves a self-signed"
    echo "  certificate; issue one on the host and re-run with --tls-cert/--tls-key:"
    echo "  https://omnesis.dev/docs/install#docker-tls"
  else
    echo "  The extension needs a browser-trusted HTTPS gateway, and this one serves a self-signed"
    echo "  certificate; provision one first with: omnesis tls provision (Tailscale or mkcert)"
  fi
  echo "  https://omnesis.dev/docs/setup#browser-extension"
  echo ""
}

# Whether the gateway serves a certificate other than its self-signed default:
# one recorded in .env by this or an earlier run (Tailscale, mkcert, an
# operator's own, or the pair handed to a Docker gateway). A private CA's
# certificate is trusted by a browser only once the CA is installed there,
# which the banner says beside the CA file when one was given.
browser_trusted_certificate() {
  [ -n "$(dotenv_value OMNESIS_TLS_CERT 2>/dev/null || true)" ]
}

# The exact lines another machine runs to join THIS gateway, carrying the URL
# this install wrote and the fingerprint of the certificate it is serving.
# Printed here because that pair is the one piece of the other machine's
# command that only this machine knows, and an operator who has to reconstruct
# it by hand usually reconstructs `install.sh` with no flag at all — which
# installs a second gateway.
print_second_machine_lines() {
  SECOND_URL="$(banner_gateway_url)"
  SECOND_FP="$(cert_fingerprint "$(banner_cert_path)" || true)"
  echo ""
  printf '\033[1mAdd another machine\033[0m — one line there, one code minted here:\n'
  echo ""
  echo "  A collector, to sync that machine's sources:"
  echo ""
  print_second_machine_line --collector "$SECOND_URL" "$SECOND_FP"
  echo "    omnesis devices pair --kind collector"
  echo ""
  echo "  An agent harness, on the machine OpenClaw or Hermes runs on:"
  echo ""
  print_second_machine_line --openclaw "$SECOND_URL" "$SECOND_FP"
  echo "    omnesis devices pair --kind agent"
  echo ""
  echo "  (--hermes for Hermes; either code can also be minted in the portal,"
  echo "  under Settings → Devices.)"
  if [ -z "$SECOND_FP" ]; then
    echo ""
    echo "  Each will show you this gateway's certificate fingerprint to confirm."
  fi
  echo ""
}

# One installer line: the role flag in $1, dialling $2, verifying $3 when this
# gateway has a certificate to be verified against.
print_second_machine_line() {
  if [ -n "${3:-}" ]; then
    echo "    curl -fsSL https://omnesis.dev/install.sh | sh -s -- $1 \\"
    echo "      --gateway-url $2 \\"
    echo "      --trust-fingerprint sha256:$3"
  else
    echo "    curl -fsSL https://omnesis.dev/install.sh | sh -s -- $1 \\"
    echo "      --gateway-url $2"
  fi
  echo ""
}

# The URL another machine should dial: the name this gateway's certificate
# covers, spelled so that it resolves from somewhere other than here.
#
# The .env value wins when it names a real host, because TLS provisioning wrote
# it precisely to name the certificate it minted. It does not always: .env also
# carries the `https://localhost:<port>` fallback of a run that minted no named
# certificate, and localhost is the one name that resolves from every machine
# and points at none of them. So the fallbacks are, in order: the name a
# provisioned certificate covers for other machines (mkcert's `<host>.local`),
# the portal host when TLS provisioning claimed one (a Tailscale MagicDNS
# name), and finally `omnesis.local` — which the gateway's own self-signed
# certificate covers and the gateway itself advertises over mDNS, so it works
# from any machine on this LAN.
configured_remote_gateway_url() {
  ENV_URL="$(dotenv_value OMNESIS_GATEWAY_URL)" || return 1
  node -e '
const { BlockList, isIP } = require("node:net");
const value = process.argv[1];
if (value.length === 0) process.exit(1);

let url;
try {
  url = new URL(value);
} catch {
  process.exit(1);
}
if (url.protocol !== "https:") process.exit(1);
let host = url.hostname.toLowerCase();
if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
if (host.endsWith(".")) host = host.slice(0, -1);
if (host === "localhost" || host.endsWith(".localhost")) process.exit(1);

const family = isIP(host);
if (family !== 0) {
  const blocked = new BlockList();
  blocked.addSubnet("127.0.0.0", 8, "ipv4");
  blocked.addAddress("0.0.0.0", "ipv4");
  blocked.addAddress("::", "ipv6");
  blocked.addAddress("::1", "ipv6");
  blocked.addSubnet("fe80::", 10, "ipv6");
  blocked.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
  blocked.addAddress("::ffff:0.0.0.0", "ipv6");
  const type = family === 4 ? "ipv4" : "ipv6";
  if (blocked.check(host, type)) process.exit(1);
}

process.stdout.write(value);
' "$ENV_URL" 2>/dev/null
}

banner_gateway_url() {
  if ENV_URL="$(configured_remote_gateway_url)"; then
    printf '%s' "$ENV_URL"
    return 0
  fi
  for HOST_CANDIDATE in "$BANNER_HOST" "$PORTAL_HOST" omnesis.local; do
    case "$HOST_CANDIDATE" in
      ''|localhost) ;;
      *) printf 'https://%s:%s' "$HOST_CANDIDATE" "$GATEWAY_PORT"; return 0 ;;
    esac
  done
}

# The certificate the gateway is actually serving: the one this run provisioned
# when it provisioned one, else the self-signed certificate the gateway minted
# for itself on first boot.
banner_cert_path() {
  if ENV_CERT="$(dotenv_value OMNESIS_TLS_CERT)"; then
    if [ -n "$ENV_CERT" ] && [ -f "$ENV_CERT" ]; then printf '%s' "$ENV_CERT"; return 0; fi
  fi
  printf '%s' "$CONFIG_DIR/tls/cert.pem"
}

print_client_banner() {
  echo ""
  printf '\033[1m\033[0;32mOmnesis client is installed.\033[0m\n'
  echo ""
  echo "  This machine will not run a gateway, collector, or embedding model."
  echo "  Omnesis executable: $OMNESIS_BIN"
  echo "  Pair it with a remote gateway using the command for your client workflow."
  echo ""
  echo "  Update later:  omnesis update"
  print_path_hints
  echo ""
}

# ── Updating an existing install ─────────────────────────────────────────────
#
# A machine this installer already set up records its source checkout in
# update-state.json. Re-running the installer there, for the role the machine
# already has, is an update: the installer makes sure the checkout can fetch
# from its origin and then hands the update to the machine's own updater
# (`omnesis update`), which moves and rebuilds the checkout, refreshes and
# restarts the services it runs, refreshes agent integrations, and rolls back
# on failure. Certificate, keyring, embedding model and pairing are left as
# they are. --reconfigure runs the full installer on the machine instead.

# The checkout an earlier run of this installer manages here: an update-state
# record of a source install whose checkout still carries the installer's
# marker. Fails when there is none.
recorded_source_root() {
  [ -f "$CONFIG_DIR/update-state.json" ] || return 1
  # Homebrew installs node@24 keg-only, and a non-login shell may not have
  # Homebrew on PATH at all: look where the source wrapper looks.
  case "$(node --version 2>/dev/null)" in
    v2[4-9].*|v[3-9][0-9].*|v[1-9][0-9][0-9].*) ;;
    *)
      for RECORDED_NODE_PREFIX in "${HOMEBREW_PREFIX:-}" /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew; do
        if [ -n "$RECORDED_NODE_PREFIX" ] && [ -x "$RECORDED_NODE_PREFIX/opt/node@24/bin/node" ]; then
          PATH="$RECORDED_NODE_PREFIX/opt/node@24/bin:$PATH"
          break
        fi
      done
      ;;
  esac
  command -v node >/dev/null 2>&1 && command -v git >/dev/null 2>&1 || return 1
  RECORDED_ROOT="$(node -e '
const fs = require("node:fs");
try {
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const exactCommit = /^[0-9a-f]{40}$/;
  // The record the source wrapper accepts. One it refuses sends its repair
  // back to this installer, so it takes the full install, not the updater.
  const usable = state?.phase === "complete"
    ? exactCommit.test(state.commit)
    : ["applying", "rolling-back"].includes(state?.phase) &&
      exactCommit.test(state.targetCommit) && exactCommit.test(state.lastCompletedCommit);
  if (state?.version === 1 && state?.method === "source" &&
      typeof state.rootDir === "string" && state.rootDir.startsWith("/") && usable) {
    process.stdout.write(state.rootDir);
  }
} catch {}
' "$CONFIG_DIR/update-state.json" 2>/dev/null)" || return 1
  [ -n "$RECORDED_ROOT" ] && [ -d "$RECORDED_ROOT/.git" ] || return 1
  [ "$(git -C "$RECORDED_ROOT" config --local --no-includes --get omnesis.install 2>/dev/null)" = managed ] || return 1
  printf '%s' "$RECORDED_ROOT"
}

# Whether this account's user service for $1 (gateway or collector) exists.
service_registered() {
  case "$PLATFORM" in
    darwin) [ -f "$HOME/Library/LaunchAgents/dev.omnesis.$1.plist" ] ;;
    *) [ -f "$HOME/.config/systemd/user/omnesis-$1.service" ] ;;
  esac
}

# The services this machine had before this run registered anything.
REGISTERED_BEFORE_RUN=""
note_registered_services() {
  for component in gateway collector; do
    service_registered "$component" && REGISTERED_BEFORE_RUN="$REGISTERED_BEFORE_RUN $component"
  done
  return 0
}
registered_before_run() {
  case " $REGISTERED_BEFORE_RUN " in *" $1 "*) return 0 ;; esac
  return 1
}

# A checkout first cloned from one release tag is configured to fetch only
# that tag, and a plain `git fetch` fails once origin no longer has it. Fetch
# origin's main branch instead, so any updater version can fetch from it.
repair_source_fetch_config() {
  CURRENT_FETCH="$(git -C "$1" config --get-all remote.origin.fetch 2>/dev/null || true)"
  case "$CURRENT_FETCH" in
    '+refs/heads/main:refs/remotes/origin/main'|'+refs/heads/*:refs/remotes/origin/*') return 0 ;;
  esac
  git -C "$1" config --unset-all remote.origin.fetch 2>/dev/null || true
  git -C "$1" config --add remote.origin.fetch '+refs/heads/main:refs/remotes/origin/main'
}

# Use the recorded checkout when this run named none, and choose an update when
# the machine already has the role this run asks for and nothing on the
# command line asks to set it up again. The role is read from the services
# registered here: a plain run updates a gateway or collector machine,
# --collector a collector machine, and --client-only a machine with neither.
# Anything else — a first install that stopped before its services were
# registered, a role change, a pinned commit — runs the full installer.
plan_existing_update() {
  [ "$DOCKER" = 0 ] || return 0
  RECORDED_SOURCE_ROOT="$(recorded_source_root)" || return 0
  if [ "$SOURCE_DIR_EXPLICIT" = 0 ]; then
    SOURCE_DIR="$RECORDED_SOURCE_ROOT"
  elif [ "$(cd "$SOURCE_DIR" 2>/dev/null && pwd -P)" != "$(cd "$RECORDED_SOURCE_ROOT" && pwd -P)" ]; then
    return 0
  fi
  [ "$RECONFIGURE_FLAG" = 0 ] && [ -z "$HARNESS" ] && [ "$METHOD" = source ] && [ -z "$PIN_COMMIT" ] || return 0
  [ "$PAIR_CODE_FLAG$PAIR_GATEWAY_URL_FLAG$PAIR_FINGERPRINT_FLAG" = 000 ] || return 0
  [ "$MKCERT_EXPLICIT$EMBEDDER_FLAG$KEYRING_PASSPHRASE_FLAG$GATEWAY_PORT_EXPLICIT" = 0000 ] || return 0
  [ "$HARDENED_FLAG$REPLACE_SOURCE_WRAPPER" = 00 ] || return 0
  if [ "$COLLECTOR" = 1 ]; then
    [ "$REGISTERED_BEFORE_RUN" = " collector" ] || return 0
  elif [ "$CLIENT_ONLY_FLAG" = 1 ]; then
    [ -z "$REGISTERED_BEFORE_RUN" ] || return 0
  else
    [ -n "$REGISTERED_BEFORE_RUN" ] || return 0
  fi
  [ -x "$HOME/.local/bin/omnesis" ] || return 0
  UPDATE_EXISTING=1
}

update_existing_install() {
  show_install_plan
  configure_network_budget
  stage "Preparing the host"
  ensure_node
  ensure_git
  OMNESIS_BIN="$HOME/.local/bin/omnesis"
  run_machine_update "$SOURCE_DIR"
  print_update_banner
}

# Run this machine's own `omnesis update` at $OMNESIS_BIN, toward --version or
# --edge when given. $1 is the checkout this installer recorded, or empty for
# an install it did not record, which its updater moves on its own.
run_machine_update() {
  MACHINE_UPDATE_ROOT="$1"
  set -- update --yes
  [ -z "$PIN_VERSION" ] || set -- "$@" --target-version "$PIN_VERSION"
  [ "$EDGE" = 0 ] || set -- "$@" --edge
  if [ -n "$MACHINE_UPDATE_ROOT" ]; then
    repair_source_fetch_config "$MACHINE_UPDATE_ROOT"
    # Updaters before 0.5.6 refuse a newer target that shares no history with
    # the installed build. Their --force also skips the downgrade refusal, so
    # it is added only when the target is not older than the installed build.
    # The installed build is the last completed one: after an interrupted
    # update the wrapper returns to it before running its updater.
    INSTALLED_VERSION="$(source_version_at "$(source_last_completed_commit "$MACHINE_UPDATE_ROOT" HEAD)")"
    if [ "$FORCE" = 1 ]; then
      set -- "$@" --force
    elif version_is_newer 0.5.6 "$INSTALLED_VERSION" &&
         { [ -z "$PIN_VERSION" ] || ! version_is_newer "$INSTALLED_VERSION" "$PIN_VERSION"; }; then
      set -- "$@" --force
    fi
  fi
  stage "Updating with this machine's own updater"
  info "Running: omnesis $*"
  UPDATE_STATUS=0
  "$OMNESIS_BIN" "$@" </dev/null || UPDATE_STATUS=$?
  [ "$UPDATE_STATUS" = 0 ] || \
    fail "The update did not finish (exit $UPDATE_STATUS); its own messages above say why. Fix that and re-run this installer, or run: omnesis update"
}

print_update_banner() {
  echo ""
  printf '\033[1m\033[0;32mOmnesis is up to date.\033[0m\n'
  echo ""
  echo "  Version:   $("$OMNESIS_BIN" --version 2>/dev/null || echo '(unavailable)')"
  echo "  Checkout:  $SOURCE_DIR"
  echo ""
  echo "  Its certificate, keyring, embedding model and pairing are unchanged."
  echo "  To set this machine up again, re-run with --reconfigure."
  echo "  Update later:  omnesis update"
  print_path_hints
  echo ""
}

# ── Argument parsing + main ──────────────────────────────────────────────────

# One harness per invocation. Refused here rather than in main() because the
# two flags write the same variable, so by the time main() runs the second one
# has already erased the evidence of the first.
set_harness_role() {
  if [ -n "$HARNESS" ] && [ "$HARNESS" != "$1" ]; then
    fail "--openclaw and --hermes name two different harnesses; connect one per invocation."
  fi
  HARNESS="$1"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --method)     METHOD="$2"; METHOD_FLAG=1; shift 2 ;;
      --channel)    CHANNEL="$2"; shift 2 ;;
      --registry)   REGISTRY="$2"; shift 2 ;;
      --version)    PIN_VERSION="$2"; shift 2 ;;
      --commit)     PIN_COMMIT="$2"; shift 2 ;;
      --edge)       EDGE=1; shift ;;
      --force)      FORCE=1; shift ;;
      --replace-source-wrapper) REPLACE_SOURCE_WRAPPER=1; shift ;;
      --source-dir) SOURCE_DIR="$2"; SOURCE_DIR_FLAG=1; SOURCE_DIR_EXPLICIT=1; shift 2 ;;
      --port)       GATEWAY_PORT="$2"; GATEWAY_PORT_EXPLICIT=1; shift 2 ;;
      --mkcert)     USE_MKCERT=1; MKCERT_EXPLICIT=1; shift ;;
      --client-only) CLIENT_ONLY=1; CLIENT_ONLY_FLAG=1; WANT_SERVICE=0; WANT_MODEL=0; WANT_TLS=0; shift ;;
      --collector)  COLLECTOR=1; shift ;;
      --openclaw)   set_harness_role openclaw; shift ;;
      --hermes)     set_harness_role hermes; shift ;;
      --gateway-url) PAIR_GATEWAY_URL="$2"; PAIR_GATEWAY_URL_FLAG=1; shift 2 ;;
      --trust-fingerprint) PAIR_FINGERPRINT="$2"; PAIR_FINGERPRINT_FLAG=1; shift 2 ;;
      --code)       PAIR_CODE="$2"; PAIR_CODE_FLAG=1; shift 2 ;;
      --docker)     DOCKER=1; shift ;;
      --build)      DOCKER_BUILD_FLAG=1; shift ;;
      --tls-cert)   TLS_CERT_PATH="$2"; TLS_FILES_FLAG=1; shift 2 ;;
      --tls-key)    TLS_KEY_PATH="$2"; TLS_FILES_FLAG=1; shift 2 ;;
      --tls-ca)     TLS_CA_PATH="$2"; TLS_FILES_FLAG=1; shift 2 ;;
      --no-service) WANT_SERVICE=0; NO_SERVICE_FLAG=1; shift ;;
      --no-modify-path) MODIFY_PATH=0; shift ;;
      --hardened)   HARDENED_FLAG=1; shift ;;
      --no-hardened) NO_HARDENED_FLAG=1; shift ;;
      --embedder)   EMBEDDER_ID="$2"; EMBEDDER_EXPLICIT=1; EMBEDDER_FLAG=1; shift 2 ;;
      --no-model)   WANT_MODEL=0; shift ;;
      --no-tls)     WANT_TLS=0; NO_TLS_FLAG=1; shift ;;
      --no-keyring) WANT_KEYRING=0; shift ;;
      --keyring-passphrase-file) KEYRING_PASSPHRASE_FILE="$2"; KEYRING_PASSPHRASE_FLAG=1; shift 2 ;;
      --reconfigure) RECONFIGURE_FLAG=1; shift ;;
      --dry-run)     DRY_RUN=1; shift ;;
      --no-prompt)   NO_PROMPT=1; shift ;;
      # The header runs to the first empty line, so it stays whole as flags
      # are added to it.
      -h|--help)    sed -n '2,/^$/p' "$0" 2>/dev/null || true; exit 0 ;;
      *) fail "Unknown flag: $1" ;;
    esac
  done
}

main() {
  parse_args "$@"
  valid_gateway_port "$GATEWAY_PORT" || fail "--port must be a whole number from 1 through 65535."
  validate_hardened_flags
  if [ "$DOCKER" = 1 ]; then
    [ -z "$PIN_COMMIT" ] || \
      fail "--commit is source-only; Docker installs published images."
    [ "$REPLACE_SOURCE_WRAPPER" = 0 ] || \
      fail "--replace-source-wrapper applies only to a native package install; --docker has no source launcher to replace."
    [ "$EDGE" != 1 ] || \
      fail "--edge cannot be used with --docker: the Docker installer resolves images cut at releases; it does not map --edge to a branch image. Use --version X.Y.Z to install a released image. For an arbitrary commit, dispatch the 'docker' workflow with publishing enabled, then follow https://omnesis.dev/docs/install#docker to pin its sha-* image tag."
    # A Docker install runs the CLI out of the images, so every flag that
    # selects how a CLI is installed on this host has nothing to act on.
    [ "$CLIENT_ONLY_FLAG" = 0 ] || \
      fail "--client-only installs the CLI on this machine; --docker runs the daemons in containers. One role per invocation."
    # A harness plugin runs inside the harness process, so there is no
    # container for it and no half of this role that would help.
    [ -z "$HARNESS" ] || \
      fail "--$HARNESS connects an agent harness installed on this machine, and its plugin runs inside the harness process — there is no container for it. Install that role natively, without --docker."
    [ "$METHOD_FLAG" = 0 ] || \
      fail "--method selects how the CLI is installed on this host; --docker runs it from published images. Pin a release with --version X.Y.Z."
    [ "$SOURCE_DIR_FLAG" = 0 ] || \
      fail "--source-dir is where a source install is checked out; --docker keeps no checkout."
    [ "$CHANNEL" = stable ] || \
      fail "--channel selects an npm dist-tag; --docker resolves images from a container registry. Pin a release with --version X.Y.Z."
    [ -z "$REGISTRY" ] || \
      fail "--registry selects the npm registry a package is installed from; --docker resolves and pulls images from the container repository named by OMNESIS_IMAGE_REPO."
    [ "$MKCERT_EXPLICIT" = 0 ] || \
      fail "--mkcert provisions a certificate on this host; the gateway container mints its own on first boot. To serve an mkcert certificate from the container, mint it on this host into the config directory — mkcert -cert-file $CONFIG_DIR/tls/mkcert.crt -key-file $CONFIG_DIR/tls/mkcert.key <names> — copy \"\$(mkcert -CAROOT)/rootCA.pem\" to $CONFIG_DIR/tls/rootCA.pem, and re-run with --tls-cert, --tls-key and --tls-ca naming those files. See https://omnesis.dev/docs/install#docker-tls."
    docker_validate_tls_flags
    [ "$NO_TLS_FLAG" = 0 ] || \
      fail "--no-tls skips provisioning a certificate on this host. The gateway container always mints its own and always serves HTTPS, so there is nothing here to skip."
    [ "$NO_SERVICE_FLAG" = 0 ] || \
      fail "--no-service skips user service registration; --docker registers no services — the containers restart themselves."
    [ "$FORCE" = 0 ] || \
      fail "--force lets a source checkout move backwards; --docker runs whichever image tag you name, so --version is all a downgrade needs."
    # The passphrase is read by a container, and a bind mount cannot reach
    # outside itself: a path elsewhere on this host would leave encryption at
    # rest silently unarmed.
    if [ "$WANT_KEYRING" = 1 ] && [ -n "$KEYRING_PASSPHRASE_FILE" ]; then
      case "$KEYRING_PASSPHRASE_FILE" in
        "$CONFIG_DIR"/*) ;;
        *) fail "--keyring-passphrase-file has to name a file inside $CONFIG_DIR under --docker: the containers see that directory and nothing else on this host." ;;
      esac
    fi
    if [ "$COLLECTOR" = 1 ]; then
      # Multicast does not cross the Docker bridge, so the discovery the
      # native collector role falls back to cannot work here. Refusing beats
      # browsing a network the container cannot see.
      [ "$PAIR_GATEWAY_URL_FLAG" = 1 ] || \
        fail "--docker --collector needs --gateway-url: multicast does not cross the Docker bridge, so a container cannot browse the LAN for a gateway. The gateway's own install printed the exact line."
      DOCKER_CLI_SERVICE="collector"
      WANT_MODEL=0
    fi
    # Nothing on this host is registered with a service manager, and the
    # certificate is either the gateway container's own or the one --tls-cert
    # names; the host tiers this script provisions natively do not apply.
    WANT_SERVICE=0
    WANT_TLS=0
    PORTAL_HOST="localhost"
  else
    [ "$DOCKER_BUILD_FLAG" = 0 ] || fail "--build builds the container images and is only meaningful with --docker."
    [ "$TLS_FILES_FLAG" = 0 ] || \
      fail "--tls-cert, --tls-key and --tls-ca hand a certificate to the gateway container under --docker. A native gateway serves your own certificate when OMNESIS_TLS_CERT and OMNESIS_TLS_KEY in $CONFIG_DIR/.env name it; see https://omnesis.dev/docs/setup#public-domain."
  fi
  validate_method
  case "$EDGE" in 0|1) ;; *) fail "OMNESIS_INSTALL_EDGE must be 0 or 1." ;; esac
  case "$GATEWAY_WAIT_SECONDS" in
    ''|*[!0-9]*|0) fail "OMNESIS_GATEWAY_WAIT_SECONDS must be a positive whole number of seconds." ;;
  esac
  case "$GATEWAY_STARTUP_MAX_SECONDS" in
    ''|*[!0-9]*) fail "OMNESIS_GATEWAY_STARTUP_MAX_SECONDS must be a whole number of seconds (0 turns the extra wait off)." ;;
  esac
  case "$GATEWAY_STARTUP_POLL_SECONDS" in
    ''|*[!0-9]*|0) fail "OMNESIS_GATEWAY_STARTUP_POLL_SECONDS must be a positive whole number of seconds." ;;
  esac
  case "$COLLECTOR_WAIT_SECONDS" in
    ''|*[!0-9]*|0) fail "OMNESIS_COLLECTOR_WAIT_SECONDS must be a positive whole number of seconds." ;;
  esac
  case "$DISCOVER_MS" in
    ''|*[!0-9]*|0) fail "OMNESIS_DISCOVER_MS must be a positive whole number of milliseconds." ;;
  esac
  case "$NETWORK_TIMEOUT_SECONDS" in
    ''|*[!0-9]*|0) fail "OMNESIS_NETWORK_TIMEOUT_SECONDS must be a positive whole number of seconds." ;;
  esac
  if [ "${#NETWORK_TIMEOUT_SECONDS}" -gt 5 ] || [ "$NETWORK_TIMEOUT_SECONDS" -gt 86400 ]; then
    fail "OMNESIS_NETWORK_TIMEOUT_SECONDS must not exceed 86400 seconds."
  fi
  case "$DRY_RUN" in 0|1) ;; *) fail "OMNESIS_DRY_RUN must be 0 or 1." ;; esac
  case "$NO_PROMPT" in 0|1) ;; *) fail "OMNESIS_NO_PROMPT must be 0 or 1." ;; esac
  # `--collector`, `--openclaw` and `--hermes` are three names for the same
  # shape: a client install plus a pairing with a gateway running elsewhere.
  # ROLE_FLAG names whichever was typed, so one set of refusals covers all of
  # them and each names the flag the operator actually used.
  ROLE_FLAG=""
  [ "$COLLECTOR" = 0 ] || ROLE_FLAG="--collector"
  if [ -n "$HARNESS" ]; then
    [ -z "$ROLE_FLAG" ] || \
      fail "--collector and --$HARNESS are two roles for one machine; install one role per invocation."
    ROLE_FLAG="--$HARNESS"
  fi
  if [ -n "$ROLE_FLAG" ]; then
    # One role per invocation. Each of these already installs the CLI the way
    # `--client-only` does, so naming both is a contradiction, not a shorthand.
    [ "$CLIENT_ONLY_FLAG" = 0 ] || \
      fail "$ROLE_FLAG already installs the CLI without local gateway services; --client-only cannot be combined with it."
    [ "$GATEWAY_PORT_EXPLICIT" = 0 ] || \
      fail "--port sets the port of a LOCAL gateway; $ROLE_FLAG pairs with one elsewhere. Name it with --gateway-url https://<host>:<port>."
    [ "$MKCERT_EXPLICIT" = 0 ] || \
      fail "--mkcert provisions a certificate for a LOCAL gateway; $ROLE_FLAG pairs with one elsewhere. Verify its certificate with --trust-fingerprint sha256:… instead."
    # These roles are a client install plus a pairing: no local gateway, no
    # certificate to provision, and no embedding model — the gateway they pair
    # with owns the index and everything that searches it.
    CLIENT_ONLY=1
    WANT_MODEL=0
    WANT_TLS=0
  else
    [ "$PAIR_GATEWAY_URL_FLAG" = 0 ] || fail "--gateway-url is only meaningful with --collector, --openclaw or --hermes."
    [ "$PAIR_FINGERPRINT_FLAG" = 0 ] || fail "--trust-fingerprint is only meaningful with --collector, --openclaw or --hermes."
    [ "$PAIR_CODE_FLAG" = 0 ] || fail "--code is only meaningful with --collector, --openclaw or --hermes."
  fi
  if [ "$EMBEDDER_FLAG" = 1 ] && [ "$WANT_MODEL" = 0 ]; then
    fail "--embedder names a model to install; it cannot be combined with --no-model, --client-only, --collector, --openclaw or --hermes."
  fi
  if [ "$CLIENT_ONLY_FLAG" = 1 ]; then
    [ "$GATEWAY_PORT_EXPLICIT" = 0 ] || fail "--port cannot be used with --client-only."
    [ "$MKCERT_EXPLICIT" = 0 ] || fail "--mkcert cannot be used with --client-only."
    # A plain CLI host holds no index and no daemon credential worth sealing.
    # A collector host holds its device token, so `--collector` keeps the flag:
    # headless collector boxes are exactly where no OS keyring is available.
    [ "$KEYRING_PASSPHRASE_FLAG" = 0 ] || \
      fail "--keyring-passphrase-file cannot be used with --client-only. Use the local OS keyring."
  fi
  if [ -n "$HARNESS" ]; then
    # The harness keeps its own credentials in its own home, which this keyring
    # does not reach. Nothing this install writes here is worth sealing.
    [ "$KEYRING_PASSPHRASE_FLAG" = 0 ] || \
      fail "--keyring-passphrase-file cannot be used with $ROLE_FLAG. The harness keeps its credentials in its own home; nothing this install writes here needs sealing."
    # Accepting it silently would say this run had a daemon it chose not to
    # register, when the harness runs its own and this role registers none.
    [ "$WANT_SERVICE" = 1 ] || \
      fail "--no-service skips registering a daemon; $ROLE_FLAG registers none. The harness runs its own."
  fi
  echo ""
  printf '\033[1mOmnesis installer\033[0m — fully local, fully private.\n'
  echo ""
  detect_platform
  note_registered_services
  plan_existing_update
  plan_existing_harness
  # Before Node, before the CLI, and above all before a single-use pairing code
  # is asked for: a harness role on a machine with no harness is refused now,
  # not after an install that cannot be used and a code that cannot be reused.
  # After detect_platform only, so an unsupported OS is named as one.
  harness_preflight
  if [ "$DOCKER" = 1 ]; then
    [ "$DOCKER_BUILD_FLAG" = 0 ] || docker_resolve_build_context
    show_install_plan
    [ "$DRY_RUN" = 0 ] || return 0
    stage "Installing the Docker stack"
    docker_install
    return 0
  fi
  ensure_supported_linux_libc
  if [ "$DRY_RUN" = 1 ]; then
    # Validate all read-only gateway-account state. An implicit interactive
    # first-run choice stays clearly deferred rather than being guessed.
    if [ "$CLIENT_ONLY" != 1 ] && [ "$UPDATE_EXISTING" = 0 ]; then choose_gateway_account preview; fi
    show_install_plan
    return 0
  fi
  if [ "$UPDATE_EXISTING" = 1 ]; then
    update_existing_install
    return 0
  fi
  if [ "$HARNESS_EXISTING" = 1 ]; then
    harness_on_existing_install
    return 0
  fi
  # Asked before the plan and every mutation, so the printed role is the one
  # this run will actually install.
  [ "$CLIENT_ONLY" = 1 ] || choose_gateway_account
  show_install_plan
  configure_network_budget
  stage "Preparing the host"
  ensure_node
  resolve_method
  if [ "$METHOD" = source ]; then
    require_source_build_memory
    ensure_git
    ensure_source_build_tools
  fi
  [ "$REPLACE_SOURCE_WRAPPER" = 0 ] || [ "$METHOD" = package ] || \
    fail "--replace-source-wrapper needs a package install. Use --method package, or use --method auto without --edge."
  # Ask before the clone and the build, so the operator can walk away. A first
  # install has no CLI to read the model catalog from yet; that run asks the
  # moment one exists, still before anything is downloaded or started.
  choose_embedder
  stage "Installing the CLI"
  if [ "$METHOD" = package ]; then install_package; else install_source; fi
  choose_embedder final
  info "Installed: $("$OMNESIS_BIN" --version 2>/dev/null || echo '(version unavailable)')"
  stage "Configuring this machine"
  if [ "$CLIENT_ONLY" = 1 ]; then
    # A harness host has nothing of Omnesis's to seal — the harness keeps its
    # credentials in its own home — and a keyring armed here would seal
    # whatever else of Omnesis this account holds as a side effect.
    if [ -z "$HARNESS" ]; then
      setup_keyring_init
      setup_keyring_migrate
    fi
    if [ "$COLLECTOR" = 1 ]; then
      setup_collector_storage_keys
      resolve_gateway
      read_pairing_code collector
      collector_pair
      collector_register_service
      PACKAGE_SERVICE_REBOUND=1
      if [ "$WANT_SERVICE" = 1 ] && { ! restart_package_service_for_wrapper collector ||
         ! restart_moved_source_service collector; }; then
        PACKAGE_SERVICE_REBOUND=0
      fi
      collector_wait_online
      if [ "$WANT_SERVICE" = 1 ] && [ "$COLLECTOR_ONLINE" = 1 ] && [ "$PACKAGE_SERVICE_REBOUND" = 1 ]; then
        finalize_package_source_wrapper healthy
      else
        finalize_package_source_wrapper unsafe
      fi
      rm -f "$CONFIG_DIR/install-method"
      print_collector_banner
      return 0
    fi
    if [ -n "$HARNESS" ]; then
      harness_pair_and_connect
      finalize_package_source_wrapper unsafe
      rm -f "$CONFIG_DIR/install-method"
      print_harness_banner
      return 0
    fi
    finalize_package_source_wrapper unsafe
    rm -f "$CONFIG_DIR/install-method"
    print_client_banner
    return 0
  fi
  if [ "$GATEWAY_PORT_EXPLICIT" = 1 ]; then
    set_env OMNESIS_GATEWAY_PORT "$GATEWAY_PORT"
  elif SAVED_GATEWAY_PORT="$(dotenv_value OMNESIS_GATEWAY_PORT)"; then
    valid_gateway_port "$SAVED_GATEWAY_PORT" || \
      fail "OMNESIS_GATEWAY_PORT in $CONFIG_DIR/.env must be a whole number from 1 through 65535."
    GATEWAY_PORT="$SAVED_GATEWAY_PORT"
  fi
  GATEWAY_BIND="$(dotenv_value OMNESIS_BIND || printf '%s' '0.0.0.0')"
  GATEWAY_HEALTH_ORIGIN="$(local_gateway_health_origin "$GATEWAY_BIND" "$GATEWAY_PORT")" || \
    fail "OMNESIS_BIND in $CONFIG_DIR/.env is not a valid local gateway bind address."
  align_configured_gateway_url_port
  if [ "$WANT_HARDENED" = 1 ]; then
    hardened_install
    finalize_package_source_wrapper unsafe
    rm -f "$CONFIG_DIR/install-method"
    print_hardened_banner
    return 0
  fi
  provision_tls
  # The gateway URL has to name whatever the certificate covers, so TLS
  # provisioning claims the key first: Tailscale and mkcert certificates are
  # valid only for the names they minted, and a client dialling a stale host
  # against either one fails the handshake. localhost is the fallback for a
  # run that minted no named cert.
  if [ "$GATEWAY_PORT" != 7600 ] && ! env_key_set OMNESIS_GATEWAY_URL; then
    append_env OMNESIS_GATEWAY_URL "https://localhost:$GATEWAY_PORT"
  fi
  setup_keyring_init
  setup_keyring_migrate
  start_services
  PACKAGE_SERVICE_REBOUND=1
  if [ "$WANT_SERVICE" = 1 ] && { ! restart_package_service_for_wrapper gateway ||
     ! restart_moved_source_service gateway; }; then
    PACKAGE_SERVICE_REBOUND=0
  fi
  if [ "$WANT_SERVICE" != 1 ]; then
    finalize_package_source_wrapper unsafe
    if [ "$WANT_MODEL" = 1 ]; then
      warn "Services not registered — start the gateway, then run: omnesis model install $EMBEDDER_ID"
    fi
  elif [ "$PACKAGE_SERVICE_REBOUND" = 1 ] && wait_for_gateway; then
    if [ "$METHOD" != package ] || package_service_is_running gateway; then
      GATEWAY_HEALTHY=1
      if restart_package_service_for_wrapper collector && restart_moved_source_service collector; then
        install_model
        setup_codex_agent
        choose_certificate_gateway_url
        finalize_package_source_wrapper healthy
      else
        PACKAGE_SERVICE_REBOUND=0
        finalize_package_source_wrapper unsafe
      fi
    else
      PACKAGE_SERVICE_REBOUND=0
      warn "The gateway stopped being supervised after its health response. The source launcher will be retained."
      finalize_package_source_wrapper unsafe
      fail_unhealthy_gateway
    fi
  else
    finalize_package_source_wrapper unsafe
    fail_unhealthy_gateway
  fi
  rm -f "$CONFIG_DIR/install-method"
  print_banner
}

main "$@"
