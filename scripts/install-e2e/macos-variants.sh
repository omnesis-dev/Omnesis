#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
# Real installer variants. Tool quarantine is NEVER allowed on a personal Mac.
set -euo pipefail
umask 077
MODE="${1:-}"
case "$MODE" in isolation|missing-node|missing-homebrew) ;; *) echo 'unsupported macOS variant' >&2; exit 2 ;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
PYTHON="$(command -v python3)"
"$PYTHON" "$HERE/macos-variants-tools.py" guard
: "${E2E_WORK:?set E2E_WORK under RUNNER_TEMP}"
"$PYTHON" - "$E2E_WORK" <<'PY'
import os,re,sys
from pathlib import Path
work=Path(sys.argv[1]).resolve();temp=Path(os.environ['RUNNER_TEMP']).resolve()
assert work.is_relative_to(temp) and work!=temp,'evidence must stay in runner temp'
assert re.fullmatch(r'[A-Za-z0-9_./-]+',str(work)),'runner scratch must have a plain absolute path'
PY
# shellcheck source=scripts/install-e2e/lib.sh
. "$HERE/lib.sh"
SESSION="$E2E_WORK/macos-$MODE"
mkdir "$SESSION"
mkdir "$SESSION/guards" "$SESSION/tmp"
PHASE=setup
COMMIT=unresolved
CHILD_PID=''
QUARANTINE="$SESSION/quarantine"
BASELINE="$SESSION/services-before"
/bin/launchctl list | awk '$3 ~ /^dev\.omnesis\.(gateway|collector)$/ {print}' | sort >"$BASELINE"
write_result() {
  "$PYTHON" - "$E2E_WORK/result.json" "$MODE" "$1" "$PHASE" "$SESSION" "$COMMIT" "$HERE/macos-native-probes.py" <<'PY'
import json,sys
from pathlib import Path
result={'mode':sys.argv[2],'passed':sys.argv[3]=='0','last_phase':sys.argv[4],'source_commit':sys.argv[6],
 'scope':'real isolated client/no-service foreground runtime' if sys.argv[2]=='isolation' else 'real prerequisite absence, exact restoration and successful rerun',
 'model_inference':'excluded','secret_store':'file'}
runtime=Path(sys.argv[5])/'runtime-result.json'
if runtime.exists():result['runtime']=json.loads(runtime.read_text())
probes=Path(sys.argv[5])/'native-startup-probes.json'
if probes.is_file() and not probes.is_symlink():
    # Only fixed stage names and bounded numeric status cross the artifact seam.
    try:
        import importlib.util
        spec=importlib.util.spec_from_file_location('native_probe_summary',sys.argv[7])
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        rows=json.loads(probes.read_text())
        valid=isinstance(rows,list) and len(rows)==len(module.STAGES)
        for row,stage in zip(rows,module.STAGES):
            valid=valid and isinstance(row,dict) and set(row)=={'stage','exit','signal','timeout'}
            valid=valid and row.get('stage')==stage and type(row.get('timeout')) is bool
            valid=valid and (row.get('exit') is None or (type(row.get('exit')) is int and 0<=row['exit']<=255))
            valid=valid and (row.get('signal') is None or (type(row.get('signal')) is int and 1<=row['signal']<=64))
        if valid:result['native_startup_probes']=rows
    except Exception:
        pass
Path(sys.argv[1]).write_text(json.dumps(result,indent=2)+'\n')
PY
}
installer_failure_diagnostics() {
  if [ "$1" != 1 ] || ! command -v node >/dev/null 2>&1 ||
     ! node --version >/dev/null 2>&1 || ! redact </dev/null >/dev/null 2>&1; then
    printf '[install-e2e] installer diagnostics unavailable after restoration\n' >&2
    return 0
  fi
  local label
  # Redact complete lines before byte truncation, which must never expose a
  # token fragment stripped of its field name. Post-setup daemon logs stay private.
  for label in client absence no-service; do
    if [ -s "$SESSION/$label.private.log" ] && [ ! -L "$SESSION/$label.private.log" ]; then
      printf '[install-e2e] redacted %s installer tail\n' "$label" >&2
      if ! tail -n 50 "$SESSION/$label.private.log" | redact | tail -c 8192 >&2; then
        printf '[install-e2e] installer diagnostic filtering unavailable\n' >&2
      fi
    fi
  done
  # Only the first gateway health failure can opt in to daemon diagnostics:
  # no collector has started and no source has been added at this boundary.
  if [ ! -L "$SESSION/startup-failure.json" ] && "$PYTHON" - "$SESSION/startup-failure.json" <<'PYDIAG'
import json,sys
from pathlib import Path
try:
    body=json.loads(Path(sys.argv[1]).read_text())
except (OSError,ValueError):
    raise SystemExit(1)
raise SystemExit(0 if body=={'phase':'gateway-health','cycle':1,'before_sources':True} else 1)
PYDIAG
  then
    if [ -f "$SESSION/gateway.private.log" ] && [ ! -L "$SESSION/gateway.private.log" ]; then
      printf '[install-e2e] redacted gateway pre-readiness tail\n' >&2
      if ! tail -n 50 "$SESSION/gateway.private.log" | redact | tail -c 8192 >&2; then
        printf '[install-e2e] startup diagnostic filtering unavailable\n' >&2
      fi
    fi
  fi
}
cleanup() {
  local status=$? restored=1
  # An errexit inside a redirected installer function keeps that redirection
  # active during EXIT. Restore the original console before diagnostics.
  exec 1>&3 2>&4
  exec 3>&- 4>&-
  trap - EXIT INT TERM
  set +e
  if [ -n "$CHILD_PID" ]; then kill -TERM "$CHILD_PID" 2>/dev/null; wait "$CHILD_PID"; CHILD_PID=''; fi
  if [ -e "$SESSION/quarantine-attempted" ]; then
    "$PYTHON" "$HERE/macos-variants-tools.py" restore --directory "$QUARANTINE" || { status=1; restored=0; PHASE=tool-restoration-failed; }
  fi
  if ! /bin/launchctl list | awk '$3 ~ /^dev\.omnesis\.(gateway|collector)$/ {print}' | sort >"$SESSION/services-after"; then
    status=1; PHASE=host-services-unavailable
  fi
  cmp -s "$BASELINE" "$SESSION/services-after" || { status=1; PHASE=host-services-changed; }
  if [ -s "$SESSION/forbidden-commands" ]; then status=1; PHASE=forbidden-host-command; fi
  if [ "$status" -ne 0 ]; then installer_failure_diagnostics "$restored"; fi
  write_result "$status" || { [ "$status" -ne 0 ] || status=1; }
  printf '[install-e2e] macOS %s %s (phase %s)\n' "$MODE" "$([ "$status" = 0 ] && echo passed || echo failed)" "$PHASE"
  exit "$status"
}
exec 3>&1 4>&2
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat >"$SESSION/guards/security" <<SHGUARD
#!/bin/sh
printf '%s\n' security >> '$SESSION/forbidden-commands'
exit 125
SHGUARD
cat >"$SESSION/guards/launchctl" <<SHGUARD
#!/bin/sh
case "\$1" in list|print|print-disabled) exec /bin/launchctl "\$@" ;; esac
printf '%s\n' launchctl >> '$SESSION/forbidden-commands'
exit 125
SHGUARD
chmod 700 "$SESSION/guards/security" "$SESSION/guards/launchctl"
fixture init --source "$E2E_ROOT" --out "$SESSION/fixture" >"$SESSION/fixture-init.private.json"
COMMIT="$(json_get "$SESSION/fixture/fixture.json" 'j.candidate')"
SOURCE="$SESSION/source"
ORIGINAL_PATH="$PATH"
PORT="$("$PYTHON" -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
child_command() {
  local home="$1"; shift
  "$PYTHON" "$HERE/macos-variants-command.py" /usr/bin/env -i \
    HOME="$home" USER="$(id -un)" LOGNAME="$(id -un)" \
    PATH="$SESSION/guards:$ORIGINAL_PATH" TMPDIR="$SESSION/tmp" LANG=C.UTF-8 \
    OMNESIS_CONFIG_DIR="$home/config" OMNESIS_SECRET_STORE=file OMNESIS_MDNS_DISABLE=1 \
    OMNESIS_REPO_URL="file://$SESSION/fixture/omnesis.git" OMNESIS_GATEWAY_URL="https://localhost:$PORT" \
    OMNESIS_GATEWAY_PORT="$PORT" OMNESIS_BIND=127.0.0.1 OMNESIS_NO_PROMPT=1 \
    OMNESIS_EXPERIMENTAL=0 OMNESIS_DEV_MODE=0 NODE_OPTIONS=--max-old-space-size=3072 \
    npm_config_cache="$SESSION/npm-cache" npm_config_jobs=2 CMAKE_BUILD_PARALLEL_LEVEL=2 MAKEFLAGS=-j2 \
    HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 "$@" &
  CHILD_PID=$!
  local status=0
  wait "$CHILD_PID" || status=$?
  CHILD_PID=''
  return "$status"
}
install_client() {
  child_command "$SESSION/client" sh "$E2E_ROOT/scripts/install.sh" --method source --commit "$COMMIT" \
    --source-dir "$SOURCE" --client-only --no-model --no-keyring --no-prompt --no-modify-path
}
assert_client() {
  test "$(git -C "$SOURCE" rev-parse HEAD)" = "$COMMIT"
  child_command "$SESSION/client" "$SESSION/client/.local/bin/omnesis" --version >/dev/null
  test ! -e "$SESSION/client/config/token"
  test ! -e "$SESSION/client/config/collector-token"
  test ! -e "$SESSION/client/config/omnesis.db"
  test ! -d "$SESSION/client/Library/LaunchAgents"
  "$PYTHON" "$HERE/macos-variants-runtime.py" --check-models "$SESSION/client/config"
}
prepare_missing_node_brew() {
  local brew repo
  brew="$(command -v brew)" || { echo 'Homebrew preparation requires the existing executable' >&2; return 1; }
  # Hosted images can ship Brew older than its OpenSSL sibling-lock fix.
  # Update the engine before hiding tools, then freeze it during the proof.
  child_command "$SESSION/client" "$brew" update || return "$?"
  repo="$("$brew" --repository)" || return "$?"
  if ! git -C "$repo" merge-base --is-ancestor 16f166d36cddcb485be5a3f2ed5b25dc445d1580 HEAD; then
    echo 'Homebrew preparation did not establish the required formula-lock fix' >&2
    return 1
  fi
}
if [ "$MODE" != isolation ]; then
  if [ "$MODE" = missing-node ]; then
    PHASE=prepare-homebrew
    prepare_missing_node_brew
  fi
  PHASE=quarantine
  : >"$SESSION/quarantine-attempted"
  "$PYTHON" "$HERE/macos-variants-tools.py" quarantine --directory "$QUARANTINE" --mode "$MODE"
  PHASE=actual-prerequisite-absence
  if [ "$MODE" = missing-homebrew ]; then
    if install_client >"$SESSION/absence.private.log" 2>&1; then echo 'missing prerequisites unexpectedly installed' >&2; exit 1; fi
    grep -F 'Homebrew was not found' "$SESSION/absence.private.log" >/dev/null
    test ! -e "$SESSION/client/.local/bin/omnesis"
    test ! -e "$SOURCE/.git"
    test ! -e "$SESSION/client/config/token"
    test ! -e "$SESSION/client/config/collector-token"
    test ! -e "$SESSION/client/config/omnesis.db"
    test ! -d "$SESSION/client/Library/LaunchAgents"
  else
    BREW=/opt/homebrew/bin/brew
    [ -x "$BREW" ] || BREW=/usr/local/bin/brew
    if "$BREW" list --versions node@24 >/dev/null 2>&1; then echo 'quarantined formula still installed' >&2; exit 1; fi
    install_client >"$SESSION/absence.private.log" 2>&1
    grep -F 'Installing Node 24 via Homebrew' "$SESSION/absence.private.log" >/dev/null
    "$BREW" list --versions node@24 >/dev/null
    assert_client
  fi
  PHASE=restore-original-tools
  "$PYTHON" "$HERE/macos-variants-tools.py" restore --directory "$QUARANTINE"
fi
PHASE=client-only
install_client >"$SESSION/client.private.log" 2>&1
assert_client
if [ "$MODE" = isolation ]; then
  PHASE=no-service
  child_command "$SESSION/server" sh "$E2E_ROOT/scripts/install.sh" --method source --commit "$COMMIT" \
    --source-dir "$SOURCE" --no-service --no-hardened --no-tls --no-model --no-keyring --no-prompt --no-modify-path \
    --port "$PORT" >"$SESSION/no-service.private.log" 2>&1
  test ! -d "$SESSION/server/Library/LaunchAgents"
  PHASE=foreground-restart-and-raw-data
  child_command "$SESSION/server" "$PYTHON" "$HERE/macos-variants-runtime.py" "$SESSION" "$SESSION/server/.local/bin/omnesis"
  test -s "$SESSION/runtime-result.json"
fi
PHASE=verified
