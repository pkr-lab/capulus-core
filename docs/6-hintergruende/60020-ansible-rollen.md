# Ansible: Rollen — Hintergründe

Begründungen zu den Rollen unter `ansible/roles/`, geordnet nach Rolle. Hosts, VMs, Playbook-Reihenfolge und die Rolle
`libvirt_host` stehen in [60010](60010-ansible-hosts-und-playbooks.md). Die Rolle `argocd` steht in
[60030](60030-argocd-und-bootstrap.md). Bedienung der Geräte: [30010](../3-apps-workloads/30010-alamos-apager.md),
[30020](../3-apps-workloads/30020-vereinsheim-alarmmonitor.md), [300e0](../3-apps-workloads/300e0-xibosignage.md).

---

## Kiosk-Geräte

### alamos_kiosk (Raspberry Pi)

- Der Pi ist ein **reines Display**: Chromium zeigt die Redirect-URL des Clusters (`argocd/apps/tech/alamos-apager`). Die echte
  AMweb-URL und die gesamte Heartbeat-/Alerting-Logik bleiben im Cluster, der Pi kennt nur seinen Stationsnamen. Ein
  systemd-Timer pingt den Heartbeat-Endpunkt, damit ein Ausfall zentral per ntfy erkannt wird.
- Chromium startet **bewusst ohne `--incognito`**. AMweb verlangt beim Laden ein Passwort plus Verschlüsselungspasswort (Formular auf
  der Seite, kein Basic-Auth) und lässt sich nicht automatisch einloggen. Ohne `--incognito` bleibt die Session (Cookies,
  LocalStorage) über Neustarts erhalten, der Login ist nur einmal manuell am Pi nötig ([30010](../3-apps-workloads/30010-alamos-apager.md),
  „Pi-Provisionierung“).
- Bildschirmschoner und Energiesparen sind deaktiviert, sonst dunkelt der Alarmmonitor nach Inaktivität ab.
- Autologin richtet die Rolle nicht ein, das erledigt der Imaging-Schritt (Raspberry Pi Imager, „Enable autologin“).

### banana_pi_kiosk (Vereinsheim-Alarmmonitor)

Wie `alamos_kiosk`, aber für Armbian/Debian: anderer Chromium-Paketname, kein Imager-Schalter für Autologin (die Rolle bildet ihn
mit getty-Drop-in, `.bash_profile` und `startx` nach) und ein lokaler **Failover-Supervisor**, der bei Nichterreichbarkeit von
alamos-apager auf eine lokal hinterlegte, vault-verschlüsselte Fallback-URL umschaltet.

| Stelle | Begründung |
|---|---|
| Supervisor startet immer im Normalbetrieb | Die erste Prüfung im Loop korrigiert das innerhalb von `POLL_SECONDS × FAIL_THRESHOLD`, falls der Cluster beim Boot des Pi schon nicht erreichbar ist. |
| Supervisor startet Chromium neu, wenn es abgestürzt ist | Im aktuellen Modus, ohne auf die nächste Zustandsänderung zu warten. |
| Periodischer Neustart (`REFRESH_SECONDS`, `0` deaktiviert) | Sicherheitsnetz gegen eine lautlos hängengebliebene In-Page-Live-Aktualisierung. |
| Heartbeat-Skript ist eine Kopie des Skripts aus `alamos_kiosk` | Ansible-Rollen teilen ihr `files/`-Verzeichnis nicht. Schlägt der Request fehl (Cluster/DNS kurz weg), passiert nichts weiter: Der lokale Supervisor kümmert sich unabhängig um die Browser-Umschaltung, der Timer steuert **nur** den zentralen ntfy-Ausfall-Alarm. |
| Täglicher Neustart startet nur die **tty1-Session** (getty → startx → X/openbox/Chromium), **kein** `reboot` | Auf dem Banana Pi M2 Ultra (Armbian „Community Supported“) ist der Warm-Reset-Pfad unzuverlässig: Der Pi blieb nach einem echten Reboot einmal komplett aus und war nur per physischem Stromzyklus wieder erreichbar. Das Vereinsheim hängt nur per Tailscale dran, ohne LAN-Fallback. Der Session-Neustart räumt Chromium-Zustand und Speicher genauso auf, ohne das Kernel-/Firmware-Risiko. |
| Timer **ohne** `Persistent=true` | Er soll nur zur geplanten Uhrzeit auslösen und nicht nachholen, falls der Pi da gerade aus war (sonst würde er direkt beim nächsten Hochfahren erneut neu starten). |
| `make banana-pi-kiosks-restart-session` | Der Handler „Reload getty@tty1“ läuft nur bei Ansible-`changed`. Liegt das Skript schon korrekt auf der Platte (z. B. weil ein früherer Lauf es geschrieben hat, bevor der `notify` existierte), meldet der Task `ok`, und der längst laufende Prozess bleibt mit veralteten Werten (z. B. `BASE_URL`) im Speicher, weil er sich nicht selbst neu einliest. Das Target erzwingt den Neustart unabhängig von einem Playbook-Diff und braucht kein Vault-Passwort, da der Ad-hoc-Befehl keine verschlüsselten Variablen referenziert. |
| Screenshot-Skript nur manuell per SSH, kein Timer/Dienst (kein x11vnc, kein Cron) | Nur für die Sichtprüfung ([30020](../3-apps-workloads/30020-vereinsheim-alarmmonitor.md), „Sichtprüfung ohne physischen Zugriff“). Läuft als Kiosk-User (gleicher User wie die X-Session auf `:0`), daher kein `XAUTHORITY`-Handling. |
| Wake-on-LAN-Skript nur manuell per SSH | Der Pi ist per Tailscale erreichbar (Semaphore und n8n haben **keinen** Pfad zu Tailscale-Peers), broadcastet das Magic Packet aber lokal. Das funktioniert nur, wenn Zielgerät und Pi im selben L2-Segment hängen (keine Client-/AP-Isolation im Router oder Repeater). |
| WoL-HTTP-Agent (`banana-pi-wol-agent.py`) direkt am Pi | Dünner HTTP-Wrapper um `banana-pi-wol.sh`, damit die iOS-App ein Magic Packet ins Standort-LAN auslösen kann. Er spiegelt strukturell `power-agent.py`, ist aber sonst unabhängig: Der power-agent läuft im LAN des Homeservers und wird vom carplay-api-Pod gerufen, dieser hier läuft im reinen Tailscale-Netz des Pi und wird **direkt** von der App gerufen, weil der carplay-api-Pod keine Route zu Tailscale-Peers hat ([40020](../4-planung/40020-vereinsheim-wol-router-vpn.md)). Er kennt keine MACs, Gültigkeit des Ziels und MAC-Lookup bleiben in `banana-pi-wol.sh` / `banana_pi_kiosk_wol_devices`, er reicht nur den Alias weiter. |

### xibo_kiosk (Raspberry Pi 3 B+, Bilder-Slideshow)

Kein echter Xibo-Player, denn Xibo unterstützt den Raspberry Pi nicht offiziell ([300e0](../3-apps-workloads/300e0-xibosignage.md)).
Stattdessen mountet der Pi den NFS-Ordner `xibosignage-display` read-only, ein winziger lokaler Python-Webserver liefert eine
statische Slideshow-Seite aus, und Chromium zeigt sie im Kiosk-Modus.

- Server und Pfad des NFS-Ordners **müssen identisch** zu `argocd/apps/tech/n8n/values.yaml` → `xibosignage.display` sein: n8n
  schreibt dorthin, der Pi liest read-only. Das Scan-Intervall des Manifest-Generators bestimmt die Verzögerung, mit der ein neues Bild
  in der Slideshow auftaucht.
- **Idempotenz beim NFS-Mount:** War der Mount aus einem früheren (ggf. abgebrochenen) Lauf noch aktiv, blockt der read-only
  NFS-Export `chown`/`chmod` im nächsten Task („Das Dateisystem ist nur lesbar“), weil dann die Attribute des Exports statt des lokalen
  Verzeichnisses gelten. Deshalb wird das Mountpoint-Verzeichnis nur angefasst, solange nichts gemountet ist.
- Der Kiosk-Browser läuft in der grafischen Session (`DISPLAY=:0`) von `xibo_kiosk_user`. Autologin für diesen User muss schon eingerichtet
  sein (Raspberry Pi Imager, „Enable autologin“), die Rolle richtet es nicht ein (wie bei `alamos_kiosk`).
- Chromium startet hier **mit** `--incognito`: Die Slideshow braucht keine Anmeldung, es gibt keinen Login-Zustand zu erhalten.
- Das Start-Skript wartet **unbegrenzt**, bis der lokale Webserver antwortet. Startet Chromium blind, landet es auf seiner eigenen
  Fehlerseite „nicht erreichbar“, die sich nie von selbst neu lädt (nur per manuellem F5). Ein Timeout würde denselben kaputten
  Zustand erzeugen, ein Neustart des Skripts holt das dank `Restart=always`/`RestartSec=5` ohnehin nach.
- Das Skript unterstützt die Binärnamen `chromium-browser` **und** `chromium`: Debian Bookworm hat das Binary umbenannt, das
  Paket `chromium-browser` existiert nur noch als Übergangspaket ohne Binary dieses Namens. So läuft es auf Bullseye- wie Bookworm-Pis.
- Die Manifest-Unit hat **kein** `After=…mount`, weil sich der Mount-Unit-Name aus dem Pfad nicht zuverlässig ableiten lässt
  (`systemd-escape`-Regeln). Das Skript ist stattdessen tolerant: Fehlt der Mount kurz, liefert `find` nichts und die `manifest.json`
  wird leer geschrieben, der nächste Timer-Lauf holt das nach. `slideshow.js` überspringt ein nicht lesbares Manifest oder eine
  zwischen Scan und Anzeige verschwundene Datei einfach, das nächste Bild kommt beim nächsten Tick.
- Der Webserver liefert die statische Seite **und** über den Symlink `media` im Webroot die Bilder aus dem NFS-Ordner. Er ist nur
  auf `localhost` gebunden: Der Kiosk-Chromium auf demselben Pi ist der einzige Client.

---

## Energie und Schutz der Hardware

### cluster_power_manager, cluster_power_manager_target und wake_on_lan

- `cluster_power_manager` läuft auf dem Homeserver und erzeugt das SSH-Schlüsselpaar, mit dem der Watchdog die Worker
  herunterfährt. Autorisiert wird der Public Key erst durch `cluster_power_manager_target` auf den Workern. Das Playbook mit
  `cluster_power_manager` muss also **vor** den Worker-Playbooks laufen.
- Der Key ist per **forced-command auf `sudo poweroff`** beschränkt. Anders als der Semaphore-Key kann er nichts anderes ausführen,
  selbst wenn das private Schlüsselmaterial je abfließt.
- **Bootstrap im Skript:** Ist ein Worker beim (Neu-)Start des Skripts schon erreichbar (Homeserver-Reboot, manueller Wake,
  State-Datei gelöscht), aber es existiert keine `woke_at`-Datei, wäre das `MIN_UPTIME_SECONDS`-Gate in `shutdown_worker()` nie
  erfüllt (`woke_at=0`), und der Worker würde nie mehr automatisch heruntergefahren. Der Zeitstempel wird deshalb beim Start
  gesetzt, die Mindestlaufzeit zählt ab da.
- Die Worker-Liste (`cluster_power_manager_workers`) gibt die **Weck-Reihenfolge** vor, das Herunterfahren läuft in umgekehrter Reihenfolge. `nightly_worker_wake` führt
  eine identische Liste. Hochskalieren (Homeserver überlastet → Worker wecken) und Herunterskalieren (Last wieder niedrig → Worker ausschalten) haben getrennte Schwellen,
  dazu kommt eine Wartezeit auf „Ready“ nach dem WoL und ein SSH-Zugang für den ferngesteuerten Poweroff.
- `wake_on_lan` setzt `ethtool wol g` bei **jedem** Boot: Die meisten NIC-Treiber vergessen „Wake-on-LAN: enabled“ nach einem
  Kaltstart. Das BIOS/UEFI sorgt nur dafür, dass die NIC im ausgeschalteten Zustand Strom bekommt, der Magic-Packet-Modus wird vom
  Linux-Treiber beim Boot zurückgesetzt. Voraussetzung ist WoL im BIOS/UEFI (je nach Hersteller „Power On by PCI-E/PCIE“,
  „Wake on LAN“ o. ä.), das kann Ansible nicht setzen und ist einmalig manuell zu prüfen. Das Interface ist im Default das der
  Default-Route, auf worker-0/worker-1 stimmt das, weil nur eine NIC aktiv ist.

### nightly_worker_wake und worker_apt_update

- `nightly_worker_wake` (01:00 Uhr) löst per n8n-Trigger den Zyklus aus und ersetzt einen früheren systemd-Timer. Es weckt den
  Worker per WoL, lässt Semaphore das Template „Deploy worker-*“ laufen (enthält `worker_apt_update`) und fährt den Worker wieder
  herunter. Die Service-Unit hat ein verlängertes Timeout, weil Playbook-Läufe über Semaphore je nach Paketlage mehrere Minuten
  dauern, deutlich über dem systemd-Default von 90 s für `Type=oneshot`.
- `nightly_worker_wake_semaphore_api_base` **muss** zu `semaphore_api_base` der Rolle `semaphore_bootstrap` passen (HTTPS, siehe unten).
- `worker_apt_update` deckt nur das apt-Update ab, weil die Worker reine k3s-Compute-Nodes **ohne** die volle `common`-Rolle sind.
  Der k3s-Node-Name für `cordon`/`drain` muss zu `k3s_agent_hostname` passen (derselbe Node), das kubeconfig stimmt mit dem von
  `cluster_power_manager` überein.
- Der **automatische Reboot** bei Kernel-/libc-Updates läuft im selben Semaphore-Task, den `nightly_worker_wake` ohnehin bis zu
  `nightly_worker_wake_max_runtime_seconds` abwartet, ein eigener Schritt im Orchestrator-Skript ist nicht nötig. `cordon`+`drain`
  laufen **vor** dem Reboot, damit Pods sauber evakuiert werden statt beim harten Neustart abzureißen. Das Uncordon übernimmt die
  Play „Uncordon nach Provisioning“ am Ende von `worker-0.yml`/`worker-1.yml`, die immer läuft.
  `worker_apt_update_reboot_timeout_seconds` (300) gilt für den Neustart samt erneuter Erreichbarkeit und für die Wartezeit danach, bis
  sich k3s-Agent und Netzwerk gesetzt haben.

### power_agent

Privilegierter HTTP-Agent auf dem Homeserver-Host, **nicht** im Cluster. Er erledigt, was der carplay-api-Pod bewusst nicht darf:
Bildschirmhelligkeit (sysfs), manuelles Wake-on-LAN und Poweroff für worker-0/worker-1 sowie den eigenen Poweroff des Homeservers.

- Er steht im Playbook **nach** `cluster_power_manager` und nutzt dessen SSH-Key, kubeconfig, State-Verzeichnis und Worker-Liste. So
  teilen manuelle Aktionen aus der App und der automatische Last-Watchdog dieselbe Buchführung (`woke_at`-Dateien), statt sich zu
  widersprechen.
- UFW braucht **keine** neue Regel: „Allow all traffic from k3s pod CIDR“ (Rolle `common`) deckt Pod → Host ab, unabhängig davon, auf
  welchem Node der carplay-api-Pod läuft (Flannel-Overlay). Von außerhalb des Clusters ist Port 9101 dadurch **nicht** erreichbar,
  und das ist gewollt.

### thermal_watchdog und resource_watchdog

- Der `thermal_watchdog` liest `/sys/class/hwmon` **direkt** (ohne Prometheus/k8s) und fährt den Host herunter, wenn der heißeste
  Sensor `THRESHOLD_C` für `SUSTAIN_SECONDS` erreicht (90 s = Mitte der gewünschten 1–2 Minuten), vorher geht eine ntfy-Meldung raus.
  Er läuft bewusst **unabhängig vom Cluster**, damit der Schutz auch greift, wenn der Cluster wegen der Hitze schon klemmt. Er
  ergänzt den Alert ab 80 °C ([60060](60060-monitoring-und-alerting.md)).
- Die ntfy-Meldung wird per `curl --resolve` direkt auf die statische Server-IP aufgelöst, damit sie auch rausgeht, wenn auf dem
  Host kein `*.homeserver`-DNS eingerichtet ist.
- `DRY_RUN=1` (z. B. `systemctl edit --runtime thermal-watchdog`) testet den kompletten Pfad Erkennung → Meldung, ohne auszuschalten.
- Der `resource_watchdog` ist das Gegenstück für CPU/RAM (Schwelle 90 %): Ist `WARN_THRESHOLD` leer, entfällt die Vorwarnstufe.
  Auch diese Schwelle läuft **nicht** über Alertmanager, sondern lokal.
- Mehrere Rollen haben einen Kill-Switch (`*_enabled: false`, z. B. in `host_vars`), um sie auf einem Host abzuschalten, ohne die
  Rolle aus dem Playbook zu nehmen: `thermal_watchdog`, `vmagent`, `node_exporter`, `smartctl_exporter`, `wake_on_lan`,
  `worker_apt_update`, `alamos_kiosk` und `xibo_kiosk`.

---

## Metriken, Logs und Zugang

### vmagent, node_exporter und smartctl_exporter

- **Metriken-Push für Tailscale-only-Hosts** (Vereinsheim-Pi): Der Cluster kann sie nicht scrapen, weil Pods keinen Pfad zu
  Tailscale-Peers haben (kein Subnet-Router ins Pod-Netz). Deshalb installiert die Rolle `vmagent` als statische Binary (es gibt kein
  Debian-Paket), scrapt lokal `node_exporter` und pusht per `remote_write` an
  `argocd/apps/tech/monitoring/templates/ingress-vm-write.yaml`. `-remoteWrite.tmpDataPath` puffert lokal, falls das Ziel kurz
  nicht erreichbar ist: Nichts geht verloren, es wird nur verzögert zugestellt.
- **`vmagent_remote_write_url` hat keinen Default**, damit ein fehlender Wert laut auffällt, und **muss `https://` sein**: Der
  TECH-Traefik leitet HTTP global per 308 um. Mit `http://` macht vmagent jeden Push in zwei Etappen, und die erste (Port 80) hängt
  bei Bodies ab ~12 KB bis zum Timeout (gemessen vom Pi am 26.09.2026: 20 KB über HTTP 9–40 s oder Timeout, über HTTPS direkt ~1 s;
  die vmagent-Blöcke sind ~20 KB groß). Gleiches Muster wie bei `journal_upload_push_url`.
- **`vmagent_remote_write_queues: 1`**: Der vmagent-Default ist 2× CPU-Kerne (Banana Pi: 8). Im Normalbetrieb sind es nur ~1 KB/s
  (ein `node_exporter`-Scrape alle 30 s). Beim Nachliefern eines Backlogs (Stunden Ausfall) schicken 8 Queues aber gleichzeitig
  Requests, die serverseitig je einen Insert-Slot von VictoriaMetrics halten (Default dort: 2) und so u. a. `vmalert` aussperren.
  Eine Queue reicht für diese Datenmenge (siehe auch `maxConcurrentInserts` in [60060](60060-monitoring-und-alerting.md)).
- Die Binary kommt aus den GitHub-Releases von VictoriaMetrics, das Asset heißt `vmutils-linux-{arch}-v{version}.tar.gz`.
- Der Banana Pi M2 Ultra (Allwinner R40, Cortex-A7) ist reines ARMv7/32-Bit (kein aarch64), deshalb `vmagent_arch: arm`, nicht
  `arm64`. Der Installationspfad ist versioniert (`/opt/vmagent-<version>`) statt fix unter `/usr/local/bin`: Ein Versions-Bump legt
  ein neues Verzeichnis an, statt eine möglicherweise noch laufende Binary zu überschreiben.
- `node_exporter` gibt es als Rolle nur für Hosts **außerhalb** des k3s-Clusters. Cluster-Mitglieder bekommen ihn per DaemonSet aus
  dem Chart `victoria-metrics-k8s-stack`. Der Port steht nirgends in der Rolle: Exporter und Scrape nutzen den Default `9100`
  (`vmagent_node_exporter_port` für den lokalen Scrape).
- `smartctl_exporter` nur für Hosts **mit** echter Hardware (homeserver, worker-0, worker-1): Die KVM-VMs sehen nur virtuelle
  virtio-Platten ohne SMART, das NAS hat seinen eigenen Docker-Exporter. Der Exporter läuft als root (Zugriff auf `/dev/sd*`,
  `/dev/nvme*`) und scannt alle Platten selbst (`smartctl --scan`). Er lauscht auf dem Default-Port `9633` des Ubuntu-Pakets
  `prometheus-smartctl-exporter`, der Cluster scrapt ihn per `VMStaticScrape`.

### journal_upload

- **HTTPS und Port sind Pflicht**, siehe [300j0](../3-apps-workloads/300j0-logging.md). Der TECH-Traefik leitet HTTP per 308 um, und
  `systemd-journal-upload` folgt keiner Weiterleitung („Upload … failed with code 308“). Mit der früheren `http://`-URL kam von
  **keinem** Host ein Journal an (Vorfall 2026-09-20). Ohne Port hängt `systemd-journal-upload` selbst `:19532/upload` an (Pfad
  `/insert/journald:19532/upload`, den VictoriaLogs nicht kennt), mit `:443` wird nur `/upload` angehängt.
- Das Server-Zertifikat wird gegen die interne Root-CA geprüft, aber es wird **kein Client-Zertifikat** verwendet. Ohne diese beiden
  Zeilen versucht der Dienst bei HTTPS `/etc/ssl/certs/journal-upload.pem` zu laden und bricht ab („could not load PEM client
  certificate“). Der Hostname muss in der SAN-Liste von `certificate-homeserver-wildcard.yaml` stehen, ein Wildcard-Zertifikat gibt es
  nicht ([60040](60040-helm-charts-tech.md#zertifikate-und-tls)).
- **Namensauflösung ohne DNS-Abhängigkeit:** worker-0/worker-1 lösen `*.homeserver` nicht auf (kein dnsmasq als Resolver), die
  Pis nur über Tailscale-Split-DNS. Ein fester `/etc/hosts`-Eintrag auf die LAN-IP des Homeservers macht den Upload unabhängig davon.
  Nur abschalten, wenn der Host `*.homeserver` zuverlässig per DNS auflöst.
- **State-Datei (Vorfall 2026-09-24):** Ohne State-Datei beginnt `systemd-journal-upload` am Journal-**Anfang** und schickt das
  komplette Backlog als einen einzigen Request. Auf dem Homeserver (5 GB Journal) brach das jedes Mal mit „Buffer space is too small
  to write entry“ / „operation aborted by callback“ ab, bevor je ein Cursor gespeichert wurde, eine Endlosschleife bis zum
  Start-Limit, und kein Log kam an. Kleine Nachträge ab einem aktuellen Cursor laufen sauber durch. Deshalb setzt die Rolle bei
  fehlendem State den Startpunkt auf das Journal-Ende. Die State-Datei liegt im `StateDirectory` des Dienstes
  (`journal_upload_state_dir`, wegen `DynamicUser` unter `/var/lib/private/…`), der Besitzer muss der (dynamische) Dienst-User sein
  („Failed to read state file: Permission denied“). Der Kopfzeilen-Text der Datei (`# This is private data. Do not parse.`) ist
  Dateiinhalt und gehört dazu.
- Reihenfolge: Das Zurücksetzen des Start-Limits (`systemctl reset-failed`) und der Restart laufen per `flush_handlers` **vor**
  „aktivieren und starten“, und der Handler zum Zurücksetzen steht in `handlers/main.yml` **vor** „Restart systemd-journal-upload“
  (Handler laufen in Definitionsreihenfolge, nicht in Notify-Reihenfolge). Ein im Start-Limit hängender Dienst lässt sich sonst nicht
  neu starten.

### semaphore_bootstrap, semaphore_secrets und semaphore_targets

- `semaphore_secrets` erzeugt das Bootstrap-Material idempotent (Access-Key-Verschlüsselungsschlüssel mit 32 Byte Base64, dediziertes
  SSH-Schlüsselpaar für Semaphore → Ziele) und legt es als Secret `semaphore-bootstrap` im Namespace `semaphore` ab. Das von ArgoCD
  verwaltete Deployment konsumiert es. `semaphore_targets` trägt den Public Key auf den Zielhosts ein.
- `semaphore_bootstrap` provisioniert per REST-API idempotent (GET-Liste, POST nur wenn die Ressource fehlt). Stolpersteine:
  - **Umgebung pro Template:** Semaphore ab v2.18 entfernt beim Start von Ansible-Tasks das Container-Environment. Variablen wie
    `ANSIBLE_VAULT_PASSWORD_FILE` erreichen den Playbook-Prozess nur über ein Environment pro Template. Ohne das lassen sich
    verschlüsselte Variablen in Semaphore-Läufen nicht entschlüsseln. Das Feld `env` erwartet die API als **String-JSON**, deshalb
    wird das Dict per `to_json` kodiert.
  - **Typen bleiben nativ:** Body als **ein** Jinja-Dict bauen und per `body_format: raw` + `to_json` senden. `body_format: json`
    serialisiert `"{{ x | int }}"` als JSON-String, und Semaphores strikter Go-Decoder antwortet mit HTTP 400 (z. B. `ssh_key_id`,
    `project_id`).
  - **Schedules** (`cron`) sind self-healing: existiert der Name schon, wird der komplette Body per PUT neu gesetzt. Sie laufen in
    `SEMAPHORE_SCHEDULE_TIMEZONE` (Europe/Berlin), `0 6 * * *` feuert also ganzjährig um 06:00 Ortszeit.
  - **HTTPS ist Pflicht** für `semaphore_api_base`: Der TECH-Traefik leitet HTTP per 308 um, und `ansible.builtin.uri` folgt einem
    308 bei POST nicht („Status code was 308 and not [200, 204]“ beim Login), während GETs wie `/api/ping` still durch die
    Weiterleitung liefen. Das Zertifikat wird gegen die interne Root-CA im System-Vertrauensspeicher geprüft (installiert von der Rolle
    `journal_upload`), und der Hostname steht in der SAN-Liste des Zertifikats.
  - Semaphore hat einen **zweiten Ingress** (`semaphore-api.tech.homeserver`), weil die Rolle die REST-API ohne Browser-Session
    anspricht ([60040](60040-helm-charts-tech.md)).

### wireguard_backup

Kernel-WireGuard über `wg-quick`, unabhängig von Tailscale (Userspace `tailscale0` samt Tailscales Koordinations- und
DERP-Servern). Er dient nur als Notzugang, falls die Tailscale-Control-Plane ausfällt ([c0011](../c-netzwerk-dns/c0011-wireguard-backup.md)).

- Tunnelnetz `/24` mit Platz für weitere vertrauenswürdige Geräte, aber **jeder Peer bekommt seine eigene `/32` in `AllowedIPs`**: Peers
  erreichen einander nicht, nur den Server.
- Das Server-Schlüsselpaar wird **einmal** erzeugt und wiederverwendet. Eine Neuerzeugung würde den öffentlichen Server-Key ändern und
  jeden bereits konfigurierten Peer stillschweigend brechen.
- In UFW wird **nur der UDP-Port** freigegeben, es gibt bewusst **keine** `FORWARD`-/NAT-Regeln (`PostUp`/`PostDown` fehlen absichtlich):
  Der Tunnel erreicht nur den Server selbst (SSH, kubectl, ArgoCD), er ist kein LAN-Subnet-Router wie die von Tailscale beworbene
  Route. Das lässt die UFW-Forward-Chain unangetastet, auf die k3s/Flannel angewiesen sind.
- Warum Port 51888 und nicht 443: [60010](60010-ansible-hosts-und-playbooks.md#zugang-und-notfallzugang).

---

## Sonstiges

### cups_print_server

Macht einen USB-Drucker am Homeserver per CUPS im Heimnetz und Tailnet verfügbar (IPP/AirPrint für Handys und Tablets, IPP für Windows/Linux, Anleitung in
[20040](../2-betrieb-hardware/20040-printer.md)). Der **Name der Druckerwarteschlange** erscheint in CUPS-/IPP-URLs und darf deshalb keine Leerzeichen oder
Sonderzeichen enthalten. Der QPDL-Community-Treiber für die Samsung-Serie M2020/M2026 ist optional und wird gebaut. Die Warteschlange wird erst angelegt, sobald Device-URI und PPD
bekannt sind, dafür gibt es Debug-Tasks, die beides ermitteln.

### crowdsec

Die Reihenfolge ist zwingend ([d0020](../d-sicherheit/d0020-crowdsec.md)): Zuerst wird CrowdSec (LAPI und Agent) installiert, den **Firewall-Bouncer** installiert die Rolle **erst danach**, wenn
CrowdSec läuft. LAN und Tailscale stehen auf der Whitelist, damit sich niemand selbst aussperrt.


### common: ArgoCD-NodePort in UFW

ArgoCD läuft mit `server.insecure` (`argocd_server_insecure`): **Beide** NodePorts (30080/30443) sprechen Klartext-HTTP,
`https://…:30443` wird zurückgesetzt. Die Web-UI läuft per HTTPS über Traefik (`argocd.tech.homeserver`). Der Klartext-NodePort **30080**
bleibt für CLI und CI: Die Promotion-Kette und der Tailscale-Runner greifen auf `192.168.178.94:30080` zu
([f00b0](../f-cicd-automatisierung/f00b0-promotion-chain.md)). Er ist nur aus LAN und Tailnet erreichbar. Die Freigabe stand früher nur
von Hand in UFW und nicht im Repo, ein Neuaufbau hätte die CI stillgelegt, deshalb steht sie jetzt in der Rolle `common`.

### vaultwarden_restore

Die Rolle stellt `db.sqlite3`, `rsa_key.pem`, Attachments und Sends aus der `vaultwarden-backup`-PVC (nachts vom Backup-CronJob auf
der NAS gefüllt) auf die `vaultwarden-data`-PVC zurück ([300a0](../3-apps-workloads/300a0-vaultwarden.md), [20010](../2-betrieb-hardware/20010-nas-backup.md)).

- **Sicherheitsgurt:** Ohne `-e force_restore=true` (Make: `make vaultwarden-restore FORCE_RESTORE=true`) bricht die Rolle sofort
  ab, statt versehentlich einen lebenden Tresor mit dem NAS-Backup zu überschreiben. Das Playbook ist aus demselben Grund **nicht** Teil
  von `site.yml`: Ein automatischer Lauf bei jedem Deploy könnte Live-Daten überschreiben.
- Der Hauptaccount samt aller Passwörter und des eigenen 2FA/TOTP ist danach automatisch wieder da, weil das alles Teil derselben
  SQLite-Datei ist. Ein separater „User anlegen“-Schritt ist nicht nötig.

### Konventionen der Linter-Konfiguration

Begründungen zu `.ansible-lint` und `.yamllint` stehen in [600a0](600a0-ci-workflows-und-skripte.md#lint-konfiguration).
