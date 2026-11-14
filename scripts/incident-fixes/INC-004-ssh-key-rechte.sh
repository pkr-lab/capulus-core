#!/usr/bin/env bash
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

SSH_DIR="$HOME/.ssh"
BACKUP_DIR="$HOME/.incident-backups/INC-004-$(date +%Y%m%d%H%M%S)"

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

fix_mode() {
  local file="$1" want="$2" have
  [[ -e "$file" ]] || { echo "fehlt: $file"; return 0; }
  have="$(stat -c '%a' "$file")"
  if [[ "$have" == "$want" ]]; then
    echo "ok ($have): $file"
    return 0
  fi
  run mkdir -p "$BACKUP_DIR"
  if (( DRY )); then
    echo "[dry-run] echo '$have $file' >> $BACKUP_DIR/modes.txt"
  else
    echo "$have $file" >> "$BACKUP_DIR/modes.txt"
  fi
  run chmod "$want" "$file"
  echo "geaendert: $file $have -> $want"
}

fix_mode "$SSH_DIR" 700
fix_mode "$SSH_DIR/client-private.key" 600
fix_mode "$SSH_DIR/client-public.key" 644
