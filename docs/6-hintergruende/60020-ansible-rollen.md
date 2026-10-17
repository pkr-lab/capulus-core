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
| WoL-HTTP-Agent (`banana-pi-wol-agent.py`) direkt am Pi | Dünner HTTP-Wrapper um `banana-pi-wol.sh`, damit die iOS-App ein Magic Packet ins Standort-LAN auslösen kann. Er spiegelt strukturell `power-agent.py`, ist aber sonst unabhängig: Der power-agent läuft im LAN des Homeservers und wird vom carplay-api-Pod gerufen, dieser hier läuft im reinen Tailscale-Netz des Pi und wird **direkt** von der App gerufen, weil der carplay-api-Pod keine Route zu Tailscale-Peers hat ([40020](../4-planung/40020-vereinsheim-wol-router-vpn.md)). Er kennt keine MACs, Gültigkeit des Ziels und MAC-Lookup bleiben in `banana-pi-wol.sh` / `banana_pi_kiosk_wol_devices`, er reicht nur den Alias weiter. Er lauscht auf `banana_pi_kiosk_wol_agent_bind_address`: Im Standard `0.0.0.0`, für den Alarmmonitor per `host_vars` auf seine Tailscale-Adresse (`ansible_host`), damit das Vereinsheim-LAN den Port nicht erreicht. Steht `ansible_host` auf einer LAN-Adresse (Ersteinrichtung), lauscht der Agent dort statt am Tailnet. Timeouts, Body-Grenze und systemd-Härtung wie beim [power_agent](#power_agent). |

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
  welchem Node der carplay-api-Pod läuft (Flannel-Overlay).
- **Der Agent lauscht nur auf der Adresse der Pod-Bridge `cni0` des homeservers** (`power_agent_bind_address: "10.42.2.1"` in `host_vars/homeserver`, das Pod-Netz `10.42.2.0/24` ist dem Node fest zugewiesen), `carplay-api` ruft
  `http://10.42.2.1:9101` auf. Er ist damit weder aus dem LAN noch aus dem Tailnet noch von den Workern oder über `127.0.0.1` erreichbar, und der Token läuft nur über die Bridge des eigenen Nodes, nicht über das LAN. Das ersetzt HTTPS und
  die Firewall-Freigabe für diesen Port. **Tests vom Host aus** gehen deshalb nur gegen `10.42.2.1`. **Beim Start nach einem Reboot** gibt es `cni0` erst, wenn die erste Pod-Sandbox angelegt ist: Bis dahin scheitert das Binden, und
  `Restart=always` (`RestartSec=10`) probiert es alle zehn Sekunden erneut. **Ändert sich die Adresse** (Node neu registriert), startet der Agent nicht mehr: `ip -4 addr show cni0` prüfen, `power_agent_bind_address` und `powerAgent.url` in `carplay-api` angleichen.
- **Hostschlüssel der Worker sind festgelegt.** Der Agent ruft `ssh` mit `StrictHostKeyChecking=yes` und `UserKnownHostsFile=/etc/power-agent/known_hosts` auf, nicht mehr mit `accept-new`. Die Rolle schreibt die Datei aus
  den Einträgen in `/root/.ssh/known_hosts` des homeservers (`ssh-keygen -F`), fehlt ein Worker dort, holt sie seinen `ed25519`-Schlüssel einmalig mit `ssh-keyscan` (so war es vorher bei der ersten Verbindung auch). Findet sie gar keine
  Schlüssel, lässt sie die Datei unverändert und warnt. **Fehlerbild:** Hat ein Worker einen neuen Hostschlüssel (Neuinstallation), scheitert der Poweroff über die App mit `Host key verification failed`. Dann den alten Eintrag aus
  `/root/.ssh/known_hosts` und `/etc/power-agent/known_hosts` entfernen und die Rolle neu laufen lassen.
- **Der Poweroff der Worker läuft über einen Schlüssel mit `command=`.** Der SSH-Aufruf des Agents führt auf dem Worker immer `sudo poweroff` aus, egal welcher Befehl übergeben wird ([20020](../2-betrieb-hardware/20020-cluster-power-manager.md)). Diesen Schlüssel
  nie zum Testen einer Verbindung benutzen. Den Hostschlüssel-Pfad prüft man gefahrlos mit `-o PreferredAuthentications=none`: Er bricht nach der Hostschlüssel-Prüfung mit `Permission denied (publickey)` ab und führt nichts aus.
- **Anfragen sind begrenzt.** Der Handler schließt Verbindungen nach 10 Sekunden ohne Daten, der Body darf höchstens 4096 Byte haben, eine negative oder unlesbare `Content-Length` ergibt `400` statt eines hängenden Threads.
- **systemd-Härtung** (`NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, `ProtectSystem=full`, `ProtectKernelModules`, `ProtectControlGroups`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `RestrictRealtime`, `RestrictNamespaces`,
  `LockPersonality`, `SystemCallArchitectures=native`, `UMask=0077`). **Bewusst nicht gesetzt:** `ProtectKernelTunables` (würde `/sys` schreibgeschützt machen, die Helligkeit wird über sysfs geschrieben), `DynamicUser` und `User=` (der Agent braucht root für
  `kubectl`, den SSH-Schlüssel, sysfs und `poweroff`), `PrivateDevices`. Die Optionen wurden vor dem Ausrollen mit einer kurzlebigen Einheit gleicher Einstellungen getestet: `kubectl get nodes`, Helligkeit schreiben, `wakeonlan`, `systemctl` und die
  Hostschlüssel-Prüfung funktionieren. Das Ergebnis zeigt `systemd-analyze security power-agent.service`.
- Der Bestätigungscode für den Shutdown des Homeservers wird nur in `carplay-api` geprüft, nicht im Agent. Wer den Token hat, fährt den Homeserver direkt herunter. Eine zweite Prüfung im Agent würde den Vertrag zwischen App, `carplay-api` und Agent ändern.

### thermal_watchdog und resource_watchdog

- Der `thermal_watchdog` liest `/sys/class/hwmon` **direkt** (ohne Prometheus/k8s) und fährt den Host herunter, wenn der heißeste
  Sensor `THRESHOLD_C` für `SUSTAIN_SECONDS` erreicht (90 s = Mitte der gewünschten 1–2 Minuten), vorher geht eine ntfy-Meldung raus.
  Er läuft bewusst **unabhängig vom Cluster**, damit der Schutz auch greift, wenn der Cluster wegen der Hitze schon klemmt. Er
  ergänzt den Alert ab 95 °C über 3 Minuten ([60060](60060-monitoring-und-alerting.md#lautstärke-der-ntfy-meldungen)).
- Die ntfy-Meldung wird per `curl --resolve` direkt auf die statische Server-IP aufgelöst, damit sie auch rausgeht, wenn auf dem
  Host kein `*.homeserver`-DNS eingerichtet ist.
- `DRY_RUN=1` (z. B. `systemctl edit --runtime thermal-watchdog`) testet den kompletten Pfad Erkennung → Meldung, ohne auszuschalten.
- Der `resource_watchdog` ist das Gegenstück für CPU/RAM (Schwelle 90 %): Ist `WARN_THRESHOLD` leer, entfällt die Vorwarnstufe.
  Auch diese Schwelle läuft **nicht** über Alertmanager, sondern lokal.
- Die Meldung an ntfy trägt einen Publisher-Token, falls `/etc/ntfy-publisher/auth-header` lesbar ist. Die Skripte (`thermal-watchdog`, `resource-watchdog`,
  `cluster-power-manager`, `nightly-worker-wake`) geben den Header per `curl -H @Datei` mit, nicht als Argument oder Umgebungsvariable: so steht der Token weder in `ps`
  noch in `systemctl show`. Fehlt die Datei, senden sie anonym weiter (sonst hinge die Reihenfolge Rolle → ntfy-Umstellung an einem Zeitpunkt). Die Datei schreibt die Rolle
  `ntfy_publisher` aus der Vault-Variable `ntfy_publisher_token`, sie ist in allen Playbooks mit Watchdogs vor diesen eingetragen (Tag `ntfy-publisher`). Ist die Variable
  nicht gesetzt, überspringt die Rolle den Schreib-Task, ein bestehender Header bleibt liegen.
- Der Token läuft über `http://ntfy.tech.homeserver` (Port 80) im Klartext durch LAN bzw. Tailscale. Das ist beabsichtigt, weil `--resolve` auf die statische Server-IP
  auch ohne DNS funktioniert. Der Publisher darf nur schreiben, ein Mitschnitt erlaubt also gefälschte Meldungen, kein Mitlesen.
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

## Alarmierung

### alert_caller

Telefon-Alarm für eine **externe VM** (noch nicht ausgerollt, heute läuft der Caller als Pod, siehe [60040](60040-helm-charts-tech.md#alert-caller)): systemd-Dienst `alert-caller` (Python, nur Standardbibliothek), der Alertmanager-Webhooks in einen Anruf per SIP verwandelt. `caller.py` liegt
im Chart `argocd/apps/tech/alert-caller/src/` und wird von der Rolle von dort kopiert (eine Quelle für beide Betriebsarten). Playbook `ansible/alert-caller.yml`, Inventar-Gruppe `alert_callers`, Make-Targets `alert-caller` und `alert-caller-check`.
Bedienung, Einrichtung und Testplan: [10020](../1-benachrichtigungen/10020-telefon-alarm.md). Routing und Regeln: [60060](60060-monitoring-und-alerting.md#telefon-alarm).

- **Playbook und Tailscale:** Die Overrides für Tailscale (`tailscale_hostname`, keine Subnetz-Route) stehen in `host_vars/alert-caller-vm`, **nicht** in `group_vars/alert_callers.yml`. Der `homeserver` kann als Fallback in der Gruppe stehen, und ein
  `tailscale_advertise_routes: ""` auf Gruppenebene würde ihm beim nächsten Lauf die Subnetz-Route nehmen.
- **`baresip` wird aus den Quellen gebaut** (`re` und `baresip` im selben Tag `alert_caller_baresip_version`, Installation nach `/opt/baresip`). Das Paket aus Ubuntu (1.1.0 in 26.04, getestet, und 1.0.0 in 22.04/24.04 mit demselben `libre`-Stand von 2021, nicht getestet) kann sich bei
  `sip.linphone.org` nicht anmelden: Der Flexisip-Server (2.6.1) schickt zwei `WWW-Authenticate`-Header, SHA-256 vor MD5. Die alte `libre` beherrscht nur MD5, verweigert die erste Challenge mit `ENOSYS`, und die Registrierung endet mit
  „Function not implemented“. `re` ab Version 4 kann SHA-256 (geprüft am 2026-10-11 mit v4.12.0: der Server antwortet auf einen erfundenen Benutzer mit `403 Forbidden`). Die Stempeldatei `/opt/baresip/.built-<hash aus Version und Modulliste>` macht den Build
  idempotent, Löschen erzwingt einen Neubau. `CMAKE_INSTALL_RPATH` ist nötig, sonst findet die Binärdatei `libbaresip.so` nur mit `LD_LIBRARY_PATH`. `-DMODULES` baut nur die benötigten Module.
- **`libre` und `baresip` werden gepatcht** (Listen `alert_caller_libre_patches` und `alert_caller_baresip_patches`, Dateien in `argocd/apps/tech/alert-caller/patches/`): `sips:`-Routen und SRTP-Suitenwechsel (ICE-Patches wurden getestet und wieder entfernt, siehe 60040). Begründungen und Messwerte: [60040](60040-helm-charts-tech.md#alert-caller). Der Hash aller Patches fließt in die Stempeldatei ein, ein geänderter Patch löst einen Neubau aus. Die `git`-Aufgabe nutzt `force: true`, sonst bricht der zweite Lauf an den gepatchten Dateien ab. Die Rollenänderung ist nur syntaxgeprüft und gelintet, nicht neu auf einem Host ausgerollt. Der Caller wartet nach dem Abheben auf den Medienstart (`ICE_TIMEOUT`, `alert_caller_ice_timeout`).
- **Modulliste** (`templates/baresip-config.j2`) weicht von der Aufgabe ab, jeweils aus einem Testlauf:
  - `stdio` bleibt drin, aber nur mit einer **Pipe** als stdin. Mit `/dev/null` (Standard unter systemd) scheitert es mit `epoll_ctl: Operation not permitted`. Der Caller startet baresip deshalb mit `stdin=PIPE` und schreibt `/dial …` hinein.
    `-e "/dial …"` taugt nicht: Es wählt sofort beim Start, und vor der Registrierung kann das Medien-Socket keine Adressfamilie bestimmen (`stream: failed to create socket for media 'audio'`, `af=AF_UNSPEC`). Mit IP-Konten ohne Registrierung geht es, mit
    `sip.linphone.org` nicht. Erkannt wird die Registrierung an der Logzeile `{0/TLS/v4} 200 Registration successful` (baresip 4.12 schreibt `v4`, nicht `IPv4`, mit dem echten Konto gesehen), ihr Scheitern an `reg: … (prio 0): 403 …`.
  - `account` ist neu: Seit baresip 1.0 lädt dieses Modul die Datei `accounts`. Ohne es gibt es kein Konto (`could not find UA for sip:…`).
  - `account` steht **zuletzt**: Es legt die Konten beim Laden sofort an, `ice` und `srtp` müssen dann schon geladen sein, sonst `medianat not found: 'ice'`.
  - `auresamp` ist neu: In baresip 4 ist der Resampler ein eigenes Modul. Ohne es bleibt der Anruf **stumm**, weil die Quelle 16 kHz liefert und der Codec PCMU 8 kHz erwartet (RTP-Zähler dauerhaft `audio=0/0`, aufgezeichnete Datei still).
  - **STUN:** Der Server von Linphone (`stun.linphone.org`, oRTP 0.99) antwortet mit RFC-3489-Attributen, die libre ablehnt (`Protocol error [71]`). Der Standard ist deshalb `stun.cloudflare.com:3478` (`alert_caller_stun_server`).
  - `audio_alert` zeigt ebenfalls auf `aufile`, damit baresip auf der Maschine ohne Soundkarte keinen ALSA-Fehler beim Rufton wirft.
- **TLS:** `sip_verify_server yes` und `sip_cafile` (System-CA) prüfen das Zertifikat des Servers. Der `transport=tls` der Konto-Adresse gilt auch für den INVITE: baresip hängt ihn an die Ziel-URI (geprüft mit `transport=tcp`, Log
  `connecting to 'sip:…;transport=tcp'`), die Ziele in `CALL_TARGETS` brauchen ihn nicht.
- **Auflegen:** baresip 1.1 legt am Ende der Audiodatei auf, baresip 4.12 **nicht**. Der Caller legt deshalb selbst auf (Länge der Ansage plus 3 s nach der Annahme). `-t` ist nur die Obergrenze (`CALL_RING_TIMEOUT` + Länge + 5 s). Ein festes `-t 60` würde
  lange Ansagen abschneiden: Drei Alarme in dreifacher Wiederholung sind rund 50 s. Annahme und Ende erkennt der Caller an den Logzeilen `Call established` und `Call with … terminated`, einen fehlgeschlagenen Verbindungsaufbau an `ua_connect failed`. Bei einem baresip-Update prüfen, ob der Wortlaut gleich geblieben ist. Ein Ziel darf höchstens
  `CALL_RING_TIMEOUT` klingeln, dann kommt das nächste.
- **Geheimnisse:** Die Umgebungsdatei liegt `root:root` mit `0600`, `accounts` (mit Passwort) `root:alert-caller-cfg` mit `0640`. Der Dienst läuft als `DynamicUser` und liest `accounts` über `SupplementaryGroups=alert-caller-cfg`, `caller.py` kopiert beide Dateien beim
  Start nach `/run/alert-caller/baresip` (`RuntimeDirectory`), weil baresip in sein Konfigurationsverzeichnis schreibt. Die Gruppe darf **nicht** `alert-caller` heißen: `DynamicUser=` legt selbst eine Gruppe mit dem Namen der Unit an, eine gleichnamige statische Gruppe
  endet mit `status=217/USER` (`User or group with specified name already exists`). `LoadCredential=` wurde verworfen, weil es im Testcontainer nicht funktionierte (`/run/credentials/…` blieb leer), auf einem echten Host wäre es vermutlich gegangen. Das Passwort darf kein `;`, `"` oder Leerzeichen enthalten, die Kontozeile wird nicht maskiert (die Rolle prüft das).
- **Webhook:** Die Antwort kommt sofort, Synthese und Anruf laufen in eigenen Threads, weil Alertmanager Webhooks nach 10 s abbricht und erneut sendet. Ein Lock macht die Anrufe sequenziell. Der Port hat keine Authentifizierung, der Schutz ist wie beim `power_agent`
  die Netzgrenze: UFW lässt 9310 nur aus `alert_caller_webhook_sources` (Tailnet) durch.
- **Pause und Alarm-Gruppen:** Die Pause (`CALL_COOLDOWN`) gilt je `groupKey` und zieht 30 s Toleranz ab. Alertmanager wiederholt in Takten von `group_interval`, der Zeitstempel kann um Millisekunden vor dem Ablauf liegen, und der Anruf käme sonst erst
  eine Runde (5 min) später. Ein Alarm mit unbekanntem Fingerprint in der Gruppe hebt die Pause auf, sonst bliebe ein zweiter Ausfall bis zu 15 min stumm.
- **Watchdog:** Der Startzeitpunkt zählt als letzter Ping, nach einem Neustart des Callers hat der Cluster also 10 min Zeit. Pro Ausfall gibt es genau einen Anruf, ein neuer Watchdog setzt zurück. Der Ping an healthchecks.io wird nur weitergegeben, wenn ein Watchdog
  ankommt: Fällt der Cluster **oder** der Caller aus, bleibt der Ping aus.
- **Label-Fallback:** `ansage`, `grund`, `summary` und `kontext*` werden auch aus den Labels gelesen. `amtool alert add … summary="…"` legt sie als Labels an, nur `--annotation=` erzeugt Annotationen. So funktioniert der manuelle Test wie dokumentiert.
- **Statischer Modus für den Pi** (`alert_caller_static_announcement: true`, Gruppe `alert_caller_pi`): Der Caller spielt statt Piper die vorab erzeugte WAV `files/cluster-down.wav` ab (`STATIC_ANNOUNCEMENT`), denn `onnxruntime` und damit Piper gibt es für armv7l nicht. `/alert` antwortet in diesem Modus mit 404, weil jeder Alarm sonst die feste Ansage bekäme. `alert_caller_manage_firewall: false` lässt UFW unberührt (der Pi hat bisher keine UFW-Konfiguration aus Ansible, ein erstmaliges Einschalten wäre ein Risiko für den Kiosk), `alert_caller_build_jobs: 2` schont den Speicher beim Bauen von baresip. `alert_caller_hc_uuid` ist optional. Details und Ausrollen: [10020](../1-benachrichtigungen/10020-telefon-alarm.md#notfall-caller-auf-dem-vereinsheim-pi-ausgerollt-anruf-vom-pi-noch-nicht-getestet).
- **Ohne Sprachsynthese:** Schlägt Piper fehl, spielt der Caller einen Warnton (`sox synth`). Ein Anruf ohne Text ist besser als keiner.
- **Firewall:** Die Rolle setzt UFW (SSH zuerst, dann `default deny incoming`, damit sich niemand aussperrt). Der RTP-Bereich in UFW, in `baresip-config.j2` und in der Oracle-Security-List muss derselbe sein.
- **Zugriffsschutz auf dem Pi:** `alert_caller_token` (aus `vault_alert_caller_token`, Standard leer) und `alert_caller_auth_mode` (`log` oder `enforce`) landen in `alert-caller.env` (`0600`). Die Rolle bricht ab, wenn der Modus `enforce` ohne Token gesetzt ist. Der Pi bekommt
  vom Alertmanager nur `/watchdog` und ist der Totmann bei einem Totalausfall des Clusters. Ist der Token im Modus `enforce` falsch, bleibt der Timer unberührt, und der Pi ruft nach `WATCHDOG_TIMEOUT` selbst an (ein lauter Fehler, kein stiller). Einführung und Rotation: [10020](../1-benachrichtigungen/10020-telefon-alarm.md#zugriffsschutz-token).

## Sonstiges

### k3s: Modus der Kubeconfig

- **`write-kubeconfig-mode: "0600"`.** `/etc/rancher/k3s/k3s.yaml` enthält ein Client-Zertifikat samt Schlüssel der Gruppe `system:masters` (cluster-admin). Mit `0644` machte ein Lesezugriff jeden lokalen Account
  oder jeden Container mit Host-Mount zum Cluster-Admin. Die Rolle kopiert die Datei außerdem für den Ansible-Benutzer nach `~/.kube/config` (Modus `0600`), und `/etc/environment` setzt `KUBECONFIG` darauf.
  Interaktiv und in Skripten läuft deshalb alles über diese Kopie oder über `sudo k3s kubectl`, nicht über die Systemdatei. `cluster-power-manager`, `nightly-worker-wake` und `power-agent` laufen als root.
- **Die Rolle startet k3s nicht neu.** k3s liest `config.yaml` und schreibt `k3s.yaml` nur beim Start. Eine Änderung des Modus über den Ansible-Lauf allein greift deshalb erst beim nächsten Neustart. Für die sofortige Wirkung
  das `chmod 0600` einmal von Hand setzen (und die Zeile in `config.yaml` angleichen, damit ein späterer Start nicht wieder `0644` schreibt), statt k3s dafür neu zu starten.
- **Wer sonst die Datei lesen muss,** braucht `sudo` oder eine eigene Kopie (`sudo install -m 0600 -o <user> /etc/rancher/k3s/k3s.yaml ~/.kube/config`). Eine Sicherungskopie der Datei darf nie weiter geöffnet sein als das Original.

### cups_print_server

Macht einen USB-Drucker am Homeserver per CUPS im Heimnetz und Tailnet verfügbar (IPP/AirPrint für Handys und Tablets, IPP für Windows/Linux, Anleitung in
[20040](../2-betrieb-hardware/20040-printer.md)). Der **Name der Druckerwarteschlange** erscheint in CUPS-/IPP-URLs und darf deshalb keine Leerzeichen oder
Sonderzeichen enthalten. Der QPDL-Community-Treiber für die Samsung-Serie M2020/M2026 ist optional und wird gebaut. Die Warteschlange wird erst angelegt, sobald Device-URI und PPD
bekannt sind, dafür gibt es Debug-Tasks, die beides ermitteln.

### crowdsec

Die Reihenfolge ist zwingend ([d0020](../d-sicherheit/d0020-crowdsec.md)): Zuerst wird CrowdSec (LAPI und Agent) installiert, den **Firewall-Bouncer** installiert die Rolle **erst danach**, wenn
CrowdSec läuft. LAN und Tailscale stehen auf der Whitelist, damit sich niemand selbst aussperrt.


### common: ArgoCD-NodePort in UFW

ArgoCD hat keinen NodePort mehr (`argocd_server_nodeport_enabled: false`, siehe [60030](60030-argocd-und-bootstrap.md#rolle-argocd)). Die Rolle `common` löscht deshalb die früheren
UFW-Freigaben für `30080` (LAN, Tailnet, WireGuard-Notzugang) und `30443`. Die Regeln hatten auch vorher nichts begrenzt, weil NodePort-Verkehr an UFW vorbeiläuft
([c0030](../c-netzwerk-dns/c0030-port-uebersicht.md)).

### ssh_hardening

- **Das Drop-in heißt `00-hardening.conf`, nicht `99-…`.** `sshd` übernimmt für jedes Schlüsselwort den **ersten** gefundenen Wert, und `Include /etc/ssh/sshd_config.d/*.conf` steht oben in der Hauptdatei. Die cloud-init-Datei
  `50-cloud-init.conf` setzt `PasswordAuthentication yes`. Ein Drop-in mit höherer Nummer würde übersteuert und nichts bewirken. Die Rolle prüft deshalb nach dem Ablegen mit `sshd -T`, ob die neuen Werte tatsächlich gelten
  (`passwordauthentication no`, `permitrootlogin no`, `allowagentforwarding no`), und bricht sonst ab.
- **Ablauf mit Selbstschutz:** Drop-in ablegen, `sshd -t`, `sshd -T` prüfen, dann `systemctl reload ssh`. Schlägt einer der Schritte fehl, entfernt die Rolle das Drop-in wieder und lädt **nicht** neu, damit ein späterer Neustart nicht
  mit einer kaputten Konfiguration anläuft. Nie `restart`: Ubuntu startet `sshd` per Socket-Aktivierung (`ssh.socket`), ein Reload behält laufende Sitzungen.
- **Werte:** `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `MaxAuthTries 4`, `LoginGraceTime 20`, `X11Forwarding no`, `AllowAgentForwarding no`, `AllowTcpForwarding no`. Vier statt drei Versuche, weil ein
  Agent mit mehreren Schlüsseln und die Standard-Identitäten schon drei Fehlversuche erzeugen können („Too many authentication failures“). `AllowTcpForwarding no` bricht `ssh -L`, `-D`, `ProxyJump` und VS-Code-Remote: Wer das braucht,
  setzt `ssh_hardening_allow_tcp_forwarding: true` in den `host_vars`.
- **Wer sich anmeldet:** Auf keinem Host liegt ein Schlüssel für `root`, und alle Dienste (Semaphore, `cluster-power-manager`, der n8n-Trigger, Ansible) melden sich als `ubuntu` per Schlüssel an. Die Vault-Dateien enthalten nur
  `become`-Passwörter (sudo). Die Härtung ändert nichts an der Schlüssel-Anmeldung.
- **Neue Hosts:** Den Schlüssel vor dem ersten Rollenlauf hinterlegen (`ssh-copy-id`, siehe [a0020](../a-betriebssystem/a0020-prerequisites.md)), sonst sperrt sich der Admin mit dem Rollenlauf selbst aus.
- **Aufgenommen sind** homeserver, worker-0, worker-1, prod-vm, entw-vm und die Kiosk-Pis (alarmmonitor, infotafel) über `banana-pi-kiosks.yml` und `xibo-kiosks.yml` (Tag `ssh-hardening`, `make ssh-hardening`). Auf dem Alarmmonitor stand
  zuvor `PermitRootLogin yes` und Passwort-Login in der Hauptdatei hinter dem `Include`: Das Drop-in gewinnt trotzdem, weil der `Include` oben steht. Der Alarmmonitor hängt nur am Tailnet und hat keinen LAN-Fallback, ein Reboot ist
  unzuverlässig ([banana_pi_kiosk](#banana_pi_kiosk-vereinsheim-alarmmonitor)). Ein Fehler hieße Besuch vor Ort: Änderungen dort immer mit Rollback-Timer und geöffneter zweiter Sitzung.
- **Schlüssel mit `command=` nie zum Testen aufrufen.** Der Schlüssel des `cluster-power-manager` ist auf den Workern fest auf `sudo poweroff` gesetzt, ein Testaufruf mit beliebigem Befehl fährt den Worker herunter
  ([20020](../2-betrieb-hardware/20020-cluster-power-manager.md)). Den Dienstweg belegt man über „Accepted publickey“ im Journal bei einem natürlichen Lauf, nicht durch einen eigenen Aufruf.
- **Änderungen an `sshd` mit Netz:** Kopie von `/etc/ssh`, Rollback-Timer (`systemd-run --on-active=… sh -c 'rm -f …/00-hardening.conf && systemctl reload ssh'`), eine zweite Sitzung offen halten, in einer neuen testen, erst dann den Timer stoppen.

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
