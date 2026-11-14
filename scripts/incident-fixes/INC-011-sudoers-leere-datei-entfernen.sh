#!/usr/bin/env bash
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

TARGET="/etc/sudoers.d/010-pela-nopasswd"
BACKUP_DIR="$HOME/.incident-backups/INC-011-$(date +%Y%m%d%H%M%S)"

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

if ! sudo test -e "$TARGET"; then
  echo "nicht vorhanden: $TARGET"
  exit 0
fi

if sudo test -s "$TARGET"; then
  echo "Datei ist nicht leer, keine Aenderung: $TARGET" >&2
  exit 1
fi

run mkdir -p "$BACKUP_DIR"
if (( DRY )); then
  echo "[dry-run] sudo stat -c '%a %U:%G %n' $TARGET > $BACKUP_DIR/stat.txt"
else
  sudo stat -c '%a %U:%G %n' "$TARGET" > "$BACKUP_DIR/stat.txt"
fi
run sudo rm -- "$TARGET"
run sudo visudo -c
