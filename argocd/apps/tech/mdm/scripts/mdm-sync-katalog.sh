#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  echo "Aufruf: $0" >&2
  echo "Spielt die INSERT INTO automation.app_catalog-Zeilen aus files/automation-schema.sql per UPSERT in die laufende MDM-Datenbank ein." >&2
  echo "Noetig, weil Postgres /docker-entrypoint-initdb.d nur beim allerersten Start mit leerem Datenverzeichnis ausfuehrt: neue Katalog-Apps in automation-schema.sql erreichen eine bereits laufende Datenbank sonst nie." >&2
  exit 1
}
[[ $# -eq 0 ]] || usage

need kubectl psql pg_isready awk
db_password="$(credential_get automation-db-password)"

seed="$(awk '/^INSERT INTO automation\.app_catalog/{flag=1} flag{print} flag && /;$/{exit}' "$mdm_chart_dir/files/automation-schema.sql")"
[[ -n "$seed" ]] || fail "INSERT INTO automation.app_catalog nicht in automation-schema.sql gefunden"
upsert="${seed%;}
ON CONFLICT (adam_id) DO UPDATE SET name = EXCLUDED.name, bundle_id = EXCLUDED.bundle_id, config = EXCLUDED.config, enabled = true;"

local_port=15432
kubectl -n "$mdm_namespace" port-forward svc/mdm-postgres "$local_port:5432" >/dev/null 2>&1 &
pf_pid=$!
trap 'kill "$pf_pid" 2>/dev/null || true' EXIT
ready=0
for _ in $(seq 1 30); do
  if PGPASSWORD="$db_password" pg_isready -h 127.0.0.1 -p "$local_port" -U mdmauto -d nanomdm >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ $ready -eq 1 ]] || fail "Port-Forward auf mdm-postgres nicht erreichbar"

PGPASSWORD="$db_password" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$local_port" -U mdmauto -d nanomdm -c "$upsert"
echo "automation.app_catalog mit automation-schema.sql abgeglichen."
echo "Erlaubt-Liste (app-allowlist) wird beim naechsten Lauf von MDM: App auf iPads installieren automatisch neu berechnet."
