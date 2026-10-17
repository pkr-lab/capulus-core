#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
creds="${NTFY_CREDENTIALS:-$HOME/ntfy-credentials-2026-10-17.txt}"

[[ -f "$creds" ]] || { echo "Fehler: $creds fehlt" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }

read_token() {
  local value
  value="$(sed -n "s/^$1=//p" "$creds" | head -n 1)"
  [[ "$value" =~ ^tk_[A-Za-z0-9]+$ ]] || { echo "Fehler: $1 in $creds fehlt oder hat falsches Format" >&2; exit 1; }
  printf '%s' "$value"
}

seal_into() {
  local token="$1" namespace="$2" name="$3" values="$4" sealed
  [[ -f "$values" ]] || { echo "Fehler: $values fehlt" >&2; exit 1; }
  grep -qE '^  ntfyToken:$' "$values" || { echo "Fehler: Block ntfyToken fehlt in $values" >&2; exit 1; }
  sealed="$(printf '%s' "$token" | kubeseal --raw \
    --namespace "$namespace" --name "$name" \
    --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
    --from-file=/dev/stdin)"
  [[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts fuer $name" >&2; exit 1; }
  sed -i -E "/^  ntfyToken:\$/,/^    encryptedData:/{s|^(    enabled: ).*|\1true|;s|^(    encryptedData: ).*|\1\"${sealed}\"|}" "$values"
  echo "versiegelt: ${values#"$repo_root"/}"
}

publisher="$(read_token publisher_token)"
reader="$(read_token reader_token)"

seal_into "$publisher" ntfy-bridge ntfy-bridge-ntfy-token "$repo_root/argocd/apps/tech/ntfy-bridge/values.yaml"
seal_into "$publisher" alamos-apager alamos-apager-ntfy-token "$repo_root/argocd/apps/tech/alamos-apager/values.yaml"
seal_into "$reader" carplay-api carplay-api-ntfy-token "$repo_root/argocd/apps/tech/carplay-api/values.yaml"
