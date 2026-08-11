# Vereinsheim-Alarmmonitor (Banana Pi M2 Ultra)

Zweiter Alarmmonitor-Standort, aber auf anderer Hardware/OS als die
Raspberry-Pi-Flotte aus [docs/19-alamos-apager.md](19-alamos-apager.md):
ein Banana Pi M2 Ultra mit Armbian statt Raspberry Pi OS, **und** — anders
als alle anderen Pis in diesem Repo — nach der Ersteinrichtung nur noch per
**Tailscale** am Netz, ohne direkten LAN-Zugriff zum Homeserver-Netz. Dieses
Dokument beschreibt nur die Abweichungen/Ergänzungen; die Grundarchitektur
(Chromium-Kiosk gegen `alamos-apager`, Standort-URL als SealedSecret,
Heartbeat → ntfy) ist identisch und dort beschrieben.

Zusätzlich zur Basis-Architektur hat dieser Standort drei Erweiterungen,
die es bei den Raspberry Pis bewusst nicht gibt:

1. **Tailscale-only-Netzwerk** — kein direktes LAN, Zugriff auf
   `*.homeserver` läuft über Tailscale Split-DNS + eine genehmigte
   Subnetz-Route.
2. **Lokaler Server-Fallback** — springt bei Nichterreichbarkeit von
   `alamos-apager.homeserver` automatisch auf die echte AMweb-URL.
3. **Grafana-Monitoring + Zammad-Ticket bei Ausfall** — taucht im
   Dashboard "Home Server Auslastung" auf (per **Push**, nicht Pull — siehe
   unten) und erzeugt (nur für dieses Gerät) ein Zammad-Ticket, wenn es
   länger als 10 Minuten nicht erreichbar ist.

## Inhaltsverzeichnis

1. [OS](#os)
2. [Netzwerk: Tailscale-only](#netzwerk-tailscale-only)
3. [Ersteinrichtung (manuell)](#ersteinrichtung-manuell)
4. [Ansible-Provisionierung](#ansible-provisionierung)
5. [Server-Fallback](#server-fallback)
6. [Grafana (Push statt Pull)](#grafana-push-statt-pull)
7. [Zammad-Ticket via n8n](#zammad-ticket-via-n8n)
8. [Fehlerbehebung](#fehlerbehebung)

---

## OS

**Armbian, Debian 13 "Trixie" (minimal/CLI-Image), Kernel 6.18.x** —
aktuell "Community Supported" für den Banana Pi M2 Ultra
(<https://armbian.com/boards/bananapim2ultra>).

Debian minimal statt des ebenfalls angebotenen Ubuntu-Xfce-Images, weil
Ubuntu `chromium` nur noch als Snap ausliefert (Sandbox-Eigenheiten,
langsamer Erststart) — Debian hat weiterhin ein echtes `.deb`-Paket, das
sich sauber per Ansible/apt installieren lässt.

## Netzwerk: Tailscale-only

Anders als die xibosignage-Pis (die volles LAN haben und Tailscale nur zur
bequemen Fernwartung nutzen, siehe [docs/44-xibosignage.md](44-xibosignage.md))
hat dieser Standort **kein LAN-Zugriff zum Homeserver-Netz**. Das betrifft
drei unabhängige Dinge, die alle einzeln gelöst werden mussten:

**1. Ansible/Semaphore-Erreichbarkeit (Henne-Ei-Problem).** Ansible kann
Tailscale nicht per Ansible installieren, wenn Tailscale der einzige Weg
zum Gerät ist. Deshalb zwei Phasen:

- **Phase 1 (Ersteinrichtung):** Pi hängt kurz am LAN,
  `ansible_host` = LAN-IP (`192.168.178.129`). Der erste
  `make banana-pi-kiosks`-Lauf installiert dabei auch Tailscale
  (`ansible/roles/tailscale`, siehe `ansible/group_vars/banana_pis.yml`
  für den eigenen Tailscale-Auth-Key — **nicht** den Homeserver-Key aus
  `group_vars/all.yml` wiederverwenden).
- **Phase 2 (Dauerbetrieb):** Nach dem Umzug an den eigentlichen Standort
  `ansible_host` in `ansible/inventory/hosts.yml` auf die Tailscale-IP
  (`tailscale ip -4` auf dem Pi) oder den MagicDNS-Namen umstellen.
  **Wichtig:** Semaphore läuft selbst als Pod im k3s-Cluster und hat wie
  jeder Pod **keinen** Netzwerkpfad zu Tailscale-Peers — Re-Provisionierung
  in Phase 2 funktioniert nur noch per `make banana-pi-kiosks` von einer
  im Tailnet angemeldeten Maschine, nicht mehr über die Semaphore-UI.

**2. DNS-Auflösung von `*.homeserver` (für den Kiosk selbst).** Gelöst über
**Tailscale Split-DNS**, ein dokumentiertes, bereits unterstütztes
Verfahren in diesem Repo (siehe
[docs/08-semaphore.md, "Zugriff über Tailscale"](08-semaphore.md#zugriff-über-tailscale-einmaliger-admin-schritt)
und [docs/09-dns-architecture.md](09-dns-architecture.md)): dnsmasq auf dem
Homeserver lauscht bereits auf `tailscale0`. Einmaliger Admin-Schritt:
Tailscale-Adminkonsole → DNS → Nameservers → Custom Nameserver mit der
Tailscale-IP des Homeservers, **restricted to search domain `homeserver`**
hinzufügen. Danach löst der Pi `alamos-apager.homeserver` etc. korrekt auf
(Antwort ist weiterhin eine LAN-IP, siehe Punkt 3).

**3. Tatsächliche Erreichbarkeit der aufgelösten LAN-IP.** Die DNS-Antwort
bringt nichts, wenn der Pi die LAN-IP dahinter nicht routen kann. Der
Homeserver bewirbt bereits `192.168.178.0/24` als Subnetz-Route
(`ansible/roles/tailscale`, Default über `group_vars/all.yml`) — die muss
im Tailscale-Adminpanel genehmigt sein
(<https://login.tailscale.com/admin/machines>). Der Pi selbst muss diese
Route zusätzlich **annehmen**: `tailscale_accept_routes: true` in
`ansible/group_vars/banana_pis.yml` (Default für alle anderen Hosts in
diesem Repo ist `false` — die Rolle wurde dafür erweitert, siehe
`ansible/roles/tailscale/defaults/main.yml`).

**Nebenbei behoben:** Die `tailscale`-Rolle war bisher hart auf das
Ubuntu-APT-Repo von Tailscale kodiert (`pkgs.tailscale.com/stable/ubuntu/...`).
Armbian meldet sich als Debian — die Rolle wählt jetzt automatisch das
richtige Repo (`tailscale_repo_os`, siehe Rollen-Defaults).

## Ersteinrichtung (manuell)

Reines Imaging, kein Ansible-Thema (analog zu "Raspberry Pi OS Desktop +
Autologin" bei den anderen Kiosks):

1. Armbian-Image auf SD/eMMC flashen.
2. Erstboot: Root-Login, Kiosk-User anlegen (Konvention: `pi`, siehe
   `banana_pi_kiosk_user` in `ansible/roles/banana_pi_kiosk/defaults/main.yml`).
3. Netzwerk/SSH so einrichten, dass der Host **noch am LAN** per
   `ansible_host` aus dem Inventory (`192.168.178.129`, Phase 1) erreichbar
   ist — siehe [Netzwerk: Tailscale-only](#netzwerk-tailscale-only).
4. `make semaphore-targets` laufen lassen (pusht den Semaphore-SSH-Key,
   Host ist bereits unter `semaphore_targets` in
   `ansible/inventory/hosts.yml` eingetragen). Funktioniert nur in Phase 1.

Autologin auf tty1 sowie die minimale X11-Session (Xorg + Openbox, kein
Desktop-Environment) richtet — anders als bei den Raspberry Pis, wo das
der Raspberry Pi Imager übernimmt — die Ansible-Rolle
`ansible/roles/banana_pi_kiosk` selbst ein (getty-Drop-in +
`.bash_profile` + `.xinitrc`).

## Ansible-Provisionierung

```bash
make banana-pi-kiosks-check   # Dry-run
make banana-pi-kiosks         # Provisionieren
```

Rollen, in dieser Reihenfolge (siehe `ansible/banana-pi-kiosks.yml`):

| Rolle | Zweck |
|---|---|
| `tailscale` | Netzwerk-Anbindung (siehe oben) — läuft zuerst, alles Weitere braucht ggf. schon `*.homeserver` |
| `node_exporter` | Metriken-Quelle (Port 9100, nur lokal) |
| `vmagent` | Pusht die Metriken aktiv an den Cluster (siehe [Grafana](#grafana-push-statt-pull)) |
| `banana_pi_kiosk` | X11-Autologin, Chromium-Kiosk, Server-Fallback-Supervisor, Heartbeat, täglicher Neustart um 00:00 Uhr |
| `thermal_watchdog` | Selbstschutz bei Übertemperatur (gleiches Bundling wie bei den Alamos-Pis) |
| `resource_watchdog` | Selbstschutz bei CPU/RAM-Sättigung |

Vor dem ersten Lauf nötig:

1. **Standort-URL im Cluster hinterlegen** — Key `vereinsheim-alarmmonitor`
   zum SealedSecret `alamos-apager-stations` hinzufügen (siehe
   [docs/19-alamos-apager.md, "Neuen Standort hinzufügen"](19-alamos-apager.md#neuen-standort-hinzufügen)).
2. **Dieselbe URL lokal verschlüsseln** (Fallback, siehe unten):
   ```bash
   ansible-vault encrypt_string 'https://amweb.alamos.cloud/...echte-url...' \
     --name 'vault_vereinsheim_alarmmonitor_fallback_url'
   ```
   Ausgabe in `ansible/host_vars/vereinsheim-alarmmonitor/vault.yml`
   anstelle des `CHANGE-ME`-Platzhalters einfügen.
3. **Eigener Tailscale-Auth-Key** in `ansible/group_vars/banana_pis.yml`
   (Ansible-Vault-verschlüsselt, siehe Kommentar dort — nicht den
   Homeserver-Key wiederverwenden).
4. **Tailscale-Adminkonsole:** Split-DNS + Subnetz-Route-Genehmigung, siehe
   [Netzwerk: Tailscale-only](#netzwerk-tailscale-only).
5. **Einmaliger manueller AMweb-Login direkt am Gerät** (Passwort +
   Verschlüsselungspasswort) — identisches Vorgehen wie bei den Raspberry
   Pis, siehe [docs/19-alamos-apager.md, Pi-Provisionierung](19-alamos-apager.md#pi-provisionierung-ansible).
   Da Normal- und Fallback-Pfad dieselbe AMweb-Domain im selben
   Chromium-Profil verwenden, deckt dieser eine Login beide Pfade ab.

## Server-Fallback

Bewusster Bruch mit der sonst geltenden Regel "die echte AMweb-URL
verlässt nie den Cluster" ([docs/19-alamos-apager.md](19-alamos-apager.md))
— nur für dieses Gerät, auf ausdrücklichen Wunsch.

`ansible/roles/banana_pi_kiosk/templates/banana-pi-kiosk-supervisor.sh.j2`
ist der X-Session-Client (läuft dauerhaft, damit `xinit` die Session nicht
beendet) und:

- prüft alle 30s (`banana_pi_kiosk_failover_poll_seconds`) die
  Erreichbarkeit von `alamos-apager.homeserver`,
- schaltet nach 3 aufeinanderfolgenden Fehlversuchen (~90s,
  `banana_pi_kiosk_failover_fail_threshold`) auf die lokal (Ansible-Vault)
  hinterlegte echte AMweb-URL um,
- schaltet nach dem ersten erfolgreichen Check
  (`banana_pi_kiosk_failover_recover_threshold`) wieder auf die normale
  Cluster-URL zurück,
- startet Chromium dafür jeweils neu (gleiches Profil, kein
  `--incognito` → Session/Login bleibt erhalten), ohne die X-Session
  selbst neu zu starten.

Der bestehende Heartbeat-Timer (→ ntfy-Ausfall-Alarm in
`argocd/apps/alamos-apager`) läuft unverändert parallel und unabhängig
davon weiter — er braucht denselben `*.homeserver`-Pfad wie der Kiosk
selbst, ist also von derselben Split-DNS/Route-Voraussetzung abhängig.

## Grafana (Push statt Pull)

**Anders als bei `ugreen-nas` (VMStaticScrape, Cluster scraped aktiv):**
Pods im Cluster (Pod-Netz `10.42.0.0/16`) haben keinen Netzwerkpfad zu
Tailscale-Peers — kein Subnet-Router ins Pod-Netz, `--accept-routes=false`
überall sonst im Repo. Cluster-seitiges Scrapen scheidet für diesen Host
also aus.

Stattdessen **pusht der Pi seine Metriken selbst**:

```
node_exporter (Port 9100, nur localhost)
  → vmagent (ansible/roles/vmagent, scraped lokal)
  → remote_write über http://vm-write.homeserver/api/v1/write
    (argocd/apps/monitoring/templates/ingress-vm-write.yaml,
     nur /api/v1/write freigegeben, nicht die volle VM-API)
  → VictoriaMetrics im Cluster
```

Das nutzt denselben Netzwerkpfad (Split-DNS + Subnetz-Route), den der Kiosk
ohnehin schon braucht — kein zusätzliches Pod-zu-Tailscale-Routing nötig.
`vmagent` ist eine statische Binary (kein Debian-Paket verfügbar,
`vmutils-linux-arm-v*.tar.gz` vom GitHub-Release), puffert bei kurzzeitiger
Nichterreichbarkeit lokal (`-remoteWrite.tmpDataPath`) und holt das dann
nach.

Kein Dashboard-Change nötig — "Home Server Auslastung"
(`uid: homeserver-auslastung`) filtert dynamisch über die Grafana-Variable
`$instance`; der Pi taucht automatisch auf, sobald seine Metriken ankommen.

## Zammad-Ticket via n8n

**Nur für diesen Standort** — die Raspberry-Pi-Alarmmonitore erzeugen
weiterhin bewusst **kein** Ticket pro Ausfall (nur ntfy, siehe
[docs/19-alamos-apager.md](19-alamos-apager.md)); das bleibt unverändert.

**Wichtig, wegen Push statt Pull:** Die VMRule nutzt `absent_over_time`
statt `up == 0` — ein `up`-Sample mit Wert 0 setzt eine laufende
Scrape-Verbindung voraus, die es hier gar nicht gibt (der Pi *pusht* ja
selbst). Fällt er aus, hört die Zeitreihe einfach auf, sich zu
aktualisieren; `absent_over_time` erkennt "seit 10 Minuten kein Sample
mehr angekommen" — das erfasst sowohl "Pi ist down" als auch "Pi lebt,
aber Tailscale/Push-Pfad ist down" (aus Nutzersicht ohnehin dasselbe
Problem: der Monitor ist nicht mehr überwachbar).

Ablauf:

```
absent_over_time(up{...}[10m]) für vereinsheim-alarmmonitor
  → VMRule "BananaPiAlarmmonitorDown" (vmrule-banana-pi.yaml, severity=critical)
  → Alertmanager, zusätzliche Route NUR für diesen Alertnamen
    (argocd/apps/monitoring/values.yaml)
  → n8n-Webhook http://n8n.homeserver/webhook/banana-pi-down
  → Workflow "Banana-Pi-Down -> Zammad-Ticket"
    (argocd/apps/n8n/workflows/banana-pi-down-to-zammad.json):
      1. letzte bekannte CPU/RAM/Temperatur-Werte aus VictoriaMetrics holen
         (der Pi selbst ist ja gerade nicht erreichbar — das sind KEINE
         Live-Daten, sondern der letzte Stand vor dem Ausfall)
      2. Zeitstempel der letzten erfolgreichen /start-Anfrage holen (=
         wann hat der Kiosk zuletzt die echte AMweb-URL angefragt) —
         kommt NICHT vom Pi, sondern von alamos-apager selbst
         (`/metrics`, siehe docs/19-alamos-apager.md), das immer im
         Cluster läuft und daher unabhängig vom Tailscale-Status des Pi
         abfragbar ist
      3. Zammad-Ticket erstellen (POST /api/v1/tickets, gleiches Muster
         wie argocd/apps/github-release-watcher)
  → Zammads eigene Agenten-Benachrichtigung verschickt die Mail an
    info@edv-kretzer.de (kein separater E-Mail-Node in n8n nötig)
```

Die bestehenden gotify-/ntfy-Routen bleiben für diesen Alert (und alle
anderen) unverändert bestehen — die n8n-Route kommt rein additiv dazu
(`continue: true`, siehe Kommentar in `values.yaml`).

**Woher "letzte AMweb-Anfrage" kommt:** `alamos-apager` (die geteilte
Cluster-Komponente aus [docs/19-alamos-apager.md](19-alamos-apager.md))
merkt sich jetzt zusätzlich zum Heartbeat auch den Zeitstempel jeder
erfolgreichen `/start`-Anfrage (also wann der Kiosk-Browser zuletzt
tatsächlich die echte AMweb-URL angefragt hat) und exportiert das über
einen eigenen `/metrics`-Endpunkt (`alamos_apager_last_start_timestamp_seconds`,
siehe `argocd/apps/alamos-apager/templates/configmap-script.yaml` +
`vmservicescrape.yaml`). Das läuft cluster-intern und ist damit — anders
als die node_exporter-Metriken des Pi selbst — auch dann abfragbar, wenn
der Pi/Tailscale gerade down ist. Betrifft alle Alamos-Standorte
gleichermaßen, nicht nur diesen.

**Einmalige manuelle Schritte:**

1. **Zammad:** `info@edv-kretzer.de` als Agent-Account anlegen (falls noch
   nicht vorhanden), Mitglied der Ticket-Gruppe (Default im Workflow:
   `Support::Administration` — angenommen als Untergruppe "Administration"
   von "Support", `::` ist der von der Zammad-API erwartete Trenner für
   Untergruppen, siehe docs/25-github-release-watcher.md; falls es
   stattdessen eine einzelne Gruppe mit dem wörtlichen Namen
   "Support / Administration" ist, im Code-Node "Ticket-Payload bauen"
   entsprechend anpassen) machen und unter **Profil → Benachrichtigungen**
   die Mail-Benachrichtigung
   für "Neues Ticket" aktivieren (Zammad-Standard: aktiviert). Gleiches
   Prinzip wie [docs/25-github-release-watcher.md, Schritt 4](25-github-release-watcher.md#schritt-4--agenten-benachrichtigung-in-zammad-prüfen).
2. **Zammad-API-Token erzeugen:** Profil → Token Access → Neuer Token,
   Berechtigung `ticket.agent` (siehe
   [docs/25-github-release-watcher.md, Schritt 1](25-github-release-watcher.md#schritt-1--zammad-api-token-erzeugen)
   für die genauen Klicks).
3. **n8n:** Workflow `banana-pi-down-to-zammad.json` importieren, dann im
   Node "Zammad-Ticket erstellen" eine Header-Auth-Credential anlegen/
   zuweisen (Name z. B. "Zammad API Token", Header-Name `Authorization`,
   Value `Token token=<ZAMMAD_TOKEN>` aus Schritt 2) — Credential-IDs
   werden beim Import nicht mit übernommen, das ist ein normaler
   Post-Import-Schritt.
4. Workflow in n8n aktivieren (`active: true` in der UI).

## Fehlerbehebung

| Symptom | Check |
|---|---|
| `make banana-pi-kiosks` erreicht den Pi nicht mehr | Phase 1 vs. Phase 2? `ansible_host` in `ansible/inventory/hosts.yml` noch auf der alten LAN-IP, obwohl der Pi schon umgezogen ist? |
| Kiosk zeigt weder Redirect noch Fallback (Chromium-Fehlerseite) | `nslookup alamos-apager.homeserver` auf dem Pi — löst das auf? Tailscale Split-DNS eingerichtet (siehe oben)? |
| DNS löst auf, aber Verbindung timeout | Subnetz-Route `192.168.178.0/24` im Tailscale-Adminpanel genehmigt? `tailscale_accept_routes: true` beim Pi angekommen (`tailscale status` auf dem Pi prüfen)? |
| Pi taucht nicht in Grafana auf | `systemctl status vmagent` auf dem Pi, `journalctl -u vmagent` — Fehler beim remote_write? `curl -I http://vm-write.homeserver/api/v1/write` vom Pi aus erreichbar? |
| Kiosk startet nicht / schwarzer Bildschirm | `systemctl status getty@tty1` auf dem Pi, Autologin aktiv? Läuft `startx`? |
| Fallback schaltet nicht um | `journalctl -t banana-pi-kiosk` auf dem Pi (Supervisor loggt Moduswechsel) |
| Fallback zeigt AMweb-Login statt Alarmmonitor | Chromium-Session abgelaufen — einmaligen manuellen Login wiederholen (siehe oben) |
| Kein Zammad-Ticket trotz 10+ Minuten Ausfall | `kubectl -n monitoring get vmrule banana-pi-availability` (Alert "firing"?), Alertmanager-Route korrekt? n8n-Workflow aktiv? |
| Ticket erstellt, aber keine Mail | Zammad-Agent-Mitgliedschaft/Benachrichtigung prüfen (siehe oben), ausgehender E-Mail-Kanal in Zammad konfiguriert? |
| n8n-Workflow schlägt am Zammad-Node fehl | Header-Auth-Credential zugewiesen? Token gültig/`ticket.agent`-Berechtigung? |

## Relevante Links

- [docs/19-alamos-apager.md](19-alamos-apager.md) — Basis-Architektur (Raspberry-Pi-Flotte)
- [docs/08-semaphore.md](08-semaphore.md) — Tailscale Split-DNS-Setup
- [docs/09-dns-architecture.md](09-dns-architecture.md) — `*.homeserver`-Auflösung
- [docs/06-tailscale.md](06-tailscale.md) — Tailscale-Grundlagen
- [docs/17-zammad.md](17-zammad.md) — Zammad-Setup
- [docs/25-github-release-watcher.md](25-github-release-watcher.md) — Zammad-API-Ticket-Muster
- [docs/29-n8n.md](29-n8n.md) — n8n-Setup
- [docs/16-nas-storage.md](16-nas-storage.md) — VMStaticScrape-Muster (ugreen-nas, Pull-Vergleichsfall)
- [Armbian — Banana Pi M2 Ultra](https://armbian.com/boards/bananapim2ultra)
- [VictoriaMetrics vmagent](https://docs.victoriametrics.com/victoriametrics/vmagent/)
