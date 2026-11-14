#!/usr/bin/env bash
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

TARGET="/etc/ssh/sshd_config.d/60-hardening.conf"
BACKUP_DIR="$HOME/.incident-backups/INC-006-$(date +%Y%m%d%H%M%S)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

if ! grep -qE '^(ssh-(ed25519|rsa)|ecdsa-sha2-[a-z0-9]+|sk-[a-z0-9@.-]+) ' "$HOME/.ssh/authorized_keys" 2>/dev/null; then
  echo "Kein Public Key in ~/.ssh/authorized_keys. Abbruch, sonst Aussperrung." >&2
  exit 1
fi

cat > "$TMP" <<'CONF'
PasswordAuthentication no
PermitRootLogin no
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
CONF

if sudo test -f "$TARGET" && sudo cmp -s "$TMP" "$TARGET"; then
  echo "bereits angewendet: $TARGET"
  exit 0
fi

if sudo test -f "$TARGET"; then
  run mkdir -p "$BACKUP_DIR"
  run sudo cp -p "$TARGET" "$BACKUP_DIR/60-hardening.conf"
fi

run sudo install -m 0644 -o root -g root "$TMP" "$TARGET"
if (( DRY )); then
  echo "[dry-run] sudo sshd -t"
  echo "[dry-run] sudo systemctl reload ssh"
else
  if ! sudo sshd -t; then
    sudo rm -f "$TARGET"
    echo "sshd -t fehlgeschlagen, Aenderung zurueckgenommen" >&2
    exit 1
  fi
  sudo systemctl reload ssh
  echo "angewendet. Zweite SSH-Sitzung zum Test oeffnen, bevor die aktuelle geschlossen wird"
fi
