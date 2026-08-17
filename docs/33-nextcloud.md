# 33 — Nextcloud

[Nextcloud](https://nextcloud.com) ist eine selbst gehostete
Datei-Sync-, Kalender- und Kontakte-Plattform (Google-Drive-/-Workspace-
Ersatz). Die Deployment-Konfiguration liegt unter `argocd/apps/workloads/nextcloud/`.

---

## Übersicht

| Komponente  | Technologie                          | Namespace   |
|-------------|---------------------------------------|-------------|
| Nextcloud   | PHP/Apache (`nextcloud:34.0.3-apache`) | `nextcloud` |
| Datenbank   | PostgreSQL 16 (eigenes Deployment)     | `nextcloud` |
| Cache/Locks | Redis 7 (eigenes Deployment)           | `nextcloud` |
| Ingress     | Traefik                                | `nextcloud` |
| Secrets     | SealedSecrets                          | `nextcloud` |
| Persistenz  | StorageClass `nas` (UGREEN NAS, NFS)   | —           |

Nutzdaten (`html`- und `data`-Verzeichnis) liegen auf der
`nas`-StorageClass (siehe [docs/16-nas-storage.md](16-nas-storage.md)) —
keine NodeAffinity nötig. `data` ist bewusst als eigenes, separat
dimensioniertes PVC von `html` getrennt (Standard-Startgröße 100Gi,
`html`/App-Code nur 5Gi), damit die eigentlichen Nutzerdateien unabhängig
von der App-Installation wachsen können.

> **Warum kein Bitnami-Subchart?** Analog zu Wiki.js/Zammad — siehe
> [docs/20-wikijs.md](20-wikijs.md) für die Begründung (Bitnami-Charts seit
> August 2025 eingeschränkt/kostenpflichtig).

---

## Voraussetzungen

- ArgoCD läuft und das Root-ApplicationSet ist aktiv (`argocd/bootstrap/root-applicationset.yaml`)
- Sealed-Secrets Controller ist installiert (`argocd/apps/platform/sealed-secrets/`)
- **`nas-storage`-App ist deployt** (`argocd/apps/platform/nas-storage/`) und die
  StorageClass `nas` existiert: `kubectl get storageclass nas`
- **NAS ist online und der NFS-Export erreichbar** (siehe
  [docs/16-nas-storage.md](16-nas-storage.md)) — sonst bleiben die PVCs
  auf `Pending`
- `kubeseal` CLI ist lokal installiert
- `kubectl` ist mit dem Cluster verbunden
- (Optional, für externen Zugriff) `argocd/apps/platform/cloudflared/` ist bereits
  deployt — die Ingress-Regel für `nextcloud.pke-lab.de` ist schon
  eingetragen (siehe [docs/23-cloudflare-deploy.md](23-cloudflare-deploy.md))

---

## Schritt 1 — Secrets versiegeln

Zwei unterschiedliche Werte, ein Secret (`nextcloud-secrets`) mit zwei Keys:

```bash
# 1. DB-Passwort generieren und versiegeln
DB_PASS=$(openssl rand -base64 32 | tr -d '=+/' | head -c 32)
echo -n "$DB_PASS" | kubeseal --raw \
  --namespace nextcloud --name nextcloud-secrets \
  --controller-namespace sealed-secrets \
  --controller-name sealed-secrets-controller
# → Ausgabe als encryptedDbPassword eintragen

# 2. Admin-Passwort generieren und versiegeln (separater Wert!)
ADMIN_PASS=$(openssl rand -base64 24 | tr -d '=+/' | head -c 24)
echo "ADMIN_PASS: $ADMIN_PASS"   # sicher speichern (Passwort-Manager)
echo -n "$ADMIN_PASS" | kubeseal --raw \
  --namespace nextcloud --name nextcloud-secrets \
  --controller-namespace sealed-secrets \
  --controller-name sealed-secrets-controller
# → Ausgabe als encryptedAdminPassword eintragen
```

Beide Ausgaben in `argocd/apps/workloads/nextcloud/values.yaml` eintragen:

```yaml
secrets:
  enabled: true
  name: nextcloud-secrets
  encryptedDbPassword: "<Ausgabe von Aufruf 1>"
  encryptedAdminPassword: "<Ausgabe von Aufruf 2>"
```

> Das Admin-Passwort wird nur beim **allerersten** Start verwendet (initiale
> Installation über die `NEXTCLOUD_ADMIN_*`-Env-Variablen des offiziellen
> Images) — spätere Änderungen des Werts in `values.yaml` haben keine
> Wirkung mehr auf einen bereits installierten Nextcloud.

---

## Schritt 2 — Deployment via ArgoCD

Nach dem Commit erkennt das Root-ApplicationSet den neuen Ordner
`argocd/apps/workloads/nextcloud/` automatisch:

```bash
kubectl get pods -n nextcloud -w
```

Erwartete Reihenfolge: `nextcloud-postgresql-*` und `nextcloud-redis-*`
zuerst, dann `nextcloud-*` (App-Pod) — führt beim ersten Start die
Installation durch, das kann 1–2 Minuten dauern (siehe `readinessProbe`
gegen `/status.php`).

**DNS:** `nextcloud.prod.homeserver` ist dank Wildcard-DNS sofort erreichbar
(siehe [docs/09-dns-architecture.md](09-dns-architecture.md) und
[docs/56-domain-tiers.md](56-domain-tiers.md) zum `prod`-Tier-Präfix).

---

## Schritt 3 — Erstlogin

1. `https://nextcloud.prod.homeserver` öffnen
2. Mit `admin` / dem in Schritt 1.2 generierten Passwort einloggen
3. Empfohlen: unter **Einstellungen → Verwaltung → Grundeinstellungen**
   prüfen, dass Redis als "Verteilter Cache" + "Transactional File Locking"
   erkannt wurde (steht automatisch, sobald `REDIS_HOST` beim Setup
   gesetzt war — bei uns immer der Fall)

---

## Externe Erreichbarkeit (Cloudflare Tunnel)

`nextcloud-prod.pke-lab.de` ist bereits in
`argocd/apps/platform/cloudflared/values.yaml` eingetragen (zeigt auf den
internen `nextcloud.nextcloud.svc.cluster.local:80`-Service). Für
Mobile-/Desktop-Sync-Clients außerhalb von LAN/Tailscale:

- **Desktop-Client / Mobile-App**: Server-URL `https://nextcloud-prod.pke-lab.de`
- Intern (LAN/Tailscale) funktioniert weiterhin `https://nextcloud.prod.homeserver`

`trustedDomains` in `values.yaml` enthält bereits beide Hostnamen
(`nextcloud.prod.homeserver nextcloud-prod.pke-lab.de`) — ohne diesen
Eintrag weist Nextcloud Requests mit "Access through untrusted domain" ab.
**Achtung:** Das greift nur bei der Erstinstallation (siehe
Troubleshooting-Abschnitt unten) — ändert sich der Hostname später (z. B.
bei einer Domain-Tier-Migration wie in docs/56 beschrieben), muss
`trusted_domains` in der bereits bestehenden `config.php` separat
nachgezogen werden.

---

## Hintergrund-Jobs (Cron)

Standardmäßig nutzt Nextcloud **AJAX-Cron** (bei jedem Seitenaufruf im
Browser ausgelöst) — für Home-Lab-Nutzung mit gelegentlichen Aufrufen
ausreichend. Bei spürbar verzögerten Hintergrund-Aufgaben (z. B.
Vorschaubilder, Dateiindizierung) lässt sich optional ein Kubernetes
`CronJob` ergänzen, der alle 5 Minuten `php cron.php` im `nextcloud`-
Container ausführt (nicht Teil dieser ersten Iteration) — Details dazu in
der [offiziellen Nextcloud-Doku](https://docs.nextcloud.com/server/latest/admin_manual/configuration_server/background_jobs_configuration.html).

---

## Troubleshooting

### Pod startet, `/status.php` liefert aber lange keine Antwort

Erster Start führt die vollständige Installation durch (DB-Schema,
Standard-Apps) — bei 100Gi-`data`-PVC auf NFS kann das je nach
NAS-Auslastung 1–2 Minuten dauern. `kubectl logs -n nextcloud
deploy/nextcloud -f` zeigt den Fortschritt.

### "Access through untrusted domain" / CrashLoopBackOff mit "Trusted domain error" (HTTP 400 auf `/status.php`)

Zwei unterschiedliche Ursachen möglich:

1. **Frischinstallation:** `trustedDomains` in `values.yaml` prüfen — muss
   exakt den Hostnamen enthalten, über den zugegriffen wird
   (Groß-/Kleinschreibung und Port spielen keine Rolle, der Domainname
   selbst muss aber exakt passen).
2. **Bestehende Installation, `values.yaml` ist bereits korrekt, Pod
   crasht trotzdem:** `NEXTCLOUD_TRUSTED_DOMAINS`/`trustedDomains` wirkt
   nur bei der Erstinstallation — bei einem bereits vorhandenen
   `config.php` (z. B. nach einer Domain-Umbenennung wie der
   Tier-Migration in docs/56) bleibt der alte Eintrag stehen, jeder
   Health-Check schlägt dann dauerhaft mit `{"error": "Trusted domain
   error.", "code": 15}` fehl → `CrashLoopBackOff`. Prüfen:
   ```bash
   kubectl exec -n nextcloud deploy/nextcloud -- \
     grep -A5 trusted_domains /var/www/html/config/config.php
   ```
   Normalerweise würde man das mit `occ config:system:set trusted_domains
   N --value=...` reparieren — hier verweigert `occ` das aber meist mit
   `Console has to be executed with the user that owns the file
   config/config.php`, weil `config.php` auf der NFS-`nas`-PVC durch das
   `all_squash` der UGREEN-NAS (siehe unten) einer anderen UID gehört als
   `www-data`. Statt manuell mit `kubectl exec` am Pod zu hantieren
   (schwer nachvollziehbar, nicht reproduzierbar), liegt dafür ein
   git-getrackter, einmaliger Reparatur-`Job` bereit:
   `templates/nextcloud-fix-trusted-domains-job.yaml` — startet explizit
   mit `runAsUser: 1000` (passend zur tatsächlichen `config.php`-Owner-UID)
   und setzt `trusted_domains` aus `values.yaml` neu. Läuft automatisch
   beim nächsten ArgoCD-Sync, danach mit `kubectl -n nextcloud delete job
   nextcloud-fix-trusted-domains` wieder entfernen (Jobs sind immutable).

### Root-Squash / all_squash der UGREEN-NAS

Die UGREEN-NAS bietet keine `no_root_squash`-Option für NFS-Exports —
stattdessen ist `all_squash` aktiv, d. h. **jeder** Client-Request
(auch von `root` im Container) wird serverseitig auf eine feste anonyme
UID/GID abgebildet. Auswirkungen:

- Dateien auf `nas`-PVCs können am Ende einer beliebigen, vom eigentlich
  erwarteten Container-User (z. B. `www-data`) abweichenden UID gehören —
  je nachdem, welcher Prozess sie zuerst angelegt hat.
- `chown`/`chmod` auf eine *andere* Ziel-UID schlägt in der Regel fehl,
  da die anonyme Identität serverseitig keine Owner-Änderungsrechte hat —
  betrifft z. B. den offiziellen Nextcloud-Entrypoint, der beim ersten
  Start versucht, `html`/`data` auf `www-data` zu chownen (siehe
  Kommentar zu `podSecurityContext`/`securityContext` in `values.yaml`).
- Plain reads/writes auf bereits existierende Dateien funktionieren i. d. R.
  weiterhin, solange konsistent dieselbe (anonyme) Identität zugreift.
- PostgreSQL liegt deshalb bewusst nicht auf `nas`, sondern auf
  `local-path` (siehe `values.yaml`, `postgresql.persistence`) — reiner
  DB-State profitiert nicht von NAS-Kapazität und ist UID-sensibel.

**Andere Lösung statt `no_root_squash`:** Für `html`/`data` bleibt NFS
vorerst die pragmatischste Option (100Gi Nutzdaten lassen sich nicht ohne
Weiteres auf lokalen Storage verschieben) — Workarounds wie der
Repair-`Job` oben (fester `runAsUser`) umgehen das UID-Problem gezielt pro
Anwendungsfall, statt eine NAS-Funktion vorauszusetzen, die es auf diesem
Gerät nicht gibt. Eine grundsätzlichere Alternative (Nextcloud-Primärspeicher
auf S3/MinIO statt Dateisystem, siehe `argocd/apps/platform/minio/`) würde
das UID/GID-Modell komplett umgehen, ist aber eine größere
Architekturentscheidung mit eigener Datenmigration — bewusst nicht Teil
dieses Fixes.

### SealedSecret wird nicht entschlüsselt

```bash
kubectl describe sealedsecret -n nextcloud nextcloud-secrets
kubectl logs -n sealed-secrets -l app.kubernetes.io/name=sealed-secrets
```

### PVC bleibt `Pending`

```bash
kubectl describe pvc -n nextcloud nextcloud-data
kubectl -n nas-storage get pods
```

Details: [docs/16-nas-storage.md → Fehlerbehebung](16-nas-storage.md#fehlerbehebung).

---

## Ressourcenverbrauch (Richtwerte Home Lab)

| Komponente   | CPU Request | RAM Request | RAM Limit | Storage                |
|---------------|-------------|--------------|-----------|--------------------------|
| Nextcloud App | 250m        | 512Mi        | 2Gi       | 5Gi `html` (`nas`)       |
| PostgreSQL    | 100m        | 256Mi        | 1Gi       | 10Gi (`nas`)             |
| Redis         | 25m         | 64Mi         | 256Mi     | —                        |
| **Gesamt**    | ~375m       | ~832Mi       | ~3,25Gi   | 100Gi `data` + 15Gi sonstiges |

`persistence.data.size` in `values.yaml` bei Bedarf erhöhen — `nas` erlaubt
zwar kein Online-Volume-Expansion (siehe
[docs/16-nas-storage.md](16-nas-storage.md)), ein größerer Wert wirkt sich
aber nur auf die Kubernetes-Quota aus, nicht auf den tatsächlich auf dem
NAS belegten Speicher (nfs-subdir-external-provisioner erzwingt keine
Quotas auf Dateisystem-Ebene).

---

## Autoskalierung (HPA)

Die Nextcloud-App-Komponente skaliert per HPA auf 1–2 Replicas (CPU 75%
/ RAM 80%). Das ist nur sicher, weil Nextcloud das mitgelieferte Redis
für verteiltes Datei-Locking nutzt — ohne das würden zwei App-Pods sich
beim gleichzeitigen Zugriff auf die geteilte `html`/`data`-PVC in die
Quere kommen. Da diese PVCs `ReadWriteOnce` sind, erzwingt eine
`podAffinity` zusätzlich, dass beide Replicas auf demselben Node laufen.
PostgreSQL und Redis bleiben unangetastet (Single-Writer, kein HPA).
Details für alle Apps: [39-hpa-autoscaling.md](39-hpa-autoscaling.md).

---

## Relevante Links

- [Nextcloud-Dokumentation](https://docs.nextcloud.com)
- [Nextcloud Docker-Image](https://github.com/nextcloud/docker)
- [NAS-Storage (UGREEN NAS)](16-nas-storage.md)
- [Cloudflare Tunnel — Deploy](23-cloudflare-deploy.md)
- [ArgoCD Setup](05-argocd.md)
