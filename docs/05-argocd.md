# ArgoCD-GitOps-Guide

Dieses Dokument behandelt ArgoCD-Zugriff, Konfiguration und GitOps-Alltag.

---

## Zugriff

### Web-UI

ArgoCD läuft als NodePort-Service auf den Ports **30080** (HTTP) und **30443** (HTTPS).

```
http://<server-ip>:30080
http://homeserver:30080          (via Tailscale-MagicDNS)
http://100.x.x.x:30080           (via Tailscale-IP)
```

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

1. `http://<server-ip>:30080` öffnen.
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
argocd repo add https://github.com/PKE-Tech/capulus-core.git \
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
  url: https://github.com/PKE-Tech/capulus-core.git
  password: ghp_YOUR_GITHUB_TOKEN
  username: YOUR_USER
```

```bash
kubectl apply -f repo-secret.yaml
```

---

## ApplicationSet-Struktur

Das Bootstrap-`ApplicationSet` (`argocd/bootstrap/root-applicationset.yaml`) nutzt
den Git-Directory-Generator, um aus Unterverzeichnissen automatisch
ArgoCD-Applications zu erzeugen.

```yaml
generators:
  - git:
      repoURL: https://github.com/PKE-Tech/capulus-core.git
      revision: HEAD
      directories:
        - path: "argocd/apps/*"
```

**Funktionsweise:**

- ArgoCD scannt `argocd/apps/` im Git-Repo.
- Jedes Unterverzeichnis wird zu einer ArgoCD-**Application**.
- Application-Name = Verzeichnisname.
- Ziel-Namespace = Verzeichnisname.
- ArgoCD synct den Inhalt des Verzeichnisses in den Cluster.

**Aktuelle Verzeichnis-Struktur in diesem Repo:**

```
argocd/apps/
├── example-whoami/      → Referenz-Helm-Chart als Wiring-Test
├── gotify/              → Push-Notification-Server (Android/iOS-Client)
├── headlamp/            → Web-basiertes Kubernetes-Dashboard
├── kubeseal-webgui/     → Browser-UI, die Werte mit dem
│                          SealedSecrets-Public-Key des Clusters verschlüsselt
├── le-homeserver/       → Eigenes Dashboard-UI: le.homeserver (Einsatz) +
│                          admin.homeserver (Admin, Health-Status aus Grafana)
├── monitoring/          → VictoriaMetrics + Grafana + node-exporter +
│                          kube-state-metrics + Alertmanager
├── sealed-secrets/      → bitnami-labs SealedSecrets-Controller
│                          (entschlüsselt SealedSecret-CRDs zu Secrets)
└── semaphore/           → Web-UI zum Ausführen von Ansible-Playbooks
```

Jedes Verzeichnis wird zu einer `Application` mit gleichem Namen und Namespace.
Eine neue App ist drei Schritte entfernt: Verzeichnis unter `argocd/apps/<name>/`
anlegen (plain Manifests, `kustomization.yaml` **oder** Helm-Chart mit
`Chart.yaml` + `values.yaml`), committen, pushen — ArgoCD greift in
~3 Minuten zu.

---

## Neue Application hinzufügen

Der GitOps-Workflow für neue Apps:

1. Verzeichnis `argocd/apps/<app-name>/` anlegen.
2. Kubernetes-Manifests oder Helm-Chart hineinlegen.
3. `git add` + `git commit` + `git push`.
4. ArgoCD erkennt das neue Verzeichnis innerhalb von ~3 Minuten.
5. ArgoCD erzeugt eine Application und synct sie.

**Beispiel: App mit Plain-Manifest**

```bash
mkdir -p argocd/apps/my-app
cat > argocd/apps/my-app/deployment.yaml << 'EOF'
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

git add argocd/apps/my-app/
git commit -m "feat: add my-app"
git push
```

**Beispiel: App als Helm-Chart**

```bash
mkdir -p argocd/apps/my-helm-app/templates

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
# argocd/apps/my-careful-app/argocd-application.yaml
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
# Login
argocd login 192.168.1.100:30080 --username admin --password <password> --insecure

# Via Tailscale
argocd login homeserver:30080 --username admin --password <password> --insecure

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
argocd repo add https://github.com/PKE-Tech/capulus-core.git

# Repo entfernen
argocd repo rm https://github.com/PKE-Tech/capulus-core.git
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
3. Payload-URL: `http://<tailscale-ip>:30080/api/webhook`.
4. Content type: `application/json`.
5. **Just the push event**.
6. **Add webhook**.

Hinweis: Der Server muss aus den GitHub-Servern erreichbar sein. Über Tailscale
geht das nur, wenn er als
[Tailscale-Exit-Node](06-tailscale.md) eingerichtet oder Subnet-Routing
konfiguriert ist.

Alternativ ist der 3-Minuten-Poll für einen Home-Server völlig ausreichend.
