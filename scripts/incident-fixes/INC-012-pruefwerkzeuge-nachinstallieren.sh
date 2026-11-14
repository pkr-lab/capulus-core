#!/usr/bin/env bash
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

BACKUP_DIR="$HOME/.incident-backups/INC-012-$(date +%Y%m%d%H%M%S)"
GOBIN_DIR="${GOBIN:-$HOME/go/bin}"

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

run mkdir -p "$BACKUP_DIR"
if (( DRY )); then
  echo "[dry-run] ls -1 $HOME/.local/bin $GOBIN_DIR > $BACKUP_DIR/bin-before.txt"
else
  ls -1 "$HOME/.local/bin" "$GOBIN_DIR" > "$BACKUP_DIR/bin-before.txt" 2>/dev/null || true
fi

if command -v pip-audit >/dev/null || [[ -x "$HOME/.local/bin/pip-audit" ]]; then
  echo "vorhanden: pip-audit"
else
  command -v pipx >/dev/null || { echo "pipx fehlt" >&2; exit 1; }
  run pipx install pip-audit
fi

command -v go >/dev/null || { echo "go fehlt" >&2; exit 1; }

if [[ -x "$GOBIN_DIR/govulncheck" ]]; then
  echo "vorhanden: govulncheck"
else
  run go install golang.org/x/vuln/cmd/govulncheck@latest
fi

if [[ -x "$GOBIN_DIR/osv-scanner" ]]; then
  echo "vorhanden: osv-scanner"
else
  run go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest
fi

echo "PATH muss $HOME/.local/bin und $GOBIN_DIR enthalten"
echo "Scans: (cd capulus-operator && govulncheck ./...) ; osv-scanner scan source -r ~/git/github/capulus"
