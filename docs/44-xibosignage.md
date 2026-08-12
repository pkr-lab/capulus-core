# xibosignage — Xibo CMS + Bilder-Slideshow auf Raspberry Pi 3 B+

Digital-Signage-Setup: **Xibo CMS** läuft als zentrale Medien-/Asset-
Verwaltung im k3s-Cluster, Bilder landen über eine vom Nutzer selbst
eingerichtete **OnlineSync** in einem festen NAS-Ordner, ein **n8n-Workflow**
verarbeitet neue Bilder automatisch, und ein **Raspberry Pi 3 B+** zeigt sie
als Slideshow.

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
3. [NAS-Ordner einrichten (Inbox/Display, OnlineSync)](#nas-ordner-einrichten-inboxdisplay-onlinesync)
4. [n8n-Workflow: Inbox → Display](#n8n-workflow-inbox--display)
5. [Raspberry-Pi-Rollout (Ansible)](#raspberry-pi-rollout-ansible)
6. [Fehlerbehebung](#fehlerbehebung)

---

## Architektur

```
                     ┌─────────────────────────────────────────┐
                     │  Xibo CMS (k3s, Namespace xibosignage)   │
                     │  cms-web ── MySQL ── XMR ── Memcached    │
                     │             └── QuickChart               │
                     │  http://xibo.homeserver                  │
                     │  PVC "library"/"state" (StorageClass nas) │
                     └─────────────────────────────────────────┘
                        (zentrale Medien-/Asset-Verwaltung,
                         unabhängig vom Anzeige-Pfad unten)

  Handy/PC/Cloud                                      UGREEN NAS (192.168.178.97)
  ────────────────                                     /volume1/k8s-storage/
  Eigene "OnlineSync"   ──(SMB/NFS, User-Setup)──▶   xibosignage-inbox/
  (z.B. UGOS-Cloud-Sync,                                    │
   Handy-Ordner-Sync)                                       │ n8n: Local File Trigger
                                                              ▼
                                                    n8n (Namespace n8n)
                                                    Resize (Edit Image) auf
                                                    1920×1080, Original nach
                                                    inbox/processed/ verschoben
                                                              │
                                                              ▼
                                             /volume1/k8s-storage/
                                             xibosignage-display/
                                                              │
                                                              │ NFS-Mount, read-only
                                                              ▼
                                             Raspberry Pi 3 B+
                                             ansible/roles/xibo_kiosk:
                                             manifest.json-Scan (alle 30s)
                                             + Chromium-Kiosk-Slideshow
                                             + Tailscale (Fernzugriff)
```

Zwei bewusst getrennte Storage-Pfade:

| Ordner | Wer schreibt | Wer liest | Zweck |
|---|---|---|---|
| Xibo-CMS-`library`-PVC | nur Xibo CMS selbst | nur Xibo CMS selbst | Interne Medien-Verwaltung (Layouts, Playlists) — Xibo speichert Dateien intern gehasht, kein direkter Dateizugriff von außen vorgesehen |
| `xibosignage-inbox` (NAS, fester Pfad) | OnlineSync (Nutzer-Setup) | n8n | Rohdateien-Eingang |
| `xibosignage-display` (NAS, fester Pfad) | n8n | Raspberry Pi (NFS, read-only) | Was tatsächlich auf dem Pi angezeigt wird |

Xibo CMS und die Inbox/Display-Ordner sind bewusst **unabhängig voneinander** —
die Slideshow auf dem Pi funktioniert komplett ohne Xibo CMS. Das CMS dient
als eigenständige Medien-/Asset-Verwaltungsoberfläche und steht bereit, falls
später doch ein offiziell unterstütztes Player-Gerät (Windows/Android/Pi 4+
mit Arexibo) dazukommt.

---

## Xibo CMS deployen (argocd/apps/workloads/xibosignage)

Liegt unter `argocd/apps/workloads/xibosignage/`, wird wie jede andere App in
`argocd/apps/*` automatisch von ArgoCD erkannt und ausgerollt (siehe
[docs/05-argocd.md](05-argocd.md)) — keine manuelle Registrierung nötig.

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

Nach dem Sync ist Xibo unter **http://xibo.homeserver** erreichbar. Das
CMS-Image führt beim allerersten Start automatisch DB-Migrationen +
Installation durch — das kann einige Minuten dauern
(`kubectl -n xibosignage logs deploy/xibosignage-cms -f`).

**Default-Login:** `xibo_admin` / `password` — **sofort nach dem ersten
Login ändern** (Einstellungen → Mein Konto).

### Konfiguration (values.yaml)

| Key | Bedeutung | Default |
|---|---|---|
| `cms.env.CMS_SERVER_NAME` | Hostname, den das CMS für sich selbst annimmt | `xibo.homeserver` |
| `cms.env.CMS_PHP_UPLOAD_MAX_FILESIZE` | Max. Upload-Größe pro Datei | `512M` |
| `cms.persistence.library.size` | Medien-Bibliothek | `50Gi` |
| `mysql.persistence.size` | Datenbank | `10Gi` |
| `quickchart.enabled` | Chart-Widget-Rendering aktivieren | `true` |

---

## NAS-Ordner einrichten (Inbox/Display, OnlineSync)

`xibosignage-inbox` und `xibosignage-display` sind **feste** Pfade unter dem
bestehenden `k8s-storage`-Export (`nas`-StorageClass, siehe
[docs/16-nas-storage.md](16-nas-storage.md)) — **nicht** dynamisch vom
`nfs-subdir-external-provisioner` vergeben, weil sowohl n8n (Kubernetes-Pod)
als auch der Raspberry Pi (rohes NFS, kein Kubernetes) als auch die eigene
OnlineSync denselben, vorhersagbaren Pfad ansprechen müssen. Details zur
Technik (statische PV mit `nfs:`-Block statt PVC über eine StorageClass):
[docs/16-nas-storage.md](16-nas-storage.md#fixer-pfad-statt-dynamischer-subdir-name).

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
  ausschließlich vom n8n-Workflow beschrieben (verarbeitete, Pi-taugliche
  Bilder). Rohdateien gehören in `xibosignage-inbox`.

---

## n8n-Workflow: Inbox → Display

`argocd/apps/workloads/n8n/values.yaml` mountet beide Ordner in den n8n-Pod
(`xibosignage.inbox.mountPath` / `xibosignage.display.mountPath`, Default
`/data/xibosignage-inbox` und `/data/xibosignage-display`) — nach dem Sync
sofort im Pod verfügbar, keine weitere Konfiguration nötig.

### Workflow importieren

Eine fertige Workflow-Definition liegt unter
`argocd/apps/workloads/n8n/workflows/xibosignage-inbox-to-display.json`:

1. n8n öffnen (http://n8n.homeserver) → **Workflows** → **Import from File**.
2. `argocd/apps/workloads/n8n/workflows/xibosignage-inbox-to-display.json` auswählen.
3. Workflow öffnen, Knoten-Parameter prüfen (Node-Schemas können sich
   zwischen n8n-Versionen leicht unterscheiden — insbesondere beim
   **Edit Image**-Knoten die Resize-Optionen einmal in der UI bestätigen)
   und **Activate**.

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

Der Pi selbst bekommt von n8n nichts mitgeteilt — er liest
`xibosignage-display` einfach periodisch neu ein (siehe unten), das neue
Bild taucht beim nächsten Manifest-Scan automatisch in der Slideshow auf.

### Optional: Bilder zusätzlich in Xibo CMS registrieren

Der obige Workflow ist unabhängig vom Xibo-CMS-Deploy — für eine zentrale
Asset-Übersicht im CMS selbst lässt sich der Workflow um einen zusätzlichen
Zweig erweitern:

1. In Xibo CMS: **Administration → Applications → Add Application** (OAuth2
   Client Credentials), Client-ID/Secret notieren.
2. In n8n: neue Credential vom Typ **OAuth2 API** mit Access Token URL
   `http://xibosignage-cms.xibosignage.svc.cluster.local/api/authorize/access_token`
   und den Werten aus Schritt 1 anlegen.
3. Nach dem Knoten "Originaldatei lesen" einen zusätzlichen **HTTP
   Request**-Knoten (Authentication: die eben angelegte OAuth2-Credential)
   einfügen: `POST http://xibosignage-cms.xibosignage.svc.cluster.local/api/library`,
   Body Type "Form-Data", Feld `files` = Binärdaten der gelesenen Datei,
   Feld `type` = `image`.

Dieser Zweig ist bewusst **nicht** im importierten JSON enthalten, da er
eigene, erst nach dem CMS-Deploy erzeugbare Zugangsdaten braucht.

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
[docs/06-tailscale.md](06-tailscale.md#auth-key-besorgen):

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
| `xibo_kiosk` | NFS-Mount von `xibosignage-display` (read-only), Manifest-Generator-Timer, lokaler Python-Webserver, Chromium-Kiosk-Slideshow |
| `thermal_watchdog` / `resource_watchdog` | Selbstschutz für unbeaufsichtigte Geräte (gleiches Bundling wie bei den ALAMOS-Kiosks, siehe [docs/19-alamos-apager.md](19-alamos-apager.md)) |

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
automatisch in der UI verfügbar (siehe [docs/08-semaphore.md](08-semaphore.md))
— **bewusst ohne** automatischen Schedule, analog zu `alarm-kiosks`.

---

## Fehlerbehebung

| Symptom | Check |
|---|---|
| Xibo-CMS-Pod bleibt `CrashLoopBackOff` beim allerersten Start | `kubectl -n xibosignage logs deploy/xibosignage-cms` — meist DB noch nicht bereit, Pod startet automatisch neu; bei anhaltenden Fehlern MySQL-Pod-Status prüfen (`kubectl -n xibosignage get pods`) |
| MySQL-Pod: `Permission denied` auf `/var/lib/mysql` | NFS-Squash-Identität auf dem UGREEN NAS hat sich geändert (siehe [docs/16-nas-storage.md](16-nas-storage.md) und die identische Problemlösung bei wikijs/immich) — `mysql.securityContext.runAsUser`/`runAsGroup` in `argocd/apps/workloads/xibosignage/values.yaml` an die aktuelle Squash-Identität anpassen. **Nicht** auf `cms.securityContext` übertragen — das offizielle xibo-cms-Image braucht beim ersten Start Root (schreibt `/root/.my.cnf`, konfiguriert Apache/PHP/cron unter `/etc`), analog zu wikijs/immich bleibt `cms.securityContext` deshalb bewusst leer |
| CMS-Pod: `CrashLoopBackOff`, Logs voller `Permission denied` (`/root/.my.cnf`, `/etc/apache2`, `/etc/php`, `settings.php`) und `ERROR 1045 ... UNKNOWN_USER` | `cms.securityContext` in `argocd/apps/workloads/xibosignage/values.yaml` wurde (versehentlich) auf `runAsUser: 1000` o.ä. gesetzt — muss leer (`{}`) sein, da das CMS-Image root für sein Setup braucht |
| `xibo.homeserver` löst nicht auf | Wildcard-DNS prüfen: `nslookup xibo.homeserver` (siehe [docs/09-dns-architecture.md](09-dns-architecture.md)) |
| n8n "Local File Trigger" feuert nicht | `kubectl -n n8n exec deploy/n8n -- ls -la /data/xibosignage-inbox` — Mount vorhanden? PVC `xibosignage-inbox-data` im Status `Bound`? (`kubectl -n n8n get pvc`) |
| n8n-PVCs bleiben `Pending` | Statische PV falsch benannt/gebunden — `kubectl get pv xibosignage-inbox-pv xibosignage-display-pv` prüfen, `nfs.path` muss exakt existieren (siehe [Ordner anlegen](#nas-ordner-einrichten-inboxdisplay-onlinesync)) |
| Pi zeigt nur "Warte auf Bilder…" | `ssh pi@<host> 'cat /var/www/xibosignage-slideshow/manifest.json'` — leer? `mountpoint /mnt/xibosignage-display` prüfen, ggf. `sudo mount -a` |
| Pi-Mount schlägt fehl | `nfs-common` installiert? (`dpkg -l | grep nfs-common`), NAS vom Pi aus erreichbar? (`showmount -e 192.168.178.97`) |
| Chromium startet nicht / schwarzer Bildschirm | Autologin auf dem Pi aktiv? `systemctl status xibosignage-kiosk xibosignage-webserver` auf dem Pi |
| `Permission denied (publickey)` bei `make xibo-kiosks` | `make semaphore-targets` lief nicht für den neuen Pi (siehe [docs/08-semaphore.md](08-semaphore.md)) |
| Nach Workflow-Import in n8n: "Watch Inbox" und/oder "Original archivieren" zeigen "Install this node to use it" | n8n blockt Local File Trigger/Execute Command standardmäßig (Sicherheitsfeature) — `env.NODES_EXCLUDE: "[]"` in `argocd/apps/workloads/n8n/values.yaml` setzt das für diese Instanz zurück, danach n8n-Pod neu starten und Workflow neu öffnen |
| Pi advertised ungewollt das Heim-Subnetz im Tailscale-Adminpanel | `tailscale_advertise_routes: ""` fehlt in `ansible/group_vars/xibo_displays.yml` — sollte nach dem nächsten Rollout verschwinden (`tailscale set --advertise-routes=` ohne Wert entfernt bestehende Routes nicht automatisch, ggf. einmalig `sudo tailscale set --advertise-routes=` manuell auf dem Pi nachziehen) |
