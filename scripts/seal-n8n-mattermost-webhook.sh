#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
values="$repo_root/argocd/apps/tech/n8n/values.yaml"

[[ -f "$values" ]] || { echo "Fehler: $values fehlt" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }
grep -qE '^  encryptedWebhookUrl: ' "$values" || { echo "Fehler: secrets.encryptedWebhookUrl fehlt in $values" >&2; exit 1; }

read -rp "Mattermost Incoming-Webhook-URL (Team Capulus-Core, Channel News): " webhook_url
[[ -n "$webhook_url" ]] || { echo "Fehler: leere URL" >&2; exit 1; }
if [[ "$webhook_url" == *[\;\"[:space:]]* ]]; then
  echo "Fehler: die URL darf kein ; kein \" und kein Leerzeichen enthalten" >&2
  exit 1
fi

sealed="$(printf '%s' "$webhook_url" | kubeseal --raw \
  --namespace n8n --name n8n-mattermost \
  --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
  --from-file=/dev/stdin)"
unset webhook_url
[[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts" >&2; exit 1; }

sed -i -E "s|^(  encryptedWebhookUrl: \").*(\")\$|\1${sealed}\2|" "$values"
echo "versiegelt: ${values#"$repo_root"/}"
