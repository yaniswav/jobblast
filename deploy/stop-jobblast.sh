#!/usr/bin/env bash
# Stops the JobBlast API started by deploy/start-jobblast.sh, using the PID
# file it wrote (deploy/jobblast.pid). Falls back to finding whatever
# process is listening on the configured port if the PID file is missing.
#
# Usage: bash deploy/stop-jobblast.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$REPO_ROOT/deploy/jobblast.pid"

if [ -f "$PID_FILE" ]; then
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  rm -f "$PID_FILE"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "==> Stopping JobBlast API (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "==> Still running, sending SIGKILL..."
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "==> Stopped."
    exit 0
  else
    echo "==> PID file was stale (process not running)."
  fi
fi

# --- Fallback: find whatever is listening on PORT ----------------------------

PORT=5000
ENV_FILE="$REPO_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  file_port=$(grep -E '^PORT=' "$ENV_FILE" | tail -n1 | cut -d '=' -f2 | tr -d '[:space:]')
  [ -n "$file_port" ] && PORT="$file_port"
fi

if command -v lsof >/dev/null 2>&1; then
  pid=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "==> Stopping process on port $PORT (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    echo "==> Stopped."
  else
    echo "==> Nothing listening on port $PORT. JobBlast API is not running."
  fi
else
  echo "==> No PID file and 'lsof' is not available - cannot locate the process automatically."
  echo "    Find it manually, e.g.: fuser $PORT/tcp   or   ss -ltnp | grep :$PORT"
  exit 1
fi
