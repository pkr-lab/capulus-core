#!/usr/bin/env bash
# Managed by Ansible (resource_watchdog role) — do not edit manually.
#
# Generic threshold watchdog: polls CPU load or RAM usage directly on the
# host (no Prometheus/k8s in the loop) for the metric named in $METRIC. If
# the value stays at/above THRESHOLD for SUSTAIN_SECONDS, sends an ntfy
# notification and powers the host off. Mirrors thermal-watchdog.sh so the
# safety cutoff also works if the cluster itself is struggling under load.
set -euo pipefail

METRIC="${METRIC:?METRIC not set (cpu|ram)}"
THRESHOLD="${THRESHOLD:?THRESHOLD not set}"
SUSTAIN_SECONDS="${SUSTAIN_SECONDS:?SUSTAIN_SECONDS not set}"
POLL_SECONDS="${POLL_SECONDS:?POLL_SECONDS not set}"
NTFY_HOST="${NTFY_HOST:?NTFY_HOST not set}"
NTFY_IP="${NTFY_IP:?NTFY_IP not set}"
NTFY_TOPIC="${NTFY_TOPIC:?NTFY_TOPIC not set}"
# Set DRY_RUN=1 (e.g. via `systemctl edit --runtime resource-watchdog@<metric>`)
# to test the full detection -> notify path without actually powering off.
DRY_RUN="${DRY_RUN:-0}"

over_since=0

cpu_percent() {
  local _ u1 n1 s1 i1 iw1 irq1 sirq1 st1 u2 n2 s2 i2 iw2 irq2 sirq2 st2
  read -r _ u1 n1 s1 i1 iw1 irq1 sirq1 st1 _ < /proc/stat
  sleep 1
  read -r _ u2 n2 s2 i2 iw2 irq2 sirq2 st2 _ < /proc/stat
  local idle=$(( (i2 + iw2) - (i1 + iw1) ))
  local total=$(( (u2+n2+s2+i2+iw2+irq2+sirq2+st2) - (u1+n1+s1+i1+iw1+irq1+sirq1+st1) ))
  if [ "$total" -le 0 ]; then
    echo 0
    return
  fi
  echo $(( 100 * (total - idle) / total ))
}

ram_percent() {
  local total avail
  total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
  avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  echo $(( 100 * (total - avail) / total ))
}

current_percent() {
  case "$METRIC" in
    cpu) cpu_percent ;;
    ram) ram_percent ;;
    *) echo "unknown METRIC: $METRIC" >&2; exit 1 ;;
  esac
}

notify_shutdown() {
  local title="PC wird heruntergefahren (${METRIC^^})"
  local body="$(hostname): ${METRIC} >= ${THRESHOLD}% fuer ${SUSTAIN_SECONDS}s. Fahre jetzt herunter."
  if [ "$DRY_RUN" = "1" ]; then
    title="[DRY RUN] ${title}"
    body="${body} (DRY_RUN=1, kein echter Shutdown)"
  fi
  curl --fail --silent --show-error --max-time 5 \
    --resolve "${NTFY_HOST}:80:${NTFY_IP}" \
    -H "Title: ${title}" \
    -H "Priority: 5" \
    -H "Tags: rotating_light,stop_sign" \
    -d "$body" \
    "http://${NTFY_HOST}/${NTFY_TOPIC}" || true
}

logger -t "resource-watchdog-${METRIC}" "started (threshold=${THRESHOLD}% sustain=${SUSTAIN_SECONDS}s poll=${POLL_SECONDS}s)"

while true; do
  value="$(current_percent)"
  now="$(date +%s)"

  if [ "$value" -ge "$THRESHOLD" ]; then
    if [ "$over_since" -eq 0 ]; then
      over_since="$now"
    elif (( now - over_since >= SUSTAIN_SECONDS )); then
      logger -t "resource-watchdog-${METRIC}" "${value}% >= ${THRESHOLD}% for $(( now - over_since ))s -- shutting down"
      notify_shutdown
      if [ "$DRY_RUN" = "1" ]; then
        logger -t "resource-watchdog-${METRIC}" "DRY_RUN=1 -- skipping systemctl poweroff"
      else
        systemctl poweroff
      fi
      exit 0
    fi
  else
    over_since=0
  fi

  sleep "$POLL_SECONDS"
done
