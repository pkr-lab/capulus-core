#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  echo "Aufruf: $0 [--text TEXT] [--version N] [--out DATEI]" >&2
  echo "Ohne --text wird lockScreenText aus values.yaml verwendet." >&2
  exit 1
}

text=""
version=1
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --text) text="${2:?}"; shift 2 ;;
    --version) version="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$text" ]] || text="$(sed -n 's/^  lockScreenText: //p' "$mdm_values" | head -n 1 | sed -e 's/^"//' -e 's/"$//')"
[[ -n "$text" ]] || fail "kein Text angegeben"

prefix="$(sed -n 's/^  profilePrefix: //p' "$mdm_values" | head -n 1)"
rendered="$(python3 -I - "$mdm_chart_dir/profiles/lockscreen.mobileconfig.tmpl" "$prefix.lockscreen" "$version" "$text" <<'PY'
import sys
from xml.sax.saxutils import escape

template, identifier, version, text = sys.argv[1:5]
values = {
    "__IDENTIFIER__": identifier,
    "__PAYLOAD_UUID__": "544b6bc0-7381-400f-b57c-beb2a74bf33b",
    "__PROFILE_UUID__": "e3907677-1014-4be8-931c-6591bdb064a2",
    "__VERSION__": version,
    "__TEXT__": escape(text),
}
body = open(template, encoding="utf-8").read()
for key, value in values.items():
    body = body.replace(key, value)
sys.stdout.write(body)
PY
)"

if [[ -n "$out" ]]; then
  printf '%s\n' "$rendered" > "$out"
  echo "geschrieben: $out"
else
  printf '%s\n' "$rendered"
fi
