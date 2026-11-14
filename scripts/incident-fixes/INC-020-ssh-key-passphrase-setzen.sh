#!/usr/bin/env bash
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

SSH_DIR="$HOME/.ssh"
BACKUP_DIR="$HOME/.incident-backups/INC-020-$(date +%Y%m%d%H%M%S)"

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

shopt -s nullglob
changed=0
for key in "$SSH_DIR"/id_ed25519 "$SSH_DIR"/id_rsa "$SSH_DIR"/prod_vm_ed25519 "$SSH_DIR"/netcup-deploy; do
  [[ -f "$key" ]] || continue
  head -n1 "$key" | grep -q 'PRIVATE KEY' || continue
  if ! ssh-keygen -y -P '' -f "$key" >/dev/null 2>&1; then
    echo "bereits mit Passphrase geschuetzt: $key"
    continue
  fi
  echo "ohne Passphrase: $key"
  if (( DRY )); then
    echo "[dry-run] cp -p $key $BACKUP_DIR/$(basename "$key")   (Backup enthaelt den ungeschuetzten Schluessel)"
    echo "[dry-run] ssh-keygen -p -f $key   (fragt interaktiv nach der neuen Passphrase)"
  else
    mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_DIR"
    cp -p "$key" "$BACKUP_DIR/$(basename "$key")"
    ssh-keygen -p -f "$key"
    changed=1
  fi
done

if (( changed )); then
  echo "Backups mit ungeschuetzten Schluesseln unter $BACKUP_DIR nach erfolgreichem Test per 'shred -u' loeschen"
  echo "Test: ssh control-plane-1 true   (Passphrase einmalig, danach ssh-agent)"
fi
