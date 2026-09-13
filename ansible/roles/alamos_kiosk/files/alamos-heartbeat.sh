#!/usr/bin/env bash
# Managed by Ansible (alamos_kiosk role) — do not edit manually.
set -uo pipefail

BASE_URL="${BASE_URL:?BASE_URL not set}"
STATION="${STATION:?STATION not set}"

curl --fail --silent --show-error --max-time 5 \
  "${BASE_URL}/heartbeat?station=${STATION}" >/dev/null || \
  logger -t alamos-heartbeat "heartbeat fuer ${STATION} fehlgeschlagen"
