#!/usr/bin/env bash
# Legt das Ruleset "main: PR + CI" an (bzw. aktualisiert es): main nur noch per
# Pull Request, dazu die CI-Jobs aus .github/workflows/ci.yml als Pflicht-Checks.
# Beschreibung und Begruendung: docs/f-cicd-automatisierung/f0090-branch-schutz-main.md
#
#   scripts/setup-main-ruleset.sh --dry-run   zeigt das JSON, aendert nichts
#   scripts/setup-main-ruleset.sh             legt an / aktualisiert (gh muss als Admin angemeldet sein)
#
# ERST AUSFUEHREN, wenn ci.yml mit den vier Jobs schon auf main liegt - sonst verlangt
# das Ruleset Checks, die es nirgends gibt, und jeder PR bleibt ewig auf "pending".
# Die Namen unten muessen den `name:` der Jobs in ci.yml entsprechen.
#
# Ablauf danach: kein Direkt-Push auf main mehr (auch nicht fuer den Admin). Ausnahme
# "Notausgang": als Repo-Admin kann ein PR trotz roter/fehlender Checks gemergt werden
# (bypass_mode "pull_request") - gedacht fuer den Fall, dass die CI selbst kaputt ist.
set -euo pipefail

NAME="main: PR + CI"

ruleset_json() {
  cat <<'JSON'
{
  "name": "main: PR + CI",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "make lint (yamllint, ansible-lint, helm lint)" },
          { "context": "helm template | kubeconform" },
          { "context": "go build, vet, test, tidy" },
          { "context": "docs links" },
          { "context": "gitleaks" }
        ]
      }
    }
  ]
}
JSON
}

if [ "${1:-}" = "--dry-run" ]; then
  ruleset_json | jq .
  exit 0
fi

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
existing=$(gh api "repos/${repo}/rulesets" --jq ".[] | select(.name == \"${NAME}\") | .id")

if [ -n "$existing" ]; then
  echo "Aktualisiere Ruleset ${existing} in ${repo} ..."
  ruleset_json | gh api --method PUT "repos/${repo}/rulesets/${existing}" --input - --jq '"ok: \(.name) (\(.enforcement))"'
else
  echo "Lege Ruleset in ${repo} an ..."
  ruleset_json | gh api --method POST "repos/${repo}/rulesets" --input - --jq '"ok: \(.name) (\(.enforcement))"'
fi
