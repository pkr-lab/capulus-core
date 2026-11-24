#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plaudi_values="$repo_root/argocd/apps/prod/plaudi/values.yaml"
gate_values="$repo_root/argocd/apps/tech/ticket-gate/values.yaml"
prod_cert="${PROD_SEALED_CERT:-$HOME/prod-sealed-secrets.pem}"

[[ -f "$plaudi_values" ]] || { echo "Fehler: $plaudi_values fehlt" >&2; exit 1; }
[[ -f "$gate_values" ]] || { echo "Fehler: $gate_values fehlt" >&2; exit 1; }
[[ -s "$prod_cert" ]] || { echo "Fehler: PROD-Zertifikat $prod_cert fehlt" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }
command -v openssl >/dev/null || { echo "Fehler: openssl nicht gefunden" >&2; exit 1; }

echo "kubectl-Kontext (muss TECH sein): $(kubectl config current-context)" >&2

ask() {
  local name="$1" value="${!1:-}"
  if [[ -z "$value" ]]; then
    read -rsp "$name: " value
    echo >&2
  fi
  [[ -n "$value" ]] || { echo "Fehler: $name ist leer" >&2; exit 1; }
  printf '%s' "$value"
}

seal_prod() {
  local sealed
  sealed="$(printf '%s' "$1" | kubeseal --raw --cert "$prod_cert" \
    --namespace plaudi --name plaudi-secrets --from-file=/dev/stdin)"
  [[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts (PROD)" >&2; exit 1; }
  printf '%s' "$sealed"
}

seal_tech() {
  local sealed
  sealed="$(printf '%s' "$1" | kubeseal --raw \
    --namespace ticket-gate --name ticket-gate-secrets \
    --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
    --from-file=/dev/stdin)"
  [[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts (TECH)" >&2; exit 1; }
  printf '%s' "$sealed"
}

api_key="$(ask API_KEY)"
admin_email="$(ask ADMIN_EMAIL | tr 'A-Z' 'a-z')"
[[ "$admin_email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$ ]] || { echo "Fehler: ADMIN_EMAIL ist keine Adresse" >&2; exit 1; }
relay_token="${MAIL_RELAY_TOKEN:-$(openssl rand -hex 32)}"

api_key_sealed="$(seal_prod "$api_key")"
admin_email_sealed="$(seal_prod "$admin_email")"
webhook_token_sealed="$(seal_prod "$relay_token")"
relay_token_sealed="$(seal_tech "$relay_token")"

sed -i -E \
  -e "s|^(    API_KEY: \")[^\"]*(\")|\1${api_key_sealed}\2|" \
  -e "s|^(    ADMIN_EMAIL: \")[^\"]*(\")|\1${admin_email_sealed}\2|" \
  -e "s|^(    MAIL_WEBHOOK_TOKEN: \")[^\"]*(\")|\1${webhook_token_sealed}\2|" \
  -e "/^secrets:\$/,/^[a-z]/{s|^(  enabled: ).*|\1true|}" \
  -e "s|^(replicaCount: ).*|\11|" \
  "$plaudi_values"

sed -i -E "s|^(  encryptedRelayToken: \")[^\"]*(\")|\1${relay_token_sealed}\2|" "$gate_values"

echo "versiegelt: ${plaudi_values#"$repo_root"/}"
echo "versiegelt: ${gate_values#"$repo_root"/}"
