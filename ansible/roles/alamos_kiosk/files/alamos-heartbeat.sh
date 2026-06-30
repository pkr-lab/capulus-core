#!/usr/bin/env bash
# Managed by Ansible (alamos_kiosk role) — do not edit manually.
#
# Sendet ein Lebenszeichen an den alamos-apager Heartbeat-Endpunkt. Schlaegt
# der Request fehl (Cluster/DNS kurz weg), passiert nichts weiter — der Pi
# soll davon nichts merken, der naechste Timer-Lauf versucht es einfach
# wieder (gleiches Prinzip wie windeployment: PC merkt nichts von
# MinIO/Zammad-Ausfaellen).
set -uo pipefail

BASE_URL="${BASE_URL:?BASE_URL not set}"
STATION="${STATION:?STATION not set}"

curl --fail --silent --show-error --max-time 5 \
  "${BASE_URL}/heartbeat?station=${STATION}" >/dev/null || \
  logger -t alamos-heartbeat "heartbeat fuer ${STATION} fehlgeschlagen"
