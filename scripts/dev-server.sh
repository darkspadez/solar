#!/usr/bin/env bash
#
# Robust start/stop for the solar dev server, safe for agents and humans.
#
# Uses `setsid` so the server runs in its own session/process-group, fully
# detached from the calling shell (survives the shell exiting, no nohup/disown).
# A pidfile tracks the session leader; stop signals the whole process group so
# the `bun --hot` child is cleaned up too. Logs go to a file (never blocks).
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$ROOT/.dev-server.pid"
LOGFILE="$ROOT/.dev-server.log"
PORTFILE="$ROOT/.dev-server.port"

worktree_port() {
  if [ -x "$ROOT/scripts/port-allocator.sh" ]; then
    "$ROOT/scripts/port-allocator.sh" "" "" "" "$ROOT"
  else
    local digest

    if command -v sha256sum >/dev/null 2>&1; then
      digest="$(printf '%s' "$ROOT" | sha256sum | cut -c1-6)"
    else
      digest="$(printf '%s' "$ROOT" | shasum -a 256 | cut -c1-6)"
    fi
    printf '%d' "$((16#$digest % 1000 + 3000))"
  fi
}

if [ "${1:-}" = "status" ] && [ -f "$PORTFILE" ]; then
  SERVER_PORT="$(cat "$PORTFILE")"
elif [ -n "${PORT:-}" ]; then
  SERVER_PORT="$PORT"
elif [ -f "$PORTFILE" ]; then
  SERVER_PORT="$(cat "$PORTFILE")"
else
  SERVER_PORT="$(worktree_port)"
fi

run_server() {
  local server_pid frpc_pid="" status

  cleanup() {
    if [ -n "$frpc_pid" ]; then
      kill -TERM "$frpc_pid" 2>/dev/null || true
    fi
    if [ -n "${server_pid:-}" ]; then
      kill -TERM "$server_pid" 2>/dev/null || true
    fi
    rm -f "$PORTFILE"
  }

  trap cleanup INT TERM HUP
  trap cleanup EXIT

  (
    cd "$ROOT/apps/server"
    exec env PORT="$SERVER_PORT" SOLAR_SEED_DEV_USER=1 bun --env-file=../../.env run dev
  ) &
  server_pid=$!

  local ready=0
  for _ in $(seq 1 60); do
    if is_server_on_port; then
      ready=1
      break
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done

  if [ "$ready" -ne 1 ]; then
    echo "dev server did not become ready on port $SERVER_PORT" >&2
    wait "$server_pid" 2>/dev/null || true
    return 1
  fi

  (cd "$ROOT" && exec env PORT="$SERVER_PORT" bun --env-file=.env scripts/run-frpc.ts) &
  frpc_pid=$!

  set +e
  wait "$server_pid"
  status=$?
  set -e
  cleanup
  trap - EXIT INT TERM HUP
  return "$status"
}

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

is_server_on_port() {
  curl --fail --silent --max-time 1 "http://localhost:$SERVER_PORT/healthz" \
    | grep --quiet '"ok":true'
}

show_server_info() {
  local pid="${1:-}"

  if [ -n "$pid" ]; then
    echo "dev server already running (pid $pid) -> http://localhost:$SERVER_PORT  port: $SERVER_PORT  logs: $LOGFILE"
  else
    echo "dev server already running -> http://localhost:$SERVER_PORT  port: $SERVER_PORT (unmanaged; no pidfile or log path)"
  fi
}

show_seed_info() {
  grep -E '^seeded dev (admin account|API key):' "$LOGFILE" || true
}

case "${1:-}" in
  start)
    if is_running; then
      show_server_info "$(cat "$PIDFILE")"
      exit 0
    fi
    rm -f "$PIDFILE"
    if is_server_on_port; then
      show_server_info
      exit 0
    fi
    printf '%s\n' "$SERVER_PORT" > "$PORTFILE"
    if [ "${2:-}" = "--foreground" ]; then
      : > "$LOGFILE"
      set +e
      (cd "$ROOT" && run_server) 2>&1 | tee "$LOGFILE"
      status="${PIPESTATUS[0]}"
      set -e
      exit "$status"
    fi
    : > "$LOGFILE"
    PORT="$SERVER_PORT" SOLAR_SEED_DEV_USER=1 setsid bash -c 'cd "'"$ROOT"'" && exec bash scripts/dev-server.sh run' \
      >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    # Give it a moment to bind or fail fast.
    sleep 3
    if is_running; then
      echo "dev server started (pid $(cat "$PIDFILE")) -> http://localhost:$SERVER_PORT  logs: $LOGFILE"
      show_seed_info
    else
      echo "dev server failed to start; last log lines:"
      tail -n 20 "$LOGFILE"
      rm -f "$PIDFILE"
      rm -f "$PORTFILE"
      exit 1
    fi
    ;;

  run)
    cd "$ROOT"
    run_server
    ;;

  stop)
    if [ -f "$PIDFILE" ]; then
      pid="$(cat "$PIDFILE")"
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      rm -f "$PIDFILE"
      rm -f "$PORTFILE"
      echo "dev server stopped"
    else
      echo "dev server not running"
    fi
    ;;

  restart)
    "$0" stop
    "$0" start
    ;;

  status)
    if is_running; then
      show_server_info "$(cat "$PIDFILE")"
    elif is_server_on_port; then
      show_server_info
    else
      echo "stopped"
    fi
    ;;

  logs)
    tail -n "${2:-80}" "$LOGFILE" 2>/dev/null || echo "no log file yet"
    ;;

  *)
    echo "usage: $0 {start [--foreground]|stop|restart|status|logs [N]}"
    exit 1
    ;;
esac
