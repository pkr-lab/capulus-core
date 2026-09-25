#!/usr/bin/env bash
set -uo pipefail

BASE_URL="${BASE_URL:?BASE_URL not set}"
STATION="${STATION:?STATION not set}"

curl --fail --silent --show-error --max-time 5 \
  "${BASE_URL}/heartbeat?station=${STATION}" >/dev/null || \
  logger -t banana-pi-heartbeat "heartbeat fuer ${STATION} fehlgeschlagen"
