#!/usr/bin/env bash
# TEMPORARY measurement helper (removed before merge): runs one command and
# records its label, start/end epoch seconds and exit code so the GC logs can
# be attributed to it by timestamp.
set -uo pipefail
label=$1
shift
start=$(date +%s)
"$@"
rc=$?
end=$(date +%s)
echo "$label $start $end $rc" >>/tmp/omnesis-heap-runs.txt
echo "::notice::$label exit=$rc seconds=$((end - start))"
exit "$rc"
