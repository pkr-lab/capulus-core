#!/usr/bin/env bash
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

BACKUP_DIR="$HOME/.incident-backups/INC-005-$(date +%Y%m%d%H%M%S)"

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

if findmnt -t nfs,nfs4 >/dev/null 2>&1; then
  echo "NFS-Mounts aktiv, rpcbind wird benoetigt. Abbruch." >&2
  exit 1
fi

for unit in rpcbind.socket rpcbind.service; do
  state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
  active="$(systemctl is-active "$unit" 2>/dev/null || true)"
  if [[ "$state" == "masked" || ( "$state" != "enabled" && "$active" != "active" ) ]]; then
    echo "bereits deaktiviert: $unit ($state/$active)"
    continue
  fi
  run mkdir -p "$BACKUP_DIR"
  if (( DRY )); then
    echo "[dry-run] echo '$unit $state $active' >> $BACKUP_DIR/state.txt"
  else
    echo "$unit $state $active" >> "$BACKUP_DIR/state.txt"
  fi
  run sudo systemctl disable --now "$unit"
done
