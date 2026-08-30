# Nextcloud

[Nextcloud](https://nextcloud.com) ist eine selbst gehostete
Datei-Sync-, Kalender- und Kontakte-Plattform (Google-Drive-/-Workspace-
Ersatz). Die Deployment-Konfiguration liegt unter `argocd/apps/workloads/nextcloud/`.

---

## Übersicht

| Komponente  | Technologie                          | Namespace   |
|-------------|---------------------------------------|-------------|
| Nextcloud   | PHP/Apache (`nextcloud:34.0.2-apache`) | `nextcloud` |
| Datenbank   | PostgreSQL 16 (eigenes Deployment)     | `nextcloud` |
| Cache/Locks | Redis 7 (eigenes Deployment)           | `nextcloud` |
| Ingress     | Traefik                                | `nextcloud` |
| Secrets     | SealedSecrets                          | `nextcloud` |
| Persistenz  | StorageClass `nas` (UGREEN NAS, NFS)   | —           |

Nutzdaten (`html`- und `data`-Verzeichnis) liegen auf der
`nas`-StorageClass (siehe [docs/2-betrieb-hardware/20000-nas-storage.md](../2-betrieb-hardware/20000-nas-storage.md)) —
keine NodeAffinity nötig. `data` ist bewusst als eigenes, separat
dimensioniertes PVC von `html` getrennt (Standard-Startgröße 100Gi,
`html`/App-Code nur 5Gi), damit die eigentlichen Nutzerdateien unabhängig
von der App-Installation wachsen können.

> **Warum kein Bitnami-Subchart?** Analog zu Wiki.js/Zammad — siehe
> [docs/3-apps-workloads/30030-wikijs.md](30030-wikijs.md) für die Begründung (Bitnami-Charts seit
> August 2025 eingeschränkt/kostenpflichtig).

---

## Voraussetzungen

- ArgoCD läuft und das Root-ApplicationSet ist aktiv (`argocd/bootstrap/root-applicationset.yaml`)
- Sealed-Secrets Controller ist installiert (`argocd/apps/platform/sealed-secrets/`)
- **`nas-storage`-App ist deployt** (`argocd/apps/platform/nas-storage/`) und die
  StorageClass `nas` existiert: `kubectl get storageclass nas`
- **NAS ist online und der NFS-Export erreichbar** (siehe
  [docs/2-betrieb-hardware/20000-nas-storage.md](../2-betrieb-hardware/20000-nas-storage.md)) — sonst bleiben die PVCs
  auf `Pending`
- `kubeseal` CLI ist lokal installiert
- `kubectl` ist mit dem Cluster verbunden
- (Optional, für externen Zugriff) `argocd/apps/platform/cloudflared/` ist bereits
  deployt — die Ingress-Regel für `nextcloud.pke-lab.de` ist schon
  eingetragen (siehe [docs/e-externe-erreichbarkeit/e0010-cloudflare-deploy.md](../e-externe-erreichbarkeit/e0010-cloudflare-deploy.md))

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
(siehe [docs/c-netzwerk-dns/c0000-dns-architecture.md](../c-netzwerk-dns/c0000-dns-architecture.md) und
[docs/c-netzwerk-dns/c0040-domain-tiers.md](../c-netzwerk-dns/c0040-domain-tiers.md) zum `prod`-Tier-Präfix).

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
bei einer Domain-Tier-Migration wie in docs/c-netzwerk-dns/c0040-domain-tiers.md beschrieben), muss
`trusted_domains` in der bereits bestehenden `config.php` separat
nachgezogen werden.

**Freigabe-Links (Share-Links) zeigen immer auf die öffentliche Domain:**
Ohne weitere Konfiguration baut Nextclouds URL-Generator Freigabe-Links aus
dem Host, über den man gerade eingeloggt ist — meldet man sich intern über
`nextcloud.prod.homeserver` an, sind erzeugte Links nur im LAN/Tailscale
aufrufbar und lassen sich nicht nach außen teilen. `overwriteHost` /
`overwriteProtocol` / `overwriteCliUrl` in `values.yaml` erzwingen deshalb
`https://nextcloud-prod.pke-lab.de` als Basis für **alle** generierten
URLs, unabhängig vom Zugriffs-Host — gesetzt über denselben Repair-`Job`
wie `trusted_domains` (siehe `templates/nextcloud-fix-config-job.yaml`,
Troubleshooting-Abschnitt unten). Die interne Erreichbarkeit über
`nextcloud.prod.homeserver` bleibt davon unberührt, nur die *generierten*
Links ändern sich.

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

## Datenbank-Major-Upgrade (Postgres 16 → 18)

Renovate schlägt für `argocd/apps/workloads/nextcloud/values.yaml` irgendwann
den Sprung von `postgresql.image.tag: "16-alpine"` auf `18-alpine` vor. Ein
reiner Tag-Bump reicht dafür **nicht** — Postgres verweigert den Start, wenn
das vorhandene Datenverzeichnis von einer älteren Major-Version stammt
("database files are incompatible with server"). Der PR bleibt also
liegen, bis das Upgrade manuell durchgeführt wurde.

**Ablauf (Dump & Restore auf neuen PGDATA-Unterordner, gleiche PVC):**
Die `postgres-deployment.yaml` zeigt `PGDATA` bereits auf einen
Unterordner (`/var/lib/postgresql/data/pgdata`) statt auf die PVC-Wurzel —
das lässt sich nutzen, um Postgres 18 in einen **frischen, leeren
Unterordner derselben PVC** starten zu lassen, ohne die alten Daten
anzufassen. Kein zweiter PVC, keine ArgoCD-Klimmzüge nötig, und ein
Rollback ist nur ein Revert der beiden geänderten Zeilen.

1. **Zusätzlicher Konsistenz-Dump** (ergänzend zum nächtlichen
   dateisystem-Backup aus [docs/2-betrieb-hardware/20010-nas-backup.md](../2-betrieb-hardware/20010-nas-backup.md) —
   das ist nur crash-consistent, kein `pg_dump`):
   ```bash
   kubectl -n nextcloud exec deploy/nextcloud-postgresql -- \
     pg_dump -U nextcloud -Fc nextcloud > nextcloud-pg16-$(date +%F).dump
   ```
2. **Nextcloud in Wartungsmodus + auf 0 Replicas skalieren** (verhindert
   Schreibzugriffe während des Umschaltens):
   ```bash
   kubectl -n nextcloud exec deploy/nextcloud -- occ maintenance:mode --on
   kubectl -n nextcloud scale deploy/nextcloud --replicas=0
   ```
3. **In der Chart-Vorlage zwei Stellen ändern** (lokal, noch nicht pushen):
   - `values.yaml`: `postgresql.image.tag: "16-alpine"` → `"18-alpine"`
   - `templates/postgres-deployment.yaml`: `PGDATA`-Wert von
     `/var/lib/postgresql/data/pgdata` auf
     `/var/lib/postgresql/data/pgdata_pg18` ändern (neuer, leerer
     Unterordner — der alte `pgdata`-Ordner bleibt als Rollback-Fallback
     unangetastet auf derselben PVC liegen).
   - Committen/pushen (macht ihr selbst), ArgoCD syncen lassen. Der neue
     Postgres-18-Pod startet danach mit leerer, frischer Datenbank.
4. **Dump zurückspielen:**
   ```bash
   kubectl -n nextcloud cp nextcloud-pg16-*.dump nextcloud-postgresql-<pod>:/tmp/restore.dump
   kubectl -n nextcloud exec deploy/nextcloud-postgresql -- \
     pg_restore -U nextcloud -d nextcloud /tmp/restore.dump
   ```
5. **Verifikation:** `kubectl scale deploy/nextcloud --replicas=1`,
   `occ maintenance:mode --off`, einloggen, ein paar Dateien/Freigaben
   stichprobenartig prüfen.
6. **Rollback**, falls irgendwas nicht passt: einfach Schritt 3 revertieren
   (Tag zurück auf `16-alpine`, `PGDATA` zurück auf `pgdata`) — die alten
   Daten liegen unverändert auf derselben PVC, kein Restore aus dem
   nächtlichen Backup nötig.
7. **Aufräumen** erst nach ein paar Tagen störungsfreiem Betrieb: alten
   `pgdata`-Ordner per einmaligem Job löschen, um PVC-Platz freizugeben
   (analog zum `fix-permissions`-initContainer-Muster oben in derselben
   Datei).

> **Hinweis `storageClassName: local-path`:** Anders als die meisten
> anderen Apps liegt die Nextcloud-Postgres-PVC bewusst nicht auf der
> NFS-`nas`-StorageClass (siehe Kommentar in `values.yaml`) — der Pod ist
> dadurch an einen festen Node gebunden. Das ändert am Ablauf oben nichts,
> nur zur Einordnung, falls der Node mal getauscht werden soll.

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
   Tier-Migration in docs/c-netzwerk-dns/c0040-domain-tiers.md) bleibt der alte Eintrag stehen, jeder
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
   `templates/nextcloud-fix-config-job.yaml` — startet explizit
   mit `runAsUser: 1000` (passend zur tatsächlichen `config.php`-Owner-UID)
   und setzt `trusted_domains` sowie `overwritehost`/`overwriteprotocol`/
   `overwrite.cli.url` (siehe Abschnitt "Freigabe-Links" oben) aus
   `values.yaml` neu. Als ArgoCD-Sync-Hook
   (`PostSync` + `BeforeHookCreation,HookSucceeded`) definiert — läuft bei
   jedem Sync frisch und räumt sich danach selbst auf, kein manuelles
   `kubectl delete job` nötig (**wichtig:** ohne diese Hook-Annotationen
   scheitert jeder zweite Sync-Versuch an genau dieser bereits
   existierenden Job-Ressource mit "field is immutable" und blockiert den
   gesamten weiteren Sync der App — so beim ersten Rollout dieses Jobs
   passiert). Mountet **beide** PVCs (`html` **und** `data`) — `occ`
   verweigert sonst mit "Environment not properly prepared" / "Your data
   directory is invalid", weil es die `.ncdata`-Markerdatei im
   Datenverzeichnis erwartet.

### CrashLoopBackOff mit tausenden `rsync: chown ... Operation not permitted`-Zeilen nach einem Image-Tag-Wechsel

**Nicht** an einzelnen Dateien herumprüfen — das ist eine strukturelle
Folge von `all_squash` (siehe unten) beim **Versions-Upgrade**, kein
Rand-/Einzelfall:

Nextclouds offizieller Entrypoint vergleicht bei jedem Start die in
`version.php` auf der PVC hinterlegte Version mit der Image-Version. Weicht
das Image (per `image.tag` in `values.yaml`) davon ab, läuft der volle
Upgrade-Sync: `rsync` kopiert den kompletten App-Code neu und versucht
dabei — weil der Container als root läuft — **jede einzelne** Datei per
`--chown www-data:www-data` umzueignen. Unter `all_squash` schlägt das
für jede Datei fehl, `rsync` beendet sich mit Exit 23, der Container
crasht, `version.php` bleibt auf dem alten Stand stehen → beim nächsten
Start exakt derselbe Upgrade-Versuch, endlos. Empirisch ausgelöst durch
einen Tag-Bump 34.0.2 → 34.0.3 am 17.08.2026 (siehe Commit-Historie) —
vorher lief der Pod stabil, weil Image- und PVC-Version übereinstimmten
und der Upgrade-Pfad dadurch gar nicht erst anlief.

**Nicht-Root ist hier keine Lösung**, auch wenn der Entrypoint dann eine
chown-freie rsync-Variante (`-rlD`) wählen würde: Das offizielle Image ist
nicht für beliebige Nicht-Root-UIDs gebaut, u. a. ist
`/usr/local/etc/php/conf.d/` nur für `root` beschreibbar (dort landet z. B.
die Redis-Session-Config) — ein Testpod mit `runAsUser: 1000` scheiterte
bereits vor dem eigentlichen App-Sync an `Permission denied` beim
Schreiben dieser Datei.

**Fix/Vermeidung:** `image.tag` **nicht** ungeprüft hochziehen, solange
`html`/`data` auf der `nas`-StorageClass liegen — vor jedem Versions-Wechsel
die tatsächlich installierte Version gegen die PVC prüfen, solange der Pod
noch läuft (bevor ein Tag-Wechsel ihn crashen lässt):

```bash
kubectl exec -n nextcloud deploy/nextcloud -- cat /var/www/html/version.php
```

Ein tatsächliches Upgrade auf dieser NAS ist damit aktuell **nicht sicher
automatisierbar** — siehe "Andere Lösung" unten (S3/MinIO als
Primärspeicher würde das Problem grundsätzlich lösen).

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

Details: [docs/2-betrieb-hardware/20000-nas-storage.md → Fehlerbehebung](../2-betrieb-hardware/20000-nas-storage.md#fehlerbehebung).

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
[docs/2-betrieb-hardware/20000-nas-storage.md](../2-betrieb-hardware/20000-nas-storage.md)), ein größerer Wert wirkt sich
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
Details für alle Apps: [../b-kubernetes-gitops/b0040-hpa-autoscaling.md](../b-kubernetes-gitops/b0040-hpa-autoscaling.md).

---

## Relevante Links

- [Nextcloud-Dokumentation](https://docs.nextcloud.com)
- [Nextcloud Docker-Image](https://github.com/nextcloud/docker)
- [NAS-Storage (UGREEN NAS)](../2-betrieb-hardware/20000-nas-storage.md)
- [Cloudflare Tunnel — Deploy](../e-externe-erreichbarkeit/e0010-cloudflare-deploy.md)
- [ArgoCD Setup](../b-kubernetes-gitops/b0010-argocd.md)
