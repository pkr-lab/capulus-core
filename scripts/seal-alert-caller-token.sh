#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
creds="${ALERT_CALLER_CREDENTIALS:-$HOME/alert-caller-token-2026-10-17.txt}"
caller_values="$repo_root/argocd/apps/tech/alert-caller/values.yaml"
monitoring_values="$repo_root/argocd/apps/tech/monitoring/values.yaml"

[[ -f "$creds" ]] || { echo "Fehler: $creds fehlt" >&2; exit 1; }
[[ -f "$caller_values" && -f "$monitoring_values" ]] || { echo "Fehler: values.yaml fehlt" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }

token="$(sed -n 's/^alert_caller_token=//p' "$creds" | head -n 1)"
[[ "$token" =~ ^[0-9a-f]{64}$ ]] || { echo "Fehler: alert_caller_token in $creds fehlt oder hat falsches Format" >&2; exit 1; }
grep -qE '^    SIP_PASSWORD: "' "$caller_values" || { echo "Fehler: Schluessel SIP_PASSWORD fehlt in $caller_values" >&2; exit 1; }
grep -qE '^alertCallerToken:$' "$monitoring_values" || { echo "Fehler: Block alertCallerToken fehlt in $monitoring_values" >&2; exit 1; }

seal() {
  local sealed
  sealed="$(printf '%s' "$token" | kubeseal --raw \
    --namespace "$1" --name "$2" \
    --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
    --from-file=/dev/stdin)"
  [[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts fuer $2" >&2; exit 1; }
  printf '%s' "$sealed"
}

caller_sealed="$(seal alert-caller alert-caller-secrets)"
monitoring_sealed="$(seal monitoring alert-caller-token)"

if grep -qE '^    ALERT_CALLER_TOKEN: "' "$caller_values"; then
  sed -i -E "s|^(    ALERT_CALLER_TOKEN: \")[^\"]*(\")|\1${caller_sealed}\2|" "$caller_values"
else
  sed -i -E "/^    SIP_PASSWORD: \"/a\\    ALERT_CALLER_TOKEN: \"${caller_sealed}\"" "$caller_values"
fi
sed -i -E "/^alertCallerToken:\$/,/^  encryptedData:/{s|^(  enabled: ).*|\1true|;s|^(  encryptedData: ).*|\1\"${monitoring_sealed}\"|}" "$monitoring_values"

echo "versiegelt: ${caller_values#"$repo_root"/}"
echo "versiegelt: ${monitoring_values#"$repo_root"/}"
