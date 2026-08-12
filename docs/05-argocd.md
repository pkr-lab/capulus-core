# ArgoCD-GitOps-Guide

Dieses Dokument behandelt ArgoCD-Zugriff, Konfiguration und GitOps-Alltag.

---

## Zugriff

### Web-UI

ArgoCD läuft als NodePort-Service auf Port **30443** (HTTPS). Der HTTP-NodePort
(30080) ist absichtlich **nicht** in der UFW-Firewall freigegeben — ArgoCD hat
vollen GitOps-Controller-Zugriff auf den Cluster, das Initial-Passwort und
spätere Logins sollen nicht im Klartext über LAN/Tailnet gehen.

```
https://<server-ip>:30443
https://homeserver:30443          (via Tailscale-MagicDNS)
https://100.x.x.x:30443           (via Tailscale-IP)
```

Das Zertifikat ist selbstsigniert (Standard-ArgoCD-Setup) — der Browser zeigt
eine Zertifikatswarnung, die du bestätigen musst (`argocd`-CLI braucht dafür
`--insecure`, siehe unten).

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

1. `https://<server-ip>:30443` öffnen (Zertifikatswarnung bestätigen).
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
argocd repo add git@github.com:PKE-Tech/Home-Lab.git \
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

Seit [docs/49-argocd-projects.md](49-argocd-projects.md) gibt es **zwei
separate Bootstrap-`ApplicationSet`-Ressourcen** statt einer einzigen —
`home-server-apps-platform` und `home-server-apps-workloads`
(`argocd/bootstrap/root-applicationset.yaml`, zwei YAML-Dokumente in einer
Datei). Jede ist strukturell identisch, bis auf Directory-Glob und
`spec.project`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: home-server-apps-platform
spec:
  generators:
    - git:
        repoURL: https://github.com/pkr-lab/capulus-core.git
        revision: main
        directories:
          - path: "argocd/apps/platform/*"
  template:
    spec:
      project: platform   # fest codiert, kein Templating
      # ...
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: home-server-apps-workloads
spec:
  generators:
    - git:
        directories:
          - path: "argocd/apps/workloads/*"
  template:
    spec:
      project: workloads   # fest codiert, kein Templating
      # ...
```

> Bewusst **zwei getrennte Ressourcen** statt einer mit zwei Generatoren oder
> einem aus dem Pfad abgeleiteten Project-Wert — beide Alternativen wurden
> verworfen, Details und Begründung in
> [docs/49-argocd-projects.md](49-argocd-projects.md#wie-es-technisch-funktioniert).

**Funktionsweise:**

- ArgoCD scannt `argocd/apps/platform/` und `argocd/apps/workloads/` im
  Git-Repo (getrennt, je eigenes ApplicationSet).
- Jedes Unterverzeichnis wird zu einer ArgoCD-**Application**.
- Application-Name = Verzeichnisname der App (nicht des Tiers).
- Ziel-Namespace = Verzeichnisname der App — **die zusätzliche
  Tier-Ebene ändert nichts an Namespaces**, nur an der Pfadstruktur in Git.
- AppProject = `platform` bzw. `workloads`, je nachdem welches
  ApplicationSet die App gefunden hat (siehe
  [docs/49-argocd-projects.md](49-argocd-projects.md) für die Details der
  AppProject-`destinations`).
- ArgoCD synct den Inhalt des Verzeichnisses in den Cluster.

**Beispielhafte Verzeichnis-Struktur** (Auszug — vollständige, aktuell gepflegte
Liste aller Apps: [README.md → Repository-Layout](../README.md#repository-layout)):

```
argocd/apps/
├── platform/             → Schicht-3-Plattformdienste (AppProject: platform)
│   ├── authentik/        → Zentrale Anmeldung, Identity Provider
│   ├── kubeseal-webgui/  → Browser-UI, die Werte mit dem
│   │                        SealedSecrets-Public-Key des Clusters verschlüsselt
│   ├── monitoring/       → VictoriaMetrics + Grafana + node-exporter +
│   │                        kube-state-metrics + Alertmanager
│   ├── sealed-secrets/   → bitnami-labs SealedSecrets-Controller
│   │                        (entschlüsselt SealedSecret-CRDs zu Secrets)
│   └── ...               → und weitere, siehe README.md
└── workloads/            → Schicht-4-Anwendungen (AppProject: workloads)
    ├── example-whoami/   → Referenz-Helm-Chart als Wiring-Test
    ├── vaultwarden/      → Bitwarden-kompatibler Passwort-Manager
    ├── zammad/           → Helpdesk/Ticket-System
    └── ...               → und weitere, siehe README.md
```

Jedes Verzeichnis wird zu einer `Application` mit gleichem Namen und Namespace.
Eine neue App ist vier Schritte entfernt: Tier entscheiden, Verzeichnis unter
`argocd/apps/platform/<name>/` oder `argocd/apps/workloads/<name>/` anlegen
(plain Manifests, `kustomization.yaml` **oder** Helm-Chart mit `Chart.yaml` +
`values.yaml`), Namen in `argocd_platform_apps`/`argocd_workloads_apps`
(`ansible/roles/argocd/defaults/main.yml`) ergänzen, committen, pushen —
ArgoCD greift in ~3 Minuten zu.

---

## Neue Application hinzufügen

Der GitOps-Workflow für neue Apps:

1. Tier entscheiden: **Platform** (Infrastruktur/Admin-Charakter) oder
   **Workloads** (echter Nutzerkreis) — siehe
   [docs/49-argocd-projects.md](49-argocd-projects.md#die-zwei-tiers).
2. Verzeichnis `argocd/apps/platform/<app-name>/` oder
   `argocd/apps/workloads/<app-name>/` anlegen.
3. Kubernetes-Manifests oder Helm-Chart hineinlegen.
4. `<app-name>` in `argocd_platform_apps` bzw. `argocd_workloads_apps`
   (`ansible/roles/argocd/defaults/main.yml`) ergänzen — sonst fehlt der
   AppProject-`destinations`-Eintrag und der Sync schlägt mit
   `application destination namespace ... is not permitted in project ...`
   fehl.
5. `make render-bootstrap` laufen lassen (aktualisiert die committeten
   Kopien unter `argocd/bootstrap/`).
6. `git add` + `git commit` + `git push`.
7. ArgoCD erkennt das neue Verzeichnis innerhalb von ~3 Minuten.
8. ArgoCD erzeugt eine Application im richtigen AppProject und synct sie.

**Beispiel: App mit Plain-Manifest** (hier als Workload-App)

```bash
mkdir -p argocd/apps/workloads/my-app
cat > argocd/apps/workloads/my-app/deployment.yaml << 'EOF'
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

# my-app in argocd_workloads_apps (ansible/roles/argocd/defaults/main.yml) ergänzen,
# dann: make render-bootstrap

git add argocd/apps/workloads/my-app/ ansible/roles/argocd/defaults/main.yml argocd/bootstrap/
git commit -m "feat: add my-app"
git push
```

**Beispiel: App als Helm-Chart**

```bash
mkdir -p argocd/apps/workloads/my-helm-app/templates

# Chart.yaml, values.yaml, templates/ — standard Helm-Chart-Struktur
# ArgoCD erkennt Chart.yaml und behandelt das Verzeichnis als Helm-Chart
```

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
# argocd/apps/workloads/my-careful-app/argocd-application.yaml
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
# Login (--insecure wegen selbstsigniertem Zertifikat)
argocd login 192.168.1.100:30443 --username admin --password <password> --insecure

# Via Tailscale
argocd login homeserver:30443 --username admin --password <password> --insecure

# Aktueller Context
argocd context
```

**Applications:**

```bash
# Alle Apps auflisten
argocd app list

# Details
argocd app get example-whoami

# Manuell syncen
argocd app sync example-whoami

# Sync mit Prune (überflüssige Resources entfernen)
argocd app sync example-whoami --prune

# Spezifische Resource syncen
argocd app sync example-whoami --resource apps:Deployment:whoami

# Auf Sync warten
argocd app wait example-whoami --sync

# Logs
argocd app logs example-whoami

# Diff (was würde sich ändern)
argocd app diff example-whoami

# Rollback auf vorherige Revision
argocd app rollback example-whoami 1   # Revision-Nummer aus der Historie

# Historie
argocd app history example-whoami

# App löschen (löscht Default-mäßig KEINE Cluster-Resources)
argocd app delete example-whoami

# App UND Cluster-Resources löschen
argocd app delete example-whoami --cascade
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
3. Payload-URL: `https://<tailscale-ip>:30443/api/webhook`.
4. Content type: `application/json`.
5. **Just the push event**.
6. **Add webhook**.

Hinweis: Der Server muss aus den GitHub-Servern erreichbar sein. Über Tailscale
geht das nur, wenn er als
[Tailscale-Exit-Node](06-tailscale.md) eingerichtet oder Subnet-Routing
konfiguriert ist.

Alternativ ist der 3-Minuten-Poll für einen Home-Server völlig ausreichend.
