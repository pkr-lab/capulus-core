mdm_chart_dir="${MDM_CHART_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
mdm_values="$mdm_chart_dir/values.yaml"
mdm_state_dir="${MDM_STATE_DIR:-$HOME/mdm-secrets}"
mdm_credentials="$mdm_state_dir/credentials.env"
mdm_apple_dir="${MDM_APPLE_DIR:-$HOME/mdm-apple}"
mdm_namespace="${MDM_NAMESPACE:-mdm}"

fail() {
  echo "Fehler: $*" >&2
  exit 1
}

need() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null || fail "$cmd nicht gefunden"
  done
}

values_get() {
  local value
  value="$(sed -n "s/^$1: //p" "$mdm_values" | head -n 1 | sed -e 's/^"//' -e 's/"$//')"
  [[ -n "$value" ]] || fail "$1 fehlt in $mdm_values"
  printf '%s' "$value"
}

credential_get() {
  [[ -f "$mdm_credentials" ]] || fail "$mdm_credentials fehlt (zuerst mdm-init-secrets.sh ausfuehren)"
  local value
  value="$(sed -n "s/^$1=//p" "$mdm_credentials" | head -n 1)"
  [[ -n "$value" ]] || fail "$1 fehlt in $mdm_credentials"
  printf '%s' "$value"
}

seal() {
  local secret="$1" value="$2" sealed
  sealed="$(printf '%s' "$value" | kubeseal --raw \
    --namespace "$mdm_namespace" --name "$secret" \
    --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
    --from-file=/dev/stdin)"
  [[ -n "$sealed" ]] || fail "kubeseal lieferte nichts fuer $secret"
  printf '%s' "$sealed"
}

values_edit() {
  python3 -I "$(dirname "${BASH_SOURCE[0]}")/values_edit.py" "$mdm_values" "$@"
}

portforward_start() {
  local service="$1" local_port="$2" remote_port="$3"
  kubectl -n "$mdm_namespace" port-forward "svc/$service" "$local_port:$remote_port" >/dev/null 2>&1 &
  portforward_pid=$!
  trap 'kill "$portforward_pid" 2>/dev/null || true' EXIT
  local i
  for i in $(seq 1 30); do
    if curl -s -o /dev/null "http://127.0.0.1:$local_port/version"; then
      return 0
    fi
    sleep 1
  done
  fail "Port-Forward auf $service nicht erreichbar"
}
