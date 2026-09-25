#!/usr/bin/env bash
# Build the security-E2E image from the CURRENT checkout and run the scenario
# suite, each scenario in its own fresh container (bounded memory, no host
# mounts, auto-removed). Usage:
#   scripts/docker-e2e/run.sh              # all scenarios
#   scripts/docker-e2e/run.sh 01 03        # a subset, by number prefix
set -euo pipefail
cd "$(dirname "$0")/../.."

IMAGE=omnesis-security-e2e
MEMORY="${OMNESIS_E2E_MEMORY:-6g}"
CPUS="${OMNESIS_E2E_CPUS:-2}"

echo "==> building ${IMAGE} (from the current checkout)"
docker build -q -f scripts/docker-e2e/Dockerfile -t "$IMAGE" . >/dev/null

selected=("$@")
failures=0
for scenario in scripts/docker-e2e/scenarios/*.sh; do
  name="$(basename "$scenario")"
  if ((${#selected[@]})) ; then
    keep=""
    for want in "${selected[@]}"; do [[ "$name" == "$want"* ]] && keep=1; done
    [[ -n "$keep" ]] || continue
  fi
  echo "==> ${name}"
  if docker run --rm --memory="$MEMORY" --cpus="$CPUS" \
      -e OMNESIS_E2E_SCENARIO="$name" \
      "$IMAGE" bash "/repo/scripts/docker-e2e/scenarios/${name}"; then
    echo "==> ${name} OK"
  else
    echo "==> ${name} FAILED" >&2
    failures=$((failures + 1))
  fi
done

if ((failures)); then
  echo "docker-e2e: ${failures} scenario(s) failed" >&2
  exit 1
fi
echo "docker-e2e: all scenarios passed"
