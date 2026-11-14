#!/usr/bin/env bash
set -euo pipefail

main() {
  local DRY=0
  [[ "${1:-}" == "--dry-run" ]] && DRY=1

  local MOUNTPOINT="/mnt/k3s-etcd-snapshots"
  local SERVICE="k3s-etcd-snapshot-copy.service"
  local UNIT DROPIN_DIR DROPIN BACKUP_DIR
  UNIT="$(systemd-escape -p --suffix=mount "$MOUNTPOINT")"
  DROPIN_DIR="/etc/systemd/system/${UNIT}.d"
  DROPIN="$DROPIN_DIR/10-network-online.conf"
  BACKUP_DIR="/var/backups/incident-INC-016-$(date +%Y%m%d%H%M%S)"
  TMP="$(mktemp)"
  trap 'rm -f "${TMP:-}"' EXIT

  run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

  printf '[Unit]\nAfter=network-online.target\nWants=network-online.target\n' > "$TMP"

  run sudo mkdir -p "$BACKUP_DIR"
  run sudo cp -a /etc/fstab "$BACKUP_DIR/fstab"
  if sudo test -d "$DROPIN_DIR"; then
    run sudo cp -a "$DROPIN_DIR" "$BACKUP_DIR/dropin"
  fi

  if sudo test -f "$DROPIN" && sudo cmp -s "$TMP" "$DROPIN"; then
    echo "Drop-in bereits vorhanden: $DROPIN"
  else
    run sudo mkdir -p "$DROPIN_DIR"
    run sudo install -m 0644 -o root -g root "$TMP" "$DROPIN"
    run sudo systemctl daemon-reload
  fi

  if mountpoint -q "$MOUNTPOINT"; then
    echo "bereits gemountet: $MOUNTPOINT"
  else
    run sudo systemctl reset-failed "$UNIT" "$SERVICE"
    run sudo systemctl start "$UNIT"
  fi

  if (( DRY )); then
    echo "[dry-run] sudo systemctl start $SERVICE"
    echo "[dry-run] mountpoint -q $MOUNTPOINT"
  else
    mountpoint -q "$MOUNTPOINT" || { echo "Mount fehlgeschlagen, NAS 192.168.178.97 und NFS-Export pruefen" >&2; return 1; }
    sudo systemctl start "$SERVICE"
    if systemctl is-failed --quiet "$SERVICE"; then
      echo "Kopierdienst weiterhin fehlgeschlagen" >&2
      return 1
    fi
    echo "ok"
  fi
}

main "$@"
exit $?
