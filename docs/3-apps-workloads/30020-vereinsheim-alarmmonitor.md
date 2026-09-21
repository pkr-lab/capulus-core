# Vereinsheim-Alarmmonitor (Banana Pi M2 Ultra)

Zweiter Alarmmonitor-Standort, aber auf anderer Hardware/OS als die
Raspberry-Pi-Flotte aus [docs/3-apps-workloads/30010-alamos-apager.md](30010-alamos-apager.md):
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
   Dashboards im Ordner "Hardware" auf (per **Push**, nicht Pull — siehe
   unten) und erzeugt (nur für dieses Gerät) ein Zammad-Ticket, wenn es
   länger als 10 Minuten nicht erreichbar ist. Ein eigenes Standort-Dashboard
   **"1002011-pis"** (`dashboard-1002011-pis.yaml`, benannt nach dem
   ALAMOS-Standortcode des Vereinsheims, siehe `banana_pi_kiosk_station` in
   `ansible/inventory/hosts.yml`) zeigt zusätzlich zum Rhein-Pegel und den
   ALAMOS-Statuswerten auch CPU/RAM/Temperatur/Disk dieses Pi im Detail —
   und, da am selben Standort, dieselben Metriken für die xibosignage-
   Infotafel `infotafel` (siehe
   [docs/3-apps-workloads/300e0-xibosignage.md, "Monitoring (Grafana)"](300e0-xibosignage.md#monitoring-grafana)).

## Inhaltsverzeichnis

1. [OS](#os)
2. [Netzwerk: Tailscale-only](#netzwerk-tailscale-only)
3. [Ersteinrichtung (manuell)](#ersteinrichtung-manuell)
4. [Ansible-Provisionierung](#ansible-provisionierung)
5. [Server-Fallback](#server-fallback)
6. [Periodischer Seiten-Neustart](#periodischer-seiten-neustart)
7. [Grafana (Push statt Pull)](#grafana-push-statt-pull)
8. [Zammad-Ticket via n8n](#zammad-ticket-via-n8n)
9. [Sichtprüfung ohne physischen Zugriff](#sichtprüfung-ohne-physischen-zugriff)
10. [Wake-on-LAN für den Windows-PC](#wake-on-lan-für-den-windows-pc)
11. [Fehlerbehebung](#fehlerbehebung)

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
bequemen Fernwartung nutzen, siehe [docs/3-apps-workloads/300e0-xibosignage.md](300e0-xibosignage.md))
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
[docs/b-kubernetes-gitops/b0030-semaphore.md, "Zugriff über Tailscale"](../b-kubernetes-gitops/b0030-semaphore.md#zugriff-über-tailscale-einmaliger-admin-schritt)
und [docs/c-netzwerk-dns/c0000-dns-architecture.md](../c-netzwerk-dns/c0000-dns-architecture.md)): dnsmasq auf dem
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
| `banana_pi_kiosk` | X11-Autologin, Chromium-Kiosk, Server-Fallback-Supervisor, Heartbeat, täglicher Kiosk-Session-Neustart um 00:00 Uhr (kein Kernel-Reboot, siehe Kommentar in `banana-pi-daily-reboot.service.j2` — Warm-Reset auf diesem Board unzuverlässig) |
| `thermal_watchdog` | Selbstschutz bei Übertemperatur (gleiches Bundling wie bei den Alamos-Pis) |
| `resource_watchdog` | Selbstschutz bei CPU/RAM-Sättigung |

Vor dem ersten Lauf nötig:

1. **Standort-URL im Cluster hinterlegen** — Key `vereinsheim-alarmmonitor`
   zum SealedSecret `alamos-apager-stations` hinzufügen (siehe
   [docs/3-apps-workloads/30010-alamos-apager.md, "Neuen Standort hinzufügen"](30010-alamos-apager.md#neuen-standort-hinzufügen)).
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
   Pis, siehe [docs/3-apps-workloads/30010-alamos-apager.md, Pi-Provisionierung](30010-alamos-apager.md#pi-provisionierung-ansible).
   Da Normal- und Fallback-Pfad dieselbe AMweb-Domain im selben
   Chromium-Profil verwenden, deckt dieser eine Login beide Pfade ab.

## Server-Fallback

Bewusster Bruch mit der sonst geltenden Regel "die echte AMweb-URL
verlässt nie den Cluster" ([docs/3-apps-workloads/30010-alamos-apager.md](30010-alamos-apager.md))
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
`argocd/apps/tech/alamos-apager`) läuft unverändert parallel und unabhängig
davon weiter — er braucht denselben `*.homeserver`-Pfad wie der Kiosk
selbst, ist also von derselben Split-DNS/Route-Voraussetzung abhängig.

## Periodischer Seiten-Neustart

**Hintergrund:** Am 2026-09-12 wurde ein echter Einsatzalarm auf diesem
Monitor nicht angezeigt. Die Nachanalyse (~4 Tage später) konnte den
Vorfall mangels Retention nicht mehr rekonstruieren (lokales `journalctl`
nur ~3,5 Tage, ntfy-Topic-Cache nur ~12h — Anlass für
[docs/3-apps-workloads/300j0-logging.md](300j0-logging.md)). Geprüft und
**ausgeschlossen** wurde dabei, dass sich die Standort-URL pro Alarm
ändert: `/start?station=...` löst serverseitig immer zur selben, fest im
SealedSecret hinterlegten AMweb-URL auf (siehe
[docs/3-apps-workloads/30010-alamos-apager.md](30010-alamos-apager.md)) —
neue Alarme sollen live innerhalb derselben, dauerhaft offenen
Chromium-Session erscheinen, nicht über einen neuen Redirect.

**Verbleibende Hypothese (nicht abschließend bestätigt):** Chromium bleibt
bis zu 24h ununterbrochen offen (bisher nur täglicher
`getty@tty1`-Neustart um 00:00, siehe
[Ansible-Provisionierung](#ansible-provisionierung)). Bleibt die Seite
äußerlich normal sichtbar, während ihre eigene In-Page-Live-Aktualisierung
(Websocket/Polling) lautlos hängen bleibt, greift **keiner** der
bestehenden Sicherheitsmechanismen: `alamos-apager` selbst bleibt
erreichbar (kein Fallback-Trigger), der Heartbeat-Timer läuft unabhängig
vom Seiteninhalt weiter (kein Down-Alarm), und es gibt keinen Login-Screen
(keine abgelaufene Session).

**Mitigation (Feature vorhanden, aktuell deaktiviert):** Der Supervisor
(`ansible/roles/banana_pi_kiosk/templates/banana-pi-kiosk-supervisor.sh.j2`)
kann Chromium zusätzlich alle `banana_pi_kiosk_periodic_refresh_seconds`
Sekunden neu starten (Rollen-Default in
`ansible/roles/banana_pi_kiosk/defaults/main.yml`) — unabhängig von
Fallback-Zustand und Crash-Erkennung, per `stop_chromium`/`start_chromium`
(gleiche Funktionen wie beim Fallback-Wechsel, also gleiches
Profil/gleiche Session, kein erneuter Login nötig). Der Timer wird bei
jedem Chromium-(Neu-)Start zurückgesetzt (auch bei Fallback-Wechsel oder
Crash-Recovery), es gibt also nie einen Neustart kurz nach einem anderen.

`banana_pi_kiosk_periodic_refresh_seconds: 0` deaktiviert das Feature
vollständig — das ist seit 2026-09-16 der Rollen-Default. Damit ist die
oben beschriebene Hypothese (stiller Hänger der In-Page-Live-Aktualisierung)
**wieder ungemindert**; bewusste Entscheidung gegen die störenden
periodischen Neustarts. Zum Reaktivieren einen Wert > 0 setzen, z. B.
`banana_pi_kiosk_periodic_refresh_seconds: 7200` (120 Minuten, der frühere
Default) in `ansible/host_vars/vereinsheim-alarmmonitor/`.

Loggt bei jedem periodischen Neustart eine Zeile über
`logger -t banana-pi-kiosk` (siehe
[docs/3-apps-workloads/300j0-logging.md](300j0-logging.md) für die
zentrale Abfrage über VictoriaLogs statt des kurz laufenden lokalen
Journals).

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
  → remote_write über https://vm-write.homeserver/api/v1/write
    (argocd/apps/tech/monitoring/templates/ingress-vm-write.yaml,
     nur /api/v1/write freigegeben, nicht die volle VM-API)
  → VictoriaMetrics im Cluster
```

Das nutzt denselben Netzwerkpfad (Split-DNS + Subnetz-Route), den der Kiosk
ohnehin schon braucht — kein zusätzliches Pod-zu-Tailscale-Routing nötig.
`vmagent` ist eine statische Binary (kein Debian-Paket verfügbar,
`vmutils-linux-arm-v*.tar.gz` vom GitHub-Release), puffert bei kurzzeitiger
Nichterreichbarkeit lokal (`-remoteWrite.tmpDataPath`) und holt das dann
nach.

Kein Dashboard-Change nötig — die Hardware-Dashboards (Ordner "Hardware",
[Hardware-Monitoring](../2-betrieb-hardware/20060-hardware-monitoring.md))
filtern dynamisch über das Label `host`; der Pi taucht automatisch auf, sobald
seine Metriken mit `host`/`kind` ankommen. Die Labels ergänzt VictoriaMetrics
beim Empfang (`argocd/apps/tech/monitoring/templates/configmap-vmsingle-relabel.yaml`),
die `vmagent`-Rolle (`ansible/roles/vmagent/templates/vmagent-scrape.yml.j2`)
setzt sie ab dem nächsten `make banana-pi-kiosks` zusätzlich selbst — ein
Ansible-Lauf gegen den Pi ist dafür nicht nötig. Zusätzlich hat der Pi (fest verdrahtet, nicht über `host`) eigene
Detail-Panels im Standort-Dashboard **"1002011-pis"**
(`argocd/apps/tech/monitoring/templates/dashboard-1002011-pis.yaml`,
ehemals "Vereinsheim-Alarmmonitor" — umbenannt, als die xibosignage-
Infotafel `infotafel` als zweites Gerät am selben Standort dazukam, siehe
[docs/3-apps-workloads/300e0-xibosignage.md, "Monitoring (Grafana)"](300e0-xibosignage.md#monitoring-grafana)).

## Zammad-Ticket via n8n

**Nur für diesen Standort** — die Raspberry-Pi-Alarmmonitore erzeugen
weiterhin bewusst **kein** Ticket pro Ausfall (nur ntfy, siehe
[docs/3-apps-workloads/30010-alamos-apager.md](30010-alamos-apager.md)); das bleibt unverändert.

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
    (argocd/apps/tech/monitoring/values.yaml)
  → n8n-Webhook https://n8n.homeserver/webhook/banana-pi-down
  → Workflow "Banana-Pi-Down -> Zammad-Ticket"
    (argocd/apps/tech/n8n/workflows/banana-pi-down-to-zammad.json):
      1. letzte bekannte CPU/RAM/Temperatur-Werte aus VictoriaMetrics holen
         (der Pi selbst ist ja gerade nicht erreichbar — das sind KEINE
         Live-Daten, sondern der letzte Stand vor dem Ausfall)
      2. Zeitstempel der letzten erfolgreichen /start-Anfrage holen (=
         wann hat der Kiosk zuletzt die echte AMweb-URL angefragt) —
         kommt NICHT vom Pi, sondern von alamos-apager selbst
         (`/metrics`, siehe docs/3-apps-workloads/30010-alamos-apager.md), das immer im
         Cluster läuft und daher unabhängig vom Tailscale-Status des Pi
         abfragbar ist
      3. Zammad-Ticket erstellen (POST /api/v1/tickets, gleiches Muster
         wie argocd/apps/tech/github-release-watcher)
  → Zammads eigene Agenten-Benachrichtigung verschickt die Mail an
    info@edv-kretzer.de (kein separater E-Mail-Node in n8n nötig)
```

Die bestehenden gotify-/ntfy-Routen bleiben für diesen Alert (und alle
anderen) unverändert bestehen — die n8n-Route kommt rein additiv dazu
(`continue: true`, siehe Kommentar in `values.yaml`).

**Achtung, Bedeutung des Werts:** Der Zeitstempel der letzten `/start`-Anfrage
ist ein *Browser-Start*-Marker, kein Lebenszeichen. `/start` wird nur
aufgerufen, wenn Chromium (neu) startet (Reboot, Absturz, Fallback-Wechsel);
danach hält der Browser die AMweb-Seite dauerhaft offen. Ein Wert von
10 h oder mehr ist daher normal und wächst bis zum nächsten Neustart. Im
Dashboard "1002011-pis" heißt das Panel deshalb "Letzter Browser-Start"
(neutral blau, ohne Alarmfarbe); massgeblich für "lebt der Monitor" ist das
Panel "Letztes Lebenszeichen (Heartbeat)" (grün < 2 min, gelb ab 2 min, rot
ab 5 min). Im Zammad-Ticket-Workflow unten steht dieser Wert ebenfalls unter
der Bezeichnung "Letzte AMweb-Anfrage" — gemeint ist dort der letzte
Browser-Start.

**Woher "letzte AMweb-Anfrage" kommt:** `alamos-apager` (die geteilte
Cluster-Komponente aus [docs/3-apps-workloads/30010-alamos-apager.md](30010-alamos-apager.md))
merkt sich jetzt zusätzlich zum Heartbeat auch den Zeitstempel jeder
erfolgreichen `/start`-Anfrage (also wann der Kiosk-Browser zuletzt
tatsächlich die echte AMweb-URL angefragt hat) und exportiert das über
einen eigenen `/metrics`-Endpunkt (`alamos_apager_last_start_timestamp_seconds`,
siehe `argocd/apps/tech/alamos-apager/templates/configmap-script.yaml` +
`vmservicescrape.yaml`). Das läuft cluster-intern und ist damit — anders
als die node_exporter-Metriken des Pi selbst — auch dann abfragbar, wenn
der Pi/Tailscale gerade down ist. Betrifft alle Alamos-Standorte
gleichermaßen, nicht nur diesen.

**Einmalige manuelle Schritte:**

1. **Zammad:** `info@edv-kretzer.de` als Agent-Account anlegen (falls noch
   nicht vorhanden), Mitglied der Ticket-Gruppe (Default im Workflow:
   `Support::Administration` — angenommen als Untergruppe "Administration"
   von "Support", `::` ist der von der Zammad-API erwartete Trenner für
   Untergruppen, siehe docs/f-cicd-automatisierung/f0040-github-release-watcher.md; falls es
   stattdessen eine einzelne Gruppe mit dem wörtlichen Namen
   "Support / Administration" ist, im Code-Node "Ticket-Payload bauen"
   entsprechend anpassen) machen und unter **Profil → Benachrichtigungen**
   die Mail-Benachrichtigung
   für "Neues Ticket" aktivieren (Zammad-Standard: aktiviert). Gleiches
   Prinzip wie [docs/f-cicd-automatisierung/f0040-github-release-watcher.md, Schritt 4](../f-cicd-automatisierung/f0040-github-release-watcher.md#schritt-4--agenten-benachrichtigung-in-zammad-prüfen).
2. **Zammad-API-Token erzeugen:** Profil → Token Access → Neuer Token,
   Berechtigung `ticket.agent` (siehe
   [docs/f-cicd-automatisierung/f0040-github-release-watcher.md, Schritt 1](../f-cicd-automatisierung/f0040-github-release-watcher.md#schritt-1--zammad-api-token-erzeugen)
   für die genauen Klicks).
3. **n8n:** Workflow `banana-pi-down-to-zammad.json` importieren, dann im
   Node "Zammad-Ticket erstellen" eine Header-Auth-Credential anlegen/
   zuweisen (Name z. B. "Zammad API Token", Header-Name `Authorization`,
   Value `Token token=<ZAMMAD_TOKEN>` aus Schritt 2) — Credential-IDs
   werden beim Import nicht mit übernommen, das ist ein normaler
   Post-Import-Schritt.
4. Workflow in n8n aktivieren (`active: true` in der UI).

## Sichtprüfung ohne physischen Zugriff

Für dieses Gerät ist bewusst **kein** dauerhafter Remote-Zugriff (VNC o. Ä.)
eingerichtet — anders als bei den Hardware-Checks über `journalctl`/`ps`
lässt sich die *visuelle* Korrektheit der Anzeige damit nicht automatisiert
prüfen. Stattdessen ein On-Demand-Screenshot-Skript
(`ansible/roles/banana_pi_kiosk/templates/banana-pi-screenshot.sh.j2`), das
nur bei Bedarf per SSH läuft — kein Timer, kein dauerhaft offener Port:

```bash
ssh pela@vereinsheim-alarmmonitor banana-pi-screenshot.sh
scp pela@vereinsheim-alarmmonitor:/home/pela/kiosk-screenshot.png .
```

Nutzt `scrot` gegen `DISPLAY=:0` (die X-Session des Kiosk-Users) und
überschreibt bei jedem Aufruf dieselbe Datei.

## Wake-on-LAN für den Windows-PC

Ein Windows-PC hängt per LAN am selben Router/Repeater wie dieser Pi.
Semaphore/n8n können ihn nicht direkt aufwecken (kein Pfad zu
Tailscale-Peers, siehe oben) — stattdessen verschickt der Pi selbst das
Magic Packet lokal ins Standort-LAN, ausgelöst manuell per SSH von jeder
Tailnet-Maschine, analog zum Screenshot-Skript unten:

```bash
ssh pela@vereinsheim-alarmmonitor banana-pi-wol.sh windows-pc
```

MAC-Adressen-Tabelle: `ansible/host_vars/vereinsheim-alarmmonitor/vars.yml`
(`banana_pi_kiosk_wol_devices`, Alias → MAC). Rollen-Implementierung:
`ansible/roles/banana_pi_kiosk/templates/banana-pi-wol.sh.j2` +
`ansible/roles/banana_pi_kiosk/tasks/main.yml` (Kill-switch
`banana_pi_kiosk_wol_enabled`).

**Voraussetzungen (einmalig, nicht per Ansible automatisierbar):**

- Auf dem PC: WoL im BIOS/UEFI aktivieren, NIC-Eigenschaften → "Wake on
  Magic Packet" aktivieren, **Windows-Schnellstart deaktivieren** (sonst
  wird beim "Herunterfahren" nur hybrid-hibernated, NIC bleibt nicht
  empfangsbereit).
- Pi und PC müssen im selben L2-Segment/Subnetz hängen (`ip a` auf dem Pi
  vs. IP des PCs vergleichen) — sonst kommt der Broadcast nicht an.
- Client-/AP-Isolation im Router-/Repeater-WebUI muss deaktiviert sein,
  sonst wird jede Geräte-zu-Geräte-Kommunikation (auch der Broadcast)
  geräuschlos verworfen, obwohl beide im selben Netz hängen.

Architektur-Hintergrund und der geplante Router-VPN-Fallback (für den
Fall, dass der Pi selbst nicht erreichbar ist) stehen in
[docs/4-planung/40020-vereinsheim-wol-router-vpn.md](../4-planung/40020-vereinsheim-wol-router-vpn.md).

### iOS-App

Die "Homeserver Dashboard"-App hat im Tab "Steuerung" einen eigenen
"Aufwecken"-Button für den Windows-PC. Anders als bei worker-0/worker-1
läuft das **nicht** über carplay-api (der Cluster-Pod hat keinen Pfad zu
Tailscale-Peers) — die App spricht stattdessen einen kleinen HTTP-Agenten
(`banana-pi-wol-agent`, Teil der `banana_pi_kiosk`-Rolle) direkt über die
Tailscale-IP des Pi an, Port 9102, Bearer-Token-gesichert. Der Agent ruft
intern nur `banana-pi-wol.sh` auf — keine doppelte MAC-Verwaltung.

Token für die App-Einstellungen auslesen:

```bash
ssh pela@vereinsheim-alarmmonitor sudo cat /etc/banana-pi-wol-agent/token
```

In der App: Zahnrad-Symbol → "Vereinsheim-WoL-Agent-Token" → einfügen →
"In Keychain speichern".

Bewusster Kompromiss mit dem sonst geltenden Prinzip "kein dauerhaft
offener Port" auf diesem Pi — Details und Begründung in
[docs/4-planung/40020-vereinsheim-wol-router-vpn.md](../4-planung/40020-vereinsheim-wol-router-vpn.md).
Kill-switch: `banana_pi_kiosk_wol_agent_enabled: false` (behält nur den
SSH-Weg).

Online-Status prüfen und den PC wieder herunterfahren: siehe
[docs/3-apps-workloads/30021-vereinsheim-windows-pc-steuerung.md](30021-vereinsheim-windows-pc-steuerung.md).

## Fehlerbehebung

| Symptom | Check |
|---|---|
| `make banana-pi-kiosks` erreicht den Pi nicht mehr | Phase 1 vs. Phase 2? `ansible_host` in `ansible/inventory/hosts.yml` noch auf der alten LAN-IP, obwohl der Pi schon umgezogen ist? |
| Kiosk zeigt weder Redirect noch Fallback (Chromium-Fehlerseite) | `nslookup alamos-apager.homeserver` auf dem Pi — löst das auf? Tailscale Split-DNS eingerichtet (siehe oben)? |
| DNS löst auf, aber Verbindung timeout | Subnetz-Route `192.168.178.0/24` im Tailscale-Adminpanel genehmigt? `tailscale_accept_routes: true` beim Pi angekommen (`tailscale status` auf dem Pi prüfen)? |
| Pi taucht nicht in Grafana auf | `systemctl status vmagent` auf dem Pi, `journalctl -u vmagent` — Fehler beim remote_write? `curl -I https://vm-write.homeserver/api/v1/write` vom Pi aus erreichbar? |
| Kiosk startet nicht / schwarzer Bildschirm | `systemctl status getty@tty1` auf dem Pi, Autologin aktiv? Läuft `startx`? |
| Fallback schaltet nicht um | `journalctl -t banana-pi-kiosk` auf dem Pi (Supervisor loggt Moduswechsel) |
| Fallback zeigt AMweb-Login statt Alarmmonitor | Chromium-Session abgelaufen — einmaligen manuellen Login wiederholen (siehe oben) |
| Dashboard zeigt "Letzter Browser-Start" vor > 10 h | Normal: `/start` kommt nur bei Chromium-Start (siehe Hinweis im Abschnitt Zammad-Ticket). Lebenszeichen prüfen: Panel "Letztes Lebenszeichen (Heartbeat)" bzw. `alamos_apager_last_heartbeat_timestamp_seconds` |
| Alert `BananaPiAlarmmonitorDown` feuert, obwohl der Pi läuft (Ausfall 18.–19.09.2026, ~37 h) | Pfad Pi → Cluster prüfen, nicht den Pi selbst: `journalctl -u tailscaled` auf dem Homeserver nach `Drop: TCP{100.123.214.4 …} no rules matched` (Tailscale-ACL/Subnetz-Route für `192.168.178.0/24`). Metriken werden vom vmagent nachgeliefert, der Verlauf sieht danach lückenlos aus, der Alarm feuerte aber in Echtzeit |
| Kein Zammad-Ticket trotz 10+ Minuten Ausfall | `kubectl -n monitoring get vmrule banana-pi-availability` (Alert "firing"?), Alertmanager-Route korrekt? n8n-Workflow aktiv? |
| Ticket erstellt, aber keine Mail | Zammad-Agent-Mitgliedschaft/Benachrichtigung prüfen (siehe oben), ausgehender E-Mail-Kanal in Zammad konfiguriert? |
| n8n-Workflow schlägt am Zammad-Node fehl | Header-Auth-Credential zugewiesen? Token gültig/`ticket.agent`-Berechtigung? |
| `banana-pi-wol.sh` läuft durch, PC wacht trotzdem nicht auf | WoL im BIOS/NIC des PCs aktiv? Windows-Schnellstart deaktiviert? Client-/AP-Isolation im Router/Repeater aktiv? Pi und PC wirklich im selben Subnetz (`ip a`)? |
| iOS-App: "Aufwecken" bei Windows-PC schlägt fehl (401) | Token in der App aktuell? Neu auslesen: `ssh pela@vereinsheim-alarmmonitor sudo cat /etc/banana-pi-wol-agent/token` |
| iOS-App: "Aufwecken" bei Windows-PC ohne Antwort/Timeout | Tailscale auf dem Handy aktiv? `systemctl status banana-pi-wol-agent` auf dem Pi — läuft der Dienst? `curl -X POST http://100.123.214.4:9102/wol -H "Authorization: Bearer <token>" -d '{"target":"windows-pc"}'` von einer Tailnet-Maschine zum Gegenchecken |
| Nachträgliche Analyse eines Vorfalls (z. B. "Alarm wurde nicht angezeigt") — lokales `journalctl` reicht nicht mehr zurück | Journal auf dem Pi ist auf ~3,5 Tage begrenzt (täglicher Reboot + 20-MB-Limit) — stattdessen Grafana/VictoriaLogs abfragen (Retention 14 Tage), siehe [docs/3-apps-workloads/300j0-logging.md](300j0-logging.md) |
| Prüfen, ob der periodische Chromium-Neustart läuft (nur relevant, falls wieder aktiviert) | `journalctl -t banana-pi-kiosk` auf dem Pi bzw. in VictoriaLogs nach `periodischer Neustart` filtern (siehe [Periodischer Seiten-Neustart](#periodischer-seiten-neustart)) |

## Relevante Links

- [docs/3-apps-workloads/30010-alamos-apager.md](30010-alamos-apager.md) — Basis-Architektur (Raspberry-Pi-Flotte)
- [docs/3-apps-workloads/30021-vereinsheim-windows-pc-steuerung.md](30021-vereinsheim-windows-pc-steuerung.md) — Windows-PC: Online-Check & Herunterfahren
- [docs/b-kubernetes-gitops/b0030-semaphore.md](../b-kubernetes-gitops/b0030-semaphore.md) — Tailscale Split-DNS-Setup
- [docs/c-netzwerk-dns/c0000-dns-architecture.md](../c-netzwerk-dns/c0000-dns-architecture.md) — `*.homeserver`-Auflösung
- [docs/c-netzwerk-dns/c0010-tailscale.md](../c-netzwerk-dns/c0010-tailscale.md) — Tailscale-Grundlagen
- [docs/3-apps-workloads/30000-zammad.md](30000-zammad.md) — Zammad-Setup
- [docs/f-cicd-automatisierung/f0040-github-release-watcher.md](../f-cicd-automatisierung/f0040-github-release-watcher.md) — Zammad-API-Ticket-Muster
- [docs/3-apps-workloads/30070-n8n.md](30070-n8n.md) — n8n-Setup
- [docs/2-betrieb-hardware/20000-nas-storage.md](../2-betrieb-hardware/20000-nas-storage.md) — VMStaticScrape-Muster (ugreen-nas, Pull-Vergleichsfall)
- [docs/4-planung/40020-vereinsheim-wol-router-vpn.md](../4-planung/40020-vereinsheim-wol-router-vpn.md) — Architektur-Plan Wake-on-LAN + Router-VPN-Fallback
- [docs/3-apps-workloads/300j0-logging.md](300j0-logging.md) — zentrales Logging (VictoriaLogs), löst die kurze lokale Journal-Retention dieses Pi ab
- [Armbian — Banana Pi M2 Ultra](https://armbian.com/boards/bananapim2ultra)
- [VictoriaMetrics vmagent](https://docs.victoriametrics.com/victoriametrics/vmagent/)
