#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  echo "Aufruf: $0 request <E-Mail-Adresse>" >&2
  echo "        $0 decrypt <Anhang-aus-der-mdmcert-Mail>" >&2
  echo "Umgebungsvariablen: MDMCERT_API_KEY (Pflicht fuer request), MDMCERT_NO_SEND=1 (nur lokal erzeugen)" >&2
  exit 1
}

[[ $# -ge 2 ]] || usage
need openssl curl xxd base64
umask 077
mkdir -p "$mdm_apple_dir/apns"
cd "$mdm_apple_dir/apns"

case "$1" in
  request)
    email="$2"
    for f in push.key push.csr pki.key pki.crt; do
      [[ ! -e "$f" ]] || fail "$PWD/$f existiert bereits (altes Verzeichnis wegsichern, dann erneut ausfuehren)"
    done
    openssl genrsa -out push.key 2048 2>/dev/null
    openssl req -new -key push.key -out push.csr -subj "/C=DE/CN=mdm-push/emailAddress=$email"
    openssl req -x509 -newkey rsa:2048 -nodes -keyout pki.key -out pki.crt -days 365 -subj "/CN=mdmcert.download" 2>/dev/null
    echo "Erzeugt in $PWD: push.key (geheim halten), push.csr, pki.key, pki.crt"
    if [[ "${MDMCERT_NO_SEND:-0}" == "1" ]]; then
      echo "MDMCERT_NO_SEND=1: nichts an mdmcert.download gesendet"
      exit 0
    fi
    [[ -n "${MDMCERT_API_KEY:-}" ]] || fail "MDMCERT_API_KEY ist nicht gesetzt (steht in cmd/mdmctl/mdmcert.download.go im micromdm-Repo)"
    payload="$(printf '{"csr":"%s","email":"%s","key":"%s","encrypt":"%s"}' \
      "$(base64 -w0 < push.csr)" "$email" "$MDMCERT_API_KEY" "$(base64 -w0 < pki.crt)")"
    response="$(printf '%s' "$payload" | curl -sS -X POST -H 'Content-Type: application/json' -H 'User-Agent: capulus-mdm' \
      --data-binary @- https://mdmcert.download/api/v1/signrequest)"
    echo "$response" | grep -q '"result": *"success"' || fail "mdmcert.download antwortete: $response"
    echo "Anfrage gesendet. Die signierte Anfrage kommt per E-Mail an $email, danach: $0 decrypt <Anhang>"
    ;;
  decrypt)
    [[ -f pki.key && -f pki.crt ]] || fail "pki.key/pki.crt fehlen in $PWD (zuerst request ausfuehren)"
    [[ ! -e push.req ]] || fail "$PWD/push.req existiert bereits"
    xxd -r -p "$2" > signed.p7
    openssl smime -decrypt -inform DER -in signed.p7 -inkey pki.key -recip pki.crt -out push.req
    rm -f signed.p7
    echo "Entschluesselt: $PWD/push.req"
    echo "Naechster Schritt: push.req auf https://identity.apple.com hochladen (Create a Certificate), das Zertifikat als push.pem herunterladen."
    echo "Danach push.pem und push.key im n8n-Formular 'MDM Verlaengerung' hochladen."
    ;;
  *)
    usage
    ;;
esac
