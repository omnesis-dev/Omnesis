#!/usr/bin/env bash
# TEMPORARY measurement helper (removed before merge): samples system memory
# and the resident size of every JVM every 5 seconds.
while true; do
  now=$(date +%s)
  if command -v free >/dev/null; then
    echo "$now MEM $(free -m | awk '/^Mem:/ {print $2, $3, $7}')"
  fi
  ps -axo pid=,rss=,args= | grep '[j]ava' | while read -r pid rss args; do
    kind=other
    case "$args" in
      *GradleDaemon*) kind=gradle-daemon ;;
      *KotlinCompileDaemon*) kind=kotlin-daemon ;;
      *GradleWorkerMain*) kind=gradle-worker ;;
      *GradleWrapperMain*) kind=gradle-client ;;
    esac
    echo "$now JVM $pid $kind $rss"
  done
  sleep 5
done
