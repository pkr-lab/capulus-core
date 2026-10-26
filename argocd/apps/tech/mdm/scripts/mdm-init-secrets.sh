#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

need openssl kubeseal python3
ca_only=0
[[ "${1:-}" == "--ca-only" ]] && ca_only=1

umask 077
ca_dir="$mdm_state_dir/scep-ca"

new_ca() {
  mkdir -p "$ca_dir"
  openssl genrsa -traditional -out "$ca_dir/ca.key" 4096 2>/dev/null
  openssl req -x509 -new -sha256 -days 7300 -key "$ca_dir/ca.key" \
    -subj "/O=Capulus MDM/CN=Capulus MDM SCEP CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,digitalSignature,keyCertSign,cRLSign" \
    -out "$ca_dir/ca.pem"
  values_edit sealed scepCa "ca.key=$(seal mdm-scep-ca "$(cat "$ca_dir/ca.key")")"
  values_edit capem "$ca_dir/ca.pem"
}

if [[ $ca_only -eq 1 ]]; then
  [[ -d "$ca_dir" ]] || fail "$ca_dir fehlt"
  mv "$ca_dir" "$ca_dir.alt-$(date +%Y%m%d%H%M%S)"
  new_ca
  echo "Neue SCEP-CA erzeugt und versiegelt. Die alte CA liegt als $ca_dir.alt-*"
  echo "Alle iPads muessen neu enrollt werden, danach das Enrollment-Profil neu versiegeln (mdm-enrollment-profile.sh)."
  exit 0
fi

[[ ! -e "$mdm_credentials" ]] || fail "$mdm_credentials existiert bereits, nichts wird ueberschrieben"

rand() { openssl rand -hex "$1"; }

postgres_password="$(rand 24)"
nanomdm_db_password="$(rand 24)"
nanodep_db_password="$(rand 24)"
automation_db_password="$(rand 24)"
nanomdm_api_key="$(rand 32)"
nanodep_api_key="$(rand 32)"
scep_challenge="$(rand 16)"
webhook_token="$(rand 16)"
restic_password="$(rand 32)"

values_edit sealed main \
  "postgres-password=$(seal mdm-secrets "$postgres_password")" \
  "nanomdm-db-password=$(seal mdm-secrets "$nanomdm_db_password")" \
  "nanodep-db-password=$(seal mdm-secrets "$nanodep_db_password")" \
  "automation-db-password=$(seal mdm-secrets "$automation_db_password")" \
  "nanomdm-api-key=$(seal mdm-secrets "$nanomdm_api_key")" \
  "nanodep-api-key=$(seal mdm-secrets "$nanodep_api_key")" \
  "scep-challenge=$(seal mdm-secrets "$scep_challenge")" \
  "webhook-token=$(seal mdm-secrets "$webhook_token")" \
  "restic-password=$(seal mdm-secrets "$restic_password")"
new_ca

cat > "$mdm_credentials" <<EOF
postgres-password=$postgres_password
nanomdm-db-password=$nanomdm_db_password
nanodep-db-password=$nanodep_db_password
automation-db-password=$automation_db_password
nanomdm-api-key=$nanomdm_api_key
nanodep-api-key=$nanodep_api_key
scep-challenge=$scep_challenge
webhook-token=$webhook_token
restic-password=$restic_password
EOF

echo "versiegelt in: $mdm_values"
echo "Zugangsdaten (nur lokal, in den Passwortmanager legen): $mdm_credentials"
echo "SCEP-CA-Schluessel und -Zertifikat (sichern!): $ca_dir"
echo "Ohne restic-password sind alle Backups unlesbar, ohne ca.key muessen alle iPads neu enrollen."
