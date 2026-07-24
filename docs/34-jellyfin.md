# 34 — Jellyfin

[Jellyfin](https://jellyfin.org) ist ein selbst gehosteter Media-Server
(Filme/Serien/Musik) mit Transcoding, vergleichbar mit Plex/Emby, aber
vollständig Open-Source ohne Konto-Zwang. Die Deployment-Konfiguration
liegt unter `argocd/apps/jellyfin/`.

---

## Übersicht

| Komponente     | Technologie                     | Namespace  |
|-----------------|-----------------------------------|------------|
| Jellyfin        | `jellyfin/jellyfin:10.11.0`      | `jellyfin` |
| Konfiguration   | SQLite (im `config`-PVC)          | `jellyfin` |
| Medienbibliothek| Direkter NFS-Mount vom UGREEN NAS | —          |
| Ingress         | Traefik                           | `jellyfin` |
| Persistenz      | StorageClass `nas` (Config) + eigener NFS-Export (Medien) | — |

**Zwei unterschiedliche Storage-Wege:**
- **Konfiguration/Metadaten/Wiedergabestatus** (`/config`) liegt auf einem
  PVC der `nas`-StorageClass (siehe [docs/16-nas-storage.md](16-nas-storage.md)).
- **Transcoding-Zwischendateien** (`/config/transcodes`) liegen bewusst
  auf einem `emptyDir` (lokaler Node-Storage) statt NFS — Live-Transcoding
  erzeugt hohe, latenzsensitive Schreiblast, für die NFS ungeeignet ist.
- **Die eigentliche Medienbibliothek** (`/media`) wird **nicht** über die
  `nas`-StorageClass/PVC eingebunden, sondern als **direkter NFS-Mount**
  vom NAS — die Dateien sollen als normale Ordnerstruktur auf dem NAS
  liegen (z. B. auch per SMB von Windows/macOS aus durchsuchbar), nicht
  als vom `nfs-subdir-external-provisioner` verwaltetes PVC-Unterverzeichnis.

---

## Voraussetzungen

- ArgoCD läuft und das Root-ApplicationSet ist aktiv (`argocd/bootstrap/root-applicationset.yaml`)
- **`nas-storage`-App ist deployt** (`argocd/apps/nas-storage/`) und die
  StorageClass `nas` existiert: `kubectl get storageclass nas`
- **Eigener NFS-Export für die Medienbibliothek auf dem NAS eingerichtet**
  (siehe Schritt 1 unten) — ohne diesen Export bleibt der Jellyfin-Pod im
  `ContainerCreating`-Status hängen (NFS-Mount schlägt fehl)

---

## Schritt 1 — NFS-Export für die Medienbibliothek einrichten (UGOS, manuell)

Analog zur `k8s-storage`-Freigabe in
[docs/16-nas-storage.md](16-nas-storage.md#nfs-export-in-ugos-einrichten-manuell-kein-ansible-playbook),
aber als **eigene** Freigabe, unabhängig vom Cluster-Storage:

1. **Speicherplatz/Freigabe erstellen**, z. B. `media` (Vorschlag:
   `/volume1/media` — falls die Freigabe an anderer Stelle liegt, Pfad
   unten entsprechend anpassen).
2. Vorhandene Filme/Serien/Musik in eine sinnvolle Ordnerstruktur unter
   dieser Freigabe legen (Jellyfin erkennt z. B. `movies/`, `tvshows/`,
   `music/` als Unterordner automatisch beim Bibliotheks-Setup in
   Schritt 3).
3. **NFS-Dienst aktivieren** (falls noch nicht durch die
   `k8s-storage`-Einrichtung geschehen) und einen NFS-Regel-Eintrag für
   die Freigabe `media` anlegen:
   - Erlaubte Hosts: `192.168.178.0/24` (LAN-Subnetz)
   - Berechtigung: Lese-/Schreibzugriff (Jellyfin kann optional
     Vorschaubilder/`.nfo`-Dateien in die Medienordner schreiben — für
     reinen Lesezugriff stattdessen `media.nfs.readOnly: true` in
     `values.yaml` setzen und hier nur Lesezugriff vergeben)
   - Squash: `no_root_squash`
4. Exportpfad notieren und in `argocd/apps/jellyfin/values.yaml` unter
   `media.nfs.path` eintragen (Platzhalter aktuell: `/volume1/media`).
5. Verbindung testen, bevor die App deployed wird:
   ```bash
   sudo mount -t nfs 192.168.178.97:/volume1/media /mnt
   ls /mnt && sudo umount /mnt
   ```

> Weitere getrennte Bibliotheken (z. B. eine zweite Freigabe nur für
> Musik) lassen sich über `media.extraMounts` in `values.yaml` als
> zusätzliche NFS-Mounts ergänzen, ohne die Haupt-Freigabe zu vermischen.

---

## Schritt 2 — Deployment via ArgoCD

```bash
kubectl get pods -n jellyfin -w
```

**DNS:** `jellyfin.homeserver` ist dank Wildcard-DNS sofort erreichbar.

---

## Schritt 3 — Setup-Wizard

1. `http://jellyfin.homeserver` öffnen
2. Sprache, Admin-Account anlegen
3. **Bibliothek hinzufügen** → Ordner unter `/media` auswählen (z. B.
   `/media/movies`, `/media/tvshows`) — das ist der in Schritt 1
   eingerichtete NFS-Mount
4. Metadaten-Sprache, Remote-Zugriff-Einstellungen nach Wunsch

---

## Externe Erreichbarkeit (Cloudflare Tunnel)

`jellyfin.pke-lab.de` ist bereits in
`argocd/apps/cloudflared/values.yaml` eingetragen. **Abwägung, bevor du
das aktiv nutzt:** anders als Vaultwarden/Nextcloud/Immich ist Streaming
bandbreitenintensiv — bei Zugriff von unterwegs läuft der komplette
Video-Traffic durch den Cloudflare Tunnel und ggf. durch Live-Transcoding
auf dem Homeserver. Für den Hausgebrauch (Familie im selben Tailnet)
reicht meist `http://jellyfin.homeserver` bzw. Tailscale völlig aus. Falls
die externe Freigabe nicht gewünscht ist, den `jellyfin.pke-lab.de`-Eintrag
einfach wieder aus `argocd/apps/cloudflared/values.yaml` entfernen (siehe
[docs/23-cloudflare-deploy.md → Dienst wieder entfernen](23-cloudflare-deploy.md#dienst-wieder-entfernen)).

`JELLYFIN_PublishedServerUrl` in der Deployment-Umgebung ist auf
`https://jellyfin.pke-lab.de` gesetzt, damit externe Clients (Handy-Apps
unterwegs) die richtige öffentliche Adresse für Direct-Play-Links erhalten.

---

## Troubleshooting

### Pod hängt in `ContainerCreating`

Meist ein fehlgeschlagener NFS-Mount für `/media`:

```bash
kubectl describe pod -n jellyfin -l app.kubernetes.io/name=jellyfin
```

NFS-Export-Pfad/Server in `values.yaml` (`media.nfs.*`) gegen den
tatsächlichen UGOS-Export prüfen, Testmount von einem k3s-Node aus
wiederholen (siehe Schritt 1.5).

### Bibliothek zeigt keine Dateien

Ordnerstruktur unter `/media` per `kubectl exec` prüfen:

```bash
kubectl exec -n jellyfin deploy/jellyfin -- ls -la /media
```

Falls leer: NFS-Export zeigt auf den falschen UGOS-Pfad, oder die Dateien
liegen auf dem NAS an anderer Stelle als erwartet.

### Ruckelnde Wiedergabe bei Transcoding

`resources.limits.cpu` in `values.yaml` erhöhen (Standard 4 CPU-Kerne) —
ohne Hardware-Transcoding (kein GPU-Passthrough konfiguriert) läuft jede
Transcoding-Session rein auf der Homeserver-CPU.

---

## Ressourcenverbrauch (Richtwerte Home Lab)

| Komponente | CPU Request | RAM Request | RAM Limit | Storage |
|---|---|---|---|---|
| Jellyfin   | 250m | 512Mi | 4Gi | 10Gi `config` (`nas`) + NFS-Medienbibliothek (Größe abhängig vom Bestand) |

---

## Relevante Links

- [Jellyfin-Dokumentation](https://jellyfin.org/docs/)
- [Jellyfin Docker-Image](https://github.com/jellyfin/jellyfin)
- [NAS-Storage (UGREEN NAS)](16-nas-storage.md)
- [Cloudflare Tunnel — Deploy](23-cloudflare-deploy.md)
