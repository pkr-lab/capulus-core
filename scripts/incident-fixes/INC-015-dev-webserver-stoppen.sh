#!/usr/bin/env bash
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

PORT=8000
BACKUP_DIR="$HOME/.incident-backups/INC-015-$(date +%Y%m%d%H%M%S)"

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

pids="$(pgrep -u "$(id -u)" -f "^python3 -m http.server $PORT$" || true)"
if [[ -z "$pids" ]]; then
  echo "kein 'python3 -m http.server $PORT' unter diesem Benutzer"
  exit 0
fi

for pid in $pids; do
  listen="$(ss -tlnpH "sport = :$PORT" 2>/dev/null | grep "pid=$pid," | awk '{print $4}' || true)"
  case "$listen" in
    0.0.0.0:*|\*:*|\[::\]:*) ;;
    *) echo "PID $pid lauscht nicht auf allen Schnittstellen ($listen), uebersprungen"; continue ;;
  esac
  run mkdir -p "$BACKUP_DIR"
  if (( DRY )); then
    echo "[dry-run] cwd und Kommandozeile von PID $pid nach $BACKUP_DIR/process.txt sichern"
  else
    {
      echo "pid=$pid"
      echo "cwd=$(readlink "/proc/$pid/cwd")"
      echo "cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline")"
    } >> "$BACKUP_DIR/process.txt"
  fi
  run kill "$pid"
done
echo "Neustart nur lokal: (cd <Verzeichnis> && python3 -m http.server $PORT --bind 127.0.0.1)"
