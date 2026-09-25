#!/usr/bin/env bash
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
