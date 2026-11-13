#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
values="$repo_root/argocd/apps/tech/mattermost/values.yaml"

[[ -f "$values" ]] || { echo "Fehler: $values fehlt" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }
command -v openssl >/dev/null || { echo "Fehler: openssl nicht gefunden" >&2; exit 1; }

password="${MATTERMOST_DB_PASSWORD:-$(openssl rand -base64 32 | tr -d '=+/' | head -c 32)}"
datasource="postgres://mattermost:${password}@mattermost-postgresql:5432/mattermost?sslmode=disable&connect_timeout=10"

seal() {
  local sealed
  sealed="$(printf '%s' "$1" | kubeseal --raw \
    --namespace mattermost --name mattermost-secrets \
    --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
    --from-file=/dev/stdin)"
  [[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts" >&2; exit 1; }
  printf '%s' "$sealed"
}

datasource_sealed="$(seal "$datasource")"
password_sealed="$(seal "$password")"

sed -i -E \
  -e "s|^(  encryptedDatasource: \").*(\")\$|\1${datasource_sealed}\2|" \
  -e "s|^(  encryptedPostgresPassword: \").*(\")\$|\1${password_sealed}\2|" \
  "$values"

echo "versiegelt: ${values#"$repo_root"/}"
echo
echo "Datenbank-Passwort (nur jetzt sichtbar, fuer ansible-vault encrypt_string in capulus-ansible):"
echo "$password"
