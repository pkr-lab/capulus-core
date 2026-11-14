#!/usr/bin/env bash
set -euo pipefail


main() {
  DRY=0
  [[ "${1:-}" == "--dry-run" ]] && DRY=1

  UNITS=(cups-browsed.service ModemManager.service)
  BACKUP_DIR="/var/backups/incident-INC-019-$(date +%Y%m%d%H%M%S)"

  run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

  for unit in "${UNITS[@]}"; do
    if ! systemctl cat "$unit" >/dev/null 2>&1; then
      echo "nicht vorhanden: $unit"
      continue
    fi
    state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    active="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [[ "$state" != "enabled" && "$active" != "active" ]]; then
      echo "bereits deaktiviert: $unit ($state/$active)"
      continue
    fi
    run sudo mkdir -p "$BACKUP_DIR"
    if (( DRY )); then
      echo "[dry-run] echo '$unit $state $active' >> $BACKUP_DIR/state.txt"
    else
      echo "$unit $state $active" | sudo tee -a "$BACKUP_DIR/state.txt" >/dev/null
    fi
    run sudo systemctl disable --now "$unit"
  done

}

main "$@"
exit $?
