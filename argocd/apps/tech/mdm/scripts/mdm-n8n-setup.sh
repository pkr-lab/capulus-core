#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  echo "Aufruf: N8N_API_KEY=... $0 [--activate] [--dry-run] [--no-credentials]" >&2
  echo "Umgebungsvariablen: N8N_URL (Standard https://n8n.prod.homeserver), N8N_WORKFLOWS_DIR, N8N_INSECURE=1 (curl -k), N8N_ACTIVATE_MATCH (Regex auf den Workflow-Namen, Standard .*)" >&2
  exit 1
}

activate=0
dry_run=0
manage_credentials=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --activate) activate=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --no-credentials) manage_credentials=0; shift ;;
    *) usage ;;
  esac
done

need curl jq openssl
[[ -n "${N8N_API_KEY:-}" ]] || fail "N8N_API_KEY ist nicht gesetzt (n8n: Einstellungen > n8n API)"
n8n_url="${N8N_URL:-https://n8n.prod.homeserver}"
workflows_dir="${N8N_WORKFLOWS_DIR:-$mdm_chart_dir/../n8n/workflows}"
curl_opts=(-sS)
[[ "${N8N_INSECURE:-0}" == "1" ]] && curl_opts+=(-k)

api() {
  local method="$1" path="$2"
  shift 2
  curl "${curl_opts[@]}" -X "$method" -H "X-N8N-API-KEY: $N8N_API_KEY" -H 'Content-Type: application/json' "$n8n_url/api/v1$path" "$@"
}

db_password="$(credential_get automation-db-password)"
nanomdm_key="$(credential_get nanomdm-api-key)"
nanodep_key="$(credential_get nanodep-api-key)"
webhook_token="$(credential_get webhook-token)"
db_host="${MDM_DB_HOST:-mdm-postgres.$mdm_namespace.svc.cluster.local}"
if [[ $manage_credentials -eq 1 ]]; then
  if ! grep -q '^form-password=' "$mdm_credentials"; then
    printf 'form-password=%s\n' "$(openssl rand -hex 16)" >> "$mdm_credentials"
  fi
  form_password="$(credential_get form-password)"
fi

existing="$(api GET '/credentials?limit=250' | jq -c '.data // []')"
credential_id() {
  printf '%s' "$existing" | jq -r --arg name "$1" '[.[] | select(.name == $name)][0].id // empty'
}

ensure_credential() {
  local name="$1" type="$2" data="$3" id
  id="$(credential_id "$name")"
  if [[ -n "$id" ]]; then
    echo "Credential vorhanden: $name ($id)"
    return 0
  fi
  if [[ $dry_run -eq 1 ]]; then
    echo "Credential wuerde angelegt: $name"
    return 0
  fi
  id="$(api POST /credentials --data "$(jq -n --arg name "$name" --arg type "$type" --argjson data "$data" '{name: $name, type: $type, data: $data}')" | jq -r '.id // empty')"
  [[ -n "$id" ]] || fail "Credential $name konnte nicht angelegt werden"
  existing="$(printf '%s' "$existing" | jq -c --arg id "$id" --arg name "$name" '. + [{id: $id, name: $name}]')"
  echo "Credential angelegt: $name ($id)"
}

if [[ $manage_credentials -eq 1 ]]; then
  ensure_credential "MDM NanoMDM API" httpBasicAuth "$(jq -n --arg p "$nanomdm_key" '{user: "nanomdm", password: $p, allowedHttpRequestDomains: "all"}')"
  ensure_credential "MDM NanoDEP API" httpBasicAuth "$(jq -n --arg p "$nanodep_key" '{user: "depserver", password: $p, allowedHttpRequestDomains: "all"}')"
  ensure_credential "MDM Formulare" httpBasicAuth "$(jq -n --arg p "$form_password" '{user: "mdm-admin", password: $p, allowedHttpRequestDomains: "all"}')"
  ensure_credential "MDM Automation DB" postgres "$(jq -n --arg h "$db_host" --arg p "$db_password" '{host: $h, database: "nanomdm", user: "mdmauto", password: $p, port: 5432, ssl: "disable", maxConnections: 5, allowUnauthorizedCerts: false, sshTunnel: false}')"
fi

current="$(api GET '/workflows?limit=250' | jq -c '.data // []')"
shopt -s nullglob
for file in "$workflows_dir"/mdm-*.json; do
  name="$(jq -r '.name' "$file")"
  body="$(sed "s|__WEBHOOK_TOKEN__|$webhook_token|g" "$file")"
  missing=""
  while IFS= read -r cname; do
    cid="$(credential_id "$cname")"
    if [[ -z "$cid" ]]; then
      missing="$missing $cname"
      continue
    fi
    body="$(printf '%s' "$body" | jq -c --arg name "$cname" --arg id "$cid" '(.nodes[] | select(.credentials != null) | .credentials[] | select(.name == $name)).id = $id')"
  done < <(printf '%s' "$body" | jq -r '[.nodes[].credentials // {} | .[] | .name] | unique[]')
  [[ -z "$missing" ]] || echo "Hinweis: Credential(s) fehlen in n8n und muessen nach dem Import zugewiesen werden:$missing"
  payload="$(printf '%s' "$body" | jq -c '{name, nodes, connections, settings: {executionOrder: (.settings.executionOrder // "v1"), timezone: (.settings.timezone // "Europe/Berlin")}}')"
  id="$(printf '%s' "$current" | jq -r --arg name "$name" '[.[] | select(.name == $name)][0].id // empty')"
  if [[ $dry_run -eq 1 ]]; then
    if [[ -n "$id" ]]; then
      echo "Workflow wuerde aktualisiert: $name"
    else
      echo "Workflow wuerde angelegt: $name"
    fi
    continue
  fi
  if [[ -n "$id" ]]; then
    api PUT "/workflows/$id" --data "$payload" >/dev/null
    echo "Workflow aktualisiert: $name ($id)"
  else
    id="$(api POST /workflows --data "$payload" | jq -r '.id // empty')"
    [[ -n "$id" ]] || fail "Workflow $name konnte nicht importiert werden"
    echo "Workflow importiert: $name ($id)"
  fi
  if [[ $activate -eq 1 && "$name" =~ ${N8N_ACTIVATE_MATCH:-.*} ]]; then
    api POST "/workflows/$id/activate" >/dev/null
    echo "Workflow aktiviert: $name"
  fi
done

if [[ $manage_credentials -eq 1 ]]; then
    echo "Formular-Zugang (Basic Auth): Benutzer mdm-admin, Passwort in $mdm_credentials (form-password)"
fi
