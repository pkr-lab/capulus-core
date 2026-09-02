# Immich

[Immich](https://immich.app) ist ein selbst gehostetes Foto-/Video-Backup
(Google-Photos-Ersatz) mit automatischem Handy-Upload, Gesichtserkennung
und Timeline-Ansicht. Die Deployment-Konfiguration liegt unter
`argocd/apps/workloads/immich/`, der zugehörige NAS-Storage unter
`argocd/apps/platform/immich-storage/`.

---

## Übersicht

| Komponente             | Technologie                                          | Namespace |
|-------------------------|--------------------------------------------------------|-----------|
| immich-server            | `ghcr.io/immich-app/immich-server:v3.1.0`              | `immich`  |
| immich-machine-learning  | `ghcr.io/immich-app/immich-machine-learning:v3.1.0` (Gesichtserkennung, CLIP-Suche, reine CPU) | `immich`  |
| Datenbank                | PostgreSQL 14 + VectorChord (`ghcr.io/immich-app/postgres`) | `immich`  |
| Job-Queue                | Valkey (Redis-kompatibel)                               | `immich`  |
| Ingress                  | Traefik                                                | `immich`  |
| Secrets                  | SealedSecrets                                          | `immich`  |
| Persistenz               | StorageClass `immich-nas` (dedizierter NFS-Export)      | —         |

> **Warum keine PostgreSQL-Standard-Images wie bei Wiki.js/Nextcloud?**
> Immichs Ähnlichkeitssuche (Gesichter, "Suche nach Motiv") basiert auf
> Vektor-Embeddings, die eine Postgres-Extension (VectorChord, vormals
> pgvecto.rs) brauchen. Das offizielle `ghcr.io/immich-app/postgres`-Image
> bringt diese Extension bereits vorinstalliert mit — ein Standard-
> `postgres`-Image reicht hier **nicht**.

---

## Dedizierter Storage: `immich-nas` statt `nas`

Anders als die übrigen Apps in diesem Repo liegt Immichs kompletter
Storage (Fotobibliothek, Postgres-Daten, ML-Modell-Cache) **nicht** auf
der generischen `nas`-StorageClass (`/volume1/k8s-storage`), sondern auf
einer eigenen StorageClass `immich-nas`, die auf einen zweiten,
unabhängigen NFS-Export zeigt: `/volume2/immich-storage`.

```
┌─────────────── UGREEN NAS ───────────────┐
│  /volume1/k8s-storage   → StorageClass "nas"        (Nextcloud, Wiki.js, …)
│  /volume2/immich-storage → StorageClass "immich-nas" (nur Immich)
└───────────────────────────────────────────┘
```

**Begründung:** Die Fotobibliothek wächst unabhängig und potenziell
deutlich schneller als der restliche Cluster-Storage — mit einem eigenen
Export lassen sich Kapazität, Backup-Priorität und ggf. später ein
eigenes RAID-Volume unabhängig vom übrigen Cluster-Storage planen, ohne
dass ein einzelner großer Fotobestand den gemeinsamen `k8s-storage`-Export
volllaufen lässt.

`argocd/apps/platform/immich-storage/` deployt dafür einen zweiten
`nfs-subdir-external-provisioner` (eigener `PROVISIONER_NAME`, eigene
RBAC-Ressourcen, eigener Namespace `immich-storage`) — technisch identisch
zum bestehenden `nas-storage`-Setup aus
[docs/2-betrieb-hardware/20000-nas-storage.md](../2-betrieb-hardware/20000-nas-storage.md), nur auf einen anderen Export
gerichtet.

---

## Voraussetzungen

- ArgoCD läuft und das Root-ApplicationSet ist aktiv
- Sealed-Secrets Controller ist installiert (`argocd/apps/platform/sealed-secrets/`)
- **NFS-Export `/volume2/immich-storage` in UGOS eingerichtet** (Schritt 1
  unten) — die IP/Firewall-Konfiguration ist identisch zum bestehenden
  `k8s-storage`-Export, nur mit neuer Freigabe auf `volume2`
- `kubeseal` CLI ist lokal installiert
- `kubectl` ist mit dem Cluster verbunden

---

## Schritt 1 — NFS-Export für Immich einrichten (UGOS, manuell)

Analog zu
[docs/2-betrieb-hardware/20000-nas-storage.md → NFS-Export in UGOS einrichten](../2-betrieb-hardware/20000-nas-storage.md#nfs-export-in-ugos-einrichten-manuell-kein-ansible-playbook),
diesmal auf `volume2`:

1. Auf `volume2` eine neue Freigabe `immich-storage` anlegen.
2. NFS-Regel-Eintrag für diese Freigabe:
   - Erlaubte Hosts: `192.168.178.0/24`
   - Berechtigung: Lese-/Schreibzugriff
   - Squash: `no_root_squash`
3. Exportpfad prüfen — falls abweichend von `/volume2/immich-storage`,
   sowohl `argocd/apps/platform/immich-storage/deployment.yaml`
   (`NFS_SERVER`/`NFS_PATH` sowie den `nfs`-Volume-Block) **als auch**
   `argocd/apps/platform/immich-storage/storageclass.yaml`-Kommentar entsprechend
   anpassen.
4. Verbindung testen:
   ```bash
   sudo mount -t nfs 192.168.178.97:/volume2/immich-storage /mnt
   touch /mnt/test && ls /mnt && sudo umount /mnt
   ```

Danach `argocd/apps/platform/immich-storage/` deployen lassen (Root-ApplicationSet
erkennt den neuen Ordner automatisch) und verifizieren:

```bash
kubectl get storageclass immich-nas
kubectl -n immich-storage get pods
```

---

## Schritt 2 — Secret versiegeln

```bash
DB_PASS=$(openssl rand -base64 32 | tr -d '=+/' | head -c 32)
echo -n "$DB_PASS" | kubeseal --raw \
  --namespace immich --name immich-secrets \
  --controller-namespace sealed-secrets \
  --controller-name sealed-secrets-controller
```

Ausgabe in `argocd/apps/workloads/immich/values.yaml` eintragen:

```yaml
secrets:
  enabled: true
  name: immich-secrets
  encryptedDbPassword: "<Ausgabe von kubeseal>"
```

---

## Schritt 3 — Deployment via ArgoCD

```bash
kubectl get pods -n immich -w
```

Erwartete Reihenfolge: `immich-postgresql-*` + `immich-redis-*` zuerst,
dann `immich-server-*` und `immich-machine-learning-*`. Der
ML-Container lädt beim ersten Start seine Modelle herunter (landet im
`model-cache`-PVC) — das kann je nach Verbindung ein paar Minuten dauern,
danach ist der Cache persistent und Neustarts sind schnell.

**DNS:** `immich.homeserver` ist dank Wildcard-DNS sofort erreichbar.

> **Machine-Learning-Verbindung:** `immich-server` erwartet den
> ML-Dienst standardmäßig unter `http://immich-machine-learning:3003`
> (Immichs eingebauter Default). Der Service-Name in diesem Chart ist
> exakt `immich-machine-learning` (im selben Namespace) — das passt ohne
> weitere Konfiguration. Falls in **Administration → Einstellungen →
> Machine Learning → URL** trotzdem ein Fehler auftaucht, dort explizit
> `http://immich-machine-learning.immich.svc.cluster.local:3003`
> eintragen.

---

## Schritt 4 — Erstlogin und Handy-App

1. `https://immich.homeserver` öffnen → erster Aufruf legt den
   Admin-Account an (kein separates Admin-Passwort in `values.yaml` nötig
   — Immich fragt das im Browser ab)
2. **Handy-App** (iOS/Android, "Immich"): Server-URL
   `https://immich.pke-lab.de` eintragen (siehe
   [Externe Erreichbarkeit](#externe-erreichbarkeit-cloudflare-tunnel)
   unten) — nötig, damit Auto-Backup auch unterwegs (nicht im
   LAN/Tailnet) funktioniert, analog zu Vaultwarden.
3. In der App unter **Backup** die zu sichernden Alben/den gesamten
   Kamera-Roll auswählen.

---

## Externe Bibliothek: Bestehende Fotoordner importieren (z. B. OneDrive-Export)

Für Fotos, die schon als fertige Ordnerstruktur vorliegen (z. B. ein
Massen-Export aus OneDrive) und nicht einzeln über Handy-App/Web-Upload
hochgeladen werden sollen, unterstützt Immich sogenannte
[External Libraries](https://immich.app/docs/features/libraries): Ordner
werden read-only in den `immich-server`-Container gemountet und nur
eingelesen/indexiert — die Dateien bleiben unverändert auf dem NAS liegen,
es entsteht kein Duplikat in der `library`-PVC.

> **Wichtig:** Dateien einfach in die `library`-PVC (`/data`, siehe
> [Übersicht](#übersicht) oben) kopieren funktioniert **nicht** — dieser
> Pfad wird ausschließlich von Immich selbst verwaltet (UUID-Struktur für
> Uploads/Thumbnails), es gibt keinen automatischen Scan dieses Ordners.

### Schritt A — Unterordner auf dem bestehenden Immich-NFS-Export anlegen

Kein neuer NFS-Export nötig — die Firewall-/Host-Regel für
`/volume2/immich-storage` (siehe [Schritt 1](#schritt-1--nfs-export-für-immich-einrichten-ugos-manuell)
oben) erlaubt bereits Lese-/Schreibzugriff für `192.168.178.0/24`. Einfach
einen Unterordner anlegen und die OneDrive-Ordner dort hinein
kopieren/synchronisieren, z. B.:

```
/volume2/immich-storage/external/onedrive/<deine Ordnerstruktur>
```

### Schritt B — Mount in `argocd/apps/workloads/immich/values.yaml` aktivieren

```yaml
server:
  externalLibrary:
    enabled: true
    mountPath: /mnt/external
    nfs:
      server: "192.168.178.97"
      path: "/volume2/immich-storage/external"
      readOnly: true
```

Weitere, unabhängige Ordner lassen sich über `extraMounts` einbinden:

```yaml
    extraMounts:
      - name: onedrive-fotos
        mountPath: /mnt/external/onedrive
        server: "192.168.178.97"
        path: "/volume2/immich-storage/external/onedrive"
        readOnly: true
```

Nach dem ArgoCD-Sync verifizieren:

```bash
kubectl -n immich exec deploy/immich-server -- ls /mnt/external
```

### Schritt C — Library in der Immich-UI anlegen

**Administration → Libraries → Create Library → External Library** →
Import-Pfad exakt auf den gemounteten Container-Pfad setzen (z. B.
`/mnt/external` oder `/mnt/external/onedrive` bei `extraMounts`). Danach
**Scan Library** anstoßen (manuell oder per Intervall in den
Library-Einstellungen) — Immich indexiert dann rekursiv alle Unterordner.

Read-only reicht aus: Immich muss die Originaldateien nur lesen, es
schreibt keine Metadaten in den externen Ordner zurück.

---

## Externe Erreichbarkeit (Cloudflare Tunnel)

`immich.pke-lab.de` ist bereits in
`argocd/apps/platform/cloudflared/values.yaml` eingetragen (zeigt auf
`immich-server.immich.svc.cluster.local:80`). Das ist hier **kein
optionales Extra**, sondern für den Kernanwendungsfall
(automatisches Foto-Backup vom Handy) notwendig — ohne Erreichbarkeit von
unterwegs würde die App nur zuhause im WLAN synchronisieren.

---

## Datenbank-Major-Upgrade (Postgres 14 → 16)

Gleiches Grundprinzip wie bei [Nextcloud](300b0-nextcloud.md#datenbank-major-upgrade-postgres-16--18)
und [Wiki.js](30030-wikijs.md#datenbank-major-upgrade-postgres-16--18) — mit
zwei Immich-spezifischen Besonderheiten:

- **Kein Standard-`postgres`-Image**: `postgresql.image.repository` ist
  `ghcr.io/immich-app/postgres`, ein Custom-Build mit der VectorChord-
  Extension für die Ähnlichkeitssuche (`values.yaml`-Tag aktuell
  `14-vectorchord0.4.3-pgvectors0.2.0`). Laut
  [offizieller Immich-Doku](https://docs.immich.app/administration/postgres-standalone)
  unterstützt Immich Postgres `>= 14, < 20` mit VectorChord `>= 0.3, < 2.0`
  — Postgres 16 ist also im unterstützten Bereich, **aber vor dem Mergen
  prüfen**, dass der von Renovate vorgeschlagene neue Tag denselben
  VectorChord-Versions-Suffix behält (z. B.
  `16-vectorchord0.4.3-pgvectors0.2.0`) und nicht gleichzeitig einen
  VectorChord-Sprung außerhalb des unterstützten Bereichs mitbringt.
- **Zwei Consumer der DB**: sowohl `immich-server` als auch
  `immich-machine-learning` müssen vor dem Umschalten auf 0 Replicas
  skaliert werden, nicht nur der Server.

**Ablauf:**

1. **Dump** (ergänzend zum nächtlichen restic-Backup unter der separaten
   `immich-nas`-StorageClass, siehe
   [docs/2-betrieb-hardware/20010-nas-backup.md](../2-betrieb-hardware/20010-nas-backup.md)):
   ```bash
   kubectl -n immich exec deploy/immich-postgresql -- \
     pg_dump -U immich -Fc immich > immich-pg14-$(date +%F).dump
   ```
2. Beide Consumer stoppen:
   ```bash
   kubectl -n immich scale deploy/immich-server immich-machine-learning --replicas=0
   ```
3. In der Chart-Vorlage:
   - `values.yaml`: `postgresql.image.tag` auf den neuen Postgres-16-Tag
     mit passendem VectorChord-Suffix setzen (siehe Hinweis oben).
   - `templates/postgres-deployment.yaml`: `PGDATA` von
     `/var/lib/postgresql/data/pgdata_fixed` auf
     `/var/lib/postgresql/data/pgdata_fixed_pg16` ändern — gleicher Trick
     wie bei Wiki.js, `runAsUser`/`runAsGroup: 1000/10` unverändert lassen.
   - Committen/pushen, ArgoCD syncen lassen.
4. Dump zurückspielen — `pg_restore` legt die VectorChord-Extension dabei
   automatisch mit an (im Dump als `CREATE EXTENSION`-Statement enthalten,
   die Extension selbst ist im Ziel-Image bereits vorhanden):
   ```bash
   kubectl -n immich cp immich-pg14-*.dump immich-postgresql-<pod>:/tmp/restore.dump
   kubectl -n immich exec deploy/immich-postgresql -- \
     pg_restore -U immich -d immich /tmp/restore.dump
   ```
5. Beide Consumer wieder hochskalieren, App öffnen, Timeline + Gesichts-/
   Ähnlichkeitssuche stichprobenartig prüfen (letzteres hängt direkt an
   VectorChord — ein guter Indikator, dass die Extension sauber
   mitgewandert ist).
6. **Rollback:** Schritt 3 revertieren, alter `pgdata_fixed`-Ordner bleibt
   unangetastet auf derselben PVC.
7. Nach störungsfreier Testphase alten `pgdata_fixed`-Ordner aufräumen.

---

## Troubleshooting

### `immich-postgresql`/`immich-server`-PVC bleibt `Pending`

```bash
kubectl describe pvc -n immich <pvc-name>
kubectl -n immich-storage get pods
kubectl -n immich-storage logs deploy/immich-nfs-subdir-external-provisioner
```

Meist: NFS-Export `/volume2/immich-storage` ist vom Node aus nicht
erreichbar, oder der `immich-storage`-Provisioner-Pod läuft nicht. Details
analog zu [docs/2-betrieb-hardware/20000-nas-storage.md → Fehlerbehebung](../2-betrieb-hardware/20000-nas-storage.md#fehlerbehebung).

### Gesichtserkennung/Suche liefert keine Ergebnisse

```bash
kubectl logs -n immich deploy/immich-machine-learning
```

Prüfen, ob der ML-Container die Modelle erfolgreich heruntergeladen hat
(erster Start braucht Internetzugang) und ob **Administration →
Einstellungen → Machine Learning** in der Immich-UI aktiviert ist.

### SealedSecret wird nicht entschlüsselt

```bash
kubectl describe sealedsecret -n immich immich-secrets
```

---

## Ressourcenverbrauch (Richtwerte Home Lab)

| Komponente             | CPU Request | RAM Request | RAM Limit | Storage                    |
|--------------------------|-------------|--------------|-----------|------------------------------|
| immich-server             | 250m        | 512Mi        | 4Gi       | 500Gi Bibliothek (`immich-nas`) |
| immich-machine-learning   | 500m        | 1Gi          | 4Gi       | 10Gi Modell-Cache (`immich-nas`)|
| PostgreSQL                | 200m        | 512Mi        | 2Gi       | 20Gi (`immich-nas`)          |
| Valkey/Redis               | 25m         | 64Mi         | 256Mi     | —                            |
| **Gesamt (1 Replica je Komponente)** | ~975m | ~2,1Gi | ~10,25Gi | 530Gi auf `immich-nas` |
| **Worst Case (volle Autoskalierung, siehe unten)** | — | — | **~22,25Gi** | — |

`server.persistence.library.size` bei Bedarf erhöhen — wie bei Nextcloud
wirkt sich das nur auf die Kubernetes-Quota aus, nicht auf den
tatsächlich belegten NAS-Speicher.

Das RAM-Limit für `immich-server` wurde am 2026-07-27 bewusst von 2Gi auf
4Gi angehoben (Absturz bei großen Uploads, siehe
[../b-kubernetes-gitops/b0040-hpa-autoscaling.md](../b-kubernetes-gitops/b0040-hpa-autoscaling.md)) —
NICHT wieder absenken, ohne die Ursache dieser Änderung erneut zu prüfen.
Da der Worst-Case-Wert (volle Autoskalierung aller vier Komponenten
gleichzeitig auf demselben Node, siehe `podAffinity` unten) einen
erheblichen Teil des Homeserver-RAM beanspruchen kann, greift stattdessen
der [Kubelet-RAM-Schutz](../2-betrieb-hardware/20020-cluster-power-manager.md#mehrschichtiger-ram-schutz):
Der Kubelet evakuiert/killt einzelne Pods, bevor die Gesamtlast den Node
gefährdet.

---

## Autoskalierung (HPA)

`immich-server` (1–3 Replicas) und `immich-machine-learning` (1–2
Replicas) skalieren per HPA auf CPU 75% / RAM 80% hoch — das hilft bei
**vielen gleichzeitigen** Uploads, nicht bei einem einzelnen Foto/Video,
das für sich allein schon mehr RAM braucht als `resources.limits`
erlaubt (dafür ggf. das Limit selbst erhöhen). Da `library`- und
`model-cache`-PVC `ReadWriteOnce` sind, erzwingt eine `podAffinity` im
jeweiligen Deployment, dass alle Replicas auf demselben Node laufen.
Details und Schwellenwerte für alle Apps: [../b-kubernetes-gitops/b0040-hpa-autoscaling.md](../b-kubernetes-gitops/b0040-hpa-autoscaling.md).

---

## Relevante Links

- [Immich-Dokumentation](https://immich.app/docs)
- [Immich GitHub-Repository](https://github.com/immich-app/immich)
- [NAS-Storage (UGREEN NAS)](../2-betrieb-hardware/20000-nas-storage.md)
- [Cloudflare Tunnel — Deploy](../e-externe-erreichbarkeit/e0010-cloudflare-deploy.md)
- [NAS-Backup auf externe USB-Platte](../2-betrieb-hardware/20010-nas-backup.md)
