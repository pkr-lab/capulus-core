#!/usr/bin/env bash
# Journal-Backlog eines Hosts in kurzen Fenstern nach VictoriaLogs nachladen und
# danach den Cursor von systemd-journal-upload dort aufsetzen, wo das Nachladen
# endet - ohne Luecken und ohne Duplikate.
#
# Wann: systemd-journal-upload haengt in einer Endlosschleife (Symptom:
# "transfer closed with N bytes remaining to read" bzw. HTTP 504, State-Datei
# /var/lib/systemd/journal-upload/state fehlt, VictoriaLogs bekommt immer
# wieder denselben Journal-Anfang -> Duplikate). Ursache und Vorbeugung:
# docs/3-apps-workloads/300j0-logging.md, Abschnitt "Backlog und die 60-s-Grenze".
#
# Aufruf (Skript laeuft AUF dem betroffenen Host, braucht root):
#   ssh <host> 'sudo bash -s -- "2026-09-19 04:14:12 UTC"' < scripts/journal-backfill.sh
# Das Argument ist der Zeitpunkt (UTC), AB DEM in VictoriaLogs noch etwas fehlt,
# = juengster _time des Hosts dort, z. B. in Grafana Explore (VictoriaLogs):
#   _HOSTNAME:"<host>" | stats max(_time)
# Optionale Umgebungsvariablen:
#   DRY_RUN=1    nur zaehlen, nichts senden, State nicht anfassen
#   NO_START=1   Dienst am Ende nicht starten
#   WINDOW=7200  Fenstergroesse in Sekunden (jedes Fenster muss < Traefik-readTimeout bleiben)
set -euo pipefail

START="${1:?Startzeitpunkt (UTC) fehlt, z. B. \"2026-09-19 04:14:12 UTC\"}"
WINDOW="${WINDOW:-7200}"
URL="${URL:-https://logs-write.tech.homeserver:443/insert/journald/upload}"
CA="${CA:-/usr/local/share/ca-certificates/homeserver-root-ca.crt}"
STATE_DIR=/var/lib/systemd/journal-upload
DRY_RUN="${DRY_RUN:-0}"

[ "$(id -u)" -eq 0 ] || { echo "Muss als root laufen (sudo)." >&2; exit 1; }

if [ "$DRY_RUN" = 1 ]; then echo "DRY_RUN: Dienst wird nicht gestoppt"; else echo "Dienst stoppen (Schleife beenden)"; systemctl stop systemd-journal-upload; fi

END="$(date -u +'%Y-%m-%d %H:%M:%S') UTC"
t=$(date -u -d "$START" +%s)
e=$(date -u -d "$END" +%s)
total=0

while [ "$t" -lt "$e" ]; do
  n=$((t + WINDOW)); [ "$n" -gt "$e" ] && n=$e
  a=$(date -u -d @"$t" +'%Y-%m-%d %H:%M:%S UTC')
  b=$(date -u -d @"$n" +'%Y-%m-%d %H:%M:%S UTC')
  f=$(mktemp)
  journalctl --since "$a" --until "$b" -o export --no-pager > "$f" 2>/dev/null || true
  c=$(grep -a -c '^__REALTIME_TIMESTAMP=' "$f" || true)
  code=DRY
  if [ "$DRY_RUN" != 1 ]; then
    code=$(curl -s -m 50 --cacert "$CA" -X POST -H 'Content-Type: application/vnd.fdo.journal' \
      --data-binary @"$f" -o /dev/null -w '%{http_code}' "$URL" || true)
  fi
  rm -f "$f"
  echo "$a -> $b : $c Eintraege, HTTP $code"
  total=$((total + c))
  if [ "$DRY_RUN" != 1 ] && [ "$code" != 200 ]; then
    echo "ABBRUCH bei Fenster $a (HTTP $code) - State NICHT gesetzt, Dienst bleibt gestoppt." >&2
    exit 1
  fi
  t=$n
done
echo "GESAMT: $total Eintraege (bis $END)"

[ "$DRY_RUN" = 1 ] && { echo "DRY_RUN: State nicht angefasst."; exit 0; }

# Cursor des letzten nachgeladenen Eintrags (<= END) als State: der Dienst
# macht danach genau dort weiter.
CUR=$(journalctl --until "$END" -n 1 -o cat --show-cursor --no-pager 2>/dev/null | sed -n 's/^-- cursor: //p')
[ -n "$CUR" ] || { echo "Kein Cursor gefunden - State nicht gesetzt." >&2; exit 1; }
printf '# This is private data. Do not parse.\nLAST_CURSOR=%s\n' "$CUR" > "$STATE_DIR/state"
# Besitzer = DynamicUser des Dienstes (sonst "Failed to read state file: Permission denied")
chown "$(stat -c '%u:%g' "$STATE_DIR")" "$STATE_DIR/state"
chmod 600 "$STATE_DIR/state"
echo "State gesetzt: ${CUR:0:60}..."

if [ "${NO_START:-0}" != 1 ]; then
  systemctl reset-failed systemd-journal-upload 2>/dev/null || true
  systemctl start systemd-journal-upload
  sleep 5
  echo "Dienst: $(systemctl is-active systemd-journal-upload)"
fi
