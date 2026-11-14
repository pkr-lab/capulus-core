#!/usr/bin/env bash
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY setzen (Ziel des Backups)}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE setzen (Datei mit Repo-Passwort, Modus 600)}"

CONF_DIR="$HOME/.config/restic"
UNIT_DIR="$HOME/.config/systemd/user"
BACKUP_DIR="$HOME/.incident-backups/INC-009-$(date +%Y%m%d%H%M%S)"

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

command -v restic >/dev/null || { echo "restic fehlt" >&2; exit 1; }
[[ -r "$RESTIC_PASSWORD_FILE" ]] || { echo "Passwortdatei nicht lesbar: $RESTIC_PASSWORD_FILE" >&2; exit 1; }
[[ "$(stat -c '%a' "$RESTIC_PASSWORD_FILE")" == "600" ]] || { echo "Passwortdatei muss Modus 600 haben" >&2; exit 1; }

write_file() {
  local target="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  if [[ -f "$target" ]] && cmp -s "$tmp" "$target"; then
    echo "unveraendert: $target"
    rm -f "$tmp"
    return 0
  fi
  if [[ -f "$target" ]]; then
    run mkdir -p "$BACKUP_DIR"
    run cp -p "$target" "$BACKUP_DIR/$(basename "$target")"
  fi
  run mkdir -p "$(dirname "$target")"
  run install -m "$mode" "$tmp" "$target"
  rm -f "$tmp"
}

write_file "$CONF_DIR/env" 600 <<CONF
RESTIC_REPOSITORY=$RESTIC_REPOSITORY
RESTIC_PASSWORD_FILE=$RESTIC_PASSWORD_FILE
CONF

write_file "$CONF_DIR/excludes" 644 <<'CONF'
.cache
node_modules
.npm
.cargo/registry
go/pkg/mod
.local/share/Trash
snap/*/common/.cache
CONF

write_file "$UNIT_DIR/restic-backup.service" 644 <<'CONF'
[Unit]
Description=Restic Backup des Home-Verzeichnisses

[Service]
Type=oneshot
EnvironmentFile=%h/.config/restic/env
ExecStart=/usr/bin/restic backup --exclude-caches --exclude-file=%h/.config/restic/excludes %h
Nice=19
IOSchedulingClass=idle
CONF

write_file "$UNIT_DIR/restic-backup.timer" 644 <<'CONF'
[Unit]
Description=Taegliches Restic Backup

[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
CONF

write_file "$UNIT_DIR/restic-prune.service" 644 <<'CONF'
[Unit]
Description=Restic Aufbewahrung und Integritaetspruefung

[Service]
Type=oneshot
EnvironmentFile=%h/.config/restic/env
ExecStart=/usr/bin/restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
ExecStart=/usr/bin/restic check
Nice=19
IOSchedulingClass=idle
CONF

write_file "$UNIT_DIR/restic-prune.timer" 644 <<'CONF'
[Unit]
Description=Woechentliche Restic Aufbewahrung

[Timer]
OnCalendar=weekly
RandomizedDelaySec=2h
Persistent=true

[Install]
WantedBy=timers.target
CONF

if (( DRY )); then
  echo "[dry-run] restic cat config || restic init"
else
  export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE
  if restic cat config >/dev/null 2>&1; then
    echo "Repository vorhanden"
  else
    restic init
  fi
fi

run systemctl --user daemon-reload
run systemctl --user enable --now restic-backup.timer restic-prune.timer
