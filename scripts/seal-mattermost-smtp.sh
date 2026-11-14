#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
values="$repo_root/argocd/apps/tech/mattermost/values.yaml"

[[ -f "$values" ]] || { echo "Fehler: $values fehlt" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }

password="${MATTERMOST_SMTP_PASSWORD:-}"
if [[ -z "$password" ]]; then
  read -r -s -p "SMTP-Passwort fuer info@pkr-service.de: " password
  echo
fi
[[ -n "$password" ]] || { echo "Fehler: kein Passwort angegeben" >&2; exit 1; }

sealed="$(printf '%s' "$password" | kubeseal --raw \
  --namespace mattermost --name mattermost-secrets \
  --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
  --from-file=/dev/stdin)"
[[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts" >&2; exit 1; }

grep -q '^  encryptedSmtpPassword: ' "$values" || { echo "Fehler: encryptedSmtpPassword fehlt in $values" >&2; exit 1; }

python3 - "$values" "$sealed" <<'PY'
import re
import sys

path, sealed = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    text = fh.read()
text = re.sub(r'^(  encryptedSmtpPassword: ).*$', lambda m: m.group(1) + '"' + sealed + '"', text, flags=re.M)
with open(path, "w", encoding="utf-8") as fh:
    fh.write(text)
PY

echo "versiegelt: ${values#"$repo_root"/}"
