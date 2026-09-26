<p align="center">
  <img src="docs/assets/banner.svg" alt="capulus-core — GitOps Home Lab on k3s, ArgoCD, Tailscale" width="100%" />
</p>

<p align="center">
  <a href="https://ubuntu.com/server"><img alt="Ubuntu" src="https://img.shields.io/badge/Ubuntu-26.04_LTS-E95420?style=for-the-badge&logo=ubuntu&logoColor=white"></a>&nbsp;
  <a href="https://k3s.io"><img alt="k3s" src="https://img.shields.io/badge/k3s-stable-FFC61C?style=for-the-badge&logo=kubernetes&logoColor=black"></a>&nbsp;
  <a href="https://argo-cd.readthedocs.io"><img alt="ArgoCD" src="https://img.shields.io/badge/ArgoCD-GitOps-EF7B4D?style=for-the-badge&logo=argo&logoColor=white"></a>&nbsp;
  <a href="https://tailscale.com"><img alt="Tailscale" src="https://img.shields.io/badge/Tailscale-VPN-246FDB?style=for-the-badge&logo=tailscale&logoColor=white"></a>&nbsp;
  <a href="https://www.cloudflare.com/products/tunnel/"><img alt="Cloudflare Tunnel" src="https://img.shields.io/badge/Cloudflare-Tunnel-F38020?style=for-the-badge&logo=cloudflare&logoColor=white"></a>&nbsp;
  <a href="https://www.ansible.com"><img alt="Ansible" src="https://img.shields.io/badge/Ansible-IaC-EE0000?style=for-the-badge&logo=ansible&logoColor=white"></a>
</p>

<p align="center">
  <img alt="Lizenz" src="https://img.shields.io/badge/Lizenz-MIT-22D3EE?style=flat-square">&nbsp;
  <img alt="GitOps" src="https://img.shields.io/badge/GitOps-driven-A78BFA?style=flat-square">&nbsp;
  <img alt="Self-hosted" src="https://img.shields.io/badge/Self--hosted-100%25-34D399?style=flat-square">&nbsp;
  <img alt="Multi-Cluster" src="https://img.shields.io/badge/Multi--Cluster-ENTW_%C2%B7_TECH_%C2%B7_PROD-F59E0B?style=flat-square">
</p>

<br/>

<p align="center">
  <strong>Vollständig automatisierter, GitOps-getriebener Home-Server mit drei getrennten Clustern.</strong><br/>
  Ansible liefert gehärtete Ubuntu-Hosts, drei schlanke Kubernetes-Cluster (<a href="https://k3s.io">k3s</a>: <b>TECH</b>, <b>PROD</b>, <b>ENTW</b>), Continuous Delivery aus Git (<a href="https://argo-cd.readthedocs.io">ArgoCD</a>) und Zero-Config-Remote-Access (<a href="https://tailscale.com">Tailscale</a>). Neue Versionen laufen erst auf ENTW und wandern nach bestandenem Gesundheits-Gate automatisch als PR nach TECH und PROD.
</p>

<br/>

---

## ⚡ TL;DR

```bash
# 1) Repo klonen
git clone https://github.com/pkr-lab/capulus-core.git && cd capulus-core

# 2) Eigene Details eintragen (Server-IP, Repo-URL, Tailscale-Key)
$EDITOR ansible/inventory/hosts.yml
$EDITOR ansible/group_vars/all.yml

# 3) Collections installieren und Playbook laufen lassen
make install
# oder:
# ansible-galaxy collection install -r ansible/requirements.yml
# ansible-playbook -i ansible/inventory/hosts.yml ansible/site.yml --ask-vault-pass
```

> Am Ende druckt das Playbook die ArgoCD-URL und das Admin-Passwort. Damit steht der **TECH**-Cluster
> mit ArgoCD-Hub. PROD und ENTW kommen als KVM-VMs dazu, siehe [Drei Cluster](#drei-cluster).

---

## Was du bekommst

<table>
<thead>
<tr>
<th>Schicht</th>
<th>Komponente</th>
<th>Hinweis</th>
</tr>
</thead>
<tbody>
<tr><td>Betriebssystem</td><td><strong>Ubuntu Server 26.04 LTS</strong></td><td>Gehärtet, UFW-Firewall, CrowdSec, NTP-synced, Swap off</td></tr>
<tr><td>Kubernetes</td><td><strong>k3s</strong> (Kanal <code>stable</code>)</td><td><b>Drei Cluster</b>: TECH (bare metal), PROD und ENTW (KVM-VMs); Traefik, CoreDNS, local-path, metrics-server</td></tr>
<tr><td>Virtualisierung</td><td><strong>KVM/libvirt</strong></td><td>PROD-VM auf dem Homeserver, ENTW-VM auf worker-1, Bridge-Netz direkt im LAN</td></tr>
<tr><td>GitOps</td><td><strong>ArgoCD</strong> + ApplicationSets</td><td>Ein Hub für TECH + PROD, eine eigene Instanz für ENTW. Ordner unter <code>argocd/apps/&lt;cluster&gt;/</code> anlegen → mergen → deployed</td></tr>
<tr><td>Promotion</td><td><strong>GitHub Actions</strong></td><td>Version läuft erst auf ENTW (24 h), dann TECH (2 h), dann PROD — jeweils als PR mit Gesundheits-Gate</td></tr>
<tr><td>Identität</td><td><strong>Authentik + lldap</strong></td><td>Zentrales SSO/2FA per Traefik-ForwardAuth, Nutzer im LDAP-Verzeichnis</td></tr>
<tr><td>Split-DNS</td><td><strong>dnsmasq</strong> auf <code>tailscale0</code></td><td><code>*.homeserver</code> aus LAN und Tailnet auflösbar, verteilt auf TECH, PROD und ENTW</td></tr>
<tr><td>Werbeblocking</td><td><strong>Pi-hole</strong></td><td>Filtert DNS-Anfragen für alle Geräte, die dnsmasq bereits als DNS nutzen — kein Router-Eingriff nötig</td></tr>
<tr><td>Web-Ansible</td><td><strong>Semaphore UI</strong></td><td>Ein-Klick-<code>git pull &amp;&amp; ansible-playbook</code> gegen das eigene LAN</td></tr>
<tr><td>Monitoring &amp; Logs</td><td><strong>VictoriaMetrics + Grafana + VictoriaLogs</strong></td><td>Single-Node TSDB, vmagent, vmalert, Alertmanager, Hardware-Dashboards, zentrale Logs</td></tr>
<tr><td>Kubernetes-UI</td><td><strong>Headlamp</strong></td><td>Browser-Dashboard für den TECH-Cluster</td></tr>
<tr><td>Secrets</td><td><strong>Sealed Secrets + kubeseal-webgui</strong></td><td>Verschlüsselte Secrets in Git, je Cluster nur dort entschlüsselbar</td></tr>
<tr><td>Internes TLS</td><td><strong>cert-manager</strong></td><td>Eigene Root-CA, HTTPS auf <code>*.tech</code>/<code>*.prod.homeserver</code></td></tr>
<tr><td>Notifications</td><td><strong>Gotify</strong> + <strong>ntfy</strong></td><td>Self-hosted Push — Gotify (Android), ntfy (iOS + Android)</td></tr>
<tr><td>Live-Streaming</td><td><strong>MediaMTX</strong></td><td>RTMP/RTSP-Ingest → HLS-Playback; Publish/Zuschauer per interner mediamtx-Auth (Nutzername/Passwort)</td></tr>
<tr><td>Speicher</td><td><strong>UGREEN NAS (NFS)</strong></td><td>RAID1, StorageClasses <code>nas</code> und <code>immich-nas</code> für alle Cluster, restic-Backup auf USB-Platte</td></tr>
<tr><td>Remote-Access</td><td><strong>Tailscale</strong></td><td>WireGuard-Mesh-VPN — keine Portfreigaben, keine öffentliche IP</td></tr>
<tr><td>Externe Erreichbarkeit</td><td><strong>Cloudflare Tunnel</strong></td><td>Je Cluster ein Tunnel: ausgewählte Dienste öffentlich erreichbar, ohne VPN und ohne offene Ports</td></tr>
<tr><td>CI/CD intern</td><td><strong>Argo Workflows + MinIO</strong></td><td>Private CI/CD-Pipeline + S3-Artifact-Store im Cluster</td></tr>
<tr><td>Ingress</td><td><strong>Traefik</strong> (k3s bundled)</td><td>HTTP/HTTPS-Routing, je Cluster eine eigene Instanz</td></tr>
<tr><td>Provisioning</td><td><strong>Ansible</strong> (≥ 2.14)</td><td>Vollständig idempotent, Role-per-Concern, Vault für Secrets</td></tr>
</tbody>
</table>

> **Ziel-Hardware (nur TECH):** kleine Box mit ≥ 4 GB RAM und ≥ 20 GB Disk.
> **Referenz-Build:** HP ProBook 450 G9 (12 vCPU, ~61 GB RAM) als 24/7-Homeserver und Hypervisor, zwei per Wake-on-LAN
> geweckte Worker (Lenovo M90q, MSI Tower), ein UGREEN NAS. Die Größen der VMs stehen unter [Drei Cluster](#drei-cluster).

<details>
<summary><strong>Auto-Upgrade-Details</strong></summary>

`auto_upgrade: true` (Default) hält bei jedem Playbook-Run den gesamten Stack aktuell:

| Komponente | Mechanismus |
|---|---|
| **APT-Pakete** | `apt dist-upgrade` + `unattended-upgrades` für tägliche Sicherheits-Patches |
| **Tailscale** | `state: latest` für das `tailscale`-Paket |
| **k3s** | Folgt `k3s_channel` (Default `stable`), pin via `k3s_version` |
| **Helm** | Re-Run des offiziellen Installers bei neuem Release |
| **ArgoCD** | `helm upgrade --install` ohne `--version`, pin via `argocd_version` |
| **Reboot** | Auto-Reboot wenn APT `/var/run/reboot-required` setzt (togglebar via `auto_reboot_if_required`) |

Für reproduzierbare Builds: `auto_upgrade: false` in `ansible/group_vars/all.yml`.

</details>

---

## Quickstart (5 Schritte)

> Erstmalig auf der Maschine? Start mit **[Ubuntu-Server-Installation](docs/a-betriebssystem/a0000-ubuntu-server-install.md)**.
> Komplette Voraussetzungen: **[docs/a-betriebssystem/a0020-prerequisites.md](docs/a-betriebssystem/a0020-prerequisites.md)**.

<details open>
<summary><strong>Schritt-für-Schritt aufklappen</strong></summary>

**1. Repo klonen**

```bash
git clone https://github.com/pkr-lab/capulus-core.git
cd capulus-core
```

**2. Inventory auf den eigenen Server zeigen**

```bash
$EDITOR ansible/inventory/hosts.yml
# ansible_host (Server-IP) und ggf. ansible_ssh_private_key_file anpassen.
```

**3. Variablen setzen**

```bash
$EDITOR ansible/group_vars/all.yml
# Pflicht: argocd_repo_url, local_subnet, timezone.
# Tailscale-Key muss vault-encrypted sein (nächster Schritt).
```

**4. Tailscale-Auth-Key verschlüsseln**

```bash
ansible-vault encrypt_string 'tskey-auth-DEIN_KEY' --name 'tailscale_auth_key'
# Den !vault-Block in all.yml über den bestehenden tailscale_auth_key-Wert pasten.
```

**5. Playbook ausführen**

```bash
make install
# oder ohne make:
ansible-galaxy collection install -r ansible/requirements.yml
ansible-playbook -i ansible/inventory/hosts.yml ansible/site.yml --ask-vault-pass
```

**Ergebnis:**

```
ArgoCD UI:  https://argocd.tech.homeserver   (CLI/CI: http://<server-ip>:30080)
Username:   admin
Password:   <auto-generiert>
```

</details>

---

## Drei Cluster

Der Stack besteht seit September 2026 aus **drei getrennten k3s-Clustern**
([Architektur und Begründung](docs/4-planung/40080-multi-cluster-entw-prod-tech.md),
[Überblick](docs/a-betriebssystem/a0010-overview.md#1-drei-cluster-im-überblick)):

| Cluster | Läuft auf | IP | Für | ArgoCD | Ordner |
|---|---|---|---|---|---|
| **TECH** | `homeserver` (bare metal, 24/7) + Worker `worker-0`/`worker-1` | `192.168.178.94` | Infrastruktur und Betriebsdienste: Identität, Secrets, Monitoring, CI/CD, DNS, Zammad, Vaultwarden, n8n | **Hub**, verwaltet TECH **und** PROD | `argocd/apps/tech/` |
| **PROD** | KVM-VM `prod-vm` auf dem Homeserver (6 vCPU / 24 GiB) | `192.168.178.99` | Apps mit echtem Nutzerkreis: Nextcloud, Immich, Paperless-ngx, Wiki.js, Mealie, Xibo | — (vom Hub verwaltet) | `argocd/apps/prod/` |
| **ENTW** | KVM-VM `entw-vm` auf `worker-1` (3 vCPU / 12 GiB) | `192.168.178.100` | Entwicklung und Tests, absichtlich verwundbare Trainingsumgebung | eigene, isolierte Instanz (Branch `entw`) | `argocd/apps/entw/` |

```
Branch entw ──► ArgoCD ENTW ──► ENTW-Cluster
                    │  (24 h gesund, Smoke-Checks)
                    ▼
Branch main ──► ArgoCD-Hub ──► TECH-Cluster   (Promotion-PR, Auto-Merge optional)
                    │  (2 h gesund)
                    ▼
                 ArgoCD-Hub ──► PROD-Cluster  (Promotion-PR, du bestätigst)
```

Die Cluster aufbauen (nach `make install` für TECH):

```bash
make worker-0 worker-1        # Worker in den TECH-Cluster aufnehmen
make libvirt-host             # KVM + Bridge auf dem Homeserver, legt prod-vm an
make prod                     # k3s in der prod-vm; danach im Hub registrieren
                              # (argocd/bootstrap-prod/README.md)
make worker-1-libvirt-host    # KVM + Bridge auf worker-1, legt entw-vm an
make entw                     # k3s + ArgoCD in der entw-vm
```

> Ein Hostname wie `mealie.prod.homeserver` sagt nur etwas über das **Tier**, nicht über den Cluster: welcher
> Cluster antwortet, entscheidet das DNS ([c0040](docs/c-netzwerk-dns/c0040-domain-tiers.md#dns-tier-und-cluster-sind-zwei-verschiedene-dinge)).
> `kubectl`-Befehle in den App-Docs gelten für den Cluster, in dem die App läuft
> ([Zugriff je Cluster](docs/a-betriebssystem/a0010-overview.md#kubectl-zugriff-je-cluster)).

---

## Repository-Layout

<details>
<summary><strong>Verzeichnisstruktur anzeigen</strong></summary>

```
capulus-core/
├── README.md
├── Makefile                          # Convenience-Targets: install, prod, entw, worker-*, lint, render-bootstrap, …
├── IdeasToDeploy.md                  # Ideensammlung für spätere Apps und Vereins-IT
├── docs/                             # Dokumentation, Konventionen: docs/TEMPLATE.md (Kategorien siehe unten)
│   ├── a-betriebssystem/             # Betriebssystem, Architektur-Überblick, Installation
│   ├── b-kubernetes-gitops/          # k3s, ArgoCD, AppProjects, Semaphore, HPA, ENTW-ArgoCD
│   ├── c-netzwerk-dns/               # DNS, Tailscale, WireGuard-Backup, Pi-hole, Ports, Domain-Tiers
│   ├── d-sicherheit/                 # Härtung, CrowdSec, NetworkPolicies, TLS, Secrets, lldap + Authentik
│   ├── e-externe-erreichbarkeit/     # Cloudflare Tunnel
│   ├── f-cicd-automatisierung/       # CI, Promotion ENTW → TECH → PROD, Renovate, Releases, Mirror
│   ├── 1-benachrichtigungen/         # Gotify, ntfy
│   ├── 2-betrieb-hardware/           # NAS, Backup, Power-Manager, Drucker, Alerts, Hardware-Monitoring
│   ├── 3-apps-workloads/             # Doku je App
│   ├── 4-planung/                    # Pläne und Analysen (teils umgesetzt, siehe Statuszeile im Doc)
│   ├── 5-incidents/                  # Vorfallsberichte
│   ├── superpowers/                  # Datierte Plan-/Spec-Docs, eigenes Namensschema
│   └── assets/                       # Banner, Root-CA-Zertifikat
├── renovate.json                     # Renovate-Konfiguration (siehe docs/f-cicd-automatisierung/f0020-renovate.md)
├── .releaserc.json                   # semantic-release-Konfiguration (siehe docs/f-cicd-automatisierung/f0030-release-automation.md)
├── .github/
│   └── workflows/
│       ├── ci.yml                    # Pflicht-Gate auf PRs: lint, kubeconform, Go, gitleaks (f0070-ci-lint.md)
│       ├── build-images.yml          # Workload-Images bauen (auf PRs ohne Push, f0060-build-images.md)
│       ├── entw-trigger.yml          # Push auf entw startet promote-entw.yml sofort
│       ├── promote-entw.yml          # entw nach grüner CI als PR an main (f0080-entw-promotion.md)
│       ├── sync-entw.yml             # hält entw auf dem Stand von main: PR main → entw mit Auto-Merge (f0080)
│       ├── promote-chain.yml         # Versionen ENTW → TECH → PROD nach Gesundheits-Gate (f00b0-promotion-chain.md)
│       ├── release.yml               # semantic-release bei jedem Push auf main
│       ├── renovate.yml              # Self-hosted Renovate als Fallback (f0020-renovate.md)
│       ├── tailscale-poc.yml         # Manueller PoC: Runner im Tailnet (f00a0-tailscale-runner-poc.md)
│       └── mirror-gitlab.yml         # Vollspiegelung zu GitLab (f0050-gitlab-mirror.md)
├── scripts/                          # Helfer: promote-chain.py, sync-entw.sh, check-doc-links.py, reseal-for-prod.sh, seal-github-token.sh, …
├── ansible/
│   ├── site.yml                      # Entry-Point TECH-Homeserver (make install)
│   ├── worker-0.yml / worker-1.yml   # TECH-Worker (worker-1 ist zusätzlich ENTW-Hypervisor)
│   ├── prod.yml / entw.yml           # k3s in der PROD- bzw. ENTW-VM (+ ArgoCD auf ENTW)
│   ├── alarm-kiosks.yml / banana-pi-kiosks.yml / xibo-kiosks.yml   # Kiosk-Geräte
│   ├── vaultwarden-restore.yml       # Vaultwarden aus dem NAS-Backup wiederherstellen
│   ├── render-bootstrap.yml          # rendert argocd/bootstrap/ aus den Templates (make render-bootstrap)
│   ├── requirements.yml              # Galaxy-Collections
│   ├── ansible.cfg                   # Defaults
│   ├── inventory/hosts.yml           # Homeserver, Worker, prod-vm, entw-vm, NAS, Kiosks
│   ├── group_vars/                   # Alle Knobs (vault-verschlüsselte Secrets)
│   ├── host_vars/                    # je Host: homeserver (PROD-VM-Definition), worker-1 (ENTW-VM), prod-vm, entw-vm, …
│   └── roles/                        # Role-per-Concern, Übersicht: docs/a-betriebssystem/a0010-overview.md#8-ansible-rollen-und-ihr-wirkungsbereich
│       ├── common/ crowdsec/ dnsmasq/ tailscale/ wireguard_backup/ disable_eee/   # OS, Firewall, DNS, VPN
│       ├── k3s/ k3s_agent/ libvirt_host/ argocd/                                  # Cluster, VMs, GitOps-Controller
│       ├── semaphore_secrets/ semaphore_targets/ semaphore_bootstrap/             # Semaphore-Web-UI
│       ├── cluster_power_manager/ cluster_power_manager_target/ wake_on_lan/
│       │   nightly_worker_wake/ worker_apt_update/ power_agent/                   # Worker per WoL steuern, nächtliches Update
│       ├── thermal_watchdog/ resource_watchdog/                                   # Selbst-Abschaltung bei Übertemperatur/Dauerlast
│       ├── node_exporter/ smartctl_exporter/ vmagent/ journal_upload/             # Metriken und Logs
│       ├── cups_print_server/                                                     # USB-Drucker per IPP/AirPrint
│       ├── alamos_kiosk/ banana_pi_kiosk/ xibo_kiosk/                             # Raspberry-Pi-/Banana-Pi-Kiosks
│       └── vaultwarden_restore/                                                   # Vaultwarden aus dem NAS-Backup wiederherstellen
├── argocd/
│   ├── promotion.yaml                # Konfiguration der Promotion-Kette (Gates, Smoke-Checks), von keinem ApplicationSet gelesen
│   ├── bootstrap/                    # TECH-Hub: root-applicationset.yaml + projects.yaml (GENERIERT, make render-bootstrap)
│   ├── bootstrap-prod/               # PROD im Hub: AppProject + zwei ApplicationSets (handgeschrieben), migrations/ (Umzug mit Daten)
│   └── apps/                         # Ein Ordner pro ArgoCD-Application, je Cluster
│       ├── tech/                     # TECH-Cluster, Projekt "tech" — siehe docs/b-kubernetes-gitops/b0020-argocd-projects.md
│       │   ├── sealed-secrets/ kubeseal-webgui/ cert-manager/ traefik-config/ coredns-custom/   # Secrets, TLS, Ingress/DNS-Konfiguration
│       │   ├── authentik/ lldap/                              # SSO/2FA und LDAP-Nutzerverzeichnis
│       │   ├── monitoring/ logging/                           # VictoriaMetrics + Grafana, VictoriaLogs
│       │   ├── gotify/ gotify-bridge/ ntfy/ ntfy-bridge/      # Push-Notifications + Alertmanager-Brücken
│       │   ├── cloudflared/ pihole/                           # Cloudflare Tunnel, DNS-Filter
│       │   ├── nas-storage/ immich-storage/ minio/            # NFS-StorageClasses, S3-Artifact-Store
│       │   ├── argo-workflows/ semaphore/ headlamp/           # CI/CD, Ansible-UI, Kubernetes-Dashboard
│       │   ├── zammad/ vaultwarden/ n8n/ ollama/              # Helpdesk, Passwort-Manager, Automatisierung, lokales LLM
│       │   ├── uptime-kuma/ mediamtx/ pacman/                 # Status-Seite, Live-Streaming, Tracking-Demo
│       │   ├── alamos-apager/ alamos-relay/                   # Alarmmonitor-Verwaltung, Webhook-Relay
│       │   └── carplay-api/ github-release-watcher/           # Dashboard-API für die iOS-App (Ordnername historisch), Release-Watcher-CronJob
│       ├── prod/                     # PROD-Cluster, Projekt "prod" (vom TECH-Hub synchronisiert)
│       │   ├── sealed-secrets/ cert-manager/ traefik-config/ cloudflared/   # eigene Plattform-Grundzutaten des Clusters
│       │   ├── nas-storage/ immich-storage/                   # NFS-StorageClasses auch in PROD
│       │   ├── nextcloud/ immich/ paperless-ngx/              # Dateien/Kalender, Fotos, Dokumente
│       │   ├── wikijs/ wiki-docs-sync/ mealie/ xibosignage/   # Wiki (+ Sync-CronJob), Rezepte, Digital Signage
│       │   └── tinyteller/ example-whoami/ demo-app/          # Kleine App, Referenz-Apps
│       └── entw/                     # ENTW-Cluster, Projekt "entw" — nur die ENTW-ArgoCD-Instanz liest das (Branch entw), siehe b0050
│           ├── sealed-secrets/ demo-app/ example-whoami/
│           └── README.md
└── ios/                              # SwiftUI-App "Homeserver Dashboard" (Backend: carplay-api)
```

</details>

---

## Monitoring

Ein schlanker VictoriaMetrics-+-Grafana-Stack lebt unter `argocd/apps/tech/monitoring/` und wird automatisch von ArgoCD ausgerollt. Er überwacht **alle drei Cluster**, das NAS und die Kiosk-Geräte; Logs laufen zentral in VictoriaLogs (`argocd/apps/tech/logging/`, [Doku](docs/3-apps-workloads/300j0-logging.md)).

<details>
<summary><strong>Stack-Details</strong></summary>

| Komponente | Detail |
|---|---|
| **TSDB** | VMSingle — 15 Tage Retention, 10 Gi `local-path`-PVC |
| **Scrapers** | VMAgent scrapet alle `VMServiceScrape`/`VMPodScrape` + Prometheus `ServiceMonitor`-CRDs |
| **Host-Metriken** | `prometheus-node-exporter` als DaemonSet auf den TECH-Knoten, `node_exporter` auf `prod-vm`/`entw-vm`, smartctl-Exporter für die Platten |
| **Cluster-Metriken** | kubelet/cAdvisor, kube-apiserver, kube-state-metrics, CoreDNS |
| **Alerts** | Default-kube-prometheus-Rules; Gotify- und ntfy-Alertmanager-Bridges |
| **Dashboards** | Ordner *Hardware* (Übersicht mit Waben, Server-Detail, Speicher & S.M.A.R.T.), *Plattform (TECH)* und *Anwendungen (TECH)*, Node Exporter Full, VictoriaMetrics + Kubernetes Views, siehe [Hardware-Monitoring](docs/2-betrieb-hardware/20060-hardware-monitoring.md) |

</details>

Grafana öffnen unter **https://grafana.tech.homeserver** — Admin-Passwort abfragen (auf dem TECH-Cluster):

```bash
kubectl -n monitoring get secret grafana-admin \
  -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

---

## Application hinzufügen (GitOps-Weg)

Erst entscheiden, **in welchen Cluster** die App gehört: **ENTW** (Entwicklung/Test, der übliche Startpunkt),
**TECH** (Infrastruktur und Betriebsdienste) oder **PROD** (Apps mit echtem Nutzerkreis). Die Projekte, Ordner und
Pflichtschritte je Cluster stehen in
[docs/b-kubernetes-gitops/b0020-argocd-projects.md](docs/b-kubernetes-gitops/b0020-argocd-projects.md).

```bash
# Beispiel TECH: Ordner anlegen (Plain-YAML, kustomization.yaml oder Helm-Chart)
mkdir -p argocd/apps/tech/my-app

# my-app in argocd_workloads_apps (oder argocd_platform_apps) ergänzen,
# ansible/roles/argocd/defaults/main.yml — sonst fehlt der AppProject-Namespace, dann:
make render-bootstrap

git checkout -b feat/my-app
git add argocd/apps/tech/my-app/ ansible/roles/argocd/defaults/main.yml argocd/bootstrap/
git commit -m "feat(apps): add my-app"
git push -u origin feat/my-app     # PR nach main, main ist geschützt
```

| Cluster | Ordner | Zusätzlich nötig |
|---|---|---|
| **TECH** | `argocd/apps/tech/<app>/` | Namespace in `argocd_platform_apps`/`argocd_workloads_apps`, `make render-bootstrap` |
| **PROD** | `argocd/apps/prod/<app>/` | Namespace in `argocd/bootstrap-prod/appproject.yaml` (im Hub anwenden), bei reinen Manifest-Ordnern Pfad im ApplicationSet, interner Host in `dnsmasq_prod_vm_hosts` |
| **ENTW** | `argocd/apps/entw/<app>/` auf dem Branch `entw` | nichts |

> Innerhalb von ~3 Minuten nach dem Merge erkennt ArgoCD das neue Verzeichnis, erstellt eine `Application`
> namens `my-app` im Namespace `my-app` (PROD-Applications heißen `prod-<app>`) und synct sie.
> Details: **[docs/b-kubernetes-gitops/b0010-argocd.md](docs/b-kubernetes-gitops/b0010-argocd.md)**, **[docs/b-kubernetes-gitops/b0020-argocd-projects.md](docs/b-kubernetes-gitops/b0020-argocd-projects.md)**,
> Auslieferung zwischen den Clustern: **[docs/f-cicd-automatisierung/f00b0-promotion-chain.md](docs/f-cicd-automatisierung/f00b0-promotion-chain.md)**.

---

## Service-URLs

Jeder Hostname trägt ein Tier-Label (`tech` = Infrastruktur/Admin, `prod` = Apps mit echtem Nutzerkreis,
`dev` = ENTW) — Details und Begründung:
**[docs/c-netzwerk-dns/c0040-domain-tiers.md](docs/c-netzwerk-dns/c0040-domain-tiers.md)**. Die Spalte
*Cluster* zeigt, wo die App tatsächlich läuft; das Tier im Namen ist nur die URL-Konvention.

| Service | Tier | Cluster | URL |
|---|---|---|---|
| Grafana | tech | TECH | https://grafana.tech.homeserver |
| ArgoCD-Hub | – | TECH | https://argocd.tech.homeserver |
| ArgoCD ENTW | – | ENTW | http://192.168.178.100:30080 |
| Headlamp | tech | TECH | https://headlamp.tech.homeserver |
| Semaphore | tech | TECH | https://semaphore.tech.homeserver |
| Authentik (SSO) | tech | TECH | https://authentik.tech.homeserver |
| lldap (Nutzerverwaltung) | tech | TECH | https://lldap.tech.homeserver |
| Gotify | tech | TECH | https://gotify.tech.homeserver |
| ntfy | tech | TECH | https://ntfy.tech.homeserver |
| Pi-hole | tech | TECH | https://pihole.tech.homeserver |
| Argo Workflows | tech | TECH | https://argo-workflows.tech.homeserver |
| MinIO Console | tech | TECH | https://minio.tech.homeserver |
| kubeseal-webgui | tech | TECH | https://kubeseal-webgui.tech.homeserver |
| Vaultwarden | tech (Ausnahme) | TECH | https://vault.tech.homeserver |
| Zammad | tech (Ausnahme) | TECH | https://zammad.tech.homeserver |
| Alarmmonitor (alamos-apager) | prod | TECH | https://alamos-apager.prod.homeserver |
| MediaMTX (Live-Stream-Playback) | prod | TECH | https://stream.prod.homeserver |
| n8n | prod | TECH | https://n8n.prod.homeserver |
| Uptime Kuma | prod | TECH | https://uptime-kuma.prod.homeserver |
| Homeserver-Dashboard-API (carplay-api) | prod | TECH | https://carplay-api.prod.homeserver |
| pacman (Schulungsobjekt) | prod | TECH | https://pacman.prod.homeserver |
| Nextcloud | prod | PROD | https://nextcloud.prod.homeserver |
| Immich | prod | PROD | https://immich.prod.homeserver |
| Paperless-ngx | prod | PROD | https://paperless.prod.homeserver |
| Mealie | prod | PROD | https://mealie.prod.homeserver |
| Wiki.js | prod | PROD | https://wiki.prod.homeserver |
| Xibo CMS (xibosignage) | prod | PROD | https://xibo.prod.homeserver |
| Demo-Apps | dev | ENTW | http://whoami.dev.homeserver, http://demo.dev.homeserver |

> Zusätzlich zu den internen `*.homeserver`-URLs können ausgewählte Dienste
> über Cloudflare Tunnel öffentlich unter einer eigenen Domain erreichbar
> gemacht werden (z. B. `https://wiki-prod.deine-domain.de` — Bindestrich
> statt Punkt vor dem Tier, siehe
> [docs/c-netzwerk-dns/c0040-domain-tiers.md](docs/c-netzwerk-dns/c0040-domain-tiers.md#warum-punkt-intern-bindestrich-extern))
> — ohne VPN, ohne offene Ports. TECH und PROD haben je einen eigenen Tunnel. Setup:
> **[docs/e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md](docs/e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md)**.
> Welche Dienste aktuell extern erreichbar sind (u. a. Nextcloud, Immich, Wiki.js, Mealie, Xibo,
> Vaultwarden, Grafana, ntfy, Authentik, Status-Seite), steht in der Tabelle unter
> [Externe Erreichbarkeit](docs/c-netzwerk-dns/c0040-domain-tiers.md#externe-erreichbarkeit-wildcard-routing-über-traefik) —
> bei Immich nötig für Handy-Auto-Backup unterwegs.
> Der Live-Stream (`https://stream-prod.pke-lab.de`) ist per mediamtx-eigenem HTTP-Basic-Login
> abgesichert — kein externer Identity-Provider, kein Cloudflare-Zero-Trust-Konto nötig. Details:
> **[docs/3-apps-workloads/30040-mediamtx.md](docs/3-apps-workloads/30040-mediamtx.md)**.

---

## Networking & Security

<table>
<thead><tr><th>Prinzip</th><th>Umsetzung</th></tr></thead>
<tbody>
<tr><td>Keine öffentlichen Ports</td><td>Zugriff ausschließlich über LAN, Tailscale-VPN oder gezielt per Cloudflare Tunnel (ausgehende Verbindung, kein Port-Forwarding)</td></tr>
<tr><td>Getrennte Cluster</td><td>TECH, PROD und ENTW haben eigene Pod-/Service-Netze und eigene SealedSecrets-Schlüssel; PROD und ENTW laufen als KVM-VMs, ENTW hat keine Route zu TECH/PROD und keinen ArgoCD-Zugriff vom Hub, siehe <a href="docs/4-planung/40080-multi-cluster-entw-prod-tech.md">40080</a></td></tr>
<tr><td>UFW-Firewall</td><td>Erlaubt nur SSH, HTTP/HTTPS, k3s-API, ArgoCD-NodePort (HTTPS-only), Flannel, Tailscale-UDP</td></tr>
<tr><td>Opt-in externe Erreichbarkeit</td><td>Nur Dienste mit einem eigenen <code>*-pke-lab.de</code>-Host in ihrer <code>ingress.hosts</code>-Liste sind öffentlich erreichbar, alles andere bleibt intern</td></tr>
<tr><td>Zentrales Login</td><td>Authentik + lldap (SSO/2FA per Traefik-ForwardAuth) für ausgewählte Apps, siehe <a href="docs/d-sicherheit/d0073-authentik-sso.md">docs/d-sicherheit/d0073-authentik-sso.md</a></td></tr>
<tr><td>Brute-Force-Schutz</td><td>CrowdSec beobachtet SSH- und Traefik-Logs und lässt einen Firewall-Bouncer auffällige IPs sperren, siehe <a href="docs/d-sicherheit/d0020-crowdsec.md">docs/d-sicherheit/d0020-crowdsec.md</a></td></tr>
<tr><td>NetworkPolicies</td><td>Default-Deny je Namespace im TECH-Cluster mit expliziten Ausnahmen, siehe <a href="docs/d-sicherheit/d0030-network-policies.md">docs/d-sicherheit/d0030-network-policies.md</a></td></tr>
<tr><td>Internes TLS</td><td>cert-manager mit eigener Root-CA (PROD: eigene Intermediate-CA), HTTP wird auf HTTPS umgeleitet, siehe <a href="docs/d-sicherheit/d0040-internal-tls.md">docs/d-sicherheit/d0040-internal-tls.md</a></td></tr>
<tr><td>Secrets</td><td>Ansible-Vault für Host-Werte, Sealed Secrets für Cluster-Werte (je Cluster eigener Schlüssel), k3s-Secrets-Encryption at rest + Audit-Log, Rotations-Checkliste in <a href="docs/d-sicherheit/d0060-secrets-rotation.md">d0060</a></td></tr>
<tr><td>ArgoCD Read-only</td><td>Hat ausschließlich Read-Access auf das Git-Repo</td></tr>
<tr><td>ArgoCD-AppProjects</td><td>Je Cluster ein Project (<code>tech</code> / <code>prod</code> / <code>entw</code>) begrenzt Quell-Repo und erlaubte Ziel-Namespaces, siehe <a href="docs/b-kubernetes-gitops/b0020-argocd-projects.md">docs/b-kubernetes-gitops/b0020-argocd-projects.md</a></td></tr>
<tr><td>Geschützter <code>main</code></td><td>Änderungen nur per Pull Request mit grüner CI (lint, kubeconform, gitleaks), siehe <a href="docs/f-cicd-automatisierung/f0090-branch-schutz-main.md">docs/f-cicd-automatisierung/f0090-branch-schutz-main.md</a></td></tr>
</tbody>
</table>

<details>
<summary><strong>Firewall-Ports</strong></summary>

| Port | Protokoll | Scope | Zweck |
|---|---|---|---|
| 22 | TCP | LAN + Tailnet | SSH |
| 53 | UDP+TCP | LAN + Tailnet | dnsmasq Split-DNS für `*.homeserver` |
| 80 | TCP | LAN + Tailnet | Traefik HTTP (leitet auf HTTPS um) |
| 443 | TCP | LAN + Tailnet | Traefik HTTPS |
| 631 | TCP | LAN + Tailnet | CUPS (IPP/AirPrint) |
| 6443 | TCP | LAN + Tailnet | k3s-API |
| 30080 | TCP | LAN + Tailnet | ArgoCD-API/CLI/CI (HTTP, Klartext; die UI läuft per HTTPS über Traefik) |
| 41641 | UDP | Internet | Tailscale-WireGuard |

Die Regeln der `common`-Rolle gelten auch in `prod-vm` und `entw-vm` (dort jeweils mit den eigenen Pod-/Service-CIDRs).
Zusätzlich lässt UFW jeden Verkehr aus dem LAN-Subnetz und dem Tailnet zu, deshalb ist z. B. die ArgoCD-UI der
ENTW-VM (30080, HTTP) aus dem LAN erreichbar. Die vollständige Port-Übersicht je App steht in
[docs/c-netzwerk-dns/c0030-port-uebersicht.md](docs/c-netzwerk-dns/c0030-port-uebersicht.md).

</details>

Vollständige Architektur: **[docs/a-betriebssystem/a0010-overview.md](docs/a-betriebssystem/a0010-overview.md)**

---

## Dokumentation

Alle Docs liegen unter `docs/`, sortiert in 11 Kategorie-Unterordner. Jede
Datei trägt eine 5-stellige Hex-ID (erstes Zeichen = Kategorie) — Details
und Konventionen für neue Docs: **[docs/TEMPLATE.md](docs/TEMPLATE.md)**.
Neu hier? Der beste Einstieg ist der **[Architektur-Überblick](docs/a-betriebssystem/a0010-overview.md)**.

### Betriebssystem & Grundlagen (`a-betriebssystem/`)

| Dokument | Inhalt |
|---|---|
| [Ubuntu-Server-Installation](docs/a-betriebssystem/a0000-ubuntu-server-install.md) | ISO, USB-Stick, Installer, erster Boot |
| [Architektur-Überblick](docs/a-betriebssystem/a0010-overview.md) | Drei Cluster, Schichten, Traffic-Flows, App-Matrix, Ansible-Rollen |
| [Voraussetzungen](docs/a-betriebssystem/a0020-prerequisites.md) | Was vor dem Ansible-Run nötig ist |
| [Installationsleitfaden](docs/a-betriebssystem/a0030-installation.md) | Vollständiger Step-by-Step-Walkthrough |
| [Troubleshooting](docs/a-betriebssystem/a0040-troubleshooting.md) | Diagnose-Playbook für häufige Probleme |

### Kubernetes & GitOps (`b-kubernetes-gitops/`)

| Dokument | Inhalt |
|---|---|
| [k3s-Referenz](docs/b-kubernetes-gitops/b0000-k3s.md) | Config, kubectl-Cheatsheet, Upgrades |
| [ArgoCD-GitOps](docs/b-kubernetes-gitops/b0010-argocd.md) | Hub und ENTW-Instanz, App-Workflow je Cluster, CLI, Sync-Policies |
| [ArgoCD-Projects](docs/b-kubernetes-gitops/b0020-argocd-projects.md) | Ein Projekt je Cluster (`tech`/`prod`/`entw`), ApplicationSets, neue App hinzufügen |
| [Semaphore-UI](docs/b-kubernetes-gitops/b0030-semaphore.md) | Web-UI zum Ausführen von Playbooks |
| [Autoskalierung (HPA)](docs/b-kubernetes-gitops/b0040-hpa-autoscaling.md) | Welche Apps per HorizontalPodAutoscaler mitskalieren, welche bewusst nicht, und mit welchen Schwellenwerten |
| [ENTW-ArgoCD](docs/b-kubernetes-gitops/b0050-entw-argocd.md) | Eigene ArgoCD-Instanz für ENTW, liest nur `argocd/apps/entw/`; neue App deployen, Rollout, Zugriff |

### Netzwerk & DNS (`c-netzwerk-dns/`)

| Dokument | Inhalt |
|---|---|
| [DNS-Architektur](docs/c-netzwerk-dns/c0000-dns-architecture.md) | Warum der Home-Server NICHT dein LAN-DNS ist |
| [Tailscale-VPN](docs/c-netzwerk-dns/c0010-tailscale.md) | Auth-Keys, MagicDNS, Subnet-Routes |
| [WireGuard-Backup](docs/c-netzwerk-dns/c0011-wireguard-backup.md) | Notfall-Tunnel für den Fall, dass die Tailscale-Control-Plane ausfällt |
| [Pi-hole](docs/c-netzwerk-dns/c0020-pihole.md) | Netzwerkweites Werbeblocking als DNS-Filter vor der Fritz!Box — kein Router-Eingriff nötig |
| [Port-Übersicht](docs/c-netzwerk-dns/c0030-port-uebersicht.md) | Interner Service-Port, LAN- und externe Erreichbarkeit für jede App |
| [Domain-Tiers](docs/c-netzwerk-dns/c0040-domain-tiers.md) | dev/tech/prod-URL-Konvention (`app.tier.homeserver`), Tier vs. Cluster im DNS, externe Hosts, Cross-App-Referenzen |

### Sicherheit (`d-sicherheit/`)

| Dokument | Inhalt |
|---|---|
| [Incident-Report 12.08.2026](docs/d-sicherheit/d0000-incident-2026-08-12.md) | Postmortem: ApplicationSet-Migration löschte versehentlich 32 Apps, Ursache + Gegenmaßnahmen |
| [Security-Härtung — Roadmap](docs/d-sicherheit/d0010-security-hardening-roadmap.md) | Phasenplan der Security-Härtung nach dem Incident vom 12.08.2026 |
| [CrowdSec](docs/d-sicherheit/d0020-crowdsec.md) | Brute-Force-Schutz für SSH und Traefik, Firewall-Bouncer, Whitelist für LAN/Tailnet |
| [Cluster-NetworkPolicies](docs/d-sicherheit/d0030-network-policies.md) | NetworkPolicies je Namespace, Default-Deny + explizite Ausnahmen (Härtung Phase 3) |
| [Internes TLS](docs/d-sicherheit/d0040-internal-tls.md) | cert-manager + eigene CA für HTTPS auf `*.homeserver`, PROD mit eigener Intermediate-CA (Härtung Phase 5) |
| [Secrets-Encryption + Audit-Log](docs/d-sicherheit/d0050-secrets-encryption-audit-log.md) | k3s Secrets-at-Rest-Verschlüsselung + API-Audit-Log (Härtung Phase 4) |
| [Secrets-Rotation-Checkliste](docs/d-sicherheit/d0060-secrets-rotation.md) | Checkliste zur regelmäßigen Rotation aller Cluster-Secrets (Härtung Phase 7) |
| [lldap](docs/d-sicherheit/d0072-lldap.md) | Nutzer- und Gruppenverwaltung als LDAP-Quelle für Authentik |
| [Authentik SSO](docs/d-sicherheit/d0073-authentik-sso.md) | Zentrale SSO-/2FA-Instanz per Traefik-ForwardAuth, Access-Control, Runbook |
| [Authentik IaC-Cookbook](docs/d-sicherheit/d0074-authentik-iac-cookbook.md) | Neue Apps und Nutzer per Blueprint anlegen |

### Externe Erreichbarkeit (`e-externe-erreichbarkeit/`)

| Dokument | Inhalt |
|---|---|
| [Cloudflare Tunnel — Setup](docs/e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md) | Externe Erreichbarkeit ohne VPN: Konzept, zwei Tunnel (TECH/PROD), Tunnel-Einrichtung, Absicherung |
| [Cloudflare Tunnel — Deploy](docs/e-externe-erreichbarkeit/e0010-cloudflare-deploy.md) | Rollout, neuen Dienst freigeben, Rotation, Troubleshooting |

### CI/CD & Automatisierung (`f-cicd-automatisierung/`)

| Dokument | Inhalt |
|---|---|
| [Argo Workflows](docs/f-cicd-automatisierung/f0000-argo-workflows.md) | Private CI/CD-Pipeline mit MinIO-Artifact-Store |
| [Renovate](docs/f-cicd-automatisierung/f0020-renovate.md) | Automatische Update-PRs für Helm-Chart-Versionen und Image-Tags |
| [Release-Automatisierung](docs/f-cicd-automatisierung/f0030-release-automation.md) | GitHub Release + Changelog bei jedem Merge auf `main` via semantic-release |
| [GitHub Release Watcher](docs/f-cicd-automatisierung/f0040-github-release-watcher.md) | Neue GitHub-Releases erkennen und per Zammad-Ticket eine E-Mail-Benachrichtigung auslösen |
| [GitLab-Mirror](docs/f-cicd-automatisierung/f0050-gitlab-mirror.md) | Vollspiegelung (alle Branches + Tags) zu GitLab als Redundanz für den Fall eines GitHub-Ausfalls |
| [Workload-Images bauen](docs/f-cicd-automatisierung/f0060-build-images.md) | Eigene Workload-Images per GitHub Actions nach GHCR bauen (auf PRs als Probebuild) |
| [CI-Pflicht-Gate](docs/f-cicd-automatisierung/f0070-ci-lint.md) | `make lint`, kubeconform (Charts, Manifeste, Bootstrap), Go-Check und gitleaks auf jedem PR |
| [ENTW → main Promotion](docs/f-cicd-automatisierung/f0080-entw-promotion.md) | Neue `entw`-Commits nach grüner CI als PR an `main`, `main` → `entw` per Sync-Workflow, Rulesets |
| [Branch-Schutz `main`](docs/f-cicd-automatisierung/f0090-branch-schutz-main.md) | Ruleset: `main` nur per Pull Request, vier CI-Jobs als Pflicht-Checks, Admin-Notausgang |
| [Tailscale-Runner-PoC](docs/f-cicd-automatisierung/f00a0-tailscale-runner-poc.md) | Diagnose: GitHub-Runner erreicht Hub- und ENTW-ArgoCD über Tailscale |
| [Promotion-Kette](docs/f-cicd-automatisierung/f00b0-promotion-chain.md) | Versionen ENTW → TECH → PROD als PRs nach bestandenem Gesundheits-Gate (24 h ENTW, 2 h TECH), Smoke-Checks |

### Benachrichtigungen (`1-benachrichtigungen/`)

| Dokument | Inhalt |
|---|---|
| [Gotify-Push](docs/1-benachrichtigungen/10000-gotify.md) | Self-hosted Push-Notifications aus dem Stack |
| [ntfy iOS-Push](docs/1-benachrichtigungen/10010-ntfy.md) | Self-hosted ntfy mit iOS APNs-Relay |

### Betrieb & Hardware (`2-betrieb-hardware/`)

| Dokument | Inhalt |
|---|---|
| [NAS-Storage](docs/2-betrieb-hardware/20000-nas-storage.md) | NFS-StorageClass gegen die UGREEN NAS (RAID1), Migration einzelner Apps von local-path |
| [NAS-Backup](docs/2-betrieb-hardware/20010-nas-backup.md) | Externe USB-Platte am NAS: regelmäßige restic-Backups von volume1 + volume2 |
| [Cluster Power Manager](docs/2-betrieb-hardware/20020-cluster-power-manager.md) | worker-0/worker-1 per Wake-on-LAN je nach Homeserver-Last automatisch dazu- und wieder abschalten |
| [Nightly Worker Update](docs/2-betrieb-hardware/20030-nightly-worker-update.md) | worker-0/worker-1 nachts um 01:00 Uhr per Wake-on-LAN wecken, apt-Update fahren (max. 20 Min.), wieder herunterfahren |
| [Drucker (CUPS)](docs/2-betrieb-hardware/20040-printer.md) | Samsung Xpress M2026 per USB am Homeserver, Freigabe im Heimnetz + Tailnet via IPP/AirPrint |
| [GitOps- und Backup-Alerts](docs/2-betrieb-hardware/20050-gitops-und-backup-alerts.md) | Alerts auf ArgoCD-Gesundheit (Degraded, OutOfSync, hängender Sync) und auf CronJobs/Backups ohne Erfolg der letzten 30–36 h |
| [Hardware-Monitoring](docs/2-betrieb-hardware/20060-hardware-monitoring.md) | Grafana-Ordner "Hardware": Waben-Übersicht aller Server/VMs/NAS, Server-Detail (CPU, RAM, Netzwerk, Disk, Temp), Füllstand + S.M.A.R.T. |

### Apps & Workloads (`3-apps-workloads/`)

Die Spalte *Cluster* zeigt, wo die App läuft (Ordner unter `argocd/apps/`).

| Dokument | Cluster | Inhalt |
|---|---|---|
| [Zammad](docs/3-apps-workloads/30000-zammad.md) | TECH | Helpdesk-/Ticket-System, u. a. Ziel für github-release-watcher-Benachrichtigungen |
| [Alarmmonitor-Kiosks](docs/3-apps-workloads/30010-alamos-apager.md) | TECH | Raspberry-Pi-Kiosks für ALAMOS AMweb, zentral verwaltet |
| [Vereinsheim-Alarmmonitor](docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md) | TECH | Banana-Pi-Kiosk fürs Vereinsheim, Alarmstatus-Anzeige + Heartbeat-Monitoring |
| [Vereinsheim-Windows-PC](docs/3-apps-workloads/30021-vereinsheim-windows-pc-steuerung.md) | — | Windows-PC am Standort: Online-Check und Herunterfahren |
| [Wiki.js](docs/3-apps-workloads/30030-wikijs.md) | PROD | Team-Wiki, `docs/` wird per wiki-docs-sync automatisch gespiegelt |
| [MediaMTX Live-Streaming](docs/3-apps-workloads/30040-mediamtx.md) | TECH | RTMP/RTSP-Ingest → HLS, Publish- und Zuschauer-Autorisierung über mediamtx' eingebaute interne Benutzerverwaltung (HTTP Basic Auth) |
| [Paperless-ngx](docs/3-apps-workloads/30050-paperless-ngx.md) | PROD | Dokumentenmanagement mit OCR — Briefe, Rechnungen, Verträge scannen und durchsuchen |
| [Mealie](docs/3-apps-workloads/30060-mealie.md) | PROD | Rezeptverwaltung + Wochenplaner mit URL-Import |
| [n8n](docs/3-apps-workloads/30070-n8n.md) | TECH | Low-Code-Automatisierung — Dienste verknüpfen ohne Programmieren |
| [Uptime Kuma](docs/3-apps-workloads/30080-uptime-kuma.md) | TECH | Status-Seite und Alerting für alle Dienste |
| [Rhein-Dashboard](docs/3-apps-workloads/30090-rhein-dashboard.md) | TECH | Grafana: Pegelonline, DWD-Warnungen, ELWIS, Hochwasservorhersage RLP |
| [Vaultwarden](docs/3-apps-workloads/300a0-vaultwarden.md) | TECH | Bitwarden-kompatibler Passwort-Manager für Browser/Mobile-Clients |
| [Nextcloud](docs/3-apps-workloads/300b0-nextcloud.md) | PROD | Datei-Sync, Kalender, Kontakte |
| [Immich](docs/3-apps-workloads/300c0-immich.md) | PROD | Foto-/Video-Backup vom Handy inkl. Gesichtserkennung, eigener NAS-Storage-Export |
| [Homeserver-Dashboard-API](docs/3-apps-workloads/300d0-carplay-api.md) | TECH | Go/Gin-API + power-agent für die reine iOS-App Homeserver Dashboard (Metriken, Alerts, Status, Helligkeit, Wake/Shutdown) |
| [xibosignage](docs/3-apps-workloads/300e0-xibosignage.md) | PROD | Xibo CMS + Bilder-Slideshow auf Raspberry Pi 3B+, n8n-Workflow für automatisches Einspielen |
| [pacman — Besuchertracking](docs/3-apps-workloads/300f0-pacman-visitor-tracking.md) | TECH | IP/GeoIP-Besucher-Tracking-Demo für die IT-Security-Schulung |
| [Ollama](docs/3-apps-workloads/300g0-ollama.md) | TECH | Lokales LLM, nur bei Bedarf hochgefahren (vom n8n-Workflow gesteuert) |
| [ALAMOS-Einsatzalarm → Zammad](docs/3-apps-workloads/300h0-alamos-einsatz-zammad.md) | TECH | n8n-Workflow: Einsatzalarm wird zum Zammad-Ticket |
| [ALAMOS-Webhook-Relay](docs/3-apps-workloads/300i0-alamos-relay.md) | TECH | Öffentlicher Mini-Proxy vor n8n, damit ALAMOS den Einsatzalarm-Webhook erreicht, ohne n8n selbst öffentlich zu machen |
| [Zentrales Logging](docs/3-apps-workloads/300j0-logging.md) | TECH | VictoriaLogs: journald aller Hosts und Pod-Logs an einem Ort |

### Planung (`4-planung/`)

Pläne und Analysen. Ein Doc trägt in seiner Statuszeile, wie weit es umgesetzt ist.

| Dokument | Inhalt |
|---|---|
| [Authelia-SSO](docs/4-planung/40000-authelia-sso.md) | Ursprünglicher SSO-Plan mit Authelia, abgelöst durch Authentik |
| [Öffentliches Teilen ohne Gast-Accounts](docs/4-planung/40010-oeffentliches-teilen-ohne-authelia.md) | Immich/Nextcloud: Teilen von Inhalten ohne Gast-Accounts |
| [Vereinsheim WoL + Router-VPN](docs/4-planung/40020-vereinsheim-wol-router-vpn.md) | Wake-on-LAN am Standort Vereinsheim, Router-VPN als Fallback |
| [GitLab + Proxmox — Prüfung](docs/4-planung/40030-gitlab-hosting-proxmox-pruefung.md) | Analyse: GitLab self-hosted und Proxmox als Hypervisor |
| [Zammad-Kalender → Nextcloud](docs/4-planung/40040-zammad-kalender-n8n-nextcloud-ios-sync.md) | Kalendereinladung aus Zammad über n8n nach Nextcloud und iOS |
| [GitHub-Repos versionieren](docs/4-planung/40050-github-repos-versionierung.md) | Versionierung für alle GitHub-Repos |
| [Einsatz-Alarm per E-Mail](docs/4-planung/40060-alamos-einsatz-email-benachrichtigung.md) | E-Mail mit den wichtigsten Einsatzdaten |
| [Authentik via IaC](docs/4-planung/40070-authentik-sso-iac.md) | Plan und Rollout von Authentik als SSO-Layer (Ablösung von Authelia) |
| [Multi-Cluster ENTW/PROD/TECH](docs/4-planung/40080-multi-cluster-entw-prod-tech.md) | Architektur und Umsetzungsplan der Drei-Cluster-Umstellung, Phasen und offene Punkte |

### Incidents (`5-incidents/`)

| Dokument | Inhalt |
|---|---|
| [NAS-Platte rot, homeserver unerreichbar](docs/5-incidents/50000-nas-disk-red-homeserver-unreachable.md) | Vorfall vom 02.09.2026: Hypothese und Prüfschritte |

Weitere Ordner-READMEs: [argocd/apps/entw/](argocd/apps/entw/README.md) (ENTW-Ordner),
[argocd/bootstrap-prod/](argocd/bootstrap-prod/README.md) (PROD im Hub anbinden, Umzug mit Daten),
[argocd/apps/tech/pacman/](argocd/apps/tech/pacman/README.md), [argocd/apps/tech/carplay-api/](argocd/apps/tech/carplay-api/README.md),
[ios/](ios/README.md) (iOS-App).

---

<p align="center">
  MIT — siehe <a href="LICENSE">LICENSE</a>
  &nbsp;·&nbsp;
  Made with ☕ &amp; GitOps
</p>
