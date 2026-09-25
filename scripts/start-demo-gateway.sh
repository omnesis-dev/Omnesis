#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Boot the synthetic-providers demo gateway with the agent harness wired
# to the replay backend. The gateway + collector + synth providers handle
# everything — sources, documents, people, sync_state — through the
# standard pipeline. The agent harness picks one of the scripted scenarios
# in <universe>/agent-demos/ based on what you type as the first message
# of each conversation; each scenario's `$DOC_<externalId>` /
# `$PERSON_<Name>` placeholders resolve at session-create time against
# the live gateway DB.
#
# Usage:
#   scripts/start-demo-gateway.sh start                            # default universe
#   scripts/start-demo-gateway.sh start --universe <name>          # specific universe
#   scripts/start-demo-gateway.sh start --universe <name> --no-seed
#   scripts/start-demo-gateway.sh stop
#
# A "universe" is a self-contained synthetic corpus under evals/universes/<name>/
# (cast.json, sources/<descriptorId>/*.json, agent-demos/, universe.json).
# See docs/universes.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${OMNESIS_CONFIG_DIR:-/tmp/omnesis-agent-demo}"
PORT="${OMNESIS_GATEWAY_PORT:-27600}"

# Parse --universe out of the args so it can drive OMNESIS_AGENT_FIXTURE
# before delegating. Everything else passes through to synth-gateway.sh.
UNIVERSE="${OMNESIS_SYNTH_UNIVERSE:-default}"
PASSTHRU=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --universe)
      UNIVERSE="$2"
      shift 2
      ;;
    --universe=*)
      UNIVERSE="${1#--universe=}"
      shift
      ;;
    *)
      PASSTHRU+=("$1")
      shift
      ;;
  esac
done
set -- "${PASSTHRU[@]+"${PASSTHRU[@]}"}"

UNIVERSE_DIR="$ROOT/evals/universes/$UNIVERSE"
if [[ ! -d "$UNIVERSE_DIR" ]]; then
  echo "Universe not found: $UNIVERSE (expected at $UNIVERSE_DIR)" >&2
  echo "Available universes:" >&2
  ls "$ROOT/evals/universes" 2>/dev/null | sed 's/^/  /' >&2 || true
  exit 1
fi

export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
export OMNESIS_CONFIG_DIR="$CONFIG_DIR"
export OMNESIS_GATEWAY_PORT="$PORT"
export OMNESIS_SYNTH_UNIVERSE="$UNIVERSE"

# Skip the synth auth wizard so OAuth sources (gmail, notion, outlook, …)
# pair instantly. Without this they sit "Sources added" but never sync
# because their authFlow is waiting on a portal Add-Source wizard click.
export OMNESIS_SYNTH_PRE_DISCOVERED="1"

# The replay agent is enabled via the inference-assignment mechanism:
# synth-gateway.sh writes {"inference":{"assignments":{"agent":"replay"}}}
# to omnesis.json. Here we only point it at the universe's agent-demos
# directory. If the universe doesn't declare one (universe.json:agentDemos
# = null), the gateway surfaces "no fixture configured" and continues
# without the agent — fine for ingest/search-only universes.
if [[ -d "$UNIVERSE_DIR/agent-demos" ]]; then
  export OMNESIS_AGENT_FIXTURE="$UNIVERSE_DIR/agent-demos"
else
  unset OMNESIS_AGENT_FIXTURE
fi

SUBCOMMAND="${1:-start}"

# Every `start` runs from a blank slate — predictable demos, deterministic
# end-to-end tests. We preserve `models/` so the embedding-model symlink
# survives (re-creating it on every boot would be slow and noisy).
# Everything else — DBs, conversations, tokens, TLS certs, cache, logs —
# regenerates on first boot.
if [[ "$SUBCOMMAND" == "start" ]]; then
  if [[ -d "$CONFIG_DIR" ]]; then
    "$ROOT/scripts/synth-gateway.sh" stop >/dev/null 2>&1 || true
    echo "Wiping previous demo state at $CONFIG_DIR (keeping models/)…"
    find "$CONFIG_DIR" -mindepth 1 -maxdepth 1 -not -name 'models' -exec rm -rf {} +
  fi
  echo "Universe: $UNIVERSE ($UNIVERSE_DIR)"
fi

# Delegate the actual boot to the synth gateway script so the documents +
# sources land via the standard sync pipeline (no bespoke seed code).
# We don't `exec` here so we can print a one-click portal URL once the
# child returns (only on `start`).
"$ROOT/scripts/synth-gateway.sh" "$SUBCOMMAND" "${@:2}"
RC=$?

if [[ "$SUBCOMMAND" == "start" && $RC -eq 0 ]]; then
  TOKEN="$(cat "${CONFIG_DIR}/token" 2>/dev/null || true)"
  if [[ -n "$TOKEN" ]]; then
    echo
    echo "→ One-click portal: https://localhost:${PORT}/portal/?token=${TOKEN}"
  fi
fi
exit $RC
