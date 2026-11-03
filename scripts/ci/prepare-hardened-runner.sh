#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# The systemd security scenario builds source releases in Docker. Its fresh
# hosted Linux VM does not use the preinstalled Android or .NET SDKs.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || "${RUNNER_OS:-}" != Linux ]]; then
  echo "Disk preparation is only supported on GitHub-hosted Linux runners; nothing was changed." >&2
  exit 1
fi

docker_root="$(docker info --format '{{.DockerRootDir}}')"
if [[ "$docker_root" != /* || ! -d "$docker_root" ]]; then
  echo "Could not locate Docker storage; nothing was changed." >&2
  exit 1
fi

report_usage() {
  df -h / "$docker_root"
  docker system df
}

echo "==> hardened runner disk usage before SDK cleanup"
report_usage
# Fixed paths only: never follow a caller-provided SDK/cache path. This job
# uses neither SDK, and the host identity check precedes all commands.
for sdk in /usr/local/lib/android /usr/share/dotnet; do
  if ! sudo rm -rf -- "$sdk"; then
    echo "Could not reclaim unused SDK at $sdk; the Docker scenario was not started." >&2
    exit 1
  fi
done

echo "==> hardened runner disk usage after SDK cleanup"
report_usage
for location in / "$docker_root"; do
  available="$(df -Pk "$location" | awk 'NR == 2 { print $4 }')"
  if [[ ! "$available" =~ ^[0-9]+$ ]]; then
    echo "Could not measure available disk space at $location; the Docker scenario was not started." >&2
    exit 1
  fi
  echo "$location: $available KiB available"
  # The installer observed that 15 GiB could not export its first runtime and
  # 31 GiB built all three, and uses a 25 GiB budget. This lane builds a different
  # image and repeated source releases, so that reference is a warning only.
  if ((available < 25 * 1024 * 1024)); then
    echo "::warning::Only $available KiB free at $location after SDK cleanup. The installer uses a conservative 25 GiB Docker-build budget, not a measured minimum for this lane. If the scenario runs out of space, inspect the filesystem and Docker usage reported here."
  fi
done
echo "==> hardened runner disk preparation complete"
