#!/usr/bin/env bash
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

PKGS=(distro-info python3-distro-info python3-software-properties snapd software-properties-common)
BACKUP_DIR="$HOME/.incident-backups/INC-008-$(date +%Y%m%d%H%M%S)"

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

pending=()
for p in "${PKGS[@]}"; do
  if apt list --upgradable 2>/dev/null | grep -q "^${p}/"; then
    pending+=("$p")
  fi
done

if (( ${#pending[@]} == 0 )); then
  echo "keine ausstehenden Updates fuer: ${PKGS[*]}"
  exit 0
fi

run mkdir -p "$BACKUP_DIR"
if (( DRY )); then
  echo "[dry-run] dpkg-query -W ${pending[*]} > $BACKUP_DIR/versions.txt"
else
  dpkg-query -W -f='${Package}=${Version}\n' "${pending[@]}" > "$BACKUP_DIR/versions.txt"
fi
run sudo apt-get install --only-upgrade -y "${pending[@]}"
