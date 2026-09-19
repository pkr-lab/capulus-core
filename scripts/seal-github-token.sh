#!/usr/bin/env bash
# Versiegelt ein GitHub-Lese-Token fuer wiki-docs-sync und github-release-watcher und traegt es in die
# Charts ein (hebt das Limit der unangemeldeten GitHub-API von 60 auf 5000 Anfragen pro Stunde).
#
# Das Token wird aus einer Datei gelesen (nie als Argument, nie ausgegeben):
#   TOKEN_FILE (Standard: ~/.github_readonly_token), Modus 600
# Erzeugen: GitHub -> Settings -> Developer settings -> Fine-grained personal access tokens ->
#   "Public repositories (read-only)", keine weiteren Berechtigungen, Ablauf z. B. 1 Jahr. Dann:
#   read -rs T; printf %s "$T" > ~/.github_readonly_token; chmod 600 ~/.github_readonly_token; unset T
#
# Ergebnis (je ein statisches SealedSecret `github-api-token`, Schluessel `token`):
#   argocd/apps/workloads/github-release-watcher/templates/sealedsecret-github-token.yaml  (TECH-Schluessel)
#   argocd/apps/prod/github-release-watcher/templates/sealedsecret-github-token.yaml       (PROD-Schluessel)
#   argocd/apps/prod/wiki-docs-sync/templates/sealedsecret-github-token.yaml               (PROD-Schluessel)
# und setzt in den drei values.yaml `github.tokenSecretName: github-api-token`.
# Voraussetzung: kubectl-Kontext = TECH (fuer das TECH-Zertifikat), ~/prod-sealed-secrets.pem (PROD).
# Test ohne Repo-Aenderung: OUT_ROOT=/tmp/x TOKEN_FILE=/tmp/dummy scripts/seal-github-token.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_root="${OUT_ROOT:-$repo_root}"
token_file="${TOKEN_FILE:-$HOME/.github_readonly_token}"
prod_cert="${PROD_SEALED_CERT:-$HOME/prod-sealed-secrets.pem}"

[[ -s "$token_file" ]] || { echo "Fehler: Token-Datei $token_file fehlt oder ist leer (siehe Kopf des Skripts)" >&2; exit 1; }
[[ -s "$prod_cert" ]] || { echo "Fehler: PROD-Zertifikat $prod_cert fehlt" >&2; exit 1; }
perm="$(stat -c %a "$token_file")"
[[ "$perm" == "600" || "$perm" == "400" ]] || { echo "Fehler: $token_file muss Modus 600 haben (ist $perm)" >&2; exit 1; }

tech_cert="$(mktemp)"
trap 'rm -f "$tech_cert"' EXIT
kubectl config current-context >/dev/null
kubeseal --fetch-cert --controller-name sealed-secrets-controller --controller-namespace sealed-secrets > "$tech_cert"
[[ -s "$tech_cert" ]] || { echo "Fehler: TECH-Zertifikat nicht abrufbar (kubectl-Kontext = TECH?)" >&2; exit 1; }

seal() { # <cert> <namespace> <ausgabedatei> <header>
  local cert="$1" ns="$2" out="$3" hdr="$4"
  mkdir -p "$(dirname "$out")"
  kubectl create secret generic github-api-token --namespace "$ns" \
    --from-file=token="$token_file" --dry-run=client -o json \
    | jq -c '{apiVersion:"v1",kind:"Secret",metadata:{name:.metadata.name,namespace:.metadata.namespace},type:.type,data:.data}' \
    | kubeseal --cert "$cert" --format yaml > "$out.tmp"
  grep -q '^kind: SealedSecret' "$out.tmp" || { rm -f "$out.tmp"; echo "Fehler: kubeseal lieferte kein SealedSecret ($out)" >&2; exit 1; }
  { echo "# $hdr"; echo "# GitHub-Lese-Token (fine-grained, nur oeffentliche Repos), erzeugt mit scripts/seal-github-token.sh."; cat "$out.tmp"; } > "$out"
  rm -f "$out.tmp"
  echo "versiegelt: ${out#"$out_root"/}"
}

seal "$tech_cert" github-release-watcher "$out_root/argocd/apps/workloads/github-release-watcher/templates/sealedsecret-github-token.yaml" "Mit dem TECH-Schluessel versiegelt."
seal "$prod_cert" github-release-watcher "$out_root/argocd/apps/prod/github-release-watcher/templates/sealedsecret-github-token.yaml" "Mit dem PROD-Schluessel versiegelt."
seal "$prod_cert" wiki-docs-sync         "$out_root/argocd/apps/prod/wiki-docs-sync/templates/sealedsecret-github-token.yaml"        "Mit dem PROD-Schluessel versiegelt."

for v in "$out_root/argocd/apps/workloads/github-release-watcher/values.yaml" \
         "$out_root/argocd/apps/prod/github-release-watcher/values.yaml" \
         "$out_root/argocd/apps/prod/wiki-docs-sync/values.yaml"; do
  [[ -f "$v" ]] || { echo "(uebersprungen, keine values.yaml: ${v#"$out_root"/})"; continue; }
  if grep -q '^  tokenSecretName: ""' "$v"; then
    sed -i 's/^  tokenSecretName: ""/  tokenSecretName: "github-api-token"/' "$v"
    echo "values.yaml: github.tokenSecretName gesetzt (${v#"$out_root"/})"
  fi
done
