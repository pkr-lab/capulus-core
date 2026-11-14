#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
values="$repo_root/argocd/apps/tech/github-release-watcher/values.yaml"

[[ -f "$values" ]] || { echo "Fehler: $values fehlt" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }

token="${MATTERMOST_BOT_TOKEN:-}"
if [[ -z "$token" ]]; then
  read -r -s -p "Access-Token des Mattermost-Bots n8n-bot: " token
  echo
fi
[[ -n "$token" ]] || { echo "Fehler: kein Token angegeben" >&2; exit 1; }

sealed="$(printf '%s' "$token" | kubeseal --raw \
  --namespace github-release-watcher --name github-release-watcher-mattermost-token \
  --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
  --from-file=/dev/stdin)"
[[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts" >&2; exit 1; }

python3 - "$values" "$sealed" <<'PY'
import re
import sys

path, sealed = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    text = fh.read()
pattern = r'(^mattermost:\n(?:  .*\n)*?  encryptedToken: ).*$'
text, count = re.subn(pattern, lambda m: m.group(1) + '"' + sealed + '"', text, count=1, flags=re.M)
if count != 1:
    sys.exit("Fehler: mattermost.encryptedToken nicht gefunden")
with open(path, "w", encoding="utf-8") as fh:
    fh.write(text)
PY

echo "versiegelt: ${values#"$repo_root"/}"
