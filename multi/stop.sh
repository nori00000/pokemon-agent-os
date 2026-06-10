#!/usr/bin/env bash
# Stop one or all instances. Kills harness -> bridge -> emulator (reverse order).
#
#   multi/stop.sh all
#   multi/stop.sh b
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"

stop_one() {
  id="$1"; dir="$RUNS_ROOT/$id"
  for stage in harness mgba-http mgba; do
    f="$dir/logs/$stage.pid"
    if [ -f "$f" ]; then
      pid="$(cat "$f")"
      if kill "$pid" >/dev/null 2>&1; then
        echo "[$id] stopped $stage (pid $pid)"
      else
        echo "[$id] $stage (pid $pid) not running"
      fi
      rm -f "$f"
    fi
  done
}

targets="${1:-all}"
if [ "$targets" = "all" ]; then targets="$INSTANCES"; fi
for id in $targets; do stop_one "$id"; done
