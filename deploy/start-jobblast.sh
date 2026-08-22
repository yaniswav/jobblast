#!/usr/bin/env bash
# Idempotent startup for the JobBlast "production" deployment on Linux/macOS:
#   (a) makes sure the jobblast-pg Postgres container is up and ready
#       (skipped gracefully if Docker isn't available - e.g. Postgres runs
#       some other way),
#   (b) does nothing if JobBlast is already running (tracked via a PID file),
#   (c) otherwise starts the built API server (SERVE_STATIC=1) in the
#       background with nohup, logging to deploy/logs/jobblast.log and
#       recording its PID in deploy/jobblast.pid.
#
# Usage: bash deploy/start-jobblast.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$REPO_ROOT/artifacts/api-server"
DIST_ENTRY="$API_DIR/dist/index.mjs"
LOG_DIR="$REPO_ROOT/deploy/logs"
LOG_FILE="$LOG_DIR/jobblast.log"
PID_FILE="$REPO_ROOT/deploy/jobblast.pid"
CONTAINER_NAME="jobblast-pg"

# --- Read PORT from the root .env (fallback 5000) ---------------------------

PORT=5000
ENV_FILE="$REPO_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  file_port=$(grep -E '^PORT=' "$ENV_FILE" | tail -n1 | cut -d '=' -f2 | tr -d '[:space:]')
  [ -n "$file_port" ] && PORT="$file_port"
fi

# Portable "is something listening on this TCP port" check using bash's
# built-in /dev/tcp pseudo-device, so this doesn't depend on lsof/ss/netstat
# being installed.
port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  local result=$?
  exec 3<&- 2>/dev/null || true
  exec 3>&- 2>/dev/null || true
  return $result
}

if [ ! -f "$DIST_ENTRY" ]; then
  echo "Build output not found at $DIST_ENTRY. Run deploy/build.sh first." >&2
  exit 1
fi

# --- (a) Postgres, if Docker is available ------------------------------------

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  running=$(docker ps --filter "name=^/${CONTAINER_NAME}\$" --filter "status=running" --format '{{.Names}}' 2>/dev/null || true)
  if [ -z "$running" ]; then
    echo "==> Starting container '$CONTAINER_NAME'..."
    if ! docker start "$CONTAINER_NAME" >/dev/null 2>&1; then
      echo "==> Container '$CONTAINER_NAME' not found. Trying 'docker compose up -d' instead..."
      (cd "$REPO_ROOT" && docker compose up -d) || {
        echo "Failed to start Postgres. Create it with 'docker compose up -d' or point DATABASE_URL at an existing instance." >&2
        exit 1
      }
    fi
  else
    echo "==> Container '$CONTAINER_NAME' already running."
  fi

  echo "==> Waiting for Postgres to be ready..."
  elapsed=0
  timeout=60
  until docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; do
    sleep 2
    elapsed=$((elapsed + 2))
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "Postgres did not become ready within ${timeout}s." >&2
      exit 1
    fi
  done
  echo "==> Postgres is ready."
else
  echo "==> Docker not available/running - assuming Postgres is managed some other way."
fi

# --- (b) Already running? ----------------------------------------------------

if [ -f "$PID_FILE" ]; then
  existing_pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "==> JobBlast API already running (PID $existing_pid). Nothing to do."
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if port_in_use "$PORT"; then
  echo "==> Something is already listening on port $PORT (started outside this script). Nothing to do."
  exit 0
fi

# --- (c) Start the API server, backgrounded, logging to deploy/logs ---------

mkdir -p "$LOG_DIR"
if [ -f "$LOG_FILE" ]; then
  size=$(wc -c <"$LOG_FILE" | tr -d '[:space:]')
  if [ "$size" -gt $((5 * 1024 * 1024)) ]; then
    echo "==> Rotating log (>5MB) -> jobblast.log.old"
    mv -f "$LOG_FILE" "$LOG_DIR/jobblast.log.old"
  fi
fi

echo "==> Starting JobBlast API (SERVE_STATIC=1) from $API_DIR ..."
(
  cd "$API_DIR"
  SERVE_STATIC=1 nohup node --enable-source-maps --env-file-if-exists=../../.env ./dist/index.mjs >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
)

new_pid=$(cat "$PID_FILE")
elapsed=0
timeout=30
started=false
while [ "$elapsed" -lt "$timeout" ]; do
  sleep 1
  elapsed=$((elapsed + 1))
  if port_in_use "$PORT"; then
    started=true
    break
  fi
  if ! kill -0 "$new_pid" 2>/dev/null; then
    break
  fi
done

if [ "$started" = true ]; then
  echo "==> JobBlast API started (PID $new_pid) -> http://localhost:$PORT/"
else
  echo "JobBlast API did not start listening on port $PORT within ${timeout}s. Check $LOG_FILE" >&2
  exit 1
fi
