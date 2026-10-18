#!/usr/bin/env bash
set -euo pipefail

SEVERITY=${SEVERITY:-HIGH,CRITICAL}
KUBECONFIG_PATH=${KUBECONFIG:-$HOME/.kube/config}

usage() {
  cat <<'USAGE'
Usage: ./scripts/scan-cluster-images.sh [--summary] [--charts] [image ...]

Scannt die im Cluster laufenden Container-Images mit Trivy (nur behebbare Funde, Schweregrad
HIGH und CRITICAL, Umgebungsvariable SEVERITY ändert das). Ohne Argumente werden alle Images
aller Pods gelesen (kubectl), mit Argumenten nur die genannten.

  --summary   eine Zeile je Image: CRITICAL und HIGH als Zahlen
  --charts    Images nicht aus dem Cluster, sondern aus allen Helm-Charts unter argocd/apps lesen
              (helm template, ohne Cluster-Zugriff; für die CI)
  -h, --help  diese Hilfe

Benötigt trivy oder Docker (aquasec/trivy).
USAGE
}

SUMMARY=0
FROM_CHARTS=0
IMAGES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --summary) SUMMARY=1 ;;
    --charts) FROM_CHARTS=1 ;;
    *) IMAGES+=("$1") ;;
  esac
  shift
done

if command -v trivy >/dev/null 2>&1; then
  scan() { trivy image --quiet --scanners vuln --ignore-unfixed --severity "$SEVERITY" "$@"; }
elif command -v docker >/dev/null 2>&1; then
  scan() {
    docker run --rm -v "$HOME/.cache/trivy:/root/.cache/" "${TRIVY_IMAGE:-aquasec/trivy:latest}" image --quiet --scanners vuln --ignore-unfixed --severity "$SEVERITY" "$@"
  }
else
  echo "Fehler: trivy oder docker wird benötigt." >&2
  exit 1
fi

if [[ $FROM_CHARTS -eq 1 && ${#IMAGES[@]} -eq 0 ]]; then
  mapfile -t IMAGES < <(
    for chart in "$(dirname "${BASH_SOURCE[0]}")"/../argocd/apps/*/*/; do
      [[ -f "${chart}Chart.yaml" ]] || continue
      if grep -q '^dependencies:' "${chart}Chart.yaml"; then
        helm dependency build "$chart" >/dev/null 2>&1 || helm dependency update "$chart" >/dev/null 2>&1 || true
      fi
      helm template x "$chart" 2>/dev/null | sed -n 's/^[[:space:]]*-\{0,1\}[[:space:]]*image:[[:space:]]*//p' | tr -d "\"'"
    done | grep -v '^$' | sort -u
  )
elif [[ ${#IMAGES[@]} -eq 0 ]]; then
  mapfile -t IMAGES < <(
    kubectl --kubeconfig "$KUBECONFIG_PATH" get pods -A \
      -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{range .spec.initContainers[*]}{.image}{"\n"}{end}{end}' \
      | sort -u
  )
fi

for image in "${IMAGES[@]}"; do
  if [[ $SUMMARY -eq 1 ]]; then
    counts=$(scan --format json "$image" 2>/dev/null | python3 -c '
import json, sys
data = json.load(sys.stdin)
crit = high = 0
for result in data.get("Results") or []:
    for vuln in result.get("Vulnerabilities") or []:
        if vuln["Severity"] == "CRITICAL":
            crit += 1
        elif vuln["Severity"] == "HIGH":
            high += 1
print(crit, high)
' || echo "Scan abgebrochen")
    printf '%s\t%s\n' "$image" "$counts"
  else
    echo "=== $image"
    scan "$image" || echo "Scan abgebrochen: $image"
  fi
done
