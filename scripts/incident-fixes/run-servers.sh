#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_ARGS=""
OPTIONAL=0
for a in "$@"; do
  case "$a" in
    --dry-run) REMOTE_ARGS="--dry-run" ;;
    --include-optional) OPTIONAL=1 ;;
    *) echo "unbekannte Option: $a (erlaubt: --dry-run, --include-optional)" >&2; exit 2 ;;
  esac
done

DEFAULT=(
  "control-plane-1 INC-016-etcd-snapshot-nfs-mount.sh"
  "control-plane-0 INC-019-ueberfluessige-dienste.sh"
)

OPTIONAL_JOBS=(
  "control-plane-1 INC-017-updates-ohne-reboot.sh"
  "prod-vm INC-017-updates-ohne-reboot.sh"
  "control-plane-0 INC-017-updates-ohne-reboot.sh"
)

run_on() {
  local host="$1" script="$2" payload
  payload="$(base64 -w0 "$HERE/$script")"
  ssh -n -p 22 -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    "bash -c \"\$(printf %s '$payload' | base64 -d)\" incident $REMOTE_ARGS"
}

JOBS=("${DEFAULT[@]}")
if (( OPTIONAL )); then
  JOBS+=("${OPTIONAL_JOBS[@]}")
fi

ok=()
failed=()
for job in "${JOBS[@]}"; do
  host="${job%% *}"
  script="${job#* }"
  echo
  echo "===== $host: $script ${REMOTE_ARGS} ====="
  if run_on "$host" "$script"; then
    ok+=("$host:$script")
  else
    failed+=("$host:$script")
  fi
done

echo
echo "===== Zusammenfassung ====="
for j in "${ok[@]}"; do echo "  ok       $j"; done
for j in "${failed[@]}"; do echo "  FEHLER   $j"; done
if (( ! OPTIONAL )); then
  echo "nicht ausgefuehrt (mit --include-optional): INC-017 auf control-plane-1, prod-vm, control-plane-0"
fi
echo "Neustart der Server bleibt manuell (kubectl drain, reboot, uncordon), siehe INC-017"
(( ${#failed[@]} == 0 ))
