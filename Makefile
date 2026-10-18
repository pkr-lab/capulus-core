.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help.
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_-]+:.*?## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: lint
lint: ## Lint YAML and ALL Helm charts.
	yamllint -c .yamllint argocd/
	@if command -v helm >/dev/null; then \
	    for chart in argocd/apps/*/*/; do \
	        [ -f "$${chart}Chart.yaml" ] || continue; \
	        if grep -q '^dependencies:' "$${chart}Chart.yaml"; then \
	            echo "==> helm dependency build $${chart}"; \
	            helm dependency build "$${chart}" || helm dependency update "$${chart}"; \
	        fi; \
	        echo "==> helm lint $${chart}"; \
	        helm lint "$${chart}"; \
	    done; \
	else \
	    echo "helm not installed — skipping chart lint"; \
	fi
