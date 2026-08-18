# Convenience targets for the home-server playbook.
# Run `make help` to see what's available.

ANSIBLE_DIR := ansible
INVENTORY   := $(ANSIBLE_DIR)/inventory/hosts.yml
PLAYBOOK    := $(ANSIBLE_DIR)/site.yml
VAULT_OPTS  ?= --ask-vault-pass
HS2_PLAYBOOK := $(ANSIBLE_DIR)/worker-0.yml
HS3_PLAYBOOK := $(ANSIBLE_DIR)/worker-1.yml

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help.
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_-]+:.*?## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: deps
deps: ## Install required Ansible Galaxy collections.
	ansible-galaxy collection install -r $(ANSIBLE_DIR)/requirements.yml

.PHONY: ping
ping: ## Verify Ansible can reach the server.
	ansible -i $(INVENTORY) homeserver -m ping

.PHONY: check
check: ## Dry-run the full playbook (no changes applied).
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --check --diff $(VAULT_OPTS)

.PHONY: install
install: deps ## Provision the home server end-to-end.
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) $(VAULT_OPTS)

.PHONY: common crowdsec dnsmasq tailscale k3s k3s-agent argocd semaphore semaphore-targets semaphore-bootstrap semaphore-bootstrap-local worker-0 worker-0-check worker-1 worker-1-check cluster-power-manager power-agent cups-print-server nightly-worker-wake worker-apt-update
common: ## Run only the `common` role (base OS, firewall, packages).
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags common $(VAULT_OPTS)

crowdsec: ## Run only the `crowdsec` role (SSH + Traefik brute-force protection).
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags crowdsec $(VAULT_OPTS)

dnsmasq: ## Run only the `dnsmasq` role (split-DNS for *.homeserver).
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags dnsmasq $(VAULT_OPTS)

tailscale: ## Run only the `tailscale` role (VPN).
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags tailscale $(VAULT_OPTS)

k3s: ## Run only the `k3s` role (Kubernetes + Helm) on homeserver.
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags k3s $(VAULT_OPTS)

k3s-agent: ## Join worker-0 as k3s worker node (requires homeserver k3s running).
	ansible-playbook -i $(INVENTORY) $(HS2_PLAYBOOK) --tags k3s-agent $(VAULT_OPTS)

argocd: ## Run only the `argocd` role (GitOps controller).
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags argocd $(VAULT_OPTS)

semaphore: ## Bootstrap Semaphore Secret on the home-server.
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags semaphore-secrets $(VAULT_OPTS)

semaphore-targets: ## Push Semaphore SSH key to all managed targets.
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags semaphore-targets $(VAULT_OPTS)

semaphore-bootstrap: ## Provision Projects/Inventories/Templates in Semaphore via API.
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags semaphore-bootstrap $(VAULT_OPTS)

semaphore-bootstrap-local: ## Bootstrap Semaphore natively on the home server (no SSH).
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) \
	    --connection local \
	    --extra-vars "ansible_host=127.0.0.1 ansible_user=$$(whoami)" \
	    --tags semaphore-bootstrap $(VAULT_OPTS)

worker-0: ## Deploy k3s agent + watchdogs on worker-0 (192.168.178.95).
	ansible-playbook -i $(INVENTORY) $(HS2_PLAYBOOK) $(VAULT_OPTS)

worker-0-check: ## Dry-run the worker-0 playbook (no changes applied).
	ansible-playbook -i $(INVENTORY) $(HS2_PLAYBOOK) --check --diff $(VAULT_OPTS)

worker-1: ## Deploy k3s agent + watchdogs on worker-1 (192.168.178.96).
	ansible-playbook -i $(INVENTORY) $(HS3_PLAYBOOK) $(VAULT_OPTS)

worker-1-check: ## Dry-run the worker-1 playbook (no changes applied).
	ansible-playbook -i $(INVENTORY) $(HS3_PLAYBOOK) --check --diff $(VAULT_OPTS)

cluster-power-manager: ## Re-deploy only the cluster_power_manager role on homeserver (WoL scale-up/down).
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags cluster-power-manager $(VAULT_OPTS)

power-agent: ## Re-deploy only the power_agent role on homeserver (brightness + manual WoL/poweroff HTTP API).
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags power-agent $(VAULT_OPTS)

cups-print-server: ## Re-deploy only the cups_print_server role on homeserver (USB-Drucker per IPP/AirPrint).
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags cups-print-server $(VAULT_OPTS)

nightly-worker-wake: ## Re-deploy only the nightly_worker_wake role on homeserver (01:00 Uhr WoL+Update+Poweroff-Zyklus).
	ansible-playbook -i $(INVENTORY) $(PLAYBOOK) --tags nightly-worker-wake $(VAULT_OPTS)

worker-apt-update: ## Manuelles apt-Update auf worker-0 + worker-1 (läuft normalerweise nachts automatisch über nightly-worker-wake).
	ansible-playbook -i $(INVENTORY) $(HS2_PLAYBOOK) --tags apt-update $(VAULT_OPTS)
	ansible-playbook -i $(INVENTORY) $(HS3_PLAYBOOK) --tags apt-update $(VAULT_OPTS)

.PHONY: windows windows-check windows-users windows-software windows-settings
WIN_PLAYBOOK := $(ANSIBLE_DIR)/windows.yml

windows: ## Einrichten aller Windows-PCs (DLRG OG Andernach).
	ansible-playbook -i $(INVENTORY) $(WIN_PLAYBOOK) $(VAULT_OPTS)

windows-check: ## Dry-run des Windows-Playbooks (keine Änderungen).
	ansible-playbook -i $(INVENTORY) $(WIN_PLAYBOOK) --check --diff $(VAULT_OPTS)

windows-users: ## Nur Benutzer auf Windows-PCs anlegen/aktualisieren.
	ansible-playbook -i $(INVENTORY) $(WIN_PLAYBOOK) --tags users $(VAULT_OPTS)

windows-software: ## Nur Software auf Windows-PCs installieren.
	ansible-playbook -i $(INVENTORY) $(WIN_PLAYBOOK) --tags software $(VAULT_OPTS)

windows-settings: ## Nur System-Einstellungen auf Windows-PCs konfigurieren.
	ansible-playbook -i $(INVENTORY) $(WIN_PLAYBOOK) --tags settings $(VAULT_OPTS)

.PHONY: alarm-kiosks alarm-kiosks-check
ALARM_PLAYBOOK := $(ANSIBLE_DIR)/alarm-kiosks.yml

alarm-kiosks: ## Alarmmonitor-Kiosks einrichten (Raspberry Pis, ALAMOS AMweb).
	ansible-playbook -i $(INVENTORY) $(ALARM_PLAYBOOK) $(VAULT_OPTS)

alarm-kiosks-check: ## Dry-run des Alarmmonitor-Kiosk-Playbooks (keine Änderungen).
	ansible-playbook -i $(INVENTORY) $(ALARM_PLAYBOOK) --check --diff $(VAULT_OPTS)

.PHONY: xibo-kiosks xibo-kiosks-check
XIBO_PLAYBOOK := $(ANSIBLE_DIR)/xibo-kiosks.yml

xibo-kiosks: ## xibosignage-Displays einrichten (Raspberry Pi 3B+, Bilder-Slideshow, Tailscale).
	ansible-playbook -i $(INVENTORY) $(XIBO_PLAYBOOK) $(VAULT_OPTS)

xibo-kiosks-check: ## Dry-run des xibosignage-Displays-Playbooks (keine Änderungen).
	ansible-playbook -i $(INVENTORY) $(XIBO_PLAYBOOK) --check --diff $(VAULT_OPTS)

.PHONY: banana-pi-kiosks banana-pi-kiosks-check banana-pi-kiosks-restart-session
BANANA_PI_PLAYBOOK := $(ANSIBLE_DIR)/banana-pi-kiosks.yml

banana-pi-kiosks: ## Banana-Pi-Alarmmonitore einrichten (Armbian, ALAMOS AMweb + Server-Fallback).
	ansible-playbook -i $(INVENTORY) $(BANANA_PI_PLAYBOOK) $(VAULT_OPTS)

banana-pi-kiosks-check: ## Dry-run des Banana-Pi-Alarmmonitor-Playbooks (keine Änderungen).
	ansible-playbook -i $(INVENTORY) $(BANANA_PI_PLAYBOOK) --check --diff $(VAULT_OPTS)

# Der "Kiosk-Supervisor-Skript deployen"-Task (ansible/roles/banana_pi_kiosk/
# tasks/main.yml) loest den "Reload getty@tty1"-Handler nur bei Ansible
# "changed" aus -- liegt das Skript auf der Platte bereits korrekt (z. B.
# weil ein frueherer Lauf es schon geschrieben hat, bevor dieser notify
# existierte), meldet der Task "ok" und der laengst laufende Prozess bleibt
# mit veralteten Werten (z. B. BASE_URL) im Speicher haengen, da er sich
# nicht selbst neu einliest. Dieses Target erzwingt den Neustart der
# tty1-Session unabhaengig von einem Playbook-Diff. Braucht kein
# Vault-Passwort, da der Ad-hoc-Befehl keine vault-verschluesselten
# Variablen referenziert.
banana-pi-kiosks-restart-session: ## tty1-Session auf den Banana-Pi-Alarmmonitoren erzwungen neu starten (laedt bereits deployte Skripte/Configs neu ein, ohne dass ein Playbook-Diff noetig ist).
	ansible -i $(INVENTORY) banana_pis -m ansible.builtin.systemd -a "name=getty@tty1.service state=restarted" --become

.PHONY: lint
lint: ## Lint YAML, Ansible, and ALL Helm charts.
	yamllint -c .yamllint ansible/ argocd/
	ansible-lint $(ANSIBLE_DIR)/
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

.PHONY: render-bootstrap
render-bootstrap: ## Regenerate argocd/bootstrap/root-applicationset.yaml from the role template.
	ansible-playbook $(ANSIBLE_DIR)/render-bootstrap.yml --connection local $(VAULT_OPTS)

.PHONY: vault-edit
vault-edit: ## Edit the vault-encrypted vars file.
	ansible-vault edit $(ANSIBLE_DIR)/group_vars/all.yml

.PHONY: vaultwarden-restore
VAULTWARDEN_RESTORE_PLAYBOOK := $(ANSIBLE_DIR)/vaultwarden-restore.yml
FORCE_RESTORE ?= false

vaultwarden-restore: ## Vaultwarden-Daten aus der NAS-Backup-PVC wiederherstellen (ueberschreibt Live-Daten!). Erst mit FORCE_RESTORE=true bestaetigen.
	ansible-playbook -i $(INVENTORY) $(VAULTWARDEN_RESTORE_PLAYBOOK) -e force_restore=$(FORCE_RESTORE) $(VAULT_OPTS)

.PHONY: clean
clean: ## Remove cached collections and temp artifacts.
	rm -rf ~/.ansible/collections/ansible_collections/{ansible,community,kubernetes}
