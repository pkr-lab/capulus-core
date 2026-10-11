#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
values="${VALUES_FILE:-$repo_root/argocd/apps/tech/alert-caller/values.yaml}"

[[ -f "$values" ]] || { echo "Fehler: $values fehlt" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }
grep -qE '^    SIP_PASSWORD: "' "$values" || { echo "Fehler: Schluessel SIP_PASSWORD fehlt in $values" >&2; exit 1; }

read -rsp "Passwort des Linphone-Kontos capulus-core: " password
echo
[[ -n "$password" ]] || { echo "Fehler: leeres Passwort" >&2; exit 1; }
if [[ "$password" == *[\;\"[:space:]]* ]]; then
  echo "Fehler: das Passwort darf kein ; kein \" und kein Leerzeichen enthalten" >&2
  exit 1
fi

sealed="$(printf '%s' "$password" | kubeseal --raw \
  --namespace alert-caller --name alert-caller-secrets \
  --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
  --from-file=/dev/stdin)"
unset password
[[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts" >&2; exit 1; }

sed -i -E "s|^(    SIP_PASSWORD: \")[^\"]*(\")|\1${sealed}\2|" "$values"
echo "versiegelt: ${values#"$repo_root"/}"
