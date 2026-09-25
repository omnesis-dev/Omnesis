#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Single-host install → update → rollback, under the host's real supervisor
# (systemd user units on Linux, launchd in the login session on macOS).
#
#   E2E_WORK=<scratch dir> scripts/install-e2e/single-host.sh
#
# 1. The candidate (this checkout) becomes release vN in a fixture remote and
#    is installed fresh with its own install.sh, gateway and collector both.
# 2. An invented Obsidian vault is added and synced, so there is data to keep.
# 3. vN+1 (the same code, the next version) is published; re-running install.sh
#    hands off to `omnesis update`, which must land it: both daemons restarted,
#    same collector device, same documents, the known search hit, a pre-update
#    backup, and no new doctor failures.
# 4. vN+2, whose gateway exits during boot, is published; `omnesis update` must
#    fail, roll back to vN+1, and leave both daemons serving it.
#
# Runs on a disposable CI machine: it installs into $HOME and registers real
# user services. Do not run it on a machine you use.
set -euo pipefail

E2E_WORK="${E2E_WORK:?set E2E_WORK}"
# shellcheck source=scripts/install-e2e/lib.sh
. "$(dirname "$0")/lib.sh"

[ -n "${CI:-}" ] || die "single-host.sh installs into \$HOME and registers services; it runs on CI machines only"

GATEWAY_URL="https://localhost:7600"
FIXTURE_DIR="$E2E_WORK/fixture"
REMOTE="$FIXTURE_DIR/omnesis.git"
SOURCE_DIR="$HOME/omnesis"

installer() {
  OMNESIS_REPO_URL="file://$REMOTE" redacted sh "$E2E_ROOT/scripts/install.sh" "$@"
}

# The gateway's self-signed certificate is what the probe verifies against.
use_gateway_ca() {
  export NODE_EXTRA_CA_CERTS="$CONFIG_DIR/tls/cert.pem"
  [ -s "$NODE_EXTRA_CA_CERTS" ] || die "no gateway certificate at $NODE_EXTRA_CA_CERTS"
}

keyring_flags() {
  case "$(uname -s)" in
    # The login keychain is unlocked in the runner's GUI session, so the
    # installer takes the macOS Keychain path a real Mac takes.
    Darwin) ;;
    # No Secret Service on a headless Linux host: the passphrase backend,
    # sealed into the systemd unit as a credential.
    *)
      local pass="$E2E_WORK/keyring.pass"
      (umask 077 && head -c 32 /dev/urandom | base64 >"$pass")
      printf '%s\n' "--keyring-passphrase-file" "$pass"
      ;;
  esac
}

group "Fixture: the candidate as release vN"
fixture init --source "$E2E_ROOT" --out "$FIXTURE_DIR" | tee "$E2E_WORK/fixture-init.json"
V_N="$(json_get "$FIXTURE_DIR/fixture.json" 'j.candidateVersion')"
log "candidate is v$V_N"
endgroup

group "Install v$V_N (gateway + collector, supervised)"
# shellcheck disable=SC2046
installer --source-dir "$SOURCE_DIR" --no-model --no-tls --no-prompt --no-modify-path $(keyring_flags) ||
  die "the fresh install failed"
use_gateway_ca
probe health --url "$GATEWAY_URL" --expect-version "$V_N" --timeout 120 >/dev/null
endgroup

group "Seed an invented vault"
mint_probe_token
COLLECTOR="$(live_collector_name "$GATEWAY_URL" 180)" || die "the gateway lists no connected collector"
make_vault "$E2E_WORK/vault"
SOURCE_ID="$(add_vault "$COLLECTOR" "$E2E_WORK/vault")"
redacted "$OMNESIS" sources sync "$SOURCE_ID" --wait --timeout 300 || die "the vault did not sync"
snapshot_with_hit before "$GATEWAY_URL"
endgroup

group "Update to vN+1 by re-running install.sh"
V_N1="$(fixture next-version --remote "$REMOTE")"
fixture release --remote "$REMOTE" --version "$V_N1" >"$E2E_WORK/release-n1.json"
installer --no-prompt || die "re-running install.sh did not update to v$V_N1"
probe health --url "$GATEWAY_URL" --expect-version "$V_N1" --timeout 180 >/dev/null
wait_collector_live "$GATEWAY_URL" "$COLLECTOR"
redacted "$OMNESIS" sources sync "$SOURCE_ID" --wait --timeout 300 || die "the vault did not sync after the update"
snapshot_with_hit updated "$GATEWAY_URL"
probe compare --before "$E2E_WORK/before.json" --after "$E2E_WORK/updated.json" \
  --expect-version "$V_N1" --expect-restart gateway,collector --expect-backup --expect-title "$SEARCH_TITLE"
endgroup

group "A broken vN+2 must roll back"
V_N2="$(fixture next-version --remote "$REMOTE")"
fixture release --remote "$REMOTE" --version "$V_N2" --base "v$V_N1" --break gateway-boot >"$E2E_WORK/release-n2.json"
set +e
"$OMNESIS" update --yes 2>&1 | tee "$E2E_WORK/broken-update.log" | redact
status=${PIPESTATUS[0]}
set -e
[ "$status" -ne 0 ] || die "updating to the broken v$V_N2 reported success"
grep -q "Rolled back to" "$E2E_WORK/broken-update.log" || die "the failed update did not report a rollback"
# The broken release builds; what has to trip the rollback is its gateway
# failing to serve, not a failed build.
if grep -q "npm run build\` failed" "$E2E_WORK/broken-update.log"; then
  die "v$V_N2 failed to build, so the boot-failure rollback was not exercised"
fi
probe health --url "$GATEWAY_URL" --expect-version "$V_N1" --timeout 180 >/dev/null
N1_COMMIT="$(json_get "$E2E_WORK/release-n1.json" 'j.commit')"
[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$N1_COMMIT" ] || die "the checkout is not back on v$V_N1"
[ "$(json_get "$CONFIG_DIR/update-state.json" 'j.phase')" = complete ] || die "update state is not complete after the rollback"
[ "$(json_get "$CONFIG_DIR/update-state.json" 'j.commit')" = "$N1_COMMIT" ] || die "update state does not name v$V_N1"
wait_collector_live "$GATEWAY_URL" "$COLLECTOR"
snapshot_with_hit rolled-back "$GATEWAY_URL"
probe compare --before "$E2E_WORK/updated.json" --after "$E2E_WORK/rolled-back.json" \
  --expect-version "$V_N1" --expect-restart gateway --expect-title "$SEARCH_TITLE"
endgroup

log "install v$V_N → update v$V_N1 → broken v$V_N2 rolled back: all held"
