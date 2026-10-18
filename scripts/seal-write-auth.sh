#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${WRITE_AUTH_VAULT_OUT:-$HOME/write-auth-vault.yml}"

command -v kubeseal >/dev/null || { echo "Fehler: kubeseal nicht gefunden" >&2; exit 1; }
command -v ansible-vault >/dev/null || { echo "Fehler: ansible-vault nicht gefunden" >&2; exit 1; }
command -v openssl >/dev/null || { echo "Fehler: openssl nicht gefunden" >&2; exit 1; }

read -rsp "Vault-Passwort: " vault_pw
echo
umask 077
: > "$out"

htpasswd_line() {
  local user="$1" pw="$2"
  if command -v htpasswd >/dev/null; then
    htpasswd -nbB "$user" "$pw" | tr -d '\n'
  else
    printf '%s:%s' "$user" "$(openssl passwd -apr1 "$pw")"
  fi
}

setup() {
  local label="$1" user="$2" namespace="$3" secret="$4" values="$5" pw users sealed
  [[ -f "$values" ]] || { echo "Fehler: $values fehlt" >&2; exit 1; }
  grep -qE '^  encryptedUsers: ' "$values" || { echo "Fehler: writeAuth.encryptedUsers fehlt in $values" >&2; exit 1; }
  pw="$(openssl rand -hex 24)"
  users="$(htpasswd_line "$user" "$pw")"
  sealed="$(printf '%s' "$users" | kubeseal --raw \
    --namespace "$namespace" --name "$secret" \
    --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
    --from-file=/dev/stdin)"
  [[ -n "$sealed" ]] || { echo "Fehler: kubeseal lieferte nichts fuer $secret" >&2; exit 1; }
  sed -i -E "s|^(  encryptedUsers: ).*|\1\"${sealed}\"|" "$values"
  printf '%s' "$user" | ansible-vault encrypt_string --vault-password-file <(printf '%s' "$vault_pw") --stdin-name "vault_${label}_write_auth_user" >> "$out"
  printf '%s' "$pw" | ansible-vault encrypt_string --vault-password-file <(printf '%s' "$vault_pw") --stdin-name "vault_${label}_write_auth_password" >> "$out"
  echo "versiegelt: ${values#"$repo_root"/}"
}

setup vm vm-writer monitoring vm-write-auth "$repo_root/argocd/apps/tech/monitoring/values.yaml"
setup logs logs-writer logging logs-write-auth "$repo_root/argocd/apps/tech/logging/values.yaml"
unset vault_pw

echo
echo "Fertig. Die verschluesselten Variablen stehen in: $out"
echo "Inhalt in capulus-ansible: group_vars/all.yml einfuegen, danach die Datei loeschen."
echo "Der Schalter writeAuth.enabled bleibt in beiden values.yaml auf false, bis die Hosts die Zugangsdaten haben."
