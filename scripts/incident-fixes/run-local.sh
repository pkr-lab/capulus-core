#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARGS=()
OPTIONAL=0
for a in "$@"; do
  case "$a" in
    --dry-run) ARGS+=(--dry-run) ;;
    --include-optional) OPTIONAL=1 ;;
    *) echo "unbekannte Option: $a (erlaubt: --dry-run, --include-optional)" >&2; exit 2 ;;
  esac
done

DEFAULT=(
  INC-004-ssh-key-rechte.sh
  INC-008-updates-einspielen.sh
  INC-011-sudoers-leere-datei-entfernen.sh
  INC-012-pruefwerkzeuge-nachinstallieren.sh
  INC-014-haertung-lynis.sh
)

OPTIONAL_SCRIPTS=(
  INC-005-rpcbind-deaktivieren.sh
  INC-006-sshd-haertung.sh
  INC-007-teamviewer-deaktivieren.sh
  INC-009-restic-user-backup.sh
  INC-015-dev-webserver-stoppen.sh
  INC-020-ssh-key-passphrase-setzen.sh
)

CHECKS=(
  INC-002-secureboot-preflight.sh
  INC-020-ssh-key-audit.sh
)

sudo -v

SCRIPTS=("${DEFAULT[@]}")
if (( OPTIONAL )); then
  SCRIPTS+=("${OPTIONAL_SCRIPTS[@]}")
fi

ok=()
failed=()
for s in "${SCRIPTS[@]}"; do
  echo
  echo "===== $s ${ARGS[*]:-} ====="
  if bash "$HERE/$s" "${ARGS[@]}"; then
    ok+=("$s")
  else
    failed+=("$s")
  fi
done

echo
echo "===== Pruefskripte (nur lesend) ====="
for s in "${CHECKS[@]}"; do
  echo
  echo "----- $s -----"
  bash "$HERE/$s" || failed+=("$s")
done

echo
echo "===== Zusammenfassung ====="
echo "erfolgreich: ${#ok[@]}"
for s in "${ok[@]}"; do echo "  ok       $s"; done
echo "fehlgeschlagen: ${#failed[@]}"
for s in "${failed[@]}"; do echo "  FEHLER   $s"; done
if (( ! OPTIONAL )); then
  echo "nicht ausgefuehrt (mit --include-optional): ${OPTIONAL_SCRIPTS[*]}"
fi
(( ${#failed[@]} == 0 ))
