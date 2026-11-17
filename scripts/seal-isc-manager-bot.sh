#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
values="$repo_root/argocd/apps/tech/isc-manager-bot/values.yaml"
namespace="isc-manager-bot"
secret_name="isc-manager-bot-secrets"

[[ -f "$values" ]] || { echo "Fehler: $values fehlt" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }
command -v openssl >/dev/null || { echo "Fehler: openssl nicht gefunden" >&2; exit 1; }

ask() {
  local name="$1" value="${!1:-}"
  if [[ -z "$value" ]]; then
    read -rsp "$name: " value
    echo >&2
  fi
  [[ -n "$value" ]] || { echo "Fehler: $name ist leer" >&2; exit 1; }
  printf '%s' "$value"
}

seal() {
  local sealed
  sealed="$(printf '%s' "$2" | kubeseal --raw \
    --namespace "$namespace" --name "$secret_name" \
    --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
    --from-file=/dev/stdin)"
  [[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts fuer $1" >&2; exit 1; }
  sed -i -E "s|^(    $1: \")[^\"]*(\")|\1${sealed}\2|" "$values"
}

totp="$(ask SEWOBE_TOTP_SECRET | tr -d ' -' | tr 'a-z' 'A-Z')"
[[ "$totp" =~ ^[A-Z2-7]{16,}=*$ ]] || { echo "Fehler: SEWOBE_TOTP_SECRET ist kein Base32-Secret" >&2; exit 1; }

api_token="${API_TOKEN:-$(openssl rand -hex 32)}"

seal ISC_USERNAME "$(ask ISC_USERNAME)"
seal ISC_PASSWORD "$(ask ISC_PASSWORD)"
seal SEWOBE_USERNAME "$(ask SEWOBE_USERNAME)"
seal SEWOBE_PASSWORD "$(ask SEWOBE_PASSWORD)"
seal SEWOBE_TOTP_SECRET "$totp"
seal API_TOKEN "$api_token"

sed -i -E "s|^(  enabled: ).*|\1true|; s|^(replicaCount: ).*|\11|" "$values"

echo "versiegelt: ${values#"$repo_root"/}"
echo "API_TOKEN fuer das n8n-Credential 'ISC-Manager-Bot API-Token' (Header Authorization: Bearer <Token>): $api_token"
