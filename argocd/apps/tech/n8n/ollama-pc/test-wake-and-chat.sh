#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli="node ${here}/cli.js"
mail="${TEST_MAIL:-${here}/testdata/emails/02-rueckfrage-du.json}"
suspend_wait="${SUSPEND_WAIT_SECONDS:-180}"
suspend_command="${SUSPEND_COMMAND:-sudo -n systemctl suspend}"

: "${OLLAMA_URL:?OLLAMA_URL muss gesetzt sein}"
: "${OLLAMA_PC_SSH:?OLLAMA_PC_SSH muss gesetzt sein (z. B. user@192.168.178.50)}"

json_field() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s);const r=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],v);process.stdout.write(String(r))})' "$1"
}

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }

step "1/5 PC wecken, falls er schläft"
$cli wake >/dev/null

step "2/5 PC in Suspend versetzen (${OLLAMA_PC_SSH}: ${suspend_command})"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$OLLAMA_PC_SSH" "$suspend_command" || true

step "3/5 warten, bis Ollama nicht mehr antwortet (max. ${suspend_wait} s)"
deadline=$((SECONDS + suspend_wait))
while [ "$(OLLAMA_HEALTH_TIMEOUT_SECONDS=2 $cli probe | json_field up)" = "true" ]; do
  [ "$SECONDS" -lt "$deadline" ] || fail "PC ist nach ${suspend_wait} s nicht in Suspend gegangen (Suspend-Kommando prüfen)"
  sleep 3
done
echo "PC schläft"

step "4/5 Request vom Homeserver, PC muss aufwachen und antworten"
started=$SECONDS
result="$($cli chat < "$mail")" || { printf '%s\n' "$result" >&2; fail "Request fehlgeschlagen"; }
elapsed=$((SECONDS - started))
[ "$(printf '%s' "$result" | json_field ok)" = "true" ] || fail "Antwort nicht ok: $result"
[ "$(printf '%s' "$result" | json_field woke)" = "true" ] || fail "PC war nicht im Suspend (woke=false)"
reply_length="$(printf '%s' "$result" | json_field reply | wc -c)"
[ "$reply_length" -gt 20 ] || fail "Antwort zu kurz oder leer"
printf 'aufgewacht und geantwortet nach %s s, Wake-Wartezeit %s ms, %s Token/s\n' \
  "$elapsed" "$(printf '%s' "$result" | json_field waited_ms)" "$(printf '%s' "$result" | json_field stats.tokens_per_second)"
printf '\n--- Antwort ---\n%s\n---------------\n' "$(printf '%s' "$result" | json_field reply)"

step "5/5 Modell auf der GPU (ollama ps)"
ps_json="$($cli ps)"
model="$(printf '%s' "$result" | json_field model)"
gpu="$(printf '%s' "$ps_json" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const m=JSON.parse(s).models.find(x=>x.name===process.argv[1]);process.stdout.write(m?String(m.gpu_percent):"-1")})' "$model")"
[ "$gpu" != "-1" ] || fail "Modell ${model} ist nach der Antwort nicht geladen"
[ "$gpu" -gt 0 ] || fail "Modell ${model} läuft nur auf der CPU (gpu_percent=0)"
printf '%s liegt zu %s%% auf der GPU\n' "$model" "$gpu"

printf '\nTEST BESTANDEN\n'
