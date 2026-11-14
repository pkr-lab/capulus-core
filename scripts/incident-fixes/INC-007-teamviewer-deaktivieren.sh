#!/usr/bin/env bash
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

UNIT="teamviewerd.service"
BACKUP_DIR="$HOME/.incident-backups/INC-007-$(date +%Y%m%d%H%M%S)"

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

if ! systemctl cat "$UNIT" >/dev/null 2>&1; then
  echo "Unit nicht vorhanden: $UNIT"
  exit 0
fi

state="$(systemctl is-enabled "$UNIT" 2>/dev/null || true)"
active="$(systemctl is-active "$UNIT" 2>/dev/null || true)"
if [[ "$state" != "enabled" && "$active" != "active" ]]; then
  echo "bereits deaktiviert: $UNIT ($state/$active)"
  exit 0
fi

run mkdir -p "$BACKUP_DIR"
if (( DRY )); then
  echo "[dry-run] sudo cp -a /etc/teamviewer $BACKUP_DIR/teamviewer"
  echo "[dry-run] echo '$UNIT $state $active' >> $BACKUP_DIR/state.txt"
else
  sudo cp -a /etc/teamviewer "$BACKUP_DIR/teamviewer"
  echo "$UNIT $state $active" >> "$BACKUP_DIR/state.txt"
fi
run sudo systemctl disable --now "$UNIT"
