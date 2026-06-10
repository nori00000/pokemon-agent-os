# Shared config + helpers for running multiple pss-mgba instances in parallel.
# Sourced by setup.sh / start.sh / stop.sh. Written for macOS default bash 3.2
# (no associative arrays, no mapfile).

REPO="$HOME/Desktop/pss-mgba"
RUNS_ROOT="$HOME/Desktop/pss-mgba-runs"
MULTI_DIR="$REPO/multi"

MGBA_BIN="/opt/homebrew/bin/mgba"
HTTP_BIN="$REPO/.local-tools/mgba-http/mGBA-http"
LUA_SRC="$REPO/.local-tools/mgba-http/mGBASocketServer.lua"
APPSETTINGS_SRC="$REPO/.local-tools/mgba-http/appsettings.json"
ROM_SRC="$REPO/pokemon-red.gb"
SAV_SRC="$REPO/pokemon-red.sav"
TSX="$REPO/node_modules/.bin/tsx"
ENTRY="$REPO/src/index.ts"

# Instances started by "all". Default is 2 (a, b) to stay light on 16GB.
# Instance c is still defined below, so `multi/start.sh c` works on demand.
INSTANCES="a b"

# id -> "socketPort httpPort metricsPort"
instance_ports() {
  case "$1" in
    a) echo "8888 5001 9464" ;;
    b) echo "8889 5002 9465" ;;
    c) echo "8890 5003 9466" ;;
    *) echo "" ; return 1 ;;
  esac
}

# AI model/proxy are shared across all 3 (same model, different prompt).
# Pulled from the original repo .env so you configure them in one place.
load_ai_env() {
  AI_BASE_URL="http://127.0.0.1:8765/v1"
  AI_API_KEY="dummy"
  AI_MODEL="gpt-5.5"
  if [ -f "$REPO/.env" ]; then
    # shellcheck disable=SC1090
    set -a; . "$REPO/.env"; set +a
  fi
}

# Wait until a TCP port accepts connections (or timeout).
wait_port() {
  port="$1"; label="$2"; tries=0
  while [ "$tries" -lt 60 ]; do
    if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      echo "    -> $label up on :$port"; return 0
    fi
    tries=$((tries + 1)); sleep 0.5
  done
  echo "    !! timed out waiting for $label on :$port"; return 1
}

# Wait until an HTTP endpoint answers at all (any status).
wait_http() {
  port="$1"; label="$2"; tries=0
  while [ "$tries" -lt 60 ]; do
    if curl -s -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
      echo "    -> $label answering on :$port"; return 0
    fi
    tries=$((tries + 1)); sleep 0.5
  done
  echo "    !! timed out waiting for $label on :$port"; return 1
}
