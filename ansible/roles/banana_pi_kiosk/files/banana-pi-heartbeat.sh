#!/usr/bin/env bash
# Managed by Ansible (banana_pi_kiosk role) — do not edit manually.
#
# Sendet ein Lebenszeichen an den alamos-apager Heartbeat-Endpunkt (gleiches
# Skript wie ansible/roles/alamos_kiosk/files/alamos-heartbeat.sh, hier
# dupliziert da Ansible-Rollen ihr files/-Verzeichnis nicht teilen). Schlaegt
# der Request fehl (Cluster/DNS kurz weg), passiert nichts weiter — der
# lokale Failover-Supervisor (banana-pi-kiosk-supervisor.sh) kuemmert sich
# unabhaengig davon um die Browser-Umschaltung, dieser Timer hier steuert
# NUR den zentralen ntfy-Ausfall-Alarm in argocd/apps/alamos-apager.
set -uo pipefail

BASE_URL="${BASE_URL:?BASE_URL not set}"
STATION="${STATION:?STATION not set}"

curl --fail --silent --show-error --max-time 5 \
  "${BASE_URL}/heartbeat?station=${STATION}" >/dev/null || \
  logger -t banana-pi-heartbeat "heartbeat fuer ${STATION} fehlgeschlagen"
