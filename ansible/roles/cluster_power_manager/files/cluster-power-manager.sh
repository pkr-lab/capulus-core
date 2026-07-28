#!/usr/bin/env bash
# Managed by Ansible (cluster_power_manager role) — do not edit manually.
#
# Läuft auf dem Homeserver. Pollt die LOKALE CPU/RAM-Last (gleiches
# Prinzip wie resource-watchdog.sh, kein Prometheus/k8s in der Messkette)
# und steuert worker-0/worker-1 gegenläufig zum Resource-Watchdog auf den
# Workern: statt sich selbst abzuschalten, weckt/schaltet dieses Skript
# die BEIDEN Worker-Nodes ab, damit deren Rechenlast bei Bedarf zur
# Verfügung steht, aber nicht dauerhaft Strom zieht.
#
# Hochskalieren: Last (CPU ODER RAM) sustained über Schwelle ->
#   1. worker-0 per Wake-on-LAN wecken
#   2. bleibt die Last weiter sustained hoch -> worker-1 zusätzlich wecken
#
# Herunterskalieren: Last (CPU UND RAM) sustained unter (niedrigerer)
# Schwelle -> jeweils EINEN Worker pro Sustain-Periode herunterfahren,
# zuletzt geweckten zuerst (LIFO), erst nach kubectl cordon+drain.
set -euo pipefail

POLL_SECONDS="${POLL_SECONDS:?POLL_SECONDS not set}"
CPU_SCALE_UP_THRESHOLD="${CPU_SCALE_UP_THRESHOLD:?not set}"
RAM_SCALE_UP_THRESHOLD="${RAM_SCALE_UP_THRESHOLD:?not set}"
SCALE_UP_SUSTAIN_SECONDS="${SCALE_UP_SUSTAIN_SECONDS:?not set}"
SCALE_UP_SUSTAIN_SECONDS_STAGE2="${SCALE_UP_SUSTAIN_SECONDS_STAGE2:?not set}"
CPU_SCALE_DOWN_THRESHOLD="${CPU_SCALE_DOWN_THRESHOLD:?not set}"
RAM_SCALE_DOWN_THRESHOLD="${RAM_SCALE_DOWN_THRESHOLD:?not set}"
SCALE_DOWN_SUSTAIN_SECONDS="${SCALE_DOWN_SUSTAIN_SECONDS:?not set}"
MIN_UPTIME_SECONDS="${MIN_UPTIME_SECONDS:?not set}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:?not set}"
SSH_USER="${SSH_USER:?not set}"
SSH_KEY="${SSH_KEY:?not set}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:?not set}"
STATE_DIR="${STATE_DIR:?not set}"
NTFY_HOST="${NTFY_HOST:?not set}"
NTFY_IP="${NTFY_IP:?not set}"
NTFY_TOPIC="${NTFY_TOPIC:?not set}"
WORKERS="${WORKERS:?WORKERS not set (Format: name:ip:mac name:ip:mac ...)}"
# Set DRY_RUN=1 (e.g. via `systemctl edit --runtime cluster-power-manager`)
# to test the full detection -> WoL/shutdown path without actually waking
# or shutting anything down.
DRY_RUN="${DRY_RUN:-0}"

export KUBECONFIG="$KUBECONFIG_PATH"

read -r -a worker_arr <<< "$WORKERS"

high_since=0
low_since=0

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

is_reachable() {
  ping -c 1 -W 2 "$1" > /dev/null 2>&1
}

notify() {
  local title="$1" body="$2"
  if [ "$DRY_RUN" = "1" ]; then
    title="[DRY RUN] ${title}"
  fi
  curl --fail --silent --show-error --max-time 5 \
    --resolve "${NTFY_HOST}:80:${NTFY_IP}" \
    -H "Title: ${title}" \
    -H "Priority: 3" \
    -H "Tags: zap,electric_plug" \
    -d "$body" \
    "http://${NTFY_HOST}/${NTFY_TOPIC}" || true
}

wait_for_ready() {
  local name="$1" waited=0
  while (( waited < READY_TIMEOUT_SECONDS )); do
    if kubectl get node "$name" --no-headers 2>/dev/null | grep -Eq '\sReady\s'; then
      return 0
    fi
    sleep 5
    waited=$(( waited + 5 ))
  done
  return 1
}

wake_worker() {
  local name="$1" ip="$2" mac="$3"
  logger -t cluster-power-manager "waking ${name} (${mac}) -- homeserver load sustained high"
  notify "Worker wird geweckt" "${name} (${ip}) wird per Wake-on-LAN gestartet -- Homeserver-Last anhaltend hoch."
  if [ "$DRY_RUN" = "1" ]; then
    logger -t cluster-power-manager "DRY_RUN=1 -- skipping wakeonlan/uncordon for ${name}"
    date +%s > "${STATE_DIR}/${name}.woke_at"
    return 0
  fi
  wakeonlan "$mac" || true
  if wait_for_ready "$name"; then
    kubectl uncordon "$name" || true
    logger -t cluster-power-manager "${name} is Ready and uncordoned"
  else
    logger -t cluster-power-manager "WARNING: ${name} did not become Ready within ${READY_TIMEOUT_SECONDS}s"
  fi
  date +%s > "${STATE_DIR}/${name}.woke_at"
}

shutdown_worker() {
  local name="$1" ip="$2"
  logger -t cluster-power-manager "shutting down ${name} -- homeserver load sustained low"
  notify "Worker wird heruntergefahren" "${name} (${ip}) wird ausgeschaltet -- Homeserver-Last anhaltend niedrig."
  if [ "$DRY_RUN" = "1" ]; then
    logger -t cluster-power-manager "DRY_RUN=1 -- skipping cordon/drain/poweroff for ${name}"
    rm -f "${STATE_DIR}/${name}.woke_at"
    return 0
  fi
  kubectl cordon "$name" || true
  kubectl drain "$name" --ignore-daemonsets --delete-emptydir-data --timeout=120s || true
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=5 \
    "${SSH_USER}@${ip}" true || true
  rm -f "${STATE_DIR}/${name}.woke_at"
}

logger -t cluster-power-manager "started (cpu_up=${CPU_SCALE_UP_THRESHOLD}% ram_up=${RAM_SCALE_UP_THRESHOLD}% cpu_down=${CPU_SCALE_DOWN_THRESHOLD}% ram_down=${RAM_SCALE_DOWN_THRESHOLD}% workers=${#worker_arr[@]})"

# Bootstrap: ein Worker ist beim (Neu-)Start dieses Skripts bereits erreichbar
# (Homeserver-Reboot, manueller Wake, State-Datei manuell geloescht, ...),
# aber es existiert keine woke_at-Datei. Ohne diese wuerde das
# MIN_UPTIME_SECONDS-Gate in shutdown_worker() NIE erfuellt sein, da woke_at=0
# bleibt -- der Worker haenge dann dauerhaft fest und wuerde nie mehr
# automatisch heruntergefahren. Zeitstempel also jetzt setzen, damit die
# Mindest-Laufzeit ab diesem Skriptstart zaehlt.
for entry in "${worker_arr[@]}"; do
  name="${entry%%:*}"
  rest="${entry#*:}"
  ip="${rest%%:*}"
  if [ ! -f "${STATE_DIR}/${name}.woke_at" ] && is_reachable "$ip"; then
    logger -t cluster-power-manager "bootstrap: ${name} already reachable at startup, no woke_at found -- stamping now"
    date +%s > "${STATE_DIR}/${name}.woke_at"
  fi
done

while true; do
  cpu="$(cpu_percent)"
  ram="$(ram_percent)"
  now="$(date +%s)"

  high=0
  if [ "$cpu" -ge "$CPU_SCALE_UP_THRESHOLD" ] || [ "$ram" -ge "$RAM_SCALE_UP_THRESHOLD" ]; then
    high=1
  fi
  low=0
  if [ "$cpu" -le "$CPU_SCALE_DOWN_THRESHOLD" ] && [ "$ram" -le "$RAM_SCALE_DOWN_THRESHOLD" ]; then
    low=1
  fi

  if [ "$high" = "1" ]; then
    low_since=0
    if [ "$high_since" -eq 0 ]; then
      high_since="$now"
    fi
    elapsed=$(( now - high_since ))

    idx=0
    for entry in "${worker_arr[@]}"; do
      name="${entry%%:*}"
      rest="${entry#*:}"
      ip="${rest%%:*}"
      mac="${rest#*:}"

      if ! is_reachable "$ip"; then
        required=$(( SCALE_UP_SUSTAIN_SECONDS + idx * SCALE_UP_SUSTAIN_SECONDS_STAGE2 ))
        if [ "$elapsed" -ge "$required" ]; then
          wake_worker "$name" "$ip" "$mac"
        fi
        break
      fi
      idx=$(( idx + 1 ))
    done
  elif [ "$low" = "1" ]; then
    high_since=0
    if [ "$low_since" -eq 0 ]; then
      low_since="$now"
    fi
    elapsed=$(( now - low_since ))

    if [ "$elapsed" -ge "$SCALE_DOWN_SUSTAIN_SECONDS" ]; then
      for (( i = ${#worker_arr[@]} - 1; i >= 0; i-- )); do
        entry="${worker_arr[$i]}"
        name="${entry%%:*}"
        rest="${entry#*:}"
        ip="${rest%%:*}"

        if is_reachable "$ip"; then
          woke_at=0
          if [ -f "${STATE_DIR}/${name}.woke_at" ]; then
            woke_at="$(cat "${STATE_DIR}/${name}.woke_at")"
          fi
          if [ "$woke_at" -gt 0 ] && (( now - woke_at >= MIN_UPTIME_SECONDS )); then
            shutdown_worker "$name" "$ip"
            low_since="$now"
          fi
          break
        fi
      done
    fi
  else
    high_since=0
    low_since=0
  fi

  sleep "$POLL_SECONDS"
done
