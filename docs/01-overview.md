# Architektur-Überblick

Dieses Dokument beschreibt die High-Level-Architektur des Home-Server-Setups.

---

## System-Architektur

```
┌─────────────────────────────────────────────────────────────────────┐
│                          INTERNET                                   │
└────────────────────────────┬────────────────────────────────────────┘
                             │ WireGuard / Tailscale
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    TAILSCALE VPN OVERLAY                            │
│                  (100.x.x.x Adressbereich)                          │
│                                                                     │
│   ┌─────────────┐         ┌──────────────┐      ┌──────────────┐   │
│   │  Laptop /   │         │    Phone /   │      │   Remote     │   │
│   │  Desktop    │◄───────►│    Tablet    │      │   Machine    │   │
│   └─────────────┘         └──────────────┘      └──────────────┘   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ Tailscale MagicDNS / IP
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                k3s CLUSTER (2-Node)                                          │
│                                                                              │
│  ┌────────────────────────────────────┐  ┌──────────────────────────────┐   │
│  │  HOMESERVER — 192.168.178.94       │  │  HOMESERVER2 — 192.168.178.95│   │
│  │  Control-Plane + Worker            │  │  Worker-Node                 │   │
│  │                                    │  │                              │   │
│  │  ┌────────────┐ ┌───────────────┐  │  │  ┌──────────────────────┐   │   │
│  │  │ tailscaled │ │   dnsmasq     │  │  │  │  k3s-agent           │   │   │
│  │  │ (Tailscale)│ │  split-DNS    │  │  │  │  (kubelet + Flannel) │   │   │
│  │  └────────────┘ │  *.homeserver │  │  │  └──────────────────────┘   │   │
│  │  ┌────────────┐ │  :53 LAN+TS  │  │  │                              │   │
│  │  │  scanbd +  │ └───────────────┘  │  │  ┌──────────────────────┐   │   │
│  │  │  SANE      │                    │  │  │  Docker-Compose       │   │   │
│  │  │  scan_.sh  │ ┌───────────────┐  │  │  │  Paperless-NGX       │   │   │
│  │  └────────────┘ │  UFW Firewall │  │  │  │  TinyTeller          │   │   │
│  │                 └───────────────┘  │  │  │  Day Pilot           │   │   │
│  │  ┌──────────────────────────────┐  │  │  │  Node Exporter       │   │   │
│  │  │  k3s server (Control-Plane)  │  │  │  └──────────────────────┘   │   │
│  │  │  ┌──────────┐ ┌───────────┐  │  │  │                              │   │
│  │  │  │ Traefik  │ │  ArgoCD   │  │◄─┼─►│  Flannel VXLAN (8472/UDP)   │   │
│  │  │  │ :80/:443 │ │  :30080   │  │  │  │  kubelet API  (10250/TCP)   │   │
│  │  │  └──────────┘ └───────────┘  │  │  └──────────────────────────────┘   │
│  │  │  argocd/apps/:                │  │                              │   │
│  │  │   monitoring, sealed-secrets, │  │                              │   │
│  │  │   semaphore, headlamp, gotify │  │                              │   │
│  │  │  Flannel VXLAN 10.42.0.0/16   │  │                              │   │
│  │  │  local-path StorageClass      │  │                              │   │
│  │  └──────────────────────────────┘  │  └──────────────────────────────┘   │
│  └────────────────────────────────────┘                                     │
└──────────────────────────────────────────────────────────────────────────────┘
                                ▲
                                │ git pull (HTTPS/SSH)
                                │
┌─────────────────────────────────────────────────────────────────────┐
│                    GIT REPOSITORY (GitHub)                          │
│                                                                     │
│   home-server/                                                      │
│   └── argocd/apps/          ← ArgoCD beobachtet dieses Verzeichnis │
│       ├── example-whoami/   ← Jedes Unterverzeichnis = eine App    │
│       ├── monitoring/                                              │
│       ├── sealed-secrets/                                          │
│       ├── kubeseal-webgui/                                         │
│       ├── headlamp/                                                │
│       ├── semaphore/                                               │
│       ├── gotify/                                                  │
│       └── my-new-app/       ← Verzeichnis anlegen → auto-deployed  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## GitOps-Flow

```
Developer                Git Repo               ArgoCD              k3s Cluster
    │                       │                     │                      │
    │── git push ──────────►│                     │                      │
    │                       │◄── poll (3 min) ────│                      │
    │                       │─── diff erkannt ───►│                      │
    │                       │                     │── kubectl apply ────►│
    │                       │                     │                      │── Pods laufen
    │                       │                     │◄── Status-Sync ──────│
    │                       │                     │── Sync complete      │
```

---

## Komponenten

### Ubuntu 26.04 LTS (Base-OS)

Das Fundament des ganzen Stacks. Konfiguriert durch die Ansible-Rolle `common`:

- Vollständiges `apt dist-upgrade` bei jedem Ansible-Run (gesteuert über `auto_upgrade`)
- `unattended-upgrades` aktiv für tägliche Sicherheits-Patches im Hintergrund
- Automatischer Reboot, wenn `/var/run/reboot-required` existiert
- UFW-Firewall mit minimal offenen Ports
- Kernel-Module für Container-Netzwerk (`br_netfilter`, `overlay`)
- sysctl-Tuning für Kubernetes-Anforderungen
- Chrony für NTP-Zeitsync
- Swap deaktiviert (Kubernetes-Pflicht)

### k3s (Kubernetes-Distribution, 2-Node-Cluster)

k3s ist eine CNCF-zertifizierte, produktionsreife Kubernetes-Distribution,
optimiert für ressourcenarme Umgebungen.

| Node | IP | Rolle | Service |
|------|----|-------|---------|
| homeserver | 192.168.178.94 | Control-Plane + Worker | k3s server |
| homeserver2 | 192.168.178.95 | Worker | k3s agent |

homeserver2 tritt dem Cluster über `k3s agent` bei — der Join-Token wird
per Ansible automatisch vom Control-Plane-Node gelesen. Kubernetes-Workloads
werden vom Scheduler auf beide Nodes verteilt. Docker-Compose-Dienste auf
homeserver2 laufen parallel dazu auf dem Host.

Mitgelieferte Komponenten:

- **Flannel** (VXLAN) für Pod-Networking (beide Nodes über UDP 8472)
- **Traefik v2** als Default-Ingress-Controller (läuft auf Control-Plane)
- **CoreDNS** für Cluster-DNS
- **local-path Provisioner** für PersistentVolume-Storage
- **metrics-server** für Resource-Metriken

### ArgoCD (GitOps-Controller)

ArgoCD beobachtet das Git-Repository und gleicht den Cluster-State mit dem
gewünschten YAML-State ab. Wird per Helm-Chart in den `argocd`-Namespace deployt.

Der **ApplicationSet**-Controller erlaubt dynamisches Erzeugen von Applications
aus Verzeichnis-Patterns — neues Verzeichnis unter `argocd/apps/` anlegen,
pushen, ArgoCD erzeugt automatisch eine neue Application und synct sie.

### Tailscale (VPN)

Tailscale liefert ein WireGuard-basiertes Mesh-VPN. Der Home-Server wird
zum Knoten im eigenen Tailscale-Netz — alle Services sind von jedem
Tailscale-Gerät per MagicDNS-Hostname oder Tailscale-IP erreichbar, ohne
Portfreigaben am Router.

### Traefik (Ingress-Controller)

Wird mit k3s mitgeliefert und routet HTTP/HTTPS in den Cluster. Services
werden über `Ingress`-Resourcen oder Traefiks `IngressRoute`-CRD exponiert.

### dnsmasq (Split-DNS für `*.homeserver`)

Auf dem Host läuft ein bare-metal `dnsmasq` und beantwortet die
`*.homeserver`-Zone sowohl auf dem LAN-Interface als auch auf `tailscale0`.
Jeder Eintrag in `dnsmasq_hosts` (`ansible/group_vars/all.yml`) löst auf
die LAN-IP des Servers auf — so erreichst du Apps als `grafana.homeserver`,
`argocd.homeserver` etc. aus LAN und Tailnet, ohne pro App den Router oder
die Tailscale-Admin-Konsole anzufassen.
Die Architektur — und warum der Home-Server bewusst **nicht** dein
LAN-weiter DNS-Server sein sollte — steht in
[`09-dns-architecture.md`](09-dns-architecture.md).

### Scanner + Paperless-Pipeline

Ein Fujitsu USB-Scanner hängt direkt am Host. `scanbd` hört auf den
Hardware-Button und triggert Shell-Skripte (`scan_button.sh` →
`scan_to_pdf.sh`), die ein PDF erzeugen und auf einem CIFS-Mount der
UGREEN NAS ablegen, wo Paperless-NGX es einliest. Optional werden
Gotify-Push-Notifications aus denselben Skripten verschickt.
Vollständiges Setup: [`10-scanner.md`](10-scanner.md) und
[`11-gotify.md`](11-gotify.md).

### Monitoring-Stack (VictoriaMetrics + Grafana)

Deployt via `argocd/apps/monitoring/`. VMSingle hält 15 Tage TSDB auf
einem `local-path`-PVC, VMAgent scrapet `VMServiceScrape`/`VMPodScrape`
**und** auto-konvertierte Prometheus-`ServiceMonitor`-CRDs, Grafana
liefert vorinstallierte Dashboards (Node Exporter Full, VictoriaMetrics,
Kubernetes Views) unter `http://grafana.homeserver`.

### Sealed Secrets

Der `sealed-secrets`-Controller von Bitnami (unter
`argocd/apps/sealed-secrets/`) entschlüsselt cluster-interne
`SealedSecret`-CRDs in normale Kubernetes-`Secret`s. `kubeseal-webgui`
(`argocd/apps/kubeseal-webgui/`) ist eine kleine Browser-UI, die
Klartext-Werte mit dem Public Key des Controllers verschlüsselt —
ideal, um per-App-Secrets sicher ins GitOps-Repo zu committen.

### Semaphore (Ansible-Web-UI)

Läuft als k8s-Pod unter `argocd/apps/semaphore/`. Die Ansible-Rolle
`semaphore_bootstrap` ruft die Semaphore-REST-API auf und legt
Projects, Inventories, Repositories und Templates idempotent an —
die UI ist nach dem ersten Playbook-Run sofort einsatzbereit.

---

## Port-Übersicht

| Port  | Protokoll | Komponente      | Scope                  | Zweck                                |
|-------|-----------|-----------------|------------------------|--------------------------------------|
| 22    | TCP       | SSH             | LAN + Tailscale        | Server-SSH-Zugriff                   |
| 53    | UDP+TCP   | dnsmasq         | LAN + Tailscale        | Split-DNS für `*.homeserver`         |
| 80    | TCP       | Traefik         | LAN + Tailscale        | HTTP-Ingress                         |
| 443   | TCP       | Traefik         | LAN + Tailscale        | HTTPS-Ingress                        |
| 6443  | TCP       | k3s API-Server  | LAN + Tailscale        | Kubernetes-API (+ Agent-Join)        |
| 30080 | TCP       | ArgoCD NodePort | LAN + Tailscale        | ArgoCD-Web-UI (HTTP)                 |
| 30443 | TCP       | ArgoCD NodePort | LAN + Tailscale        | ArgoCD-Web-UI (HTTPS)                |
| 41641 | UDP       | Tailscale       | Internet               | WireGuard-VPN (Tailscale)            |
| 10250 | TCP       | k3s-kubelet     | Cluster-intern (beide) | kubelet-API                          |
| 8472  | UDP       | Flannel VXLAN   | Cluster-intern (beide) | Pod-Overlay-Netz zwischen den Nodes  |

---

## Netzwerk-Übersicht

| Netz                | CIDR              | Zweck                            |
|---------------------|-------------------|----------------------------------|
| Home-LAN            | 192.168.1.0/24    | Physikalisches Heimnetz          |
| Tailscale-Overlay   | 100.64.0.0/10     | VPN-Mesh                         |
| k3s-Pod-CIDR        | 10.42.0.0/16      | Pod-IPs                          |
| k3s-Service-CIDR    | 10.43.0.0/16      | ClusterIP-Service-Adressen       |

---

## Security-Modell

- **Keine Ports ins Internet** — Remote-Zugriff ausschließlich über Tailscale.
- **UFW-Firewall** blockt alles, was nicht explizit erlaubt ist.
- **Tailscale-ACLs** können zusätzlich pro Gerät einschränken, welche Services erreichbar sind.
- **ArgoCD** hat ausschließlich Read-Access auf das Git-Repo.
- **Ansible-Vault** verschlüsselt sensitive Werte (Tailscale-Auth-Key, SMB-Password, Vault-Password, Tokens) at rest.
