# Hintergründe zum Code — Übersicht

Der Code in diesem Repo (Ansible, Helm-Charts, Skripte, Workflows, iOS-App) enthält keine Kommentare. Alles, was früher als Kommentar neben dem Code stand — **warum** etwas so gebaut ist,
welcher Vorfall eine Regel ausgelöst hat, welche Fallstricke es gibt und was man beim Ändern beachten muss —, steht stattdessen in dieser Kategorie.

Die Fach-Kategorien (`a`–`f`, `1`–`3`) beschreiben, **was läuft und wie man es bedient**. Diese Kategorie beschreibt, **warum es so ist**. Die Zeitachse eines Vorfalls steht in
[`5-incidents/`](../5-incidents/50010-prod-vm-basis-image-ersetzt.md) oder [d0000](../d-sicherheit/d0000-incident-2026-08-12.md), hier steht die Regel, die daraus folgt.

---

## Die Docs

| Doc | Inhalt |
|---|---|
| [60010 Ansible: Hosts, VMs und Playbooks](60010-ansible-hosts-und-playbooks.md) | ENTW- und PROD-VM, Rolle `libvirt_host` (Bridge, dnsmasq-Snippet, Basis-Image), DNS der VMs, Worker-Playbooks und ihre Reihenfolge, Tailscale-Auth-Keys, WireGuard-Notzugang |
| [60020 Ansible: Rollen](60020-ansible-rollen.md) | Kiosk-Geräte (alamos, Banana Pi, Xibo), Energie-Rollen, Watchdogs, vmagent und Exporter, `journal_upload`, Semaphore-Rollen, `wireguard_backup`, `vaultwarden_restore` |
| [60030 ArgoCD, Bootstrap und SealedSecrets](60030-argocd-und-bootstrap.md) | Generierte Bootstrap-Dateien, `ignoreDifferences`, Rolle `argocd`, PROD im Hub, Daten-Migrationen, Promotion-Konfiguration, Fallstricke beim Versiegeln |
| [60040 Helm-Charts im TECH-Cluster](60040-helm-charts-tech.md) | Gemeinsame Muster (HPA, Speicher, Root-Container), Zertifikate und TLS, Traefik-Metriken, cloudflared, alle TECH-Apps von alamos bis zammad |
| [60050 Helm-Charts im PROD-Cluster](60050-helm-charts-prod.md) | Regeln für PROD-Kopien, Nextcloud, Immich, Wiki.js und wiki-docs-sync, Xibo, Paperless-ngx, Mealie, TinyTeller |
| [60060 Monitoring und Alerting](60060-monitoring-und-alerting.md) | Alertmanager-Routing, alle VMRules, Scrapes und Labels, VictoriaMetrics, Grafana-Ordner, Logging |
| [60070 Authentik und lldap](60070-authentik-und-lldap.md) | Blueprint-Fallstricke aus dem Live-Betrieb, Chart und Secrets, lldap |
| [60080 carplay-api und iOS-App](60080-carplay-api-und-ios-app.md) | Verträge, Absicherung, Datenquellen, Transport und Tailscale in der App, Modelle und Bedienung |
| [60090 pacman (Schulungsobjekt)](60090-pacman-schulungsobjekt.md) | Server, Bestenliste, Zugriffslog, Trainingsmodus, Frontend-Skripte |
| [600a0 CI-Workflows, Skripte und Lint](600a0-ci-workflows-und-skripte.md) | Alle Workflows, Promotions- und Sync-Skripte, Ruleset, `.ansible-lint`, `.yamllint` |

## So ist ein Eintrag aufgebaut

- Eine Aussage hat eine **Fundstelle** (Pfad, Datei oder Rolle in Backticks) und eine **Begründung**. Wo es einen Vorfall gab, steht sein Datum dabei.
- Wer den Code an einer solchen Stelle ändern will, prüft **zuerst** den Eintrag: Die meisten Regeln existieren, weil ein naheliegender Ansatz schon einmal gescheitert ist.
- Ein Eintrag beschreibt den **Grund**, nicht den Inhalt des Codes. Was der Code tut, steht im Code und in den Fach-Docs.

## Neue Begründungen eintragen

Kommentare **nicht** wieder in den Code schreiben. Eine neue Begründung, einen neuen Fallstrick oder eine neue Entscheidung trägt man im **selben PR** wie die Codeänderung in das Doc der passenden Fläche ein
(Tabelle unten), unter der Komponente, zu der sie gehört. Passt ein Thema in kein bestehendes Doc, entsteht ein neues Doc mit der nächsten freien ID (`6xxxx`, in `0x10`-Schritten,
siehe [TEMPLATE](../TEMPLATE.md)).

## Von der Datei zum Eintrag

| Pfad | Doc |
|---|---|
| `ansible/host_vars/`, `ansible/group_vars/`, `ansible/inventory/`, `ansible/*.yml`, `ansible/roles/libvirt_host`, `ansible/roles/dnsmasq`, `ansible/roles/disable_eee` | [60010](60010-ansible-hosts-und-playbooks.md) |
| `ansible/roles/*` (übrige Rollen) | [60020](60020-ansible-rollen.md) |
| `ansible/roles/argocd`, `argocd/bootstrap/`, `argocd/bootstrap-prod/`, `argocd/promotion.yaml`, SealedSecrets | [60030](60030-argocd-und-bootstrap.md) |
| `argocd/apps/tech/*` (ohne monitoring, authentik, lldap, carplay-api, pacman) | [60040](60040-helm-charts-tech.md) |
| `argocd/apps/prod/*`, `argocd/apps/entw/*` | [60050](60050-helm-charts-prod.md) |
| `argocd/apps/tech/monitoring`, `argocd/apps/tech/logging` | [60060](60060-monitoring-und-alerting.md) |
| `argocd/apps/tech/authentik`, `argocd/apps/tech/lldap` | [60070](60070-authentik-und-lldap.md) |
| `argocd/apps/tech/carplay-api`, `ios/` | [60080](60080-carplay-api-und-ios-app.md) |
| `argocd/apps/tech/pacman` | [60090](60090-pacman-schulungsobjekt.md) |
| `.github/workflows/`, `scripts/`, `Makefile`, `.ansible-lint`, `.yamllint` | [600a0](600a0-ci-workflows-und-skripte.md) |

## Sync ins Wiki

Die Docs werden von `wiki-docs-sync` nach Wiki.js gespiegelt (eine Ebene tief, also auch diese Kategorie). Jeder zusätzliche Kategorie-Ordner kostet einen weiteren GitHub-API-Call je Lauf, siehe
[60050](60050-helm-charts-prod.md#wikijs-und-wiki-docs-sync).
