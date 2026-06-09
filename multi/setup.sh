#!/usr/bin/env bash
# Idempotently scaffold per-instance working dirs under ~/Desktop/pss-mgba-runs/.
# Re-running is safe: it refreshes ROM/save/ports but does NOT overwrite a
# strategy.md you have edited.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"
load_ai_env

mkdir -p "$RUNS_ROOT"

for id in $INSTANCES; do
  set -- $(instance_ports "$id"); sock="$1"; http="$2"; metrics="$3"
  dir="$RUNS_ROOT/$id"
  echo "[$id] scaffolding $dir  (socket $sock / http $http / metrics $metrics)"
  mkdir -p "$dir/mgba-http" "$dir/logs"

  # ROM + save checkpoint: copied (not symlinked) so each save stays independent
  # while all three start from the SAME current checkpoint for a fair comparison.
  cp -f "$ROM_SRC" "$dir/pokemon-red.gb"
  if [ -f "$SAV_SRC" ]; then cp -f "$SAV_SRC" "$dir/pokemon-red.sav"; fi

  # Lua socket server pinned to this instance's port.
  sed "s/^local port = .*/local port = $sock/" "$LUA_SRC" > "$dir/mGBASocketServer.lua"

  # mGBA-http: share the 110MB binary via symlink, give it its own appsettings.
  ln -sf "$HTTP_BIN" "$dir/mgba-http/mGBA-http"
  sed -e "s#http://localhost:5001#http://127.0.0.1:$http#" \
      -e "s/\"Port\": 8888/\"Port\": $sock/" \
      "$APPSETTINGS_SRC" > "$dir/mgba-http/appsettings.json"

  # Strategy prompt: seed from template once; never clobber user edits.
  if [ ! -f "$dir/strategy.md" ]; then
    cp "$HERE/strategies/$id.md" "$dir/strategy.md"
  fi

  # Per-instance .env (CWD-relative loading isolates this automatically).
  cat > "$dir/.env" <<EOF
MGBA_HTTP_BASE_URL=http://127.0.0.1:$http
AI_BASE_URL=$AI_BASE_URL
AI_API_KEY=$AI_API_KEY
AI_MODEL=$AI_MODEL
METRICS_HTTP_HOST=127.0.0.1
METRICS_HTTP_PORT=$metrics
STRATEGY_PROMPT_FILE=$dir/strategy.md
EOF
done

echo
echo "Done. Instances ready under $RUNS_ROOT/{a,b,c}."
echo "Edit each strategy.md, then: multi/start.sh all"
