#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# This branch's install.sh, run for real against the newest RELEASED CLI —
# the combination omnesis.dev serves, since the site deploys main's installer
# and the installer installs the newest release.
#
#   E2E_WORK=<scratch dir> scripts/install-e2e/release-skew.sh native
#   E2E_WORK=<scratch dir> scripts/install-e2e/release-skew.sh docker
#
# native: a fixture remote keeps the real release tags, so the installer checks
#   out and builds the newest one, exactly as the published one-liner does.
#   1. A gateway host, with no terminal (how automation and agents run it).
#   2. A collector, with no terminal, from the code the gateway mints and its
#      certificate fingerprint.
#   3. A collector on a pseudo-terminal, typing the pairing code at the prompt,
#      trusting the certificate when the CLI asks, and arming the generated
#      passphrase keyring.
#   4. install.sh re-run on the gateway host, which hands off to the released
#      CLI's own `omnesis update`.
#   Every CLI process those runs start is recorded (cli-trace.cjs) and checked
#   against the installed release's own command tree, including the calls whose
#   output the installer discards.
#
# docker: the newest published images.
#   1. install.sh --docker with no terminal, encrypted at rest.
#   2. The launcher it wrote, running each command the installer and its banner
#      lead an operator to.
#   3. install.sh --docker re-run on a pseudo-terminal over that install, the
#      way an operator re-runs the one-liner.
#   The CLI runs inside the images there, so its output is what is checked.
#
# Runs on a disposable CI machine: it installs into $HOME and registers real
# user services. Do not run it on a machine you use.
set -euo pipefail

MODE="${1:?usage: release-skew.sh native|docker}"
E2E_WORK="${E2E_WORK:?set E2E_WORK}"
# shellcheck source=scripts/install-e2e/lib.sh
. "$(dirname "$0")/lib.sh"

[ -n "${CI:-}" ] || die "release-skew.sh installs into \$HOME and registers services; it runs on CI machines only"

SKEW="$E2E_DIR/release-skew.mjs"
skew() { node "$SKEW" "$@"; }
GATEWAY_URL="https://localhost:7600"
NPM_CACHE="$(npm config get cache)"
# The installer reads a dozen OMNESIS_* variables; this lane sets exactly the
# ones it means to.
while IFS='=' read -r name _; do
  case "$name" in OMNESIS_*) unset "$name" ;; esac
done < <(env)
export OMNESIS_GATEWAY_WAIT_SECONDS=240 OMNESIS_OAUTH_HOST_PORTS=ephemeral

case "$MODE" in
native)
  FIXTURE_DIR="$E2E_WORK/fixture"
  REMOTE="$FIXTURE_DIR/omnesis.git"
  TRACE="$E2E_WORK/cli-trace.jsonl"
  : >"$TRACE"

  # install.sh as the one-liner runs it, from this branch, against the fixture
  # remote, with every CLI process it starts recorded. `home` is the HOME of
  # the machine being installed; the npm cache is the runner's, so the second
  # and third builds of the same release fetch nothing.
  installer() {
    local home="$1"
    shift
    HOME="$home" NPM_CONFIG_CACHE="$NPM_CACHE" OMNESIS_REPO_URL="file://$REMOTE" \
      OMNESIS_CLI_TRACE="$TRACE" NODE_OPTIONS="--require=$E2E_DIR/cli-trace.cjs" \
      sh "$E2E_ROOT/scripts/install.sh" "$@"
  }

  group "Fixture: the real release tags, this branch as main"
  fixture init --source "$E2E_ROOT" --out "$FIXTURE_DIR" --keep-releases >"$E2E_WORK/fixture-init.json"
  RELEASE="$(skew newest-tag --remote "$REMOTE")"
  log "the installer will install $RELEASE, the newest release"
  endgroup

  group "Gateway host, no terminal"
  new_passphrase_file
  set +e
  installer "$HOME" --source-dir "$HOME/omnesis" --no-model --no-tls --no-modify-path \
    --keyring-passphrase-file "$PASSPHRASE_FILE" </dev/null 2>&1 | tee "$E2E_WORK/gateway-install.log" | redact
  status=${PIPESTATUS[0]}
  set -e
  [ "$status" -eq 0 ] || die "the gateway install failed (exit $status)"
  # The version alone cannot tell: between releases main carries the newest
  # release's version too.
  [ "$(git -C "$HOME/omnesis" rev-parse HEAD)" = "$(git -C "$E2E_ROOT" rev-parse "$RELEASE^{commit}")" ] ||
    die "the installer did not check out $RELEASE"
  [ "$("$OMNESIS" --version)" = "${RELEASE#v}" ] || die "the installed CLI is not ${RELEASE#v}"
  export NODE_EXTRA_CA_CERTS="$CONFIG_DIR/tls/cert.pem"
  probe health --url "$GATEWAY_URL" --expect-version "${RELEASE#v}" --timeout 120 >/dev/null
  FINGERPRINT="$(skew fingerprint "$CONFIG_DIR/tls/cert.pem")"
  endgroup

  # Each collector is another machine: its own HOME, and its own host name,
  # which names the device it pairs as. Two collectors named after this
  # runner would collide with the gateway host's own collector.
  as_machine() {
    local home="$1" name="$2"
    mkdir -p "$home/.release-skew-bin"
    printf '#!/bin/sh\necho %s\n' "$name" >"$home/.release-skew-bin/hostname"
    chmod +x "$home/.release-skew-bin/hostname"
  }

  # Sets CODE. Not for use inside $(…): the mask has to reach the runner.
  mint_code() {
    CODE="$("$OMNESIS" devices pair --kind collector --json </dev/null | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => process.stdout.write(JSON.parse(s).pairingCode || ""));')"
    [ -n "$CODE" ] || die "the gateway minted no pairing code"
    secret "$CODE"
  }

  group "Collector, no terminal"
  mint_code
  HOME_A="$E2E_WORK/home-collector"
  as_machine "$HOME_A" release-skew-headless
  set +e
  PATH="$HOME_A/.release-skew-bin:$PATH" installer "$HOME_A" --collector --gateway-url "$GATEWAY_URL" --code "$CODE" \
    --trust-fingerprint "$FINGERPRINT" --source-dir "$HOME_A/omnesis" --no-service \
    --no-modify-path --keyring-passphrase-file "$PASSPHRASE_FILE" </dev/null 2>&1 |
    tee "$E2E_WORK/collector-install.log" | redact
  status=${PIPESTATUS[0]}
  set -e
  [ "$status" -eq 0 ] || die "the collector install with no terminal failed (exit $status)"
  [ -s "$HOME_A/.config/omnesis/collector-token" ] || die "the collector install saved no device token"
  endgroup

  group "Collector on a terminal"
  mint_code
  HOME_B="$E2E_WORK/home-collector-tty"
  as_machine "$HOME_B" release-skew-terminal
  # Choice 2 arms the generated passphrase keyring: what an operator on a
  # headless box picks, and the path with the most keyring calls.
  set +e
  RELEASE_SKEW_PAIR_CODE="$CODE" RELEASE_SKEW_KEYRING_CHOICE=2 \
    PATH="$HOME_B/.release-skew-bin:$PATH" HOME="$HOME_B" NPM_CONFIG_CACHE="$NPM_CACHE" OMNESIS_REPO_URL="file://$REMOTE" \
    OMNESIS_CLI_TRACE="$TRACE" NODE_OPTIONS="--require=$E2E_DIR/cli-trace.cjs" \
    node "$SKEW" tty --log "$E2E_WORK/collector-tty.log" -- \
    sh "$E2E_ROOT/scripts/install.sh" --collector --gateway-url "$GATEWAY_URL" \
    --source-dir "$HOME_B/omnesis" --no-service --no-modify-path </dev/null | redact
  status=${PIPESTATUS[0]}
  set -e
  [ "$status" -eq 0 ] || die "the collector install on a terminal failed (exit $status)"
  [ -s "$HOME_B/.config/omnesis/collector-token" ] || die "the collector install on a terminal saved no device token"
  endgroup

  group "install.sh again on the gateway host (hands off to omnesis update)"
  set +e
  installer "$HOME" --no-prompt </dev/null 2>&1 | tee "$E2E_WORK/rerun.log" | redact
  status=${PIPESTATUS[0]}
  set -e
  [ "$status" -eq 0 ] || die "re-running install.sh on the gateway host failed (exit $status)"
  endgroup

  group "Every CLI call the installer made, against $RELEASE's own command tree"
  skew trace --trace "$TRACE" --tree "$HOME/omnesis" --min 10
  skew scan "$E2E_WORK"/*.log
  endgroup
  log "install.sh on this branch drove $RELEASE in both modes without a refused CLI call"
  ;;

docker)
  RELEASE="$(skew newest-tag)"
  group "install.sh --docker, no terminal (the newest published images)"
  mkdir -p "$CONFIG_DIR"
  new_passphrase_file
  # Under --docker the passphrase has to live inside the config directory the
  # containers see.
  cp "$PASSPHRASE_FILE" "$CONFIG_DIR/keyring.pass"
  chmod 600 "$CONFIG_DIR/keyring.pass"
  set +e
  sh "$E2E_ROOT/scripts/install.sh" --docker --no-model \
    --keyring-passphrase-file "$CONFIG_DIR/keyring.pass" </dev/null 2>&1 |
    tee "$E2E_WORK/docker-install.log" | redact
  status=${PIPESTATUS[0]}
  set -e
  [ "$status" -eq 0 ] || die "install.sh --docker failed (exit $status)"
  IMAGE_VERSION="$("$OMNESIS" --version </dev/null | tr -d '\r')"
  if [ "$IMAGE_VERSION" != "${RELEASE#v}" ]; then
    # A tag whose images are still building: the installer takes the newest
    # complete image release, which is what this lane then tests.
    printf '::notice::the newest complete image release is %s; the newest tag is %s\n' "$IMAGE_VERSION" "$RELEASE"
  fi
  endgroup

  group "The launcher, against the v$IMAGE_VERSION images"
  # Read-only commands the installer's own steps and banner lead to.
  for command in "--version" "status" "health" "whoami --json" "keyring status --json" \
    "devices list --json" "service status" "tls status" "doctor --json" "folders" "secure --verify"; do
    log "omnesis $command"
    # shellcheck disable=SC2086 # the words of one command
    "$OMNESIS" $command </dev/null >"$E2E_WORK/launcher.out" 2>&1 || true
    cat "$E2E_WORK/launcher.out" >>"$E2E_WORK/launcher.log"
    redact <"$E2E_WORK/launcher.out" | tail -n 5
  done
  "$OMNESIS" devices pair --kind collector --json </dev/null >/dev/null 2>"$E2E_WORK/launcher-pair.log" ||
    die "the launcher could not mint a pairing code: $(redact <"$E2E_WORK/launcher-pair.log" | tail -n 5)"
  endgroup

  group "install.sh --docker again, on a terminal, over the install"
  set +e
  skew tty --log "$E2E_WORK/docker-tty.log" -- sh "$E2E_ROOT/scripts/install.sh" --docker --no-model \
    </dev/null | redact
  status=${PIPESTATUS[0]}
  set -e
  [ "$status" -eq 0 ] || die "re-running install.sh --docker on a terminal failed (exit $status)"
  [ "$("$OMNESIS" --version </dev/null | tr -d '\r')" = "$IMAGE_VERSION" ] ||
    die "the launcher no longer reports v$IMAGE_VERSION after the re-run"
  endgroup

  group "No refused CLI call in any output"
  skew scan "$E2E_WORK"/*.log
  endgroup
  log "install.sh --docker on this branch drove the v$IMAGE_VERSION images in both modes without a refused CLI call"
  ;;

*) die "unknown mode $MODE (native or docker)" ;;
esac
