# 35 — Immich

[Immich](https://immich.app) ist ein selbst gehostetes Foto-/Video-Backup
(Google-Photos-Ersatz) mit automatischem Handy-Upload, Gesichtserkennung
und Timeline-Ansicht. Die Deployment-Konfiguration liegt unter
`argocd/apps/immich/`, der zugehörige NAS-Storage unter
`argocd/apps/immich-storage/`.

---

## Übersicht

| Komponente             | Technologie                                          | Namespace |
|-------------------------|--------------------------------------------------------|-----------|
| immich-server            | `ghcr.io/immich-app/immich-server:v3.0.3`              | `immich`  |
| immich-machine-learning  | `ghcr.io/immich-app/immich-machine-learning:v3.0.3` (Gesichtserkennung, CLIP-Suche, reine CPU) | `immich`  |
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

`argocd/apps/immich-storage/` deployt dafür einen zweiten
`nfs-subdir-external-provisioner` (eigener `PROVISIONER_NAME`, eigene
RBAC-Ressourcen, eigener Namespace `immich-storage`) — technisch identisch
zum bestehenden `nas-storage`-Setup aus
[docs/16-nas-storage.md](16-nas-storage.md), nur auf einen anderen Export
gerichtet.

---

## Voraussetzungen

- ArgoCD läuft und das Root-ApplicationSet ist aktiv
- Sealed-Secrets Controller ist installiert (`argocd/apps/sealed-secrets/`)
- **NFS-Export `/volume2/immich-storage` in UGOS eingerichtet** (Schritt 1
  unten) — die IP/Firewall-Konfiguration ist identisch zum bestehenden
  `k8s-storage`-Export, nur mit neuer Freigabe auf `volume2`
- `kubeseal` CLI ist lokal installiert
- `kubectl` ist mit dem Cluster verbunden

---

## Schritt 1 — NFS-Export für Immich einrichten (UGOS, manuell)

Analog zu
[docs/16-nas-storage.md → NFS-Export in UGOS einrichten](16-nas-storage.md#nfs-export-in-ugos-einrichten-manuell-kein-ansible-playbook),
diesmal auf `volume2`:

1. Auf `volume2` eine neue Freigabe `immich-storage` anlegen.
2. NFS-Regel-Eintrag für diese Freigabe:
   - Erlaubte Hosts: `192.168.178.0/24`
   - Berechtigung: Lese-/Schreibzugriff
   - Squash: `no_root_squash`
3. Exportpfad prüfen — falls abweichend von `/volume2/immich-storage`,
   sowohl `argocd/apps/immich-storage/deployment.yaml`
   (`NFS_SERVER`/`NFS_PATH` sowie den `nfs`-Volume-Block) **als auch**
   `argocd/apps/immich-storage/storageclass.yaml`-Kommentar entsprechend
   anpassen.
4. Verbindung testen:
   ```bash
   sudo mount -t nfs 192.168.178.97:/volume2/immich-storage /mnt
   touch /mnt/test && ls /mnt && sudo umount /mnt
   ```

Danach `argocd/apps/immich-storage/` deployen lassen (Root-ApplicationSet
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

Ausgabe in `argocd/apps/immich/values.yaml` eintragen:

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

1. `http://immich.homeserver` öffnen → erster Aufruf legt den
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

## Externe Erreichbarkeit (Cloudflare Tunnel)

`immich.pke-lab.de` ist bereits in
`argocd/apps/cloudflared/values.yaml` eingetragen (zeigt auf
`immich-server.immich.svc.cluster.local:80`). Das ist hier **kein
optionales Extra wie bei Jellyfin**, sondern für den Kernanwendungsfall
(automatisches Foto-Backup vom Handy) notwendig — ohne Erreichbarkeit von
unterwegs würde die App nur zuhause im WLAN synchronisieren.

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
analog zu [docs/16-nas-storage.md → Fehlerbehebung](16-nas-storage.md#fehlerbehebung).

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
| immich-server             | 250m        | 512Mi        | 2Gi       | 500Gi Bibliothek (`immich-nas`) |
| immich-machine-learning   | 500m        | 1Gi          | 4Gi       | 10Gi Modell-Cache (`immich-nas`)|
| PostgreSQL                | 200m        | 512Mi        | 2Gi       | 20Gi (`immich-nas`)          |
| Valkey/Redis               | 25m         | 64Mi         | 256Mi     | —                            |
| **Gesamt**                | ~975m       | ~2,1Gi       | ~8,25Gi   | 530Gi auf `immich-nas`       |

`server.persistence.library.size` bei Bedarf erhöhen — wie bei Nextcloud
wirkt sich das nur auf die Kubernetes-Quota aus, nicht auf den
tatsächlich belegten NAS-Speicher.

---

## Relevante Links

- [Immich-Dokumentation](https://immich.app/docs)
- [Immich GitHub-Repository](https://github.com/immich-app/immich)
- [NAS-Storage (UGREEN NAS)](16-nas-storage.md)
- [Cloudflare Tunnel — Deploy](23-cloudflare-deploy.md)
- [NAS-Backup auf externe USB-Platte](36-nas-backup.md)
