#!/usr/bin/env bash
# Erzeugt einen API-Token fuer das ArgoCD-Konto `ci` (Nur-Lese-Rolle) und legt ihn direkt als
# GitHub-Repo-Secret ab - der Token wird nicht ausgegeben und nirgends gespeichert.
# Gebraucht von der Promotion-Kette (.github/workflows/promote-chain.yml),
# Beschreibung: docs/f-cicd-automatisierung/f00b0-promotion-chain.md#einrichtung
#
#   scripts/create-argocd-ci-token.sh hub    -> Secret ARGOCD_HUB_TOKEN   (ArgoCD auf dem Homeserver: TECH + PROD)
#   scripts/create-argocd-ci-token.sh entw   -> Secret ARGOCD_ENTW_TOKEN  (eigene ArgoCD-Instanz auf entw-vm)
#
# Voraussetzung: das Konto `ci` existiert (Ansible-Rolle argocd, `argocd_ci_account_enabled: true`, einmal
# `make argocd` bzw. `ansible-playbook ansible/entw.yml --tags argocd`), `gh` ist als Repo-Admin angemeldet,
# und das Admin-Passwort ist ueber das Secret argocd-initial-admin-secret lesbar - sonst ARGOCD_ADMIN_PASSWORD setzen.
# TOKEN_TTL_DAYS (Standard 365) begrenzt die Laufzeit; alte Token bleiben bis zum Ablauf gueltig.
set -euo pipefail

target=${1:-}
case "$target" in
  hub)
    url=http://192.168.178.94:30080
    secret=ARGOCD_HUB_TOKEN
    admin_pw() { kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; }
    ;;
  entw)
    url=http://192.168.178.100:30080
    secret=ARGOCD_ENTW_TOKEN
    admin_pw() {
      ssh -o BatchMode=yes ubuntu@192.168.178.100 \
        "sudo k3s kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}'" | base64 -d
    }
    ;;
  *)
    echo "Aufruf: $0 hub|entw" >&2
    exit 2
    ;;
esac

pw=${ARGOCD_ADMIN_PASSWORD:-$(admin_pw)}
session=$(curl -fsS -m 15 -X POST "$url/api/v1/session" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$pw" '{username: "admin", password: $p}')" | jq -r .token)
unset pw

if ! curl -fsS -m 15 -H "Authorization: Bearer $session" "$url/api/v1/account/ci" >/dev/null 2>&1; then
  echo "Das ArgoCD-Konto 'ci' existiert auf $target noch nicht. Erst die Rolle ausrollen (argocd_ci_account_enabled: true)." >&2
  exit 1
fi

ttl=$(( ${TOKEN_TTL_DAYS:-365} * 86400 ))
token=$(curl -fsS -m 15 -X POST "$url/api/v1/account/ci/token" -H "Authorization: Bearer $session" \
  -H 'Content-Type: application/json' -d "{\"expiresIn\": $ttl}" | jq -r .token)
unset session

printf '%s' "$token" | gh secret set "$secret"
unset token
echo "Secret $secret gesetzt (Konto ci, ${TOKEN_TTL_DAYS:-365} Tage gueltig)."
