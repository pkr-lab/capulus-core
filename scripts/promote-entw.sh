#!/usr/bin/env bash
# shellcheck disable=SC2016 # Backticks in '...' sind Markdown fuer PR-/Issue-Texte, keine Expansion
# Promotion ENTW -> main (Logik hinter .github/workflows/promote-entw.yml,
# Beschreibung in docs/f-cicd-automatisierung/f0080-entw-promotion.md).
#
#   detect             Gibt `head`, `base` und `changed` aus (GITHUB_OUTPUT, sonst stdout).
#   promote            Cherry-pickt die neuen entw-Commits auf einen Branch ab main,
#                      oeffnet den PR und setzt danach den Tag entw-promoted um.
#   report-ci-failure  Meldet ein rotes CI auf entw als Issue (verhindert, dass der
#                      Cron denselben Stand alle 15 Minuten neu prueft).
#
# Umgebung: PROMOTE_HEAD (promote, report-ci-failure), GH_TOKEN (gh + git push),
# GITHUB_REPOSITORY, optional DRY_RUN=1 (ueberspringt alle `gh`-Aufrufe, fuer lokale Tests).
#
# Der Tag `entw-promoted` ist die Marke "bis hierhin wurde entw an main uebergeben".
# Er wandert erst nach erfolgreich geoeffnetem PR (oder nach "nichts zu uebergeben")
# auf den neuen entw-Stand. Neue Commits = alles zwischen Tag und entw-Spitze, das
# nicht schon in main ist. Ohne Tag (erster Lauf) gilt der Merge-Base von main und entw.
set -euo pipefail

TAG="entw-promoted"
MAIN="main"
ENTW="entw"
MARKER="[entw-only]"
ISSUE_LABEL="entw-promotion"
PR_LABEL="promotion"

log() { echo "[promote-entw] $*" >&2; }

# gh nur ausfuehren, wenn kein Trockenlauf; im Trockenlauf wird der Aufruf nur gezeigt.
gh_run() {
  if [ -n "${DRY_RUN:-}" ]; then
    log "DRY_RUN: gh $*"
    return 0
  fi
  gh "$@"
}

emit() {
  printf '%s\n' "$@"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_OUTPUT"; fi
}

fetch_refs() {
  git fetch --quiet origin \
    "+refs/heads/${MAIN}:refs/remotes/origin/${MAIN}" \
    "+refs/heads/${ENTW}:refs/remotes/origin/${ENTW}"
  # Der Tag existiert erst nach der ersten Promotion.
  git fetch --quiet origin "+refs/tags/${TAG}:refs/tags/${TAG}" 2>/dev/null || true
}

base_commit() {
  if git rev-parse -q --verify "refs/tags/${TAG}^{commit}" >/dev/null; then
    git rev-parse "refs/tags/${TAG}^{commit}"
  else
    git merge-base "origin/${MAIN}" "origin/${ENTW}"
  fi
}

# Alte -> neue Reihenfolge, ohne Merge-Commits und ohne alles, was main schon hat
# (z. B. nach einem Merge main -> entw kommen main-Commits nicht doppelt zurueck).
candidates() {
  git rev-list --no-merges --reverse "$1..$2" "^origin/${MAIN}"
}

# Nicht uebernommen wird ein Commit, wenn er `[entw-only]` traegt ODER ausschliesslich
# argocd/apps/entw/ aendert: solche Aenderungen gehen ueber die Promotion-Kette
# (promote-chain.yml: Versionen nach 24 h Gesundheit als PR nach tech/prod), ein Cherry-Pick
# des ENTW-Ordners nach main waere nur Rauschen (TECH/PROD lesen ihn nie).
is_entw_only() {
  if git log -1 --format=%B "$1" | grep -qF "$MARKER"; then
    return 0
  fi
  local other
  other=$(git diff-tree --no-commit-id --name-only -r "$1" | grep -v '^argocd/apps/entw/' || true)
  [ -z "$other" ]
}

# Konflikt, der ausschliesslich argocd/apps/entw/ betrifft (typisch: ein Vorgaenger-Commit im
# ENTW-Ordner wurde uebersprungen): den ENTW-Anteil verwerfen, den Rest des Commits uebernehmen.
resolve_entw_only_conflict() {
  local unmerged
  unmerged=$(git diff --name-only --diff-filter=U)
  [ -n "$unmerged" ] || return 1
  if grep -qv '^argocd/apps/entw/' <<<"$unmerged"; then return 1; fi
  git checkout HEAD -- argocd/apps/entw >/dev/null 2>&1 || return 1
  GIT_EDITOR=true git cherry-pick --continue >/dev/null 2>&1
}

short() { printf '%s' "${1:0:7}"; }

subject() { git log -1 --format=%s "$1"; }

repo_url() { printf 'https://github.com/%s' "${GITHUB_REPOSITORY:-pkr-lab/capulus-core}"; }

ensure_label() {
  gh_run label create "$1" --color "$2" --description "$3" 2>/dev/null || true
}

# Ein offenes Issue mit der Kurz-SHA im Titel bedeutet: fuer diesen entw-Stand ist
# bereits Bescheid gegeben (Konflikt oder rotes CI) - nicht erneut versuchen.
open_issue_for_head() {
  [ -z "${DRY_RUN:-}" ] || return 1
  command -v gh >/dev/null || return 1
  [ -n "${GH_TOKEN:-}" ] || return 1
  gh issue list --state open --label "$ISSUE_LABEL" --json title --jq '.[].title' 2>/dev/null \
    | grep -qF "$(short "$1")"
}

cmd_detect() {
  fetch_refs
  local head base n changed=false
  head=$(git rev-parse "origin/${ENTW}")
  base=$(base_commit)
  n=$(candidates "$base" "$head" | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ]; then
    changed=true
    if open_issue_for_head "$head"; then
      log "Fuer $(short "$head") gibt es bereits ein offenes ${ISSUE_LABEL}-Issue - kein neuer Versuch."
      changed=false
    fi
  fi
  log "entw=$(short "$head") base=$(short "$base") neue Commits=$n changed=$changed"
  emit "head=$head" "base=$base" "changed=$changed"
}

cmd_report_ci_failure() {
  : "${PROMOTE_HEAD:?PROMOTE_HEAD fehlt}"
  local head=$PROMOTE_HEAD run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
  ensure_label "$ISSUE_LABEL" d93f0b "Promotion entw -> main blockiert"
  gh_run issue create --label "$ISSUE_LABEL" \
    --title "ENTW-CI rot bei $(short "$head") - Promotion nach main blockiert" \
    --body "Die CI-Pruefungen fuer \`entw\` @ [\`$(short "$head")\`]($(repo_url)/commit/$head) sind fehlgeschlagen, es wurde **kein** PR nach main geoeffnet und der Tag \`${TAG}\` nicht bewegt.

Lauf: ${run_url}

Weiter mit: Fehler auf \`entw\` beheben und pushen (neuer Stand -> neuer Versuch). Dieses Issue schliesst sich nicht selbst; die naechste erfolgreiche Promotion schliesst alle offenen \`${ISSUE_LABEL}\`-Issues."
}

close_open_issues() {
  local msg=$1 nr
  [ -z "${DRY_RUN:-}" ] || return 0
  for nr in $(gh issue list --state open --label "$ISSUE_LABEL" --json number --jq '.[].number'); do
    gh issue close "$nr" --comment "$msg" >/dev/null || true
  done
}

move_tag() {
  git tag -f "$TAG" "$1" >/dev/null
  git push --force origin "refs/tags/${TAG}"
  log "Tag ${TAG} -> $(short "$1")"
}

cmd_promote() {
  : "${PROMOTE_HEAD:?PROMOTE_HEAD fehlt}"
  if [ -z "${GH_TOKEN:-}" ]; then
    log "GH_TOKEN fehlt: Repo-Secret PROMOTE_TOKEN (oder RENOVATE_TOKEN) anlegen. Ein PAT ist noetig, weil PRs/Pushes"
    log "mit dem Standard-GITHUB_TOKEN keine weiteren Workflows (die CI auf dem PR) ausloesen."
    exit 1
  fi

  fetch_refs
  local head=$PROMOTE_HEAD base branch c before
  base=$(base_commit)
  branch="promote/entw-$(short "$head")"

  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git checkout -q -B "$branch" "origin/${MAIN}"

  local picked=() skipped=() already=() conflict="" conflict_files=""
  for c in $(candidates "$base" "$head"); do
    if is_entw_only "$c"; then
      skipped+=("$c")
      continue
    fi
    before=$(git rev-parse HEAD)
    if git cherry-pick -x --empty=drop "$c" >/dev/null 2>&1 || resolve_entw_only_conflict; then
      if [ "$(git rev-parse HEAD)" = "$before" ]; then already+=("$c"); else picked+=("$c"); fi
    else
      conflict=$c
      conflict_files=$(git diff --name-only --diff-filter=U | sed 's/^/- `/; s/$/`/')
      git cherry-pick --abort
      break
    fi
  done

  if [ -n "$conflict" ]; then
    log "Konflikt beim Uebernehmen von $(short "$conflict")"
    ensure_label "$ISSUE_LABEL" d93f0b "Promotion entw -> main blockiert"
    gh_run issue create --label "$ISSUE_LABEL" \
      --title "ENTW -> main: Konflikt bei $(short "$head") ($(short "$conflict"))" \
      --body "Beim Uebernehmen von \`entw\` nach \`main\` ist ein Cherry-Pick-Konflikt aufgetreten. Es wurde **kein** PR geoeffnet und der Tag \`${TAG}\` nicht bewegt.

Commit: [\`$(short "$conflict")\`]($(repo_url)/commit/$conflict) - $(subject "$conflict")

Konfliktdateien:
${conflict_files:-_(nicht ermittelbar)_}

**Loesung:** die Aenderung von Hand nach \`main\` uebertragen (eigener PR), danach den Tag setzen, damit dieser Stand nicht erneut uebergeben wird:

\`\`\`
git fetch origin && git tag -f ${TAG} ${head} && git push --force origin refs/tags/${TAG}
\`\`\`

Alternativ die Commit-Nachricht auf \`entw\` mit \`${MARKER}\` versehen, wenn die Aenderung nur ENTW betrifft."
    exit 1
  fi

  if [ "${#picked[@]}" -eq 0 ]; then
    log "Nichts zu uebergeben (${#skipped[@]} x ${MARKER}, ${#already[@]} bereits in main) - setze nur den Tag."
    move_tag "$head"
    close_open_issues "Erledigt: entw @ $(short "$head") enthaelt nichts, was nach main uebergeben werden muss."
    return 0
  fi

  # Neue Dateien im alten Layout (platform/workloads) haben auf main keinen Platz mehr
  # (tech/prod) - Cherry-Pick erkennt Umzuege bestehender Dateien, aber keine Neuanlagen.
  local legacy draft=() draft_note=""
  legacy=$(git diff --name-only "origin/${MAIN}" HEAD | grep -E '^argocd/apps/(platform|workloads)/' || true)
  if [ -n "$legacy" ]; then
    draft=(--draft)
    draft_note="

> [!WARNING]
> Der PR legt Dateien im **alten Layout** an (\`argocd/apps/platform|workloads/\`), das auf \`main\` nicht mehr existiert. Nach \`tech/\` oder \`prod/\` verschieben, dann \"Ready for review\":
>
$(printf '%s\n' "$legacy" | sed 's/^/> - `/; s/$/`/')"
  fi

  git push --force origin "$branch"

  local body list_picked list_skipped
  list_picked=$(for c in "${picked[@]}"; do printf -- '- [`%s`](%s/commit/%s) %s\n' "$(short "$c")" "$(repo_url)" "$c" "$(subject "$c")"; done)
  list_skipped=""
  if [ "${#skipped[@]}" -gt 0 ]; then
    list_skipped="
### Nicht uebernommen (\`${MARKER}\` oder nur \`argocd/apps/entw/\`)
$(for c in "${skipped[@]}"; do printf -- '- [`%s`](%s/commit/%s) %s\n' "$(short "$c")" "$(repo_url)" "$c" "$(subject "$c")"; done)
"
  fi
  body="Automatisch erzeugt aus \`entw\` @ [\`$(short "$head")\`]($(repo_url)/commit/$head). Die CI-Pruefungen (lint, kubeconform, go, gitleaks) sind auf \`entw\` gruen durchgelaufen; auf diesem PR laufen sie erneut gegen das Ergebnis auf \`main\`.

### Uebernommene Commits (Cherry-Pick, \`-x\` verweist auf das Original)
${list_picked}
${list_skipped}${draft_note}

**Merge = Rollout:** \`main\` ist die Quelle fuer TECH und PROD, ArgoCD synct nach dem Merge sofort. Deshalb kein Auto-Merge - bitte pruefen, ob der Stand auf ENTW wirklich gesund ist. Der Tag \`${TAG}\` steht schon auf \`$(short "$head")\`, dieselben Commits kommen also nicht erneut.

Details: docs/f-cicd-automatisierung/f0080-entw-promotion.md"

  ensure_label "$PR_LABEL" 0e8a16 "Automatische Promotion aus ENTW"
  local existing=""
  if [ -z "${DRY_RUN:-}" ]; then
    existing=$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')
  fi
  if [ -n "$existing" ]; then
    log "PR #${existing} fuer ${branch} existiert - Branch wurde aktualisiert."
  else
    gh_run pr create --base "$MAIN" --head "$branch" "${draft[@]}" --label "$PR_LABEL" \
      --title "chore(entw): ${#picked[@]} Aenderung(en) aus ENTW uebernehmen ($(short "$head"))" \
      --body "$body"
  fi

  move_tag "$head"
  close_open_issues "Erledigt: PR fuer entw @ $(short "$head") wurde geoeffnet."
}

case "${1:-}" in
  detect) cmd_detect ;;
  promote) cmd_promote ;;
  report-ci-failure) cmd_report_ci_failure ;;
  *)
    echo "Aufruf: $0 detect | promote | report-ci-failure" >&2
    exit 2
    ;;
esac
