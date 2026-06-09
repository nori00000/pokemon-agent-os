#!/usr/bin/env bash
# Start one or all instances. Each instance brings up its own 3-stage chain in
# order: mGBA (emulator) -> mGBA-http (bridge) -> harness (AI agent).
#
#   multi/start.sh all      # start a, b, c
#   multi/start.sh a        # start only instance a
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"

start_one() {
  id="$1"
  set -- $(instance_ports "$id"); sock="$1"; http="$2"; metrics="$3"
  dir="$RUNS_ROOT/$id"
  if [ ! -f "$dir/.env" ]; then
    echo "[$id] not scaffolded yet -- run multi/setup.sh first"; return 1
  fi
  echo "[$id] starting (socket $sock / http $http / metrics $metrics)"
  mkdir -p "$dir/logs"

  # 1) mGBA emulator window: loads this instance's pinned-port Lua + own ROM.
  #    nohup so it survives the session/terminal that launched it.
  nohup "$MGBA_BIN" --script "$dir/mGBASocketServer.lua" "$dir/pokemon-red.gb" \
      > "$dir/logs/mgba.log" 2>&1 &
  echo $! > "$dir/logs/mgba.pid"
  wait_port "$sock" "mGBA socket"

  # 2) mGBA-http bridge: cwd = its own dir so it reads its own appsettings.json.
  ( cd "$dir/mgba-http" && nohup ./mGBA-http > "$dir/logs/mgba-http.log" 2>&1 &
    echo $! > "$dir/logs/mgba-http.pid" )
  wait_http "$http" "mGBA-http"

  # 3) harness: cwd = instance dir so .env, .pss-mgba traces, and save isolate.
  ( cd "$dir" && nohup "$TSX" "$ENTRY" > "$dir/logs/harness.log" 2>&1 &
    echo $! > "$dir/logs/harness.pid" )
  echo "[$id] up. logs: $dir/logs/  metrics: http://127.0.0.1:$metrics/metrics"
}

targets="${1:-all}"
if [ "$targets" = "all" ]; then targets="$INSTANCES"; fi
for id in $targets; do start_one "$id"; done

echo
echo "All requested instances launched. Tail a log with:"
echo "  tail -f $RUNS_ROOT/a/logs/harness.log"
echo "Stop everything with: multi/stop.sh all"
