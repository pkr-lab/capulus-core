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
#                                                              (per PR + Auto-Merge)
#
# Ein Merge-Konflikt bricht ab, ohne zu mergen; der Lauf wird rot und entw bleibt unveraendert.
# Pause per Hand: Repo-Variable ENTW_SYNC_PAUSED=true (Workflow prueft sie).
#
# Umgebung: DRY_RUN=1 oeffnet keinen PR.
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

PR_TITLE="chore: sync main into entw"

# Das Ruleset auf entw verlangt Pull Requests (keine Bypass-Actors) -> statt direkt zu pushen
# wird ein PR main -> entw geoeffnet und per Auto-Merge (Merge-Commit, kein Squash, damit
# main danach Vorfahre von entw bleibt) gemergt.
if [ -n "${DRY_RUN:-}" ]; then
  log "DRY_RUN: haette einen PR ${MAIN} -> ${ENTW} geoeffnet und Auto-Merge aktiviert."
  exit 0
fi

pr=$(gh pr list --base "${ENTW}" --head "${MAIN}" --state open --json number --jq '.[0].number // empty')
if [ -z "$pr" ]; then
  pr=$(gh pr create --base "${ENTW}" --head "${MAIN}" --title "${PR_TITLE}" \
    --body "Automatischer Sync von \`${MAIN}\` nach \`${ENTW}\` (scripts/sync-entw.sh)." )
  log "PR geoeffnet: ${pr}"
else
  log "PR #${pr} ist schon offen."
fi

# --auto wartet auf die Pflicht-Checks. Sind keine (mehr) offen, lehnt gh das mit "clean status"
# ab -> dann direkt mergen. Ein Merge-Konflikt bricht hier mit Fehler ab, entw bleibt unveraendert.
if ! out=$(gh pr merge "$pr" --auto --merge 2>&1); then
  if echo "$out" | grep -qi "clean status"; then
    gh pr merge "$pr" --merge
  else
    echo "$out" >&2
    exit 1
  fi
fi
log "PR ${pr} wird gemergt (Auto-Merge/Merge)."
