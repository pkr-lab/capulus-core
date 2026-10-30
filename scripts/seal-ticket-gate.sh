#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
creds="${TICKET_GATE_CREDENTIALS:-$HOME/ticket-gate-credentials-2026-10-30.txt}"
values="$repo_root/argocd/apps/tech/ticket-gate/values.yaml"

[[ -f "$creds" ]] || { echo "Fehler: $creds fehlt" >&2; exit 1; }
[[ -f "$values" ]] || { echo "Fehler: $values fehlt" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }
command -v openssl >/dev/null || { echo "Fehler: openssl nicht gefunden" >&2; exit 1; }

read_value() {
  local value
  value="$(sed -n "s/^$1=//p" "$creds" | head -n 1)"
  [[ -n "$value" ]] || { echo "Fehler: $1 in $creds fehlt" >&2; exit 1; }
  printf '%s' "$value"
}

seal() {
  local sealed
  sealed="$(printf '%s' "$1" | kubeseal --raw \
    --namespace ticket-gate --name ticket-gate-secrets \
    --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
    --from-file=/dev/stdin)"
  [[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts" >&2; exit 1; }
  printf '%s' "$sealed"
}

hmac_secret="${TICKET_GATE_HMAC_SECRET:-$(openssl rand -hex 32)}"
smtp_password="$(read_value smtp_password)"
zammad_token="$(read_value zammad_token)"

hmac_sealed="$(seal "$hmac_secret")"
smtp_sealed="$(seal "$smtp_password")"
zammad_sealed="$(seal "$zammad_token")"

sed -i -E \
  -e "/^secrets:\$/,/^[a-z]/{s|^(  enabled: ).*|\1true|;s|^(  encryptedHmacSecret: ).*|\1\"${hmac_sealed}\"|;s|^(  encryptedSmtpPassword: ).*|\1\"${smtp_sealed}\"|;s|^(  encryptedZammadToken: ).*|\1\"${zammad_sealed}\"|}" \
  "$values"

echo "versiegelt: ${values#"$repo_root"/}"
