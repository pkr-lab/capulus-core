#!/usr/bin/env bash
set -euo pipefail

NAMESPACE=headlamp
SERVICE_ACCOUNT=headlamp-viewer
DURATION=1h
KUBE_CONFIG=${KUBECONFIG:-$HOME/.kube/config}

usage() {
  cat <<'USAGE'
Usage: ./scripts/show-headlamp-token.sh [--duration <dauer>] [--namespace <namespace>] [--kubeconfig <path>]

Erzeugt ein kurzlebiges Anmelde-Token für Headlamp (ServiceAccount headlamp-viewer, Rolle view).
Das Token läuft nach der Dauer ab (Standard 1h) und wird nirgends gespeichert.

Options:
  --duration    Gültigkeit des Tokens (Standard: 1h)
  --namespace   Namespace von Headlamp (Standard: headlamp)
  --kubeconfig  Pfad zur kubeconfig (Standard: $HOME/.kube/config oder $KUBECONFIG)
  -h, --help    Diese Hilfe
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --duration)
      shift
      DURATION=${1:-}
      ;;
    --namespace)
      shift
      NAMESPACE=${1:-}
      ;;
    --kubeconfig)
      shift
      KUBE_CONFIG=${1:-}
      ;;
    *)
      echo "Unbekannte Option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

if ! command -v kubectl >/dev/null 2>&1; then
  echo "Fehler: kubectl wird benötigt." >&2
  exit 1
fi

if [[ ! -f "$KUBE_CONFIG" ]]; then
  echo "Fehler: kubeconfig nicht gefunden unter $KUBE_CONFIG" >&2
  exit 1
fi

TOKEN=$(kubectl --kubeconfig "$KUBE_CONFIG" -n "$NAMESPACE" create token "$SERVICE_ACCOUNT" --duration="$DURATION")

echo "Headlamp URL: https://headlamp.tech.homeserver"
echo "Bearer-Token (gültig ${DURATION}, nur Leserechte):"
echo
printf '%s\n' "$TOKEN"
