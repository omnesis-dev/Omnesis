#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Pull a pinned container image before a lane runs it, retrying transient
# registry failures (Docker Hub's token service and CDN occasionally refuse a
# request). A failure on every attempt still fails the lane loudly.
#
# Usage: scripts/ci/docker-pull.sh <image@sha256:...>
set -euo pipefail

image="${1:?usage: docker-pull.sh <image@sha256:...>}"
delays=(0 15 45)
for attempt in 1 2 3; do
  sleep "${delays[$((attempt - 1))]}"
  if docker pull --quiet "$image"; then
    exit 0
  fi
  echo "docker pull attempt $attempt of 3 failed for $image" >&2
done
echo "::error::Could not pull $image after 3 attempts."
exit 1
