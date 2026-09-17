#!/usr/bin/env bash
set -euo pipefail

MAX_RUNTIME_SECONDS="${MAX_RUNTIME_SECONDS:?not set}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:?not set}"
STOP_GRACE_SECONDS="${STOP_GRACE_SECONDS:?not set}"
POLL_SECONDS="${POLL_SECONDS:?not set}"
SSH_USER="${SSH_USER:?not set}"
SSH_KEY="${SSH_KEY:?not set}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:?not set}"
STATE_DIR="${STATE_DIR:?not set}"
SEMAPHORE_API_BASE="${SEMAPHORE_API_BASE:?not set}"
SEMAPHORE_ADMIN_USERNAME="${SEMAPHORE_ADMIN_USERNAME:?not set}"
SEMAPHORE_ADMIN_PASSWORD_PATH="${SEMAPHORE_ADMIN_PASSWORD_PATH:?not set}"
NTFY_HOST="${NTFY_HOST:?not set}"
NTFY_IP="${NTFY_IP:?not set}"
NTFY_TOPIC="${NTFY_TOPIC:?not set}"
N8N_WEBHOOK_URL="${N8N_WEBHOOK_URL:?not set}"
WORKERS="${WORKERS:?WORKERS not set (Format: name:ip:mac name:ip:mac ...)}"
DRY_RUN="${DRY_RUN:-0}"

export KUBECONFIG="$KUBECONFIG_PATH"

read -r -a worker_arr <<< "$WORKERS"
all_names=()
declare -A wp_ip wp_mac
for entry in "${worker_arr[@]}"; do
  name="${entry%%:*}"; rest="${entry#*:}"; ip="${rest%%:*}"; mac="${rest#*:}"
  all_names+=("$name")
  wp_ip["$name"]="$ip"
  wp_mac["$name"]="$mac"
done

COOKIE_JAR="$(mktemp)"
wakened_names=()
CPM_STOPPED=0
NOTE=""

START="$(date +%s)"
START_ISO="$(date -u -Iseconds)"
DEADLINE=$(( START + MAX_RUNTIME_SECONDS ))

# ---- Report-Buchführung je Worker -----------------------------------
declare -A wp_status wp_reason wp_changed wp_recap wp_rebooted
for name in "${all_names[@]}"; do
  wp_status["$name"]="pending"
  wp_reason["$name"]=""
  wp_changed["$name"]="false"
  wp_recap["$name"]=""
  wp_rebooted["$name"]="false"
done

notify() {
  local title="$1" body="$2"
  if [ "$DRY_RUN" = "1" ]; then
    title="[DRY RUN] ${title}"
  fi
  curl --fail --silent --show-error --max-time 5 \
    --resolve "${NTFY_HOST}:80:${NTFY_IP}" \
    -H "Title: ${title}" \
    -H "Priority: 3" \
    -H "Tags: package,zap" \
    -d "$body" \
    "http://${NTFY_HOST}/${NTFY_TOPIC}" || true
}

send_report() {
  local note="$1" finished_iso elapsed workers_json
  finished_iso="$(date -u -Iseconds)"
  elapsed=$(( $(date +%s) - START ))

  workers_json="[]"
  for name in "${all_names[@]}"; do
    workers_json="$(jq -c \
      --argjson arr "$workers_json" \
      --arg name "$name" \
      --arg status "${wp_status[$name]}" \
      --arg reason "${wp_reason[$name]}" \
      --argjson changed "${wp_changed[$name]}" \
      --arg recap "${wp_recap[$name]}" \
      --argjson rebooted "${wp_rebooted[$name]}" \
      -n '$arr + [{name:$name, status:$status, reason:$reason, changed:$changed, play_recap:$recap, rebooted:$rebooted}]')"
  done

  local payload
  payload="$(jq -n \
    --arg started_at "$START_ISO" \
    --arg finished_at "$finished_iso" \
    --argjson elapsed_seconds "$elapsed" \
    --arg note "$note" \
    --argjson dry_run "$([ "$DRY_RUN" = "1" ] && echo true || echo false)" \
    --argjson workers "$workers_json" \
    '{started_at:$started_at, finished_at:$finished_at, elapsed_seconds:$elapsed_seconds, note:$note, dry_run:$dry_run, workers:$workers}')"

  curl --silent --show-error --max-time 15 \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$N8N_WEBHOOK_URL" > /dev/null || \
    logger -t nightly-worker-wake "WARNUNG: n8n-Webhook (${N8N_WEBHOOK_URL}) nicht erreichbar -- kein Zammad-Ticket für diesen Lauf"
}

wait_for_ready() {
  local name="$1" waited=0 ready
  while (( waited < READY_TIMEOUT_SECONDS )); do
    ready="$(kubectl get node "$name" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
    [ "$ready" = "True" ] && return 0
    sleep 5
    waited=$(( waited + 5 ))
  done
  return 1
}

wake_worker() {
  local name="$1" mac="$2"
  logger -t nightly-worker-wake "waking ${name} (${mac}) for nightly update"
  if [ "$DRY_RUN" = "1" ]; then
    logger -t nightly-worker-wake "DRY_RUN=1 -- skipping wakeonlan for ${name}"
    date +%s > "${STATE_DIR}/${name}.woke_at"
    return 0
  fi
  wakeonlan "$mac" || true
  if wait_for_ready "$name"; then
    kubectl uncordon "$name" || true
    date +%s > "${STATE_DIR}/${name}.woke_at"
    logger -t nightly-worker-wake "${name} is Ready and uncordoned"
    return 0
  fi
  logger -t nightly-worker-wake "WARNING: ${name} did not become Ready within ${READY_TIMEOUT_SECONDS}s -- skipping update"
  wp_status["$name"]="not_ready"
  wp_reason["$name"]="Nicht innerhalb von ${READY_TIMEOUT_SECONDS}s nach Wake-on-LAN erreichbar geworden"
  return 1
}

shutdown_worker() {
  local name="$1" ip="$2"
  logger -t nightly-worker-wake "shutting down ${name} -- nightly update window closed"
  if [ "$DRY_RUN" = "1" ]; then
    logger -t nightly-worker-wake "DRY_RUN=1 -- skipping cordon/drain/poweroff for ${name}"
    rm -f "${STATE_DIR}/${name}.woke_at"
    return 0
  fi
  kubectl cordon "$name" || true
  kubectl drain "$name" --ignore-daemonsets --delete-emptydir-data --timeout=120s || true
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=5 \
    "${SSH_USER}@${ip}" true || true
  rm -f "${STATE_DIR}/${name}.woke_at"
}

semaphore_login() {
  local admin_password
  admin_password="$(cat "$SEMAPHORE_ADMIN_PASSWORD_PATH")"
  curl --fail --silent --show-error --max-time 10 \
    -c "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -d "{\"auth\":\"${SEMAPHORE_ADMIN_USERNAME}\",\"password\":\"${admin_password}\"}" \
    "${SEMAPHORE_API_BASE}/api/auth/login"
}

semaphore_project_id() {
  curl --fail --silent --show-error --max-time 10 -b "$COOKIE_JAR" \
    "${SEMAPHORE_API_BASE}/api/projects" \
    | jq -r --arg name "$1" '.[] | select(.name == $name) | .id'
}

semaphore_template_id() {
  curl --fail --silent --show-error --max-time 10 -b "$COOKIE_JAR" \
    "${SEMAPHORE_API_BASE}/api/project/$1/templates" \
    | jq -r --arg name "$2" '.[] | select(.name == $name) | .id'
}

semaphore_trigger_task() {
  curl --fail --silent --show-error --max-time 10 -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -d "{\"template_id\": $2}" \
    "${SEMAPHORE_API_BASE}/api/project/$1/tasks" \
    | jq -r '.id'
}

semaphore_task_status() {
  curl --fail --silent --show-error --max-time 10 -b "$COOKIE_JAR" \
    "${SEMAPHORE_API_BASE}/api/project/$1/tasks/$2" \
    | jq -r '.status'
}

semaphore_stop_task() {
  curl --silent --show-error --max-time 10 -b "$COOKIE_JAR" -X POST \
    "${SEMAPHORE_API_BASE}/api/project/$1/tasks/$2/stop" > /dev/null || true
}

semaphore_fill_report_from_output() {
  local name="$1" project_id="$2" task_id="$3" output recap
  output="$(curl --silent --show-error --max-time 15 -b "$COOKIE_JAR" \
    "${SEMAPHORE_API_BASE}/api/project/${project_id}/tasks/${task_id}/output" \
    | jq -r '.[].output' 2>/dev/null || true)"
  [ -z "$output" ] && return 0

  recap="$(printf '%s\n' "$output" | sed -E 's/\x1b\[[0-9;]*m//g' | grep -E "^${name}[[:space:]]*:" | tail -1 | tr -d '\r' || true)"
  wp_recap["$name"]="$recap"

  if printf '%s' "$recap" | grep -Eq 'changed=[1-9]'; then
    wp_changed["$name"]="true"
  fi
  if printf '%s' "$output" | grep -q "wurde automatisch neu gestartet"; then
    wp_rebooted["$name"]="true"
  fi
}

cleanup_and_report() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -z "$NOTE" ]; then
    NOTE="Skript brach mit Exit-Code ${rc} vorzeitig ab (siehe journalctl -u nightly-worker-wake) -- Worker wurden sicherheitshalber heruntergefahren."
    logger -t nightly-worker-wake "WARNUNG: unerwarteter Abbruch (exit ${rc}) -- fahre geweckte Worker sicherheitshalber herunter"
  fi

  for name in "${wakened_names[@]:-}"; do
    [ -n "$name" ] || continue
    shutdown_worker "$name" "${wp_ip[$name]}"
  done

  if [ "$CPM_STOPPED" = "1" ]; then
    systemctl start cluster-power-manager.service || true
  fi

  local elapsed
  elapsed=$(( $(date +%s) - START ))
  logger -t nightly-worker-wake "finished after ${elapsed}s (exit ${rc})"
  send_report "$NOTE"
  rm -f "$COOKIE_JAR"
}
trap cleanup_and_report EXIT

logger -t nightly-worker-wake "started (workers=${#worker_arr[@]}, max_runtime=${MAX_RUNTIME_SECONDS}s)"
notify "Nightly Worker Update startet" "Wecke ${#worker_arr[@]} Worker, führe Updates aus (max. $(( MAX_RUNTIME_SECONDS / 60 )) Minuten)."

if [ "$DRY_RUN" != "1" ]; then
  systemctl stop cluster-power-manager.service || true
  CPM_STOPPED=1
fi

for name in "${all_names[@]}"; do
  if wake_worker "$name" "${wp_mac[$name]}"; then
    wakened_names+=("$name")
  fi
done

if [ "${#wakened_names[@]}" -eq 0 ]; then
  logger -t nightly-worker-wake "no worker became Ready -- nothing to update"
  notify "Nightly Worker Update übersprungen" "Kein Worker wurde rechtzeitig Ready -- keine Updates ausgeführt."
  NOTE="Kein Worker wurde rechtzeitig Ready -- keine Updates versucht."
  exit 0
fi

if ! semaphore_login > /dev/null; then
  logger -t nightly-worker-wake "WARNUNG: Semaphore-Login fehlgeschlagen -- Worker werden ohne Update wieder heruntergefahren"
  notify "Nightly Worker Update: Semaphore-Login fehlgeschlagen" "Worker wurden geweckt, aber Semaphore-API war nicht erreichbar -- kein Update, direkter Shutdown."
  for name in "${wakened_names[@]}"; do
    wp_status["$name"]="error"
    wp_reason["$name"]="Semaphore-Login fehlgeschlagen -- kein Update versucht"
  done
  NOTE="Semaphore-API/Login fehlgeschlagen -- Worker wurden ohne Update wieder heruntergefahren."
  exit 0
fi

declare -A wp_project_id wp_task_id
for name in "${wakened_names[@]}"; do
  project_id="$(semaphore_project_id "$name")"
  if [ -z "$project_id" ] || [ "$project_id" = "null" ]; then
    logger -t nightly-worker-wake "WARNUNG: kein Semaphore-Projekt '${name}' gefunden -- überspringe Update"
    wp_status["$name"]="no_template"
    wp_reason["$name"]="Kein Semaphore-Projekt '${name}' gefunden"
    continue
  fi
  template_id="$(semaphore_template_id "$project_id" "Deploy ${name}")"
  if [ -z "$template_id" ] || [ "$template_id" = "null" ]; then
    logger -t nightly-worker-wake "WARNUNG: kein Template 'Deploy ${name}' im Projekt '${name}' gefunden -- überspringe Update"
    wp_status["$name"]="no_template"
    wp_reason["$name"]="Kein Template 'Deploy ${name}' im Semaphore-Projekt '${name}' gefunden"
    continue
  fi
  task_id="$(semaphore_trigger_task "$project_id" "$template_id")"
  logger -t nightly-worker-wake "started Semaphore task ${task_id} for ${name} (template ${template_id})"
  wp_project_id["$name"]="$project_id"
  wp_task_id["$name"]="$task_id"
done

pending=("${!wp_task_id[@]}")
while [ "${#pending[@]}" -gt 0 ] && [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep "$POLL_SECONDS"
  still_pending=()
  for name in "${pending[@]}"; do
    status="$(semaphore_task_status "${wp_project_id[$name]}" "${wp_task_id[$name]}")"
    case "$status" in
      success|error)
        wp_status["$name"]="$status"
        semaphore_fill_report_from_output "$name" "${wp_project_id[$name]}" "${wp_task_id[$name]}"
        if [ "$status" = "success" ]; then
          logger -t nightly-worker-wake "${name}: Update erfolgreich (Task ${wp_task_id[$name]})"
        else
          wp_reason["$name"]="Semaphore-Task endete mit Status 'error'"
          logger -t nightly-worker-wake "WARNUNG: ${name}: Update-Task endete mit Status 'error'"
        fi
        ;;
      stopped)
        wp_status["$name"]="stopped"
        wp_reason["$name"]="Semaphore-Task wurde abgebrochen (Status 'stopped')"
        semaphore_fill_report_from_output "$name" "${wp_project_id[$name]}" "${wp_task_id[$name]}"
        logger -t nightly-worker-wake "WARNUNG: ${name}: Update-Task endete mit Status 'stopped'"
        ;;
      *)
        still_pending+=("$name")
        ;;
    esac
  done
  pending=("${still_pending[@]}")
done

if [ "${#pending[@]}" -gt 0 ]; then
  logger -t nightly-worker-wake "WARNUNG: Zeitbudget erreicht, folgende Updates laufen noch: ${pending[*]} -- breche ab"
  notify "Nightly Worker Update: Zeitbudget erreicht" "Update lief bei ${pending[*]} nach $(( MAX_RUNTIME_SECONDS / 60 )) Minuten noch -- breche Task ab und fahre trotzdem herunter."
  for name in "${pending[@]}"; do
    wp_status["$name"]="stopped"
    wp_reason["$name"]="Zeitbudget (${MAX_RUNTIME_SECONDS}s) erreicht, Update lief noch -- Task abgebrochen"
    semaphore_stop_task "${wp_project_id[$name]}" "${wp_task_id[$name]}"
  done
  sleep "$STOP_GRACE_SECONDS"
  for name in "${pending[@]}"; do
    semaphore_fill_report_from_output "$name" "${wp_project_id[$name]}" "${wp_task_id[$name]}"
  done
fi

logger -t nightly-worker-wake "update phase done, shutting down"
notify "Nightly Worker Update abgeschlossen" "Updates fertig, Worker fahren jetzt herunter."
