#!/usr/bin/env bash
# Sync main -> entw (Logik hinter .github/workflows/sync-entw.yml,
# Beschreibung in docs/f-cicd-automatisierung/f0080-entw-promotion.md).
#
# Haelt `entw` auf dem Stand von `main`, solange entw keine eigenen Commits hat.
# Eigene Commits = Nicht-Merge-Commits auf entw, die main inhaltlich nicht hat
# (git cherry, also nach Patch-Id: ein nach main uebergebener Cherry-Pick zaehlt
# nicht) und die noch nicht mit dem Tag `entw-promoted` uebergeben wurden.
#
#   entw hat eigene Commits (es wird gerade dort getestet) -> nichts tun
#   entw enthaelt schon alles aus main                      -> nichts tun
#   sonst                                                   -> main in entw mergen
#                                                              (Fast-Forward, wenn moeglich)
#
# Ein Merge-Konflikt bricht ab, ohne zu pushen; der Lauf wird rot und entw bleibt unveraendert.
# Pause per Hand: Repo-Variable ENTW_SYNC_PAUSED=true (Workflow prueft sie).
#
# Umgebung: DRY_RUN=1 merged lokal, pusht aber nicht.
set -euo pipefail

TAG="entw-promoted"
MAIN="main"
ENTW="entw"

log() { echo "[sync-entw] $*" >&2; }

git fetch --quiet origin \
  "+refs/heads/${MAIN}:refs/remotes/origin/${MAIN}" \
  "+refs/heads/${ENTW}:refs/remotes/origin/${ENTW}"
git fetch --quiet origin "+refs/tags/${TAG}:refs/tags/${TAG}" 2>/dev/null || true

if git merge-base --is-ancestor "origin/${MAIN}" "origin/${ENTW}"; then
  log "entw enthaelt main bereits, nichts zu tun."
  exit 0
fi

# Bereits uebergebene Commits (bis zum Tag) ausnehmen.
promoted=$(mktemp)
if git rev-parse -q --verify "refs/tags/${TAG}^{commit}" >/dev/null; then
  git rev-list "refs/tags/${TAG}" > "$promoted"
fi
own=$(git cherry "origin/${MAIN}" "origin/${ENTW}" | awk '$1 == "+" {print $2}' \
  | grep -vxFf "$promoted" || true)
rm -f "$promoted"

if [ -n "$own" ]; then
  log "entw hat eigene, noch nicht uebergebene Commits - kein Sync:"
  echo "$own" | while read -r sha; do git log -1 --format='  %h %s' "$sha" >&2; done
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git checkout --quiet -B "${ENTW}" "origin/${ENTW}"

if ! git merge --no-edit -m "chore: sync main into entw" "origin/${MAIN}"; then
  git merge --abort || true
  log "Merge-Konflikt - entw bleibt unveraendert, bitte von Hand aufloesen."
  exit 1
fi

if [ -n "${DRY_RUN:-}" ]; then
  log "DRY_RUN: kein Push. entw waere jetzt $(git rev-parse --short HEAD)."
  exit 0
fi

git push origin "${ENTW}"
log "entw auf $(git rev-parse --short HEAD) aktualisiert."
