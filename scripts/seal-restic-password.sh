#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="${1:-vaultwarden}"
values="$repo_root/argocd/apps/tech/$app/values.yaml"

[[ -f "$values" ]] || { echo "Fehler: $values nicht gefunden (Aufruf: $0 [vaultwarden|n8n])" >&2; exit 1; }

command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }
command -v openssl >/dev/null || { echo "Fehler: openssl nicht gefunden" >&2; exit 1; }
grep -qE '^  encryptedPassword: ' "$values" || { echo "Fehler: resticBackup.encryptedPassword fehlt in $values" >&2; exit 1; }

read -rsp "Repository-Passwort (leer = zufällig erzeugen und einmal anzeigen): " password
echo
generated=0
if [[ -z "$password" ]]; then
  password="$(openssl rand -hex 32)"
  generated=1
fi

sealed="$(printf '%s' "$password" | kubeseal --raw \
  --namespace "$app" --name "$app-restic" \
  --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
  --from-file=/dev/stdin)"
[[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts" >&2; exit 1; }

sed -i -E "/^resticBackup:/,/^  encryptedPassword:/{s|^(  enabled: ).*|\1true|;s|^(  encryptedPassword: ).*|\1\"${sealed}\"|}" "$values"
echo "versiegelt: ${values#"$repo_root"/}"

if [[ $generated -eq 1 ]]; then
  echo
  echo "Repository-Passwort (nur jetzt sichtbar, in den Passwortmanager legen):"
  echo "$password"
fi
echo
echo "Ohne dieses Passwort sind alle restic-Snapshots unlesbar. Es gehört nicht in Git und wird nicht routinemäßig gewechselt."
unset password
