#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Run the Gradle wrapper in the current directory for a CI lane, offline when
# the restored Gradle cache is known to be complete, and say what Gradle is
# waiting on whenever it goes quiet.
#
# Usage: scripts/ci/gradlew.sh <gradle arguments...>
#
# OMNESIS_GRADLE_OFFLINE=true adds --offline. A workflow sets it when its cache
# step restored the exact entry for the current build inputs: the run that
# saved that entry resolved everything the lanes use, so nothing needs the
# network. Online, Gradle checks again before the first task every dependency
# result it cached more than 24 hours ago and may not keep forever (dynamic
# versions, changing modules, missing artifacts), and a slow repository turns
# those checks into many minutes of silence (#1228).
#
# Whenever Gradle has printed nothing for OMNESIS_GRADLE_QUIET_SECONDS (180 by
# default), this prints a warning and the stacks of the Gradle JVMs' threads
# that are on the network or resolving dependencies, and again after each
# further quiet period. Gradle reports repository retries only at info level,
# so without this a stall in resolution shows nothing at all.
set -uo pipefail

quiet_limit="${OMNESIS_GRADLE_QUIET_SECONDS:-180}"
args=("$@")
if [[ "${OMNESIS_GRADLE_OFFLINE:-}" == true ]]; then
  echo "The Gradle cache is the exact entry for these build inputs: resolving offline."
  args+=(--offline)
fi

beat="$(mktemp)"
jcmd="${JAVA_HOME:+$JAVA_HOME/bin/}jcmd"

# The threads of each Gradle JVM (the launcher and the build daemon it forks)
# that are resolving dependencies or talking to a repository, with the top 20
# frames of each: a thread asleep in the retry code is waiting out a
# repository error, one in the HTTP client is waiting on a response.
print_gradle_threads() {
  local pid main
  "$jcmd" -l 2>/dev/null | while read -r pid main _; do
    [[ "$main" =~ GradleDaemon|GradleWrapperMain|GradleMain ]] || continue
    echo "--- ${main##*.} (pid ${pid}) ---"
    "$jcmd" "$pid" Thread.print 2>&1 | awk '
      BEGIN { RS = ""; shown = 0 }
      /org\.gradle\.api\.internal\.artifacts\.|org\.gradle\.internal\.resource\.transport\.|org\.apache\.http\.|javax\.net\.ssl\./ {
        n = split($0, lines, "\n")
        for (i = 1; i <= n && i <= 22; i++) print lines[i]
        if (n > 22) print "\t..."
        print ""
        shown++
      }
      END { if (shown == 0) print "(no thread resolving dependencies or talking to a repository)" }'
  done
}

# Polls the time of Gradle's last line and reports each quiet period.
watch_quiet() {
  local now last
  while sleep 1; do
    now="$(date +%s)"
    last="$(stat -c %Y "$beat" 2>/dev/null || stat -f %m "$beat")"
    if ((now - last >= quiet_limit)); then
      echo "::warning::Gradle has printed nothing for $((now - last)) s. Its threads resolving dependencies or talking to a repository:"
      print_gradle_threads
      : >"$beat"
    fi
  done
}

watch_quiet &
watcher=$!
trap 'kill "$watcher" 2>/dev/null; rm -f "$beat"' EXIT

./gradlew "${args[@]}" 2>&1 | while IFS= read -r line || [[ -n "$line" ]]; do
  printf '%s\n' "$line"
  : >"$beat"
done
exit "${PIPESTATUS[0]}"
