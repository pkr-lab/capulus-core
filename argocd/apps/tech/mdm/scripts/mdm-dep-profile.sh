#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

need kubectl curl jq
dep_name="${DEP_NAME:-$(sed -n 's/^  depName: //p' "$mdm_values" | head -n 1)}"
public_host="$(values_get publicHost)"
api_key="$(credential_get nanodep-api-key)"
profile="${1:-$mdm_chart_dir/profiles/dep-enrollment-profile.json}"
[[ -f "$profile" ]] || fail "$profile nicht gefunden"

portforward_start mdm-depserver 19001 9001
body="$(sed "s|__ENROLL_URL__|https://$public_host/mdm/enroll|" "$profile")"
response="$(printf '%s' "$body" | curl -fsS -u "depserver:$api_key" -X POST \
  -H 'Content-Type: application/json;charset=UTF8' -A 'capulus-mdm/0' \
  --data-binary @- "http://127.0.0.1:19001/proxy/$dep_name/profile")"
profile_uuid="$(printf '%s' "$response" | jq -r '.profile_uuid')"
[[ -n "$profile_uuid" && "$profile_uuid" != "null" ]] || fail "kein profile_uuid in Antwort: $response"
curl -fsS -u "depserver:$api_key" -X PUT \
  "http://127.0.0.1:19001/v1/assigner/$dep_name?profile_uuid=$profile_uuid" >/dev/null
echo "DEP-Profil $profile_uuid definiert und als Assigner gesetzt"
