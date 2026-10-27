#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Single-host install → uninstall → reinstall → uninstall --purge, under the
# host's real supervisor (systemd user units on Linux, launchd on macOS).
#
#   E2E_WORK=<scratch dir> scripts/install-e2e/uninstall.sh
#
# 1. The candidate is installed fresh — gateway and collector supervised, the
#    installer's PATH line in the shell profile — and an invented vault synced.
# 2. `omnesis uninstall --dry-run` changes nothing.
# 3. `omnesis uninstall --yes` removes the services, the checkout, the
#    launcher, the lock helper and the PATH line, and keeps the data.
# 4. Installing again over the kept data serves the same corpus, with the same
#    collector device, and search still finds the seeded note.
# 5. `omnesis uninstall --yes --purge` removes the data, the logs and the keys;
#    nothing of Omnesis is left in $HOME.
#
# Runs on a disposable CI machine: it installs into $HOME and registers real
# user services. Do not run it on a machine you use.
set -euo pipefail

E2E_WORK="${E2E_WORK:?set E2E_WORK}"
# shellcheck source=scripts/install-e2e/lib.sh
. "$(dirname "$0")/lib.sh"

[ -n "${CI:-}" ] || die "uninstall.sh installs into \$HOME and registers services; it runs on CI machines only"

GATEWAY_URL="https://localhost:7600"
FIXTURE_DIR="$E2E_WORK/fixture"
REMOTE="$FIXTURE_DIR/omnesis.git"
SOURCE_DIR="$HOME/omnesis"
BIN_DIR="$HOME/.local/bin"
PLATFORM="$(uname -s)"
if [ "$PLATFORM" = Darwin ]; then
  PROFILE="$HOME/.bash_profile"
  LOG_DIR="$HOME/Library/Logs/Omnesis"
else
  PROFILE="$HOME/.bashrc"
  LOG_DIR="$HOME/.local/state/omnesis"
fi

# The installer writes its PATH line only when the directory is not on PATH
# already, so it runs with ~/.local/bin taken off, the way a first install sees
# a fresh account.
INSTALL_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$BIN_DIR" | paste -sd: -)"
installer() {
  OMNESIS_REPO_URL="file://$REMOTE" redacted env PATH="$INSTALL_PATH" SHELL=/bin/bash \
    sh "$E2E_ROOT/scripts/install.sh" "$@"
}

use_gateway_ca() {
  export NODE_EXTRA_CA_CERTS="$CONFIG_DIR/tls/cert.pem"
  [ -s "$NODE_EXTRA_CA_CERTS" ] || die "no gateway certificate at $NODE_EXTRA_CA_CERTS"
}

# The units this account has registered, one name per line.
registered_units() {
  if [ "$PLATFORM" = Darwin ]; then
    ls "$HOME/Library/LaunchAgents" 2>/dev/null | grep '^dev\.omnesis\.' || true
  else
    ls "$HOME/.config/systemd/user" 2>/dev/null | grep '^omnesis-' || true
  fi
}

# Whether the supervisor still has a job for a component, file or no file.
supervised() {
  if [ "$PLATFORM" = Darwin ]; then
    launchctl print "gui/$(id -u)/dev.omnesis.$1" >/dev/null 2>&1
  else
    systemctl --user is-active --quiet "omnesis-$1.service"
  fi
}

gateway_answers() { curl -sk --max-time 5 "$GATEWAY_URL/health" >/dev/null 2>&1; }

# Fails the lane naming every path of $@ that exists.
expect_gone() {
  local what="$1" path left=""
  shift
  for path in "$@"; do
    if [ -e "$path" ] || [ -L "$path" ]; then left="$left $path"; fi
  done
  [ -z "$left" ] || die "$what left behind:$left"
}

set -- --source-dir "$SOURCE_DIR" --no-model --no-tls --no-prompt
if [ "$PLATFORM" != Darwin ]; then
  new_passphrase_file
  set -- "$@" --keyring-passphrase-file "$PASSPHRASE_FILE"
fi

group "Fixture: the candidate as release vN"
fixture init --source "$E2E_ROOT" --out "$FIXTURE_DIR" | tee "$E2E_WORK/fixture-init.json"
V_N="$(json_get "$FIXTURE_DIR/fixture.json" 'j.candidateVersion')"
log "candidate is v$V_N"
endgroup

group "Install v$V_N (gateway + collector, supervised, PATH line in $PROFILE)"
if [ -f "$PROFILE" ]; then cp "$PROFILE" "$E2E_WORK/profile.before"; else : >"$E2E_WORK/profile.before"; fi
installer "$@" || die "the fresh install failed"
use_gateway_ca
probe health --url "$GATEWAY_URL" --expect-version "$V_N" --timeout 120 >/dev/null
grep -qxF "# Added by the Omnesis installer" "$PROFILE" || die "the installer wrote no PATH line to $PROFILE"
[ -n "$(registered_units)" ] || die "the install registered no units"
endgroup

group "Seed an invented vault"
mint_probe_token
COLLECTOR="$(live_collector_name "$GATEWAY_URL" 180)" || die "the gateway lists no connected collector"
make_vault "$E2E_WORK/vault"
SOURCE_ID="$(add_vault "$COLLECTOR" "$E2E_WORK/vault")"
redacted "$OMNESIS" sources sync "$SOURCE_ID" --wait --timeout 300 || die "the vault did not sync"
snapshot_with_hit before "$GATEWAY_URL"
endgroup

group "omnesis uninstall --dry-run changes nothing"
redacted "$OMNESIS" uninstall --dry-run || die "the dry run failed"
[ -x "$OMNESIS" ] || die "the dry run removed the launcher"
[ -n "$(registered_units)" ] || die "the dry run removed units"
supervised gateway || die "the dry run stopped the gateway"
gateway_answers || die "the gateway stopped answering after the dry run"
endgroup

group "omnesis uninstall removes the software and keeps the data"
"$OMNESIS" uninstall --yes --json >"$E2E_WORK/uninstall.json" 2>"$E2E_WORK/uninstall.err" || {
  redact <"$E2E_WORK/uninstall.err" >&2
  redact <"$E2E_WORK/uninstall.json" >&2
  die "omnesis uninstall failed"
}
redact <"$E2E_WORK/uninstall.json"
[ "$(json_get "$E2E_WORK/uninstall.json" 'j.steps.every((s) => s.status === "done")')" = true ] \
  || die "a step of the uninstall did not finish"
[ "$(json_get "$E2E_WORK/uninstall.json" 'j.components.join(",")')" = "collector,gateway,cli" ] \
  || die "the uninstall did not remove the collector, the gateway and the CLI"
[ -z "$(registered_units)" ] || die "units are still registered: $(registered_units | tr '\n' ' ')"
! supervised gateway || die "the supervisor still runs the gateway"
! supervised collector || die "the supervisor still runs the collector"
! gateway_answers || die "something still answers on $GATEWAY_URL"
expect_gone "the uninstall" "$OMNESIS" "$SOURCE_DIR" "$HOME/.local/lib/omnesis"
[ -s "$CONFIG_DIR/omnesis.db" ] || die "the uninstall did not keep the corpus"
if [ -z "$(ls -A "$BIN_DIR" 2>/dev/null)" ]; then
  cmp -s "$PROFILE" "$E2E_WORK/profile.before" || {
    diff "$E2E_WORK/profile.before" "$PROFILE" >&2 || true
    die "$PROFILE does not read as it did before the install"
  }
else
  log "$BIN_DIR holds other programs, so the PATH line stays by design"
fi
endgroup

group "Installing again opens the kept data"
installer "$@" || die "the reinstall over the kept data failed"
probe health --url "$GATEWAY_URL" --expect-version "$V_N" --timeout 180 >/dev/null
wait_collector_live "$GATEWAY_URL" "$COLLECTOR"
snapshot_with_hit reinstalled "$GATEWAY_URL"
probe compare --before "$E2E_WORK/before.json" --after "$E2E_WORK/reinstalled.json" \
  --expect-version "$V_N" --expect-title "$SEARCH_TITLE"
endgroup

group "omnesis uninstall --purge removes the data and keys too"
redacted "$OMNESIS" uninstall --yes --purge || die "omnesis uninstall --purge failed"
[ -z "$(registered_units)" ] || die "units are still registered after --purge"
! gateway_answers || die "something still answers on $GATEWAY_URL"
expect_gone "uninstall --purge" "$OMNESIS" "$SOURCE_DIR" "$HOME/.local/lib/omnesis" "$CONFIG_DIR" "$LOG_DIR"
if [ "$PLATFORM" = Darwin ]; then
  ! security find-generic-password -s dev.omnesis >/dev/null 2>&1 \
    || die "the login keychain still holds a dev.omnesis entry"
fi
# Nothing named for Omnesis anywhere in the home, outside this lane's own
# scratch space and the repository checkout under test.
LEFT="$(find "$HOME" -maxdepth 5 -iname '*omnesis*' \
  -not -path "$E2E_WORK*" -not -path "$E2E_ROOT*" -not -path "${RUNNER_TEMP:-/nonexistent}*" \
  -not -path "$HOME/work/*" -not -path "$HOME/actions-runner/*" -not -path "$HOME/.npm/*" 2>/dev/null || true)"
[ -z "$LEFT" ] || die "left in \$HOME after --purge: $(printf '%s' "$LEFT" | tr '\n' ' ')"
endgroup

log "install v$V_N → uninstall (data kept) → reinstall → uninstall --purge: all held"
