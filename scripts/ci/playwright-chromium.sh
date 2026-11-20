#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Install Playwright's Chromium and the system packages it needs on a Linux CI
# runner. The arguments are the Playwright command to use, so the browser
# revision matches the library that launches it:
#
#   scripts/ci/playwright-chromium.sh npx playwright
#   scripts/ci/playwright-chromium.sh npm exec --workspace packages/collector -- playwright
#
# `playwright install-deps` runs `apt-get update` and `apt-get install`, which
# read the runner's Ubuntu mirrors. When one of them is unreachable, or answers
# 404 for an index while it syncs, apt-get exits 100 and the job fails before
# any test runs. apt already retries each file a few times within seconds; a
# mirror that stays away for minutes outlasts those tries. So the package step
# is tried again a bounded number of times, waiting longer each time, and
# re-runs apt-get update so the next try reads fresh indexes. The browser
# download that follows comes from Playwright's own servers and is not retried
# here.
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <playwright command...>" >&2
  exit 64
fi

attempts="${PLAYWRIGHT_DEPS_ATTEMPTS:-4}"
retry_seconds="${PLAYWRIGHT_DEPS_RETRY_SECONDS:-30}"

attempt=1
until "$@" install-deps chromium; do
  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error::Installing Chromium's system packages failed $attempts times; the apt-get output above names the mirror and the file it could not fetch." >&2
    exit 1
  fi
  echo "Installing Chromium's system packages failed (attempt $attempt of $attempts); retrying in $((attempt * retry_seconds))s" >&2
  sleep "$((attempt * retry_seconds))"
  attempt=$((attempt + 1))
done

exec "$@" install chromium
