#!/usr/bin/env bash
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
