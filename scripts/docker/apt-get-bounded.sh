#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# apt-get for image builds, with every download bounded in wall-clock time. The
# Dockerfiles bind-mount it into the RUN steps that install packages, so it
# never lands in an image:
#
#   sh /tmp/apt-get-bounded.sh update
#   sh /tmp/apt-get-bounded.sh install -y --no-install-recommends curl
#
# apt's own limits bound a mirror that is gone: Acquire::http::Timeout (30 s by
# default) ends a wait in which no byte arrives, and Acquire::Retries (3 by
# default) tries the file again. Neither bounds a mirror that keeps a request
# open while sending next to nothing, because every byte restarts the timeout;
# such a mirror holds apt-get, and the image build, until the job limit. So each
# download runs under `timeout`. One that has not finished after
# APT_BOUNDED_SECONDS is stopped and started again on a fresh connection, at most
# APT_BOUNDED_ATTEMPTS times in all, and then fails with an error that says so.
#
# A healthy download in these images takes seconds. The largest, the build
# stage's compiler toolchain of about 85 MB, fits in one 300 s attempt at
# 2.5 Mbit/s. An attempt that is stopped keeps what it fetched (finished
# packages stay in apt's cache and a partial one resumes), so across three
# attempts it still arrives at under 1 Mbit/s. A stuck mirror costs at most
# 15 minutes per command, well inside a CI job's limit.
#
# `install` and `upgrade` fetch their packages with --download-only under that
# bound, then run for real with every package already in the cache, so a timeout
# never interrupts dpkg.
set -u

seconds="${APT_BOUNDED_SECONDS:-300}"
attempts="${APT_BOUNDED_ATTEMPTS:-3}"

fetch() {
  attempt=1
  while :; do
    # `timeout` signals its whole process group, so apt-get's download methods
    # stop with it.
    timeout --kill-after=10 "$seconds" apt-get "$@"
    status=$?
    case "$status" in
      124 | 137) ;;
      *) return "$status" ;;
    esac
    if [ "$attempt" -ge "$attempts" ]; then
      echo "apt-get $* did not finish within ${seconds}s, $attempts times; the package mirror is not answering. The lines above name the files it was fetching." >&2
      return 124
    fi
    echo "apt-get $* did not finish within ${seconds}s (attempt $attempt of $attempts); trying again." >&2
    attempt=$((attempt + 1))
  done
}

case "${1:-}" in
  install | upgrade | dist-upgrade | full-upgrade)
    fetch "$@" --download-only || exit
    exec apt-get "$@"
    ;;
  *)
    fetch "$@"
    ;;
esac
