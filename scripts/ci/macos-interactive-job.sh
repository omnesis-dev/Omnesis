#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Run a command as an interactive launchd job in the logged-in user's session,
# stream its output, and exit with its status.
#
# Usage: scripts/ci/macos-interactive-job.sh <command> [args...]
#
# A hosted macOS runner starts every step under its agent's launchd daemon,
# and every process a step starts inherits that daemon's scheduling class:
# utility QoS, base priority 20. The iOS simulator's processes are started by
# the simulator's own launchd at 31 to 47. On a 3-core runner busy with the
# simulator, a utility-class gateway is runnable but gets a few percent of a
# core, and its event loop stalls for up to a minute: long enough for a phone
# request to time out (#1055). A launchd job with `ProcessType` Interactive
# runs at the default priority a program started from Terminal has, so the
# command and everything it starts compete with the simulator as equals.
#
# The job inherits this shell's environment and working directory. On an
# interrupt the job is booted out, which ends its process group. Anywhere but
# macOS the command simply runs in the foreground.

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/ci/macos-interactive-job.sh <command> [args...]" >&2
  exit 2
fi

if [[ "$(uname)" != Darwin ]]; then
  exec "$@"
fi

uid="$(id -u)"
domain="gui/$uid"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/interactive-job.XXXXXX")"
label="dev.omnesis.ci.$(basename "$work" | tr -c 'A-Za-z0-9\n' '-')"

# What the job runs: this environment, this directory, this command. `export
# -p` and `printf %q` quote for bash, so any value survives the round trip.
export -p >"$work/env"
printf '%q ' "$@" >"$work/command"
cat >"$work/run.sh" <<'RUN'
dir="$1"
source "$dir/env"
cd "$(cat "$dir/cwd")" || exit 1
eval "$(cat "$dir/command")"
echo $? >"$dir/status.part" && mv "$dir/status.part" "$dir/status"
RUN
pwd >"$work/cwd"
: >"$work/output.log"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
cat >"$work/job.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>$(xml <<<"$work/run.sh")</string>
      <string>$(xml <<<"$work")</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>$(xml <<<"$work/output.log")</string>
    <key>StandardErrorPath</key>
    <string>$(xml <<<"$work/output.log")</string>
  </dict>
</plist>
PLIST

tail_pid=""
finish() {
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  if [[ -n "$tail_pid" ]]; then
    kill "$tail_pid" 2>/dev/null || true
    wait "$tail_pid" 2>/dev/null || true
  fi
}
trap finish EXIT
trap 'exit 130' INT TERM

tail -n +1 -f "$work/output.log" &
tail_pid=$!
if ! launchctl bootstrap "$domain" "$work/job.plist"; then
  echo "Could not start the command as a launchd job in $domain: is a user logged in?" >&2
  exit 1
fi

# The job writes its status as its last act. One that launchd reports as no
# longer running without having written it was killed.
while [[ ! -f "$work/status" ]]; do
  if launchctl print "$domain/$label" 2>/dev/null | grep -qE '^[[:space:]]*state = not running'; then
    [[ -f "$work/status" ]] && break
    echo "The launchd job $label ended without reporting a status." >&2
    exit 1
  fi
  sleep 1
done
# Let tail print the last lines before it stops.
sleep 1
exit "$(cat "$work/status")"
