#!/usr/bin/env bash
set -euo pipefail

SSH_DIR="${1:-$HOME/.ssh}"

echo "== Private Schluessel in $SSH_DIR (nur Status, keine Ausgabe von Schluesseldaten) =="
shopt -s nullglob
for f in "$SSH_DIR"/*; do
  [[ -f "$f" ]] || continue
  head -n1 "$f" 2>/dev/null | grep -q 'PRIVATE KEY' || continue
  mode="$(stat -c '%a' "$f")"
  if ssh-keygen -y -P '' -f "$f" >/dev/null 2>&1; then
    prot="OHNE Passphrase"
  else
    prot="mit Passphrase"
  fi
  fp="$(ssh-keygen -lf "$f" 2>/dev/null | awk '{print $2}' || true)"
  echo "$(basename "$f")  modus=$mode  $prot  fingerprint=${fp:-n/a}"
done

echo "== Eintraege in authorized_keys: Optionen und Kommentar =="
if [[ -r "$SSH_DIR/authorized_keys" ]]; then
  awk '{ if ($1 ~ /^(ssh-|ecdsa|sk-)/) print "ohne-Optionen", $1, $NF; else print "mit-Optionen", $2, $NF }' "$SSH_DIR/authorized_keys"
fi
