#!/usr/bin/env bash
# Managed by Ansible (thermal_watchdog role) — do not edit manually.
#
# Polls /sys/class/hwmon directly (no Prometheus/k8s in the loop) for the
# hottest sensor on this host. If it stays at/above THRESHOLD_C for
# SUSTAIN_SECONDS, sends an ntfy notification and powers the host off.
# Runs independently of the cluster so the safety cutoff still works if
# the cluster itself is struggling because of the heat.
set -euo pipefail

THRESHOLD_C="${THRESHOLD_C:?THRESHOLD_C not set}"
SUSTAIN_SECONDS="${SUSTAIN_SECONDS:?SUSTAIN_SECONDS not set}"
POLL_SECONDS="${POLL_SECONDS:?POLL_SECONDS not set}"
NTFY_HOST="${NTFY_HOST:?NTFY_HOST not set}"
NTFY_IP="${NTFY_IP:?NTFY_IP not set}"
NTFY_TOPIC="${NTFY_TOPIC:?NTFY_TOPIC not set}"
# Set DRY_RUN=1 (e.g. via `systemctl edit --runtime thermal-watchdog`) to
# test the full detection → notify path without actually powering off.
DRY_RUN="${DRY_RUN:-0}"

over_since=0

max_temp_c() {
  local max_milli=0 v f
  for f in /sys/class/hwmon/hwmon*/temp*_input; do
    [ -r "$f" ] || continue
    v=$(cat "$f" 2>/dev/null) || continue
    if [ "$v" -gt "$max_milli" ]; then
      max_milli="$v"
    fi
  done
  echo $(( max_milli / 1000 ))
}

notify_shutdown() {
  local title="PC wird heruntergefahren"
  local body="$(hostname): Temperatur >= ${THRESHOLD_C} C fuer ${SUSTAIN_SECONDS}s. Fahre jetzt herunter."
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

logger -t thermal-watchdog "started (threshold=${THRESHOLD_C}C sustain=${SUSTAIN_SECONDS}s poll=${POLL_SECONDS}s)"

while true; do
  temp="$(max_temp_c)"
  now="$(date +%s)"

  if [ "$temp" -ge "$THRESHOLD_C" ]; then
    if [ "$over_since" -eq 0 ]; then
      over_since="$now"
    elif (( now - over_since >= SUSTAIN_SECONDS )); then
      logger -t thermal-watchdog "${temp}C >= ${THRESHOLD_C}C for $(( now - over_since ))s -- shutting down"
      notify_shutdown
      if [ "$DRY_RUN" = "1" ]; then
        logger -t thermal-watchdog "DRY_RUN=1 -- skipping systemctl poweroff"
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
