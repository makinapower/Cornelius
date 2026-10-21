#!/usr/bin/env bash
# Production : serveur et perception locale sur le seul port du serveur (PORT de .env), sans Vite.
# Compile l’interface si elle manque ou si le code a changé depuis, puis arrête une instance précédente.
# Usage : scripts/start.sh [--build] [--no-perception] [--timeout SECONDES]
#   --build   recompile l’interface même si elle existe déjà
# Arrêt : scripts/stop.sh. Au démarrage de la machine : services systemd (docs/installation/linux.md).
set -euo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

build=0
perception=1
timeout=60
while [ $# -gt 0 ]; do
  case "$1" in
    --build) build=1 ;;
    --no-perception) perception=0 ;;
    --timeout)
      [ $# -ge 2 ] || { echo "Option --timeout : indiquez un nombre de secondes." >&2; exit 2; }
      timeout="$2"
      shift
      ;;
    -h | --help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $1 (voir --help)" >&2; exit 2 ;;
  esac
  shift
done

init_dirs
cd "$ROOT"
check_prerequisites
sync_dependencies
port="$(server_port)"

# --- Interface compilée (dist/web) ---------------------------------------------------
# Après une mise à jour (git pull), une source plus récente que la compilation la relance.
stale() {
  [ ! -f dist/web/index.html ] ||
    [ -n "$(find web shared package.json package-lock.json vite.config.ts -type f \
      -newer dist/web/index.html -print -quit 2>/dev/null)" ]
}
if [ "$build" = 1 ] || stale; then
  npm run build
fi

# --- Instance précédente, développement compris ---------------------------------------
"$ROOT/scripts/stop.sh"

launch_server "$port"
if [ "$perception" = 1 ]; then launch_perception; fi
launch_voice

echo
wait_server "$port" "$timeout"
