#!/usr/bin/env bash
set -euo pipefail


main() {
  DRY=0
  [[ "${1:-}" == "--dry-run" ]] && DRY=1

  BACKUP_DIR="/var/backups/incident-INC-017-$(date +%Y%m%d%H%M%S)"
  export DEBIAN_FRONTEND=noninteractive

  run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

  run sudo apt-get update
  pending="$(apt list --upgradable 2>/dev/null | grep -vc '^Listing' || true)"
  if [[ "$pending" == "0" ]]; then
    echo "keine ausstehenden Paket-Updates"
  else
    run sudo mkdir -p "$BACKUP_DIR"
    if (( DRY )); then
      echo "[dry-run] dpkg-query -W > $BACKUP_DIR/versions-before.txt"
      sudo apt-get -s upgrade
    else
      dpkg-query -W -f='${Package}=${Version}\n' | sudo tee "$BACKUP_DIR/versions-before.txt" >/dev/null
      sudo env NEEDRESTART_MODE=a apt-get -y -o Dpkg::Options::=--force-confold upgrade
    fi
  fi

  if [[ -e /var/run/reboot-required ]]; then
    echo "Neustart erforderlich (nicht ausgefuehrt):"
    cat /var/run/reboot-required.pkgs 2>/dev/null || true
  fi

}

main "$@"
exit $?
