#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
garage_values="$repo_root/argocd/apps/tech/garage/values.yaml"
argo_values="$repo_root/argocd/apps/tech/argo-workflows/values.yaml"

command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }
command -v openssl >/dev/null || { echo "Fehler: openssl nicht gefunden" >&2; exit 1; }

seal() {
  local value="$1" namespace="$2" name="$3" sealed
  sealed="$(printf '%s' "$value" | kubeseal --raw \
    --namespace "$namespace" --name "$name" \
    --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
    --from-file=/dev/stdin)"
  [[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts fuer $namespace/$name" >&2; exit 1; }
  printf '%s' "$sealed"
}

set_value() {
  local file="$1" key="$2" value="$3"
  grep -qE "^  ${key}:" "$file" || { echo "Fehler: ${key} fehlt in $file" >&2; exit 1; }
  sed -i -E "s|^(  ${key}: ).*|\1\"${value}\"|" "$file"
}

rpc_secret="$(openssl rand -hex 32)"
access_key="GK$(openssl rand -hex 12)"
secret_key="$(openssl rand -hex 32)"

set_value "$garage_values" encryptedRpcSecret "$(seal "$rpc_secret" garage garage-secrets)"
set_value "$garage_values" encryptedAccessKey "$(seal "$access_key" garage garage-secrets)"
set_value "$garage_values" encryptedSecretKey "$(seal "$secret_key" garage garage-secrets)"
set_value "$argo_values" encryptedAccessKey "$(seal "$access_key" argo-workflows argo-artifacts-s3)"
set_value "$argo_values" encryptedSecretKey "$(seal "$secret_key" argo-workflows argo-artifacts-s3)"

echo "versiegelt: ${garage_values#"$repo_root"/}, ${argo_values#"$repo_root"/}"
echo "Access-Key-ID: $access_key"
