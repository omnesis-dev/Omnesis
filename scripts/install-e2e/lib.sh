# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# shellcheck shell=bash disable=SC2034 # sourced: the variables are for the caller
# Shared helpers for the install/update lane (sourced, never executed).
# Written for bash 3.2, the version macOS ships.
#
# The caller sets E2E_WORK (a scratch directory that outlives the step) before
# sourcing. Everything the lane writes lives under it: the fixture, the
# scoped test token, snapshots, the secrets list the redactor reads.

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_ROOT="$(cd "$E2E_DIR/../.." && pwd)"
: "${E2E_WORK:?set E2E_WORK to the scratch directory of the lane}"
mkdir -p "$E2E_WORK"
export INSTALL_E2E_SECRETS_FILE="$E2E_WORK/secrets"
touch "$INSTALL_E2E_SECRETS_FILE"
chmod 600 "$INSTALL_E2E_SECRETS_FILE"

OMNESIS="$HOME/.local/bin/omnesis"
CONFIG_DIR="${OMNESIS_CONFIG_DIR:-$HOME/.config/omnesis}"
TOKEN_FILE="$E2E_WORK/probe-token"

log() { printf '[install-e2e] %s\n' "$*"; }
# To stderr, so a failure inside a command substitution is still seen.
die() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}
group() { printf '::group::%s\n' "$*"; }
endgroup() { printf '::endgroup::\n'; }

# Register a value this run must never publish: masked by the runner from
# here on, and by the redactor in anything it filters.
secret() {
  [ -n "$1" ] || return 0
  printf '::add-mask::%s\n' "$1"
  printf '%s\n' "$1" >>"$INSTALL_E2E_SECRETS_FILE"
}

redact() { node "$E2E_DIR/redact.mjs"; }

# Run a command with its output redacted, keeping the command's exit status.
redacted() {
  set +e
  "$@" 2>&1 | redact
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

# The value of a JavaScript expression over a JSON file, e.g.
#   json_get file.json 'j.version'
json_get() {
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = (0, eval)("(j) => " + process.argv[2])(j);
    if (v === undefined || v === null) process.exit(3);
    process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
  ' "$1" "$2"
}

fixture() { node "$E2E_DIR/fixture.mjs" "$@"; }
probe() { node "$E2E_DIR/probe.mjs" "$@"; }
mailbox() { node "$E2E_DIR/mailbox.mjs" "$@"; }

# Write the CLI's JSON view of this host (services, doctor, backups) next to
# a snapshot name, for `probe snapshot` to fold in.
host_json() {
  local name="$1"
  "$OMNESIS" service status --json >"$E2E_WORK/$name.services.json" 2>/dev/null || true
  "$OMNESIS" doctor --json >"$E2E_WORK/$name.doctor.json" 2>/dev/null || true
  "$OMNESIS" backup --list --json >"$E2E_WORK/$name.backups.json" 2>/dev/null || true
}

# snapshot <name> <gateway url> [extra probe flags…]
snapshot() {
  local name="$1" url="$2"
  shift 2
  host_json "$name"
  probe snapshot --url "$url" --token-file "$TOKEN_FILE" \
    --services "$E2E_WORK/$name.services.json" \
    --doctor "$E2E_WORK/$name.doctor.json" \
    --backups "$E2E_WORK/$name.backups.json" \
    "$@" >"$E2E_WORK/$name.json"
  log "snapshot $name: version $(json_get "$E2E_WORK/$name.json" 'j.version'), $(json_get "$E2E_WORK/$name.json" 'j.docTotal') documents"
}

# Mint the lane's own read+admin token on the gateway host, so the probe can
# read the HTTP API without touching the installer's (keyring-sealed) token.
mint_probe_token() {
  local device out token
  device="$("$OMNESIS" whoami --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => process.stdout.write(JSON.parse(s).deviceId || ""));')"
  [ -n "$device" ] || die "could not resolve the gateway's own device id"
  out="$("$OMNESIS" tokens create --device "$device" --scopes read,admin --name install-e2e-probe --ttl 1d 2>&1)" ||
    die "could not mint the probe token"
  token="$(printf '%s\n' "$out" | sed -n 's/^ *Token: *//p' | head -1)"
  [ -n "$token" ] || die "the probe token was not printed"
  secret "$token"
  (umask 077 && printf '%s\n' "$token" >"$TOKEN_FILE")
}

# An invented Obsidian vault: three notes, one carrying a word nothing else
# in the corpus does, so a keyword search has exactly one right answer.
SEARCH_WORD="brindlewick"
SEARCH_TITLE="Harbor lantern checklist"
make_vault() {
  local vault="$1"
  mkdir -p "$vault/.obsidian" "$vault/Projects"
  cat >"$vault/$SEARCH_TITLE.md" <<EOF
# $SEARCH_TITLE

Trim the wick, polish the lens, and log the $SEARCH_WORD reading before dusk.
EOF
  cat >"$vault/Projects/Garden Plan.md" <<'EOF'
# Garden Plan

Tomatoes along the south fence; basil in the raised bed by the shed.
EOF
  cat >"$vault/Reading List.md" <<'EOF'
# Reading List

- A field guide to coastal birds
- Notes on bread baking at altitude
EOF
}

# snapshot_with_hit <name> <gateway url> [extra probe flags…]: a snapshot
# taken once keyword search finds the seeded note. A synced document reaches
# the search index shortly after the sync reports it, so this polls.
snapshot_with_hit() {
  local name="$1" url="$2" deadline=$(($(date +%s) + 180))
  shift 2
  while :; do
    snapshot "$name" "$url" --query "$SEARCH_WORD" "$@"
    json_get "$E2E_WORK/$name.json" 'j.search.titles' | grep -qF "$SEARCH_TITLE" && return 0
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "search for $SEARCH_WORD returned: $(json_get "$E2E_WORK/$name.json" 'j.search.titles' || echo none)"
      die "keyword search does not find the seeded note ($name)"
    fi
    sleep 5
  done
}

# wait_collector_live <gateway url> <collector name> [seconds]: after an
# update or a rollback restarts the daemons, the collector reconnects a few
# seconds after the command that restarted it returns.
wait_collector_live() {
  local url="$1" name="$2" deadline=$(($(date +%s) + ${3:-180})) file="$E2E_WORK/devices.json"
  while :; do
    if probe snapshot --url "$url" --token-file "$TOKEN_FILE" >"$file" 2>/dev/null &&
      [ "$(json_get "$file" "(j.devices.find((d) => d.name === '$name') || {}).online === true")" = true ]; then
      return 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || die "collector $name did not reconnect to the gateway"
    sleep 3
  done
}

# add_vault <collector device name> <vault path> → prints the new source id
add_vault() {
  local device="$1" vault="$2" out id
  out="$("$OMNESIS" sources add obsidian-notes "$vault" --device "$device" 2>&1)" || true
  printf '%s\n' "$out" | redact >&2
  id="$(printf '%s\n' "$out" | sed -n 's/^ *Source: *//p' | head -1)"
  [ -n "$id" ] || die "adding the obsidian-notes source failed"
  printf '%s\n' "$id"
}

# The name of a collector the gateway lists as connected, waiting up to $2
# seconds for one: the installer returns once the gateway is healthy, and its
# collector connects moments later.
live_collector_name() {
  local url="$1" deadline=$(($(date +%s) + ${2:-120})) file="$E2E_WORK/devices.json" name
  while :; do
    if probe snapshot --url "$url" --token-file "$TOKEN_FILE" >"$file" 2>/dev/null &&
      name="$(json_get "$file" "(j.devices.find((d) => d.kind === 'collector' && d.online) || {}).name")"; then
      printf '%s\n' "$name"
      return 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 3
  done
}
