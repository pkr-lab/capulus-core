#!/usr/bin/env bash
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

if ! out=$(gh pr merge "$pr" --auto --merge 2>&1); then
  if echo "$out" | grep -qi "clean status"; then
    gh pr merge "$pr" --merge
  else
    echo "$out" >&2
    exit 1
  fi
fi
log "PR ${pr} wird gemergt (Auto-Merge/Merge)."
