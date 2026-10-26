#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

need kubectl curl
dep_name="${DEP_NAME:-$(sed -n 's/^  depName: //p' "$mdm_values" | head -n 1)}"
[[ -n "$dep_name" ]] || fail "depName fehlt in $mdm_values"
validity_days="${1:-365}"
common_name="${2:-depserver}"
api_key="$(credential_get nanodep-api-key)"

umask 077
mkdir -p "$mdm_apple_dir"
out="$mdm_apple_dir/dep-public-cert.pem"
[[ ! -e "$out" ]] || fail "$out existiert bereits (wegsichern, wenn ein neues Schluesselpaar noetig ist)"

portforward_start mdm-depserver 19001 9001
curl -fsS -u "depserver:$api_key" \
  "http://127.0.0.1:19001/v1/tokenpki/$dep_name?cn=$common_name&validity_days=$validity_days" > "$out"
grep -q 'BEGIN CERTIFICATE' "$out" || { rm -f "$out"; fail "keine Zertifikatsantwort von depserver"; }
echo "Oeffentliches Zertifikat fuer Apple Business: $out"
echo "Der private Schluessel bleibt in der NanoDEP-Datenbank (wird mit gesichert)."
