# ArgoCD-GitOps-Guide

Dieses Dokument behandelt ArgoCD-Zugriff, Konfiguration und GitOps-Alltag.

## Welche ArgoCD-Instanzen es gibt

| Instanz | Läuft auf | Verwaltet | Liest | UI |
|---|---|---|---|---|
| **Hub** | `homeserver` (TECH, `.94`) | den TECH-Cluster **und** den PROD-Cluster (dort als Cluster `prod` registriert) | Branch `main`: `argocd/apps/tech/*` und `argocd/apps/prod/*` | `https://<server-ip>:30443` (HTTPS) |
| **ENTW** | `entw-vm` (`.100`, KVM-VM auf worker-1) | nur den ENTW-Cluster | Branch `entw`: `argocd/apps/entw/*` | `http://192.168.178.100:30080` |

PROD hat **keine** eigene ArgoCD-Instanz. Im Hub erscheinen PROD-Applications mit dem Präfix `prod-`
(`argocd app list | grep '^prod-'`). Die Projekte im Einzelnen: [b0020](b0020-argocd-projects.md), die
ENTW-Instanz: [b0050](b0050-entw-argocd.md). Alles Folgende bezieht sich, wenn nicht anders
gesagt, auf den **Hub**.

---

## Zugriff

### Web-UI

Die Web-UI läuft per **HTTPS über Traefik** (wie alle anderen Dienste, mit dem
internen Zertifikat, siehe [d0040](../d-sicherheit/d0040-internal-tls.md)):

```
https://argocd.tech.homeserver
```

Der Hostname löst über den dnsmasq-Wildcard (`*.homeserver`) im LAN und im Tailnet auf.
Konfiguriert ist der Ingress in `ansible/roles/argocd` (`argocd_ingress_enabled`,
`argocd_ui_host`, gesetzt in `ansible/host_vars/homeserver/vars.yml`) — als Wert der Rolle,
damit der tägliche Semaphore-Lauf (`helm upgrade`) ihn nicht zurückdreht.

**Klartext-Zugang für CLI und CI:** Der ArgoCD-Server läuft mit `server.insecure: true`
(TLS endet im Traefik). Deshalb sprechen beide NodePorts **Klartext-HTTP**:
`https://<server-ip>:30443` wird zurückgesetzt und ist **nicht** nutzbar. Für `argocd`-CLI und
die Promotion-Kette gilt:

```
http://<server-ip>:30080          (LAN)
http://homeserver:30080           (via Tailscale-MagicDNS)
```

UFW lässt Port 30080 nur aus dem LAN, dem Tailnet (`100.64.0.0/10`) und dem WireGuard-Notzugang
(`10.99.99.0/24`) zu, nicht aus dem Internet. Da der Port Klartext spricht, das Admin-Passwort
bitte nur in der Web-UI (HTTPS) eingeben und für die CLI ein API-Token verwenden.

### Initial-Credentials

Bei der Installation generiert ArgoCD ein zufälliges Initial-Passwort in einem Kubernetes-Secret.

Auslesen:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d; echo
```

- **Username:** `admin`
- **Passwort:** Output des Befehls

---

## Erst-Login und Passwortwechsel

1. `https://argocd.tech.homeserver` öffnen.
2. Login mit `admin` + Initial-Passwort.
3. **User-Icon** oben links anklicken.
4. **User Info**.
5. **Update Password**.
6. Neues, starkes Passwort vergeben und bestätigen.
7. **Save**.

Nach dem Passwortwechsel kann das Initial-Secret optional gelöscht werden:

```bash
kubectl -n argocd delete secret argocd-initial-admin-secret
```

---

## Repository-Konfiguration

Das Bootstrap-`ApplicationSet` ist so konfiguriert, dass es aus dem eigenen
Git-Repo zieht. Bei **öffentlichem** Repo ist keine zusätzliche Konfiguration nötig.

### Privates Repository

Bei privatem Repo Credentials über UI oder CLI hinterlegen:

**Über die UI:**

1. **Settings → Repositories**
2. **Connect Repo**
3. **HTTPS** oder **SSH** wählen
4. Repo-URL und Credentials eingeben

**Über die CLI:**

```bash
# HTTPS mit User/Password oder Token
argocd repo add https://github.com/pkr-lab/capulus-core.git \
  --username YOUR_USER \
  --password YOUR_TOKEN

# SSH mit Key
argocd repo add git@github.com:pkr-lab/capulus-core.git \
  --ssh-private-key-path ~/.ssh/id_rsa

# Repos prüfen
argocd repo list
```

**Über ein Kubernetes-Secret:**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: home-server-repo
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
type: Opaque
stringData:
  type: git
  url: https://github.com/pkr-lab/capulus-core.git
  password: ghp_YOUR_GITHUB_TOKEN
  username: YOUR_USER
```

```bash
kubectl apply -f repo-secret.yaml
```

---

## ApplicationSet-Struktur

Der Hub kennt **drei** `ApplicationSet`-Ressourcen, je Ordner-Familie eine:

| ApplicationSet | Quelle | Projekt | Ziel-Cluster | Pflege |
|---|---|---|---|---|
| `home-server-apps-tech` | `argocd/apps/tech/*` | `tech` | Hub-Cluster (TECH) | **generiert** aus [`bootstrap-applicationset.yaml.j2`](../../ansible/roles/argocd/templates/bootstrap-applicationset.yaml.j2), committet als [`argocd/bootstrap/root-applicationset.yaml`](../../argocd/bootstrap/root-applicationset.yaml) |
| `home-server-apps-prod` | explizit gelistete Manifest-Ordner unter `argocd/apps/prod/` | `prod` | Cluster `prod` | handgeschrieben in [`argocd/bootstrap-prod/`](../../argocd/bootstrap-prod/README.md) |
| `home-server-apps-prod-charts` | jeder Ordner mit `Chart.yaml` unter `argocd/apps/prod/` | `prod` | Cluster `prod` | dito |

Das TECH-Set in Kurzform (Auszug aus der generierten Datei):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: home-server-apps-tech
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/pkr-lab/capulus-core.git
        revision: main
        directories:
          - path: "argocd/apps/tech/*"
  template:
    metadata:
      name: "{{.path.basename}}"
    spec:
      project: tech            # fest codiert, kein Templating
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{.path.basename}}"
      # ... Sync-Policy, ignoreDifferences, siehe Datei
```

**Funktionsweise:**

- ArgoCD scannt die Ordner auf `main`; jedes Unterverzeichnis wird zu einer **Application**.
- Application-Name = Ordnername (bei PROD mit Präfix `prod-`), Ziel-Namespace = Ordnername.
- Das `AppProject` (`tech` / `prod`) begrenzt Repo und Namespaces, siehe [b0020](b0020-argocd-projects.md).
- ArgoCD synct den Inhalt des Verzeichnisses in den jeweiligen Cluster. Die Ordner sind entweder
  plain Manifeste, Kustomize oder ein Helm-Chart (`Chart.yaml` + `values.yaml`).

**Verzeichnisstruktur** (Auszug, die vollständige Liste steht im
[README → Repository-Layout](../../README.md#repository-layout)):

```
argocd/apps/
├── tech/                 → TECH-Cluster (Projekt tech), Infrastruktur + Betriebs-Apps
│   ├── sealed-secrets/   → SealedSecrets-Controller
│   ├── monitoring/       → VictoriaMetrics + Grafana + Alertmanager
│   ├── authentik/        → zentrales SSO (siehe d0073)
│   ├── vaultwarden/      → Passwort-Manager
│   └── ...
├── prod/                 → PROD-Cluster (Projekt prod), Familien-/Vereins-Apps
│   ├── nextcloud/
│   ├── immich/
│   ├── paperless-ngx/
│   └── ...
└── entw/                 → ENTW-Cluster (eigene ArgoCD-Instanz, Branch entw)
    ├── demo-app/
    ├── example-whoami/
    └── sealed-secrets/
```

---

## Neue Application hinzufügen

Erst entscheiden, **in welchem Cluster** die App laufen soll: **TECH** (Infrastruktur, Admin- und
Betriebsdienste), **PROD** (Apps mit echtem Nutzerkreis: Familie, Verein) oder **ENTW** (Experimente,
Neuentwicklung). Neue Apps starten in der Regel auf ENTW und wandern über die
[Promotion-Kette](../f-cicd-automatisierung/f00b0-promotion-chain.md) nach TECH bzw. PROD.

### TECH

1. Verzeichnis `argocd/apps/tech/<app-name>/` anlegen, Manifeste oder Helm-Chart hineinlegen.
2. `<app-name>` in `argocd_platform_apps` (Infrastruktur) oder `argocd_workloads_apps` (Anwendung)
   in `ansible/roles/argocd/defaults/main.yml` ergänzen. Sonst fehlt der `destinations`-Eintrag im
   Projekt `tech`, und der Sync schlägt mit
   `application destination namespace ... is not permitted in project ...` fehl.
3. `make render-bootstrap` (aktualisiert die committeten Kopien unter `argocd/bootstrap/`).
4. Committen, per PR nach `main` bringen (`main` ist geschützt, siehe
   [f0090](../f-cicd-automatisierung/f0090-branch-schutz-main.md)).
5. Innerhalb von ~3 Minuten erkennt ArgoCD den Ordner, erzeugt die Application und synct sie.
   Danach `make argocd` laufen lassen, damit die `argocd`-Rolle das Projekt `tech` mit dem neuen
   Namespace anwendet.

Beispiel mit Plain-Manifest:

```bash
mkdir -p argocd/apps/tech/my-app
cat > argocd/apps/tech/my-app/deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: my-app
          image: nginx:alpine
          ports:
            - containerPort: 80
EOF

# my-app in argocd_workloads_apps (ansible/roles/argocd/defaults/main.yml) ergänzen, dann:
make render-bootstrap

git add argocd/apps/tech/my-app/ ansible/roles/argocd/defaults/main.yml argocd/bootstrap/
git commit -m "feat(apps): add my-app"
git push   # auf einem Feature-Branch, dann PR nach main
```

Beispiel als Helm-Chart: Ordner `argocd/apps/tech/my-helm-app/` mit `Chart.yaml`, `values.yaml` und
`templates/` anlegen. ArgoCD erkennt die `Chart.yaml` und behandelt das Verzeichnis als Helm-Chart.

### PROD

1. Verzeichnis `argocd/apps/prod/<app-name>/` anlegen.
2. Namespace in [`argocd/bootstrap-prod/appproject.yaml`](../../argocd/bootstrap-prod/appproject.yaml)
   eintragen und die Datei im Hub anwenden: `kubectl apply -f argocd/bootstrap-prod/appproject.yaml`.
3. **Nur bei reinen Manifest-Ordnern** (ohne `Chart.yaml`): zusätzlich den Pfad in
   [`argocd/bootstrap-prod/applicationset.yaml`](../../argocd/bootstrap-prod/applicationset.yaml)
   ergänzen und anwenden. Helm-Charts werden automatisch gefunden.
4. Für einen internen Host unter `*.prod.homeserver` den Namen in `dnsmasq_prod_vm_hosts`
   (`ansible/group_vars/all.yml`) aufnehmen und `make dnsmasq` ausführen, sonst löst der Name auf den
   TECH-Cluster auf, siehe [c0040](../c-netzwerk-dns/c0040-domain-tiers.md#dns-tier-und-cluster-sind-zwei-verschiedene-dinge).
5. Per PR nach `main`. In der Hub-UI erscheint die Application als `prod-<app-name>`.

### ENTW

Ordner `argocd/apps/entw/<app-name>/` auf dem **Branch `entw`** anlegen, fertig. Keine Liste, kein
Projekt, kein Ansible-Lauf. Details: [b0050](b0050-entw-argocd.md#neue-app-auf-entw-deployen).

---

## Sync-Policies

Das Bootstrap-`ApplicationSet` konfiguriert Apps mit voller Automation:

```yaml
syncPolicy:
  automated:
    prune: true      # Resources, die aus Git entfernt wurden, löschen
    selfHeal: true   # Manuelle Änderungen am Cluster zurückdrehen
  syncOptions:
    - CreateNamespace=true    # Ziel-Namespace automatisch erstellen
    - ServerSideApply=true    # Server-Side-Apply für bessere Field-Ownership
```

**Bedeutung:**

| Policy           | Effekt                                                              |
|------------------|---------------------------------------------------------------------|
| `automated`      | ArgoCD synct automatisch bei Git-Changes (kein manueller Sync nötig)|
| `prune: true`    | Aus Git entfernte Resources werden vom Cluster gelöscht             |
| `selfHeal: true` | Manuelle `kubectl`-Änderungen werden auf den Git-Stand zurückgedreht|
| `CreateNamespace`| Ziel-Namespace wird erzeugt, falls nicht vorhanden                  |
| `ServerSideApply`| Nutzt `kubectl apply --server-side` für besseres Field-Management   |

**Automated Sync für eine einzelne App deaktivieren:**

Für eine App, die manuell kontrolliert werden soll, ein eigenes
`Application`-Manifest hinterlegen, das die Sync-Policy überschreibt:

```yaml
# Beispiel: argocd/apps/tech/my-careful-app/argocd-application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-careful-app
  namespace: argocd
  annotations:
    argocd.argoproj.io/skip-reconcile: "true"  # nicht durch das ApplicationSet überschreiben
spec:
  syncPolicy: {}  # nur manueller Sync
```

---

## CLI-Nutzung

ArgoCD-CLI installieren:

```bash
# Linux
curl -sSL -o argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
chmod +x argocd && sudo mv argocd /usr/local/bin/

# macOS
brew install argocd
```

### Gängige CLI-Kommandos

**Authentifizierung:**

```bash
# Login (--plaintext: der NodePort spricht Klartext-HTTP, kein TLS)
argocd login 192.168.178.94:30080 --username admin --password <password> --plaintext

# Via Tailscale
argocd login homeserver:30080 --username admin --password <password> --plaintext

# Aktueller Context
argocd context
```

**Applications:**

```bash
# Alle Apps auflisten (PROD-Apps tragen das Präfix prod-)
argocd app list

# Details
argocd app get uptime-kuma

# Manuell syncen
argocd app sync uptime-kuma

# Sync mit Prune (überflüssige Resources entfernen)
argocd app sync uptime-kuma --prune

# Spezifische Resource syncen
argocd app sync uptime-kuma --resource apps:Deployment:uptime-kuma

# Auf Sync warten
argocd app wait uptime-kuma --sync

# Logs
argocd app logs uptime-kuma

# Diff (was würde sich ändern)
argocd app diff uptime-kuma

# Rollback auf vorherige Revision
argocd app rollback uptime-kuma 1   # Revision-Nummer aus der Historie

# Historie
argocd app history uptime-kuma

# App löschen (löscht Default-mäßig KEINE Cluster-Resources)
argocd app delete uptime-kuma

# App UND Cluster-Resources löschen
argocd app delete uptime-kuma --cascade
```

**Repositories:**

```bash
# Repos auflisten
argocd repo list

# Repo hinzufügen
argocd repo add https://github.com/pkr-lab/capulus-core.git

# Repo entfernen
argocd repo rm https://github.com/pkr-lab/capulus-core.git
```

**Accounts:**

```bash
# Accounts auflisten
argocd account list

# Passwort ändern
argocd account update-password

# API-Token generieren
argocd account generate-token --account admin
```

---

## Health-Status

ArgoCD führt zwei Status-Werte pro Application:

**Sync-Status:**

- `Synced` — Cluster stimmt mit Git überein
- `OutOfSync` — Unterschiede zwischen Git und Cluster
- `Unknown` — Status nicht ermittelbar

**Health-Status:**

- `Healthy` — alle Resources gesund
- `Progressing` — Resources deployen/updaten gerade
- `Degraded` — Resources schlagen fehl
- `Missing` — Resources noch nicht vorhanden
- `Suspended` — Resources pausiert (z. B. CronJob)
- `Unknown` — Health nicht ermittelbar

Über die UI unter **Applications** oder per CLI:

```bash
argocd app list
# NAME   CLUSTER   NAMESPACE   PROJECT   STATUS   HEALTH   ...
```

---

## Notifications & Webhooks

### GitHub-Webhook (schnellerer Sync)

Default-mäßig pollt ArgoCD das Git-Repo alle 3 Minuten. Mit einem GitHub-Webhook
wird der Sync sofort nach jedem Push ausgelöst:

1. GitHub-Repo → **Settings → Webhooks**.
2. **Add webhook**.
3. Payload-URL: `http://<tailscale-ip>:30080/api/webhook` (nur sinnvoll, wenn GitHub den Hub erreichen kann; ohne offenen Port bleibt es beim Polling).
4. Content type: `application/json`.
5. **Just the push event**.
6. **Add webhook**.

Hinweis: Der Server muss aus den GitHub-Servern erreichbar sein. Über Tailscale
geht das nur, wenn er als
[Tailscale-Exit-Node](../c-netzwerk-dns/c0010-tailscale.md) eingerichtet oder Subnet-Routing
konfiguriert ist.

Alternativ ist der 3-Minuten-Poll für einen Home-Server völlig ausreichend.
