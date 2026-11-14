#!/usr/bin/env bash
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

BACKUP_DIR="/var/backups/incident-INC-014-$(date +%Y%m%d%H%M%S)"
MODPROBE_FILE="/etc/modprobe.d/60-incident-unused-net-protocols.conf"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

run sudo mkdir -p "$BACKUP_DIR"

missing=()
for p in auditd debsums; do
  dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
done
if (( ${#missing[@]} )); then
  run sudo apt-get install -y "${missing[@]}"
else
  echo "vorhanden: auditd debsums"
fi

if systemctl is-enabled auditd >/dev/null 2>&1 && systemctl is-active auditd >/dev/null 2>&1; then
  echo "auditd bereits aktiv"
elif systemctl cat auditd >/dev/null 2>&1 || (( ! DRY )); then
  run sudo systemctl enable --now auditd
fi

printf 'install dccp /bin/false\ninstall sctp /bin/false\ninstall rds /bin/false\ninstall tipc /bin/false\n' > "$TMP"
if [[ -f "$MODPROBE_FILE" ]] && cmp -s "$TMP" "$MODPROBE_FILE"; then
  echo "unveraendert: $MODPROBE_FILE"
else
  if [[ -f "$MODPROBE_FILE" ]]; then
    run sudo cp -p "$MODPROBE_FILE" "$BACKUP_DIR/$(basename "$MODPROBE_FILE")"
  fi
  run sudo install -m 0644 -o root -g root "$TMP" "$MODPROBE_FILE"
fi

rc_all="$(dpkg -l | awk '/^rc/{print $2}')"
rc_kernel="$(echo "$rc_all" | grep -E '^linux-(image|image-unsigned|modules|main-modules|modules-nvidia|signed)' || true)"
rc_other="$(echo "$rc_all" | grep -vE '^linux-(image|image-unsigned|modules|main-modules|modules-nvidia|signed)' | grep . || true)"

if [[ -n "$rc_other" ]]; then
  echo "NICHT entfernt (Konfiguration koennte von dir angepasst sein, manuell pruefen und mit 'sudo apt-get purge' entfernen):"
  echo "$rc_other" | sed 's/^/  /'
fi

if [[ -z "$rc_kernel" ]]; then
  echo "keine entfernten Kernel-Pakete mit Konfigurationsresten"
else
  if (( DRY )); then
    echo "[dry-run] Liste der rc-Kernelpakete nach $BACKUP_DIR/rc-kernel-packages.txt sichern"
    echo "[dry-run] sudo apt-get purge -y $(echo "$rc_kernel" | tr '\n' ' ')"
  else
    echo "$rc_kernel" | sudo tee "$BACKUP_DIR/rc-kernel-packages.txt" >/dev/null
    echo "$rc_kernel" | xargs sudo apt-get purge -y
  fi
fi
