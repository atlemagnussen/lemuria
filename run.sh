#!/usr/bin/env bash
# Dev runner: starts the ASP.NET server (dotnet watch, :5228) and the Vite client (:5173).
# Browse http://localhost:5228. Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")"

[ -d src/Lemuria.Client/node_modules ] || (cd src/Lemuria.Client && npm install)

# Job control gives each child its own process group (and keeps SIGINT un-ignored),
# so we can stop each whole tree cleanly.
set -m
pids=()

cleanup() {
  trap - INT TERM EXIT
  echo; echo "Stopping..."
  for pid in "${pids[@]}"; do kill -INT -- "-$pid" 2>/dev/null || true; done
  # dotnet watch stops the app on SIGINT but keeps waiting for file changes, so the
  # KILL below is the normal path for it after the app has shut down gracefully.
  for _ in {1..30}; do
    alive=0
    for pid in "${pids[@]}"; do kill -0 -- "-$pid" 2>/dev/null && alive=1; done
    [ "$alive" = 0 ] && return
    sleep 0.1
  done
  for pid in "${pids[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
}
trap cleanup INT TERM EXIT

(cd src/Lemuria.Client && exec npm run dev </dev/null) & pids+=($!)
(cd src/Lemuria.Server && exec dotnet watch --non-interactive </dev/null) & pids+=($!)

wait -n
