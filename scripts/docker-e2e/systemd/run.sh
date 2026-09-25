#!/usr/bin/env bash
# The dedicated-account gateway under real systemd. Builds the image from the
# CURRENT checkout, boots it privileged with systemd as its first process, and
# runs scenario.sh inside it. Needs Docker with cgroup v2.
#
#   scripts/docker-e2e/systemd/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."

IMAGE=omnesis-hardened-systemd-e2e
CONTAINER="omnesis-hardened-systemd-e2e-$$"
MEMORY="${OMNESIS_E2E_MEMORY:-8g}"
CPUS="${OMNESIS_E2E_CPUS:-4}"

echo "==> building ${IMAGE} (from the current checkout)"
docker build -q -f scripts/docker-e2e/systemd/Dockerfile -t "$IMAGE" . >/dev/null

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$CONTAINER" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  --memory="$MEMORY" --cpus="$CPUS" "$IMAGE" >/dev/null

echo "==> waiting for systemd to boot"
deadline=$((SECONDS + 120))
until docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded'; do
  if ((SECONDS >= deadline)); then
    echo "systemd did not finish booting within 120s" >&2
    exit 1
  fi
  sleep 1
done
# systemd hands a service its credentials by moving a mount into
# /run/credentials, which a container's private /run never propagates.
docker exec "$CONTAINER" mount --make-rshared /run

if docker exec "$CONTAINER" bash /src/scripts/docker-e2e/systemd/scenario.sh; then
  echo "docker-e2e systemd: passed"
else
  echo "docker-e2e systemd: FAILED; the gateway service's journal follows" >&2
  docker exec "$CONTAINER" journalctl -u omnesis-gateway.service --no-pager -n 150 >&2 || true
  exit 1
fi
