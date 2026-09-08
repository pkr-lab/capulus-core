# xibosignage — Xibo CMS + Bilder-Slideshow auf Raspberry Pi 3 B+

Digital-Signage-Setup: **Xibo CMS** läuft als zentrale Medien-/Asset-
Verwaltung im k3s-Cluster, Inhalte werden über eine **Xibo-CMS-Playlist** im
Web-UI gepflegt, ein **n8n-Workflow** synchronisiert die Playlist-Bilder
periodisch über die Xibo-REST-API in einen festen NAS-Ordner, und ein
**Raspberry Pi 3 B+** zeigt sie als Slideshow.

> **Alternative Quelle (deaktiviert):** Ursprünglich befüllte eine vom Nutzer
> selbst eingerichtete **OnlineSync** (Handy-/Cloud-Ordner-Sync) den
> NAS-Ordner. Dieser Pfad existiert weiterhin als deaktivierter n8n-Workflow
> (`xibosignage-inbox-to-display.json`) für den Fall, dass spontane Fotos
> ohne CMS-Umweg gezeigt werden sollen — siehe
> [Alternative: OnlineSync → Inbox → Display](#alternative-deaktiviert-onlinesync--inbox--display).
> Playlist-Sync und OnlineSync-Workflow **nicht gleichzeitig aktiv lassen**,
> beide schreiben in denselben Ordner.

> **Wichtig — kein offizieller Xibo-Player auf dem Pi:** Xibo Signage sagt
> selbst, dass kein Raspberry-Pi-Modell für ihre Player geeignet ist. Der
> einzige Community-Player (Arexibo, Rust + Qt6/WebEngine) läuft erst seit
> Anfang 2026 einigermaßen auf einem **Pi 5** (getestet mit 8 GB RAM) — auf
> einem Pi 3 B+ (1 GB RAM, deutlich schwächere CPU) wäre er unbrauchbar
> langsam oder würde gar nicht laufen. Dieses Setup verzichtet deshalb
> bewusst auf das echte Xibo-Player-Protokoll: der Pi liest stattdessen
> direkt einen NFS-Ordner und zeigt dessen Bilder per Chromium-Kiosk als
> Slideshow — robust, leichtgewichtig, und exakt das, was tatsächlich
> gebraucht wird ("Bild in Ordner legen → wird angezeigt").

## Inhaltsverzeichnis

1. [Architektur](#architektur)
2. [Xibo CMS deployen (argocd/apps/workloads/xibosignage)](#xibo-cms-deployen-argocdappsxibosignage)
3. [NAS-Ordner einrichten (Display)](#nas-ordner-einrichten-display)
4. [n8n-Workflow: Xibo-CMS-Playlist → Display (primär)](#n8n-workflow-xibo-cms-playlist--display-primär)
5. [Alternative (deaktiviert): OnlineSync → Inbox → Display](#alternative-deaktiviert-onlinesync--inbox--display)
6. [Raspberry-Pi-Rollout (Ansible)](#raspberry-pi-rollout-ansible)
7. [Monitoring (Grafana)](#monitoring-grafana)
8. [Fehlerbehebung](#fehlerbehebung)

---

## Architektur

```
┌─────────────────────────────────────────────┐
│  Xibo CMS (k3s, Namespace xibosignage)       │
│  cms-web ── MySQL ── XMR ── Memcached        │
│             └── QuickChart                   │
│  https://xibo.homeserver                     │
│  PVC "library"/"state" (StorageClass nas)    │
│                                               │
│  Design → Playlists → "infotafel"            │
│  (Bild-Widgets, Reihenfolge per Drag&Drop)    │
└─────────────────────────────────────────────┘
                    │ REST API (OAuth2 Client Credentials)
                    │ GET /api/playlist?name=infotafel&embed=widgets
                    │ GET /api/library/download/{mediaId}
                    ▼
         n8n (Namespace n8n), Cron-Zeitplan
         xibosignage-playlist-sync.json:
         Resize (Edit Image) auf 1920×1080,
         Dateiname mit Reihenfolge-Präfix
         (xibo-playlist-<order>-<mediaId>),
         entfernte Playlist-Bilder aufräumen
                    │
                    ▼
   /volume1/k8s-storage/xibosignage-display/  (UGREEN NAS, 192.168.178.97)
                    │
                    │ NFS-Mount, read-only
                    ▼
         Raspberry Pi 3 B+ ("infotafel")
         ansible/roles/xibo_kiosk:
         manifest.json-Scan (alle 30s, alphabetisch sortiert)
         + Chromium-Kiosk-Slideshow
         + Tailscale (Fernzugriff)
```

Zwei bewusst getrennte Storage-Pfade:

| Ordner | Wer schreibt | Wer liest | Zweck |
|---|---|---|---|
| Xibo-CMS-`library`-PVC | nur Xibo CMS selbst | nur Xibo CMS selbst | Interne Medien-Verwaltung (Layouts, Playlists) — Xibo speichert Dateien intern gehasht, kein direkter Dateizugriff von außen vorgesehen |
| `xibosignage-display` (NAS, fester Pfad) | n8n (Playlist-Sync, s.u.) | Raspberry Pi (NFS, read-only) | Was tatsächlich auf dem Pi angezeigt wird |

Der Pi selbst spricht weiterhin **kein echtes Xibo-Player-Protokoll** (siehe
Hinweis oben) — Xibo CMS ist nur noch die Verwaltungsoberfläche für die
Playlist-Inhalte, der eigentliche Transport zum Pi läuft komplett über den
`xibosignage-display`-Ordner + die bestehende Chromium-Kiosk-Slideshow.

---

## Xibo CMS deployen (argocd/apps/workloads/xibosignage)

Liegt unter `argocd/apps/workloads/xibosignage/`, wird wie jede andere App in
`argocd/apps/*` automatisch von ArgoCD erkannt und ausgerollt (siehe
[docs/b-kubernetes-gitops/b0010-argocd.md](../b-kubernetes-gitops/b0010-argocd.md)) — keine manuelle Registrierung nötig.

Komponenten (1:1 aus dem offiziellen
[xibosignage/xibo-docker](https://github.com/xibosignage/xibo-docker)
`docker-compose.yml` übernommen, kein Bitnami-Subchart):

| Deployment | Image | Zweck |
|---|---|---|
| `cms` | `ghcr.io/xibosignage/xibo-cms:release-4.5.0` | Web-UI + REST-API |
| `mysql` | `mysql:8.4` | Datenbank |
| `xmr` | `ghcr.io/xibosignage/xibo-xmr:1.3` | Message-Relay (Player-Kommunikation, für dieses Setup ungenutzt, aber vom CMS erwartet) |
| `memcached` | `memcached:alpine` | Objekt-/Session-Cache |
| `quickchart` | `ianw/quickchart` | Chart-Widget-Rendering |

### Secrets versiegeln

Vor dem ersten Deploy das DB-Passwort mit kubeseal versiegeln:

```bash
echo -n 'EIN-STARKES-PASSWORT' | kubeseal --raw --namespace xibosignage \
  --name xibosignage-secrets --controller-namespace sealed-secrets \
  --controller-name sealed-secrets-controller
```

Den Output in `argocd/apps/workloads/xibosignage/values.yaml` unter
`secrets.encryptedDbPassword` eintragen (ersetzt den Platzhalter
`REPLACE_ME_WITH_KUBESEAL_OUTPUT`), committen, pushen.

### Erster Start

Nach dem Sync ist Xibo unter **https://xibo.prod.homeserver** (intern) und
**https://xibo-prod.pke-lab.de** (extern, über den Cloudflare Tunnel —
Wildcard-DNS/-Ingress-Route, kein zusätzlicher DNS-Schritt nötig, siehe
[docs/e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md))
erreichbar. Bewusst **ohne** zusätzliche Authentik-ForwardAuth-Middleware
(anders als mealie/uptime-kuma) — nur das CMS-eigene Login schützt den
externen Host. Das CMS-Image führt beim allerersten Start automatisch
DB-Migrationen + Installation durch — das kann einige Minuten dauern
(`kubectl -n xibosignage logs deploy/xibosignage-cms -f`).

**Default-Login:** `xibo_admin` / `password` — **sofort nach dem ersten
Login ändern** (Einstellungen → Mein Konto), besonders wichtig durch die
externe Erreichbarkeit.

### Konfiguration (values.yaml)

| Key | Bedeutung | Default |
|---|---|---|
| `cms.env.CMS_SERVER_NAME` | Hostname, den das CMS für sich selbst annimmt (self-generierte Links — bleibt auf dem internen Hostname, unabhängig vom zusätzlichen externen Ingress-Host) | `xibo.prod.homeserver` |
| `cms.env.CMS_PHP_UPLOAD_MAX_FILESIZE` | Max. Upload-Größe pro Datei | `512M` |
| `cms.persistence.library.size` | Medien-Bibliothek | `50Gi` |
| `mysql.persistence.size` | Datenbank | `10Gi` |
| `quickchart.enabled` | Chart-Widget-Rendering aktivieren | `true` |

---

## NAS-Ordner einrichten (Display)

`xibosignage-inbox` und `xibosignage-display` sind **feste** Pfade unter dem
bestehenden `k8s-storage`-Export (`nas`-StorageClass, siehe
[docs/2-betrieb-hardware/20000-nas-storage.md](../2-betrieb-hardware/20000-nas-storage.md)) — **nicht** dynamisch vom
`nfs-subdir-external-provisioner` vergeben, weil sowohl n8n (Kubernetes-Pod)
als auch der Raspberry Pi (rohes NFS, kein Kubernetes) denselben,
vorhersagbaren Pfad ansprechen müssen. `xibosignage-inbox` wird nur vom
deaktivierten Alternativ-Pfad gebraucht (siehe
[Alternative: OnlineSync → Inbox → Display](#alternative-deaktiviert-onlinesync--inbox--display))
— beide Ordner trotzdem gemeinsam anlegen, da beide PV/PVC-Paare unabhängig
davon bestehen bleiben. Details zur Technik (statische PV mit `nfs:`-Block
statt PVC über eine StorageClass):
[docs/2-betrieb-hardware/20000-nas-storage.md](../2-betrieb-hardware/20000-nas-storage.md#fixer-pfad-statt-dynamischer-subdir-name).

### Einmalig: Ordner auf dem NAS anlegen

Der `nas`-Export-Root existiert bereits (`/volume1/k8s-storage`), die beiden
Unterordner aber nicht — einmalig von einem k3s-Node aus anlegen:

```bash
ssh ubuntu@192.168.178.94   # oder worker-0/worker-1
sudo mkdir -p /mnt/xibosignage-tmp
sudo mount -t nfs 192.168.178.97:/volume1/k8s-storage /mnt/xibosignage-tmp
sudo mkdir -p /mnt/xibosignage-tmp/xibosignage-inbox/processed
sudo mkdir -p /mnt/xibosignage-tmp/xibosignage-display
sudo umount /mnt/xibosignage-tmp
```

Danach `argocd/apps/workloads/n8n` syncen lassen (siehe unten) — die beiden
`PersistentVolume`/`PersistentVolumeClaim`-Paare
(`templates/xibosignage-pv.yaml`, `templates/xibosignage-pvc.yaml`) binden
an genau diese Pfade.

---

## n8n-Workflow: Xibo-CMS-Playlist → Display (primär)

`argocd/apps/workloads/n8n/values.yaml` mountet den Display-Ordner in den
n8n-Pod (`xibosignage.display.mountPath`, Default `/data/xibosignage-display`)
— keine weitere Konfiguration nötig.

### 1. OAuth2-Application in Xibo CMS anlegen

**Administration → Applications → Add Application** (Grant Type "Client
Credentials"), Client-ID/Secret notieren. Der der Application zugeordnete
User braucht **View-Recht** auf die Playlist "infotafel" (s. u.) und deren
Library-Medien — Xibo prüft Objekt-Permissions pro Playlist/Medium, ein
frisch angelegter Application-User sieht standardmäßig nur eigene Objekte.
Einfachste Variante: Playlist + Bilder mit demselben User anlegen, den die
Application referenziert.

### 2. n8n-Credential anlegen

n8n (https://n8n.homeserver) → **Credentials** → neue Credential vom Typ
**OAuth2 API**, Name **`Xibo CMS (OAuth2 Client Credentials)`** (exakt so,
der importierte Workflow referenziert die Credential über diesen Namen):

- Grant Type: `Client Credentials`
- Access Token URL: `http://xibosignage-cms.xibosignage.svc.cluster.local/api/authorize/access_token`
- Client ID / Client Secret: aus Schritt 1

### 3. Playlist in Xibo CMS anlegen

**Design → Playlists → Add Playlist**, Name **`infotafel`** (= exakter
Ansible-Inventory-Hostname des Displays, siehe
[Raspberry-Pi-Rollout](#raspberry-pi-rollout-ansible) — der Workflow sucht
per API-Filter nach genau diesem Namen). Bild-Widgets hinzufügen, Reihenfolge
per Drag&Drop festlegen — die Reihenfolge wird beim Sync als Dateinamen-
Präfix übernommen und bestimmt damit auch die Anzeige-Reihenfolge auf dem Pi.

### 4. Workflow importieren

Eine fertige Workflow-Definition liegt unter
`argocd/apps/workloads/n8n/workflows/xibosignage-playlist-sync.json`:

1. n8n → **Workflows** → **Import from File** →
   `argocd/apps/workloads/n8n/workflows/xibosignage-playlist-sync.json`.
2. Beim Import nach der Credential aus Schritt 2 gefragt werden (an jedem
   HTTP-Request-Knoten) — zuweisen.
3. Workflow öffnen, Knoten-Parameter prüfen (Node-Schemas können sich
   zwischen n8n-Versionen leicht unterscheiden, insbesondere die genaue
   Feldstruktur der Playlist-/Library-API-Antworten — Response von
   "Playlist von Xibo CMS holen" einmal testweise ausführen und mit dem
   Code-Node "Bild-Widgets extrahieren & sortieren" abgleichen; ebenso beim
   **Edit Image**-Knoten die Resize-Optionen bestätigen) und **Activate**.

Ablauf (Cron-Zeitplan, Default: jeden Donnerstag 16 Uhr — Cron-Ausdruck
`0 0 16 * * 4` im Schedule-Trigger, bei Bedarf im n8n-UI anpassen):

```
Jeden Donnerstag 16 Uhr (Schedule Trigger)
  → Playlist von Xibo CMS holen (HTTP Request, GET /api/playlist?name=infotafel&embed=widgets)
  → Bild-Widgets extrahieren & sortieren (Code-Node: nur type=image, nach
    displayOrder sortiert, ein Item pro Bild)
  → Medien-Metadaten holen (HTTP Request, GET /api/library/{mediaId} — Dateiname/Extension)
  → Mediendatei herunterladen (HTTP Request, GET /api/library/download/{mediaId})
  → Auf Pi-Auflösung skalieren (Edit Image, resize auf max. 1920×1080)
  → Zieldateiname bestimmen (Code-Node: xibo-playlist-<order>-<mediaId>.<ext>)
  → In Display-Ordner schreiben (Read/Write Files from Disk, write, nach
    /data/xibosignage-display)
  → Erwartete Dateien sammeln (Code-Node: alle Dateinamen dieses Laufs
    einsammeln — require('fs') ist im Code-Node gesperrt, deshalb kein
    direktes Loeschen hier)
  → Alte Playlist-Bilder aufräumen (Execute Command, bereits per
    NODES_EXCLUDE freigeschaltet: löscht xibo-playlist-*-Dateien, die in
    diesem Lauf nicht mehr aus der Playlist kamen — Bild aus Playlist
    entfernt → verschwindet aus der Slideshow)
```

Der Pi selbst bekommt von n8n nichts mitgeteilt — er liest
`xibosignage-display` einfach alle 30s neu ein (siehe
[Raspberry-Pi-Rollout](#raspberry-pi-rollout-ansible)), alphabetisch nach
Dateiname sortiert; der Reihenfolge-Präfix sorgt dafür, dass das der
Playlist-Reihenfolge entspricht.

**Bekannte Einschränkungen:** nur `type: image`-Widgets werden
synchronisiert (keine Videos, siehe Hinweis oben). Individuelle
Anzeigedauer pro Widget aus Xibo wird nicht übernommen — alle Bilder
werden weiterhin gleich lang gezeigt (`xibo_kiosk_slide_duration_ms`).
Aktuell genau eine Playlist ↔ ein Display (`infotafel`); ein zweites
Display bräuchte einen eigenen Zielordner (Per-Host-NFS-Pfad-Override im
Inventory) und eine zweite Workflow-Instanz mit anderem Playlist-Namen.

---

## Alternative (deaktiviert): OnlineSync → Inbox → Display

Ursprüngliches Setup, bevor Xibo-CMS-Playlists als primäre Quelle genutzt
wurden — bleibt als deaktivierter n8n-Workflow im Repo, falls spontane
Fotos ohne CMS-Umweg gezeigt werden sollen. **Nicht gleichzeitig mit dem
Playlist-Sync-Workflow aktiv lassen** (beide schreiben in denselben Ordner,
der Playlist-Sync würde die Inbox-Ergebnisse als "nicht mehr in der
Playlist" wieder löschen, sofern sie zufällig mit dem `xibo-playlist-`-
Präfix kollidieren — tun sie zwar per Namensschema nicht, trotzdem
unübersichtlich).

### Eigene OnlineSync einrichten

Die eigentliche Synchronisation (Handy-Fotos, Cloud-Ordner, PC-Ordner → NAS)
richtet der Nutzer selbst ein (UGOS-eigene Cloud-Sync-App, Handy-App mit
Ordner-Sync, rclone, o. Ä.) — dieses Repo kümmert sich nur darum, dass ein
stabiles Ziel dafür existiert:

- **Ziel-Pfad:** `k8s-storage/xibosignage-inbox` (Freigabe/Share auf dem NAS
  je nach genutztem Protokoll einrichten — SMB-Freigabe auf denselben
  UGOS-Speicherplatz zeigen lassen wie der NFS-Export, oder NFS direkt,
  falls das Sync-Tool das unterstützt).
- **NICHT** direkt in `xibosignage-display` syncen — dieser Ordner wird
  ausschließlich von einem der beiden n8n-Workflows beschrieben
  (verarbeitete, Pi-taugliche Bilder). Rohdateien gehören in
  `xibosignage-inbox`.

### Workflow importieren

Eine fertige Workflow-Definition liegt unter
`argocd/apps/workloads/n8n/workflows/xibosignage-inbox-to-display.json`
(bleibt nach Import **deaktiviert**, solange der Playlist-Sync-Workflow
läuft):

1. n8n öffnen (https://n8n.homeserver) → **Workflows** → **Import from File**.
2. `argocd/apps/workloads/n8n/workflows/xibosignage-inbox-to-display.json` auswählen.
3. Workflow öffnen, Knoten-Parameter prüfen (Node-Schemas können sich
   zwischen n8n-Versionen leicht unterscheiden — insbesondere beim
   **Edit Image**-Knoten die Resize-Optionen einmal in der UI bestätigen).
   **Nicht aktivieren**, solange der Playlist-Sync-Workflow der primäre Pfad ist.

Ablauf:

```
Watch Inbox (Local File Trigger, beobachtet /data/xibosignage-inbox)
  → Nur Bilddateien (Filter: .jpg/.jpeg/.png/.gif/.webp)
  → Originaldatei lesen (Read/Write Files from Disk, read)
  → Auf Pi-Auflösung skalieren (Edit Image, resize auf max. 1920×1080 —
    verhindert, dass der schwache Pi 3B+ große Fotos im Browser selbst
    herunterskalieren muss)
  → Zieldateiname bestimmen (Code-Node, eindeutiger Dateiname mit Timestamp)
  → In Display-Ordner schreiben (Read/Write Files from Disk, write, nach
    /data/xibosignage-display)
  → Original archivieren (Execute Command: mv nach inbox/processed/,
    verhindert erneutes Verarbeiten desselben Bilds)
```

---

## Raspberry-Pi-Rollout (Ansible)

**Voraussetzung:** Raspberry Pi OS (Desktop) bereits geflasht, Autologin für
den Kiosk-User im Raspberry Pi Imager aktiviert ("Enable autologin") — das
richtet diese Rolle nicht zusätzlich ein.

### 1. Host eintragen

`ansible/inventory/hosts.yml`, Gruppe `xibo_displays`:

```yaml
xibo_displays:
  hosts:
    wohnzimmer:
      ansible_host: 192.168.178.120
      ansible_user: pi
```

Denselben Host auch unter `semaphore_targets` eintragen.

### 2. Eigenen Tailscale-Auth-Key hinterlegen

`ansible/group_vars/xibo_displays.yml` enthält bereits die richtigen
Defaults (eigener Hostname pro Pi, kein Subnetz-Advertising). Fehlt noch:
ein eigener Tailscale-Auth-Key für diese Geräte-Gruppe — **nicht** den
Home-Server-Key aus `group_vars/all.yml` wiederverwenden (der ist i. d. R.
Single-Use und bereits verbraucht). Empfehlung bei mehreren Displays: ein
**wiederverwendbarer** Key mit eigenem Tag (`tag:xibo-display`), siehe
[docs/c-netzwerk-dns/c0010-tailscale.md](../c-netzwerk-dns/c0010-tailscale.md#auth-key-besorgen):

```bash
ansible-vault encrypt_string 'tskey-auth-...' --name 'tailscale_auth_key'
```

Den `!vault |`-Block in `ansible/group_vars/xibo_displays.yml` einsetzen
(ersetzt den auskommentierten Platzhalter).

### 3. Rollout ausführen

```bash
make semaphore-targets   # pusht den Semaphore-SSH-Key auf den Pi
make xibo-kiosks          # oder: Semaphore-UI → "Deploy xibosignage Displays" → Run
```

Dry-Run vorher: `make xibo-kiosks-check`.

Das Playbook `ansible/xibo-kiosks.yml` führt pro Pi aus:

| Rolle | Zweck |
|---|---|
| `tailscale` | VPN-Beitritt, reiner Client (kein Subnetz-Advertising) — Fernzugriff/-wartung ohne Portfreigabe |
| `node_exporter` | Metriken-Quelle (Port 9100, nur lokal) für Grafana, siehe [Monitoring](#monitoring-grafana) |
| `xibo_kiosk` | NFS-Mount von `xibosignage-display` (read-only), Manifest-Generator-Timer, lokaler Python-Webserver, Chromium-Kiosk-Slideshow |
| `thermal_watchdog` / `resource_watchdog` | Selbstschutz für unbeaufsichtigte Geräte (gleiches Bundling wie bei den ALAMOS-Kiosks, siehe [docs/3-apps-workloads/30010-alamos-apager.md](30010-alamos-apager.md)) |

### Wie die Slideshow funktioniert

- `xibosignage-manifest.timer` läuft alle `xibo_kiosk_manifest_interval_seconds`
  (Default 30s) und schreibt eine `manifest.json` mit allen Bilddateien im
  NFS-Mount.
- Ein winziger `python3 -m http.server` (nur auf `127.0.0.1` gebunden)
  liefert die Slideshow-Seite (`index.html`/`slideshow.js`) + Bilder aus.
- `slideshow.js` liest die `manifest.json` periodisch neu ein und zeigt die
  Bilder als Crossfade-Slideshow (`xibo_kiosk_slide_duration_ms`, Default
  10s pro Bild).
- Chromium läuft im Kiosk-Modus (`--kiosk --incognito`) gegen
  `http://127.0.0.1:8080/`.

Das Semaphore-Projekt **"xibo-displays"** ist nach `make semaphore-bootstrap`
automatisch in der UI verfügbar (siehe [docs/b-kubernetes-gitops/b0030-semaphore.md](../b-kubernetes-gitops/b0030-semaphore.md))
— **bewusst ohne** automatischen Schedule, analog zu `alarm-kiosks`.

---

## Monitoring (Grafana)

Anders als die Tailscale-only Banana-Pi-Alarmmonitore (vmagent-Push, siehe
[docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md, "Grafana (Push statt Pull)"](30020-vereinsheim-alarmmonitor.md#grafana-push-statt-pull))
hängen die xibosignage-Displays am normalen Heim-LAN — der Cluster kann
`node_exporter` also direkt per **VMStaticScrape** scrapen, gleiches Muster
wie bei `ugreen-nas`
([docs/2-betrieb-hardware/20000-nas-storage.md](../2-betrieb-hardware/20000-nas-storage.md)):

```
node_exporter (Port 9100, ansible/roles/node_exporter)
  → VMStaticScrape "infotafel-node-exporter"
    (argocd/apps/platform/monitoring/templates/vmstaticscrape-infotafel.yaml,
     Ziel 192.168.178.98:9100, label instance=infotafel)
  → VictoriaMetrics im Cluster
```

Kein Dashboard-Change für "Home Server Auslastung" nötig (`uid:
homeserver-auslastung`) — das Dashboard filtert dynamisch über die
Grafana-Variable `$instance`, `infotafel` taucht dort automatisch mit auf,
sobald die Metriken ankommen (identisches Prinzip wie bei den Banana-Pi-
Alarmmonitoren).

Da `infotafel` physisch am selben Standort (Vereinsheim, ALAMOS-Standortcode
`1002011`) wie `vereinsheim-alarmmonitor` steht, hat es zusätzlich eigene
Detail-Panels (Erreichbarkeit, Uptime, CPU, RAM, Temperatur, Disk) im
gemeinsamen Standort-Dashboard **"1002011-pis"**
(`argocd/apps/platform/monitoring/templates/dashboard-1002011-pis.yaml`,
ehemals "Vereinsheim-Alarmmonitor" — umbenannt, als `infotafel` als zweites
Geraet dazukam, siehe
[docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md](30020-vereinsheim-alarmmonitor.md)).

---

## Datenbank-Major-Upgrade (MySQL 8.4 → 26.x)

MySQL ist seit den 9.x-„Innovation"-Releases auf ein Jahres-basiertes
Versionsschema umgestiegen — die von Renovate vorgeschlagene Version
`26.x` ist also eine echte, aktuelle MySQL-Version und kein Datenfehler
(auch wenn der Sprung von `8.4` auf `26.x` auf den ersten Blick komisch
aussieht). `8.4` ist die aktuelle LTS-Reihe; ein Wechsel auf `26.x` ist
kein Zwang, nur bei Bedarf.

Gleiches Grundprinzip wie bei den Postgres-Apps oben: ein reiner Tag-Bump
lässt den MySQL-Pod nicht gegen ein inkompatibles altes Datenverzeichnis
starten. Anders als beim offiziellen `postgres`-Image gibt es beim
offiziellen `mysql`-Image aber keinen einfachen `PGDATA`-artigen Env-Var-
Trick — stattdessen denselben Effekt über `subPath` im Volume-Mount
erreichen (neuer, leerer Unterordner derselben PVC):

1. **Dump** (ergänzend zum nächtlichen restic-Backup, siehe
   [docs/2-betrieb-hardware/20010-nas-backup.md](../2-betrieb-hardware/20010-nas-backup.md)):
   ```bash
   kubectl -n xibosignage exec deploy/xibosignage-mysql -- \
     mysqldump -u cms -p"$(kubectl -n xibosignage get secret xibosignage-secrets -o jsonpath='{.data.db-password}' | base64 -d)" \
     --databases cms > xibo-mysql84-$(date +%F).sql
   ```
2. Xibo CMS auf 0 Replicas skalieren (`kubectl -n xibosignage scale deploy/xibosignage-cms --replicas=0`).
3. In der Chart-Vorlage:
   - `values.yaml`: `mysql.image.tag: "8.4"` → gewünschte `26.x`-Version
     (vorher Docker-Hub-Tag-Liste für `mysql` gegenchecken, welche
     `26.x`-Version aktuell empfohlen ist).
   - `templates/mysql-deployment.yaml`: beim `volumeMounts`-Eintrag für
     `data` (`mountPath: /var/lib/mysql`) ein `subPath: mysql-data-v26`
     ergänzen — MySQL initialisiert dann in einem frischen Unterordner
     derselben PVC, statt gegen das alte 8.4-Datenverzeichnis an der
     PVC-Wurzel zu starten.
   - Committen/pushen, ArgoCD syncen lassen.
4. Dump zurückspielen:
   ```bash
   kubectl -n xibosignage cp xibo-mysql84-*.sql xibosignage-mysql-<pod>:/tmp/restore.sql
   kubectl -n xibosignage exec deploy/xibosignage-mysql -- \
     sh -c 'mysql -u cms -p"$MYSQL_PASSWORD" cms < /tmp/restore.sql'
   ```
5. Xibo CMS wieder hochskalieren, Login + Displays/Playlists
   stichprobenartig prüfen.
6. **Rollback:** Schritt 3 revertieren (Tag zurück auf `8.4`, `subPath`
   entfernen) — die alten Daten liegen unangetastet an der PVC-Wurzel.
7. Nach störungsfreier Testphase alten Datenbestand an der PVC-Wurzel
   aufräumen (per einmaligem Job, analog zu den `fix-permissions`-
   Mustern bei den Postgres-Apps).

---

## Fehlerbehebung

| Symptom | Check |
|---|---|
| Xibo-CMS-Pod bleibt `CrashLoopBackOff` beim allerersten Start | `kubectl -n xibosignage logs deploy/xibosignage-cms` — meist DB noch nicht bereit, Pod startet automatisch neu; bei anhaltenden Fehlern MySQL-Pod-Status prüfen (`kubectl -n xibosignage get pods`) |
| MySQL-Pod: `Permission denied` auf `/var/lib/mysql` | NFS-Squash-Identität auf dem UGREEN NAS hat sich geändert (siehe [docs/2-betrieb-hardware/20000-nas-storage.md](../2-betrieb-hardware/20000-nas-storage.md) und die identische Problemlösung bei wikijs/immich) — `mysql.securityContext.runAsUser`/`runAsGroup` in `argocd/apps/workloads/xibosignage/values.yaml` an die aktuelle Squash-Identität anpassen. **Nicht** auf `cms.securityContext` übertragen — das offizielle xibo-cms-Image braucht beim ersten Start Root (schreibt `/root/.my.cnf`, konfiguriert Apache/PHP/cron unter `/etc`), analog zu wikijs/immich bleibt `cms.securityContext` deshalb bewusst leer |
| CMS-Pod: `CrashLoopBackOff`, Logs voller `Permission denied` (`/root/.my.cnf`, `/etc/apache2`, `/etc/php`, `settings.php`) und `ERROR 1045 ... UNKNOWN_USER` | `cms.securityContext` in `argocd/apps/workloads/xibosignage/values.yaml` wurde (versehentlich) auf `runAsUser: 1000` o.ä. gesetzt — muss leer (`{}`) sein, da das CMS-Image root für sein Setup braucht |
| `xibo.homeserver` löst nicht auf | Wildcard-DNS prüfen: `nslookup xibo.homeserver` (siehe [docs/c-netzwerk-dns/c0000-dns-architecture.md](../c-netzwerk-dns/c0000-dns-architecture.md)) |
| Playlist-Sync-Workflow: `Failed to acquire OAuth2 access token: Client authentication failed` (`invalid_client`) | Fast immer: **"Confidential Client"** in der Xibo-Application (Administration → Applications → General) ist nicht angehakt — ohne dieses Häkchen lehnt Xibo jede Secret-basierte Client-Auth ab, unabhängig davon, ob Client-ID/Secret korrekt sind. Anhaken, speichern, erneut versuchen |
| Playlist-Sync-Workflow: jeder API-Call liefert `403` (auch `/api/display`, `/api/library`, nicht nur `/api/playlist`) | OAuth2-Token hat leere `scopes` (im JWT-Payload prüfbar) — in der Xibo-Application unter dem Tab **"Sharing"** fehlen die Scopes. Mindestens **"Access to Library, Layouts, Playlists, Widgets and Resolutions"** anhaken und speichern |
| Playlist-Sync-Workflow: `Playlist "infotafel" nicht gefunden oder ohne widgets` trotz befüllter Playlist | Playlist ist **dynamisch** (`isDynamic: 1` in der API-Antwort) — dynamische Playlists liefern ihre Inhalte nicht über das `widgets`-Embed. Playlist auf **statisch** umstellen (oder neu als statische Playlist anlegen) und Bilder manuell per "Add Media" hinzufügen |
| Playlist-Sync-Workflow: `Error: Playlist "infotafel" nicht gefunden oder ohne widgets` (Playlist ist statisch, aber leer) | Playlist-Name im CMS muss exakt `infotafel` heißen (Design → Playlists); der Application-User braucht View-Recht auf die Playlist und ihre Bild-Widgets (Xibo-Objektberechtigungen, siehe [Playlist-Sync-Setup](#n8n-workflow-xibo-cms-playlist--display-primär)) |
| Playlist-Sync-Workflow: `Mediendatei herunterladen` liefert `403` | Application-User hat kein View-Recht auf das konkrete Library-Medium — Berechtigung im CMS auf dem Medium bzw. dessen Ordner prüfen |
| Playlist-Sync-Workflow: nach Beheben eines Credential-Fehlers (z.B. Confidential Client/Scopes nachträglich gesetzt) weiterhin derselbe alte Fehler | n8n cacht den einmal geholten OAuth2-Access-Token in der Credential (bis zu 1h, kein automatischer Refresh bei `403`) — ein einfaches erneutes Speichern der Credential löscht den Cache **nicht** zuverlässig. Credential löschen und **neu anlegen**, danach in allen betroffenen HTTP-Request-Knoten neu zuweisen (verwaiste Credential-IDs erzeugen `Credential with ID "..." does not exist`) |
| Playlist-Sync-Workflow: `In Display-Ordner schreiben` liefert `Access to the file is not allowed` | Seit n8n 1.123.5 beschränkt der "Read/Write Files from Disk"-Node den Dateizugriff standardmäßig auf `/home/node/.n8n-files`. `N8N_RESTRICT_FILE_ACCESS_TO` in `argocd/apps/workloads/n8n/values.yaml` muss die erlaubten Pfade enthalten — **Separator ist ein Semikolon `;`, kein Komma** (n8n-Doku ist hier widersprüchlich) |
| Playlist-Sync-Workflow: letzter Knoten `Alte Playlist-Bilder aufräumen` liefert `Module 'fs' is disallowed` | `require('fs')` ist im Code-Node gesperrt (anders als `require('path')`) — Cleanup läuft deshalb über einen **Execute Command**-Knoten (bereits per `NODES_EXCLUDE: "[]"` freigeschaltet), nicht über direkten `fs`-Zugriff im Code-Node. Bei einer älteren Workflow-Version ggf. `xibosignage-playlist-sync.json` neu importieren |
| `infotafel` zeigt Bilder, die längst aus der Playlist entfernt wurden | `kubectl -n n8n exec deploy/n8n -- ls -la /data/xibosignage-display` — liegen noch `xibo-playlist-*`-Dateien ohne aktuelles Playlist-Gegenstück? Workflow-Ausführungshistorie in n8n prüfen, ob der letzte Lauf fehlgeschlagen ist (Cleanup-Schritt läuft nur bei erfolgreichem Durchlauf) |
| n8n "Local File Trigger" feuert nicht (nur relevant für den [deaktivierten Alternativ-Pfad](#alternative-deaktiviert-onlinesync--inbox--display)) | `kubectl -n n8n exec deploy/n8n -- ls -la /data/xibosignage-inbox` — Mount vorhanden? PVC `xibosignage-inbox-data` im Status `Bound`? (`kubectl -n n8n get pvc`) |
| n8n-PVCs bleiben `Pending` | Statische PV falsch benannt/gebunden — `kubectl get pv xibosignage-inbox-pv xibosignage-display-pv` prüfen, `nfs.path` muss exakt existieren (siehe [Ordner anlegen](#nas-ordner-einrichten-display)) |
| Pi zeigt nur "Warte auf Bilder…" | `ssh pi@<host> 'cat /var/www/xibosignage-slideshow/manifest.json'` — leer? `mountpoint /mnt/xibosignage-display` prüfen, ggf. `sudo mount -a` |
| Pi-Mount schlägt fehl | `nfs-common` installiert? (`dpkg -l | grep nfs-common`), NAS vom Pi aus erreichbar? (`showmount -e 192.168.178.97`) |
| Chromium startet nicht / schwarzer Bildschirm | Autologin auf dem Pi aktiv? `systemctl status xibosignage-kiosk xibosignage-webserver` auf dem Pi |
| `xibosignage-kiosk.service` im Crash-Loop, `journalctl -u xibosignage-kiosk` zeigt `exec: chromium-browser: Nicht gefunden` (exit 127) | Auf aktuellen (Debian-trixie-basierten) Raspberry-Pi-OS-Images ist `chromium-browser` nur noch ein leeres transitionales Dummy-Paket, das Binary heißt `chromium` (`/usr/bin/chromium`). `xibosignage-kiosk-start.sh.j2` löst das Binary zur Laufzeit dynamisch auf (`command -v chromium \|\| command -v chromium-browser`) — bei älterem Rollenstand `make xibo-kiosks` erneut laufen lassen, um das aktualisierte Skript auszurollen |
| `Permission denied (publickey)` bei `make xibo-kiosks` | `make semaphore-targets` lief nicht für den neuen Pi (siehe [docs/b-kubernetes-gitops/b0030-semaphore.md](../b-kubernetes-gitops/b0030-semaphore.md)) |
| Nach Workflow-Import in n8n: "Watch Inbox" und/oder "Original archivieren" zeigen "Install this node to use it" | n8n blockt Local File Trigger/Execute Command standardmäßig (Sicherheitsfeature) — `env.NODES_EXCLUDE: "[]"` in `argocd/apps/workloads/n8n/values.yaml` setzt das für diese Instanz zurück, danach n8n-Pod neu starten und Workflow neu öffnen |
| Pi advertised ungewollt das Heim-Subnetz im Tailscale-Adminpanel | `tailscale_advertise_routes: ""` fehlt in `ansible/group_vars/xibo_displays.yml` — sollte nach dem nächsten Rollout verschwinden (`tailscale set --advertise-routes=` ohne Wert entfernt bestehende Routes nicht automatisch, ggf. einmalig `sudo tailscale set --advertise-routes=` manuell auf dem Pi nachziehen) |
| `infotafel` taucht nicht in Grafana auf | `systemctl status prometheus-node-exporter` auf dem Pi — läuft der Dienst (Port 9100)? `curl -s 192.168.178.98:9100/metrics` von einem k3s-Node aus erreichbar? `kubectl -n monitoring get vmstaticscrape infotafel-node-exporter` |
| `make xibo-kiosks` bricht bei "Gathering Facts"/erstem `become`-Task mit `sudo: Ein Passwort ist notwendig` ab | Nur relevant, wenn `ansible_user` **nicht** `pi` ist (siehe Kommentar in `ansible/inventory/hosts.yml`) — Raspberry Pi OS legt nur für den Default-User `pi` automatisch einen `NOPASSWD`-Sudoers-Eintrag an. Einmalig direkt am Gerät (Henne-Ei-Problem, nicht per Ansible automatisierbar): `sudo visudo -f /etc/sudoers.d/010-<user>-nopasswd` mit Inhalt `<user> ALL=(ALL) NOPASSWD:ALL`. Alternative: Ansible-Vault-verschlüsseltes `ansible_become_password` in `ansible/host_vars/<host>/vault.yml`, gleiches Muster wie `vault_worker-0_become_password` in `ansible/group_vars/all.yml` |
| `make xibo-kiosks` bricht bei "Mount-Point für xibosignage-display anlegen" mit `chown failed ... Das Dateisystem ist nur lesbar` ab | Wiederholungslauf nach einem vorherigen abgebrochenen Durchlauf — der NFS-Mount (read-only) war noch aktiv, `ansible.builtin.file` kann dann keine lokalen Attribute mehr auf den (jetzt read-only) Mountpoint schreiben. Behoben in `ansible/roles/xibo_kiosk/tasks/main.yml` (haengt vor dem `file`-Task ein `state: unmounted` voraus, idempotent egal ob vorher gemountet oder nicht) — bei älterem Rollenstand einmalig manuell `sudo umount /mnt/xibosignage-display` auf dem Pi, dann Playbook erneut laufen lassen |
