#!/usr/bin/env bash
# Re-versiegelt die SealedSecrets einer App fuer den PROD-Cluster
# (docs/4-planung/40080, Phase 2.7 / 3.3).
#
# Die SealedSecrets im Repo sind mit dem TECH-Schluessel versiegelt und lassen
# sich in PROD nicht entschluesseln. Dieses Skript liest das bereits von TECH
# entschluesselte, laufende Secret, versiegelt es OFFLINE mit dem oeffentlichen
# Zertifikat des PROD-Controllers und ueberschreibt die Datei in der PROD-Kopie
# (argocd/apps/prod/<app>/templates/..., als statisches SealedSecret). Der Klartext geht nur durch eine
# Pipe, wird nie in eine Datei geschrieben und nie ausgegeben.
#
# Voraussetzung: kubectl-Kontext zeigt auf TECH, jq, kubeseal, und die PROD-Kopie
# der App existiert (das Skript legt sie an, falls sie fehlt).
#
# Aufruf:
#   scripts/reseal-for-prod.sh --list <app>     # nur anzeigen, was passieren wuerde
#   scripts/reseal-for-prod.sh <app>            # wirklich versiegeln
#
# Zertifikat holen (einmalig, oeffentlicher Teil):
#   ssh ubuntu@192.168.178.99 "sudo k3s kubectl -n sealed-secrets get secret \
#     -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
#     -o jsonpath='{.items[0].data.tls\.crt}' | base64 -d" > ~/prod-sealed-secrets.pem
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cert="${PROD_SEALED_CERT:-$HOME/prod-sealed-secrets.pem}"
list_only=false
if [[ "${1:-}" == "--list" ]]; then
  list_only=true
  shift
fi
app="${1:?Aufruf: $0 [--list] <app>}"

src="$repo_root/argocd/apps/workloads/$app"
dst="$repo_root/argocd/apps/prod/$app"
[[ -d "$src" ]] || { echo "Fehler: $src existiert nicht (TECH-App?)" >&2; exit 1; }

if [[ ! -d "$dst" ]]; then
  if $list_only; then
    echo "(PROD-Kopie fehlt, wuerde von $src angelegt)"
    dst="$src"
  else
    cp -r "$src" "$dst"
    echo "PROD-Kopie angelegt: $dst"
  fi
fi

mapfile -t files < <(grep -rl '^kind: SealedSecret' "$dst" || true)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "Keine SealedSecrets in $dst - nichts zu tun."
  exit 0
fi

if ! $list_only; then
  [[ -s "$cert" ]] || { echo "Fehler: PROD-Zertifikat $cert fehlt (siehe Kopf dieses Skripts)" >&2; exit 1; }
  echo "kubectl-Kontext (muss TECH sein): $(kubectl config current-context)"
fi

for f in "${files[@]}"; do
  rel="${f#"$dst"/}"
  # Namen/Namespace aus dem GERENDERTEN Template (die Dateien enthalten Helm-
  # Ausdruecke). Release-Name = App-Name, wie im PROD-ApplicationSet.
  rendered="$(helm template "$app" "$dst" --namespace "$app" --show-only "$rel" 2>/dev/null || true)"
  name="$(awk '/^kind: SealedSecret/{k=1} k&&/^metadata:/{m=1;next} m&&/^  name:/{print $2;exit}' <<<"$rendered" | tr -d '"')"
  ns="$(awk '/^kind: SealedSecret/{k=1} k&&/^metadata:/{m=1;next} m&&/^  namespace:/{print $2;exit}' <<<"$rendered" | tr -d '"')"
  if [[ -z "$name" || -z "$ns" ]]; then
    echo "- ${f#"$repo_root"/}: (rendert leer, uebersprungen - deaktiviertes Template?)"
    continue
  fi
  echo "- ${f#"$repo_root"/}: Secret $ns/$name"
  $list_only && continue

  if grep -q 'sealedsecrets.bitnami.com/\(cluster-wide\|namespace-wide\)' "$f"; then
    echo "  WARNUNG: nicht-strikter Scope im Original, Ergebnis ist strikt (Name+Namespace)." >&2
  fi

  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  kubectl -n "$ns" get secret "$name" -o json \
    | jq -c '{apiVersion:"v1",kind:"Secret",metadata:{name:.metadata.name,namespace:.metadata.namespace},type:.type,data:.data}' \
    | kubeseal --cert "$cert" --format yaml > "$tmp"
  grep -q '^kind: SealedSecret' "$tmp" || { echo "  Fehler: kubeseal lieferte kein SealedSecret" >&2; exit 1; }
  # Ergebnis ist ein statisches SealedSecret (ersetzt das Helm-Template der Datei).
  { echo "# Fuer den PROD-Cluster versiegelt (scripts/reseal-for-prod.sh), nicht mit TECH-Schluessel."; cat "$tmp"; } > "$f"
  rm -f "$tmp"
  echo "  neu versiegelt"
done
