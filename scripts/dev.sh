#!/usr/bin/env bash
# Développement : serveur, interface Vite (port 5173, rechargement à chaud) et perception locale.
# Usage : scripts/dev.sh [--no-frontend] [--no-perception] [--timeout SECONDES]
# Arrêt : scripts/stop.sh. Production (interface compilée, sans Vite) : scripts/start.sh.
set -euo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

frontend=1
perception=1
timeout=60
while [ $# -gt 0 ]; do
  case "$1" in
    --no-frontend) frontend=0 ;;
    --no-perception) perception=0 ;;
    --timeout)
      [ $# -ge 2 ] || { echo "Option --timeout : indiquez un nombre de secondes." >&2; exit 2; }
      timeout="$2"
      shift
      ;;
    -h | --help) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $1 (voir --help)" >&2; exit 2 ;;
  esac
  shift
done

init_dirs
cd "$ROOT"
check_prerequisites
sync_dependencies
port="$(server_port)"

# --- Serveur (Fastify, port de .env) -------------------------------------------------
launch_server "$port"

# --- Interface de développement (Vite, port 5173) ------------------------------------
if [ "$frontend" = 1 ]; then
  owner="$(port_owner 5173)"
  if pid_alive "$owner"; then
    echo "Interface Vite déjà active sur le port 5173 (PID $owner)."
  else
    start_service frontend node node_modules/vite/bin/vite.js --host 127.0.0.1
  fi
fi

# --- Perception locale (worker Python) -----------------------------------------------
if [ "$perception" = 1 ]; then launch_perception; fi
launch_voice

echo
status=0
wait_server "$port" "$timeout" || status=1
if [ "$frontend" = 1 ]; then
  if wait_http "http://127.0.0.1:5173/" "$timeout"; then
    echo "Interface prête : http://127.0.0.1:5173"
  else
    echo "Interface non confirmée après $timeout s." >&2
    show_log_tail frontend
    status=1
  fi
fi
exit "$status"
