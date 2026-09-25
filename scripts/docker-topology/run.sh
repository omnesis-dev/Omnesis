#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Container topology lane: two containers standing in for two machines, a
# fixture release server carrying ordered tags, and the REAL installer and
# updater driven across both.
#
#   scripts/docker-topology/run.sh            # the whole story, then tear down
#   scripts/docker-topology/run.sh --keep     # leave the containers up
#   scripts/docker-topology/run.sh --keep 01  # one scenario against a kept topology
#
# The scenarios are deliberately ORDERED and share one topology: 01 installs
# the gateway, 02 pairs a collector to it, 03 updates both, and 04 proves a
# release that cannot build is rolled back. Re-installing per scenario would
# triple a lane that is already minutes long, and the thing worth proving is
# precisely that the later steps work on state the earlier ones left behind.
set -euo pipefail
cd "$(dirname "$0")/../.."

source scripts/docker-topology/lib.sh

KEEP=0
selected=()
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) selected+=("$arg") ;;
  esac
done

echo "==> building $IMAGE (warm npm cache; first build is slow)"
docker build -q -f scripts/docker-topology/Dockerfile -t "$IMAGE" . >/dev/null

if ((${#selected[@]} == 0)) || [[ ! "$(docker ps -q -f name="$GW")" ]]; then
  echo "==> building fixture release repositories"
  scripts/docker-topology/fixtures.sh "$FIXTURE_DIR"
  echo "==> starting the topology"
  topo_up
fi

if ((KEEP == 0)); then
  trap 'echo "==> tearing down"; topo_down' EXIT
fi

failures=0
for scenario in scripts/docker-topology/scenarios/*.sh; do
  name="$(basename "$scenario")"
  if ((${#selected[@]})); then
    keep=""
    for want in "${selected[@]}"; do [[ "$name" == "$want"* ]] && keep=1; done
    [[ -n "$keep" ]] || continue
  fi
  echo
  echo "==> $name"
  if bash "$scenario"; then
    echo "==> $name OK"
  else
    echo "==> $name FAILED" >&2
    failures=$((failures + 1))
    # The scenarios build on each other, so a failure makes every later one
    # meaningless. Stop and leave the evidence in place.
    break
  fi
done

if ((failures)); then
  echo "docker-topology: failed" >&2
  ((KEEP)) && echo "containers left up for inspection: $GW $COL $GIT" >&2
  exit 1
fi
echo
echo "docker-topology: all scenarios passed"
((KEEP)) && echo "containers left up: $GW $COL $GIT"
exit 0
