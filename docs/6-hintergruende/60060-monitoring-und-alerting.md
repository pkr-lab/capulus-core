# Monitoring und Alerting — Hintergründe

Begründungen zu `argocd/apps/tech/monitoring/` (VictoriaMetrics, Grafana, Alertmanager, Scrapes, Regeln), zum Logging-Stack und zu den
Anbindungen nicht-clusterinterner Hosts. Bedienung: [20060](../2-betrieb-hardware/20060-hardware-monitoring.md),
[20050](../2-betrieb-hardware/20050-gitops-und-backup-alerts.md), [300j0](../3-apps-workloads/300j0-logging.md).
Die Push-Seite auf den Hosts (Rolle `vmagent`) steht in [60020](60020-ansible-rollen.md#vmagent-node_exporter-und-smartctl_exporter).
Übersicht dieser Kategorie: [60000](60000-uebersicht.md).

---

## Alertmanager-Routing

`InfoInhibitor` landet im Blackhole, `Watchdog` geht an den Telefon-Caller. Alle übrigen Alerts werden nur zugestellt, wenn eine der folgenden Routen passt:

| Bedingung | Empfänger |
|---|---|
| **nur** `alertname=Watchdog` | Webhook `/watchdog` am Telefon-Caller ([10020](../1-benachrichtigungen/10020-telefon-alarm.md)), jede Minute |
| `page=true` | Webhook `/alert` am Telefon-Caller (Anruf), **zusätzlich** zu den folgenden Routen (`continue: true`) |
| `severity=critical` | ntfy `/Home-Lab` (iOS-Push, der Alertmanager-Webhook wird direkt von ntfy empfangen) |
| **nur** `alertname=BananaPiAlarmmonitorDown` | n8n-Webhook des Workflows „Banana-Pi-Down → Zammad-Ticket“ ([30020](../3-apps-workloads/30020-vereinsheim-alarmmonitor.md)) |

- **Keine Entwarnungen:** Der ntfy-Receiver hat `send_resolved: false`. Eine Meldung „✅ erledigt“ gibt es nicht mehr, nur noch die Meldung beim Auftreten (siehe [Lautstärke der ntfy-Meldungen](#lautstärke-der-ntfy-meldungen)).
- **Warnungen werden nicht zugestellt:** Gotify (früher Empfänger für alle Alerts) ist im Oktober 2026 samt Bridge entfernt worden. Alerts mit `severity=warning`/`info`
  sind seitdem nur in Alertmanager und Grafana sichtbar, nur `critical` löst einen Push aus.
- Der n8n-Pfad ist **rein additiv**: Die anderen Alamos-Raspberry-Pis bekommen bewusst weiterhin **kein** Ticket pro Ausfall
  ([30010](../3-apps-workloads/30010-alamos-apager.md)), nur dieser eine Alertname bekommt den zusätzlichen Weg.
- **Warum explizite Geschwister-Routen:** Ein nacktes Top-Level-Receiver wird **nicht** mit einer passenden Kind-Route kombiniert, Alertmanager fällt nur darauf
  zurück, wenn gar keine Kind-Route passt. Der Fan-out „critical (+ Banana Pi)“ ist deshalb als explizite Geschwister-Routen modelliert. Die
  n8n-Route hat `continue: true` und fällt so zur nächsten passenden Route durch.
- **Reihenfolge:** Die n8n-Route (nur dieser Alertname) muss **vor** der `severity=critical`-Route stehen. Die hat kein `continue: true` und würde die Auswertung sonst
  dort beenden.

## Lautstärke der ntfy-Meldungen

Anlass am 2026-10-11: Auf dem Handy kamen rund 65 bis 175 ntfy-Nachrichten am Tag an (Zähler `messages_published` des ntfy-Servers). Im Cache des Topics `Home-Lab` standen 64 Nachrichten aus knapp 10 Stunden: 32 `DeploymentUnavailable`, 18 `TooHighMemoryUsage`,
8 `HostHighTemperature`, 4 `worker-*Down`, 2 `ArgoAppDegraded`, davon rund 40 % „✅ erledigt“. Gewünscht ist: nur melden, was wirklich kritisch ist, nicht kurze Spitzen. Folgende Stellschrauben wurden gedreht:

| Änderung | Begründung |
|---|---|
| `HostHighTemperature`: `max by (host) (node_hwmon_temp_celsius) >= 95` für 3 Minuten (vorher: je Sensor, ab 80 °C für 1 Minute) | Der Homeserver hat rund 17 Sensoren, jeder konnte einzeln auslösen, und der Alertmanager-Webhook wird von der ntfy-Bridge **pro Alarm** in eine Nachricht aufgelöst. Gemessen über 7 Tage (VictoriaMetrics, 30-s-Auflösung, höchster Sensor): ab 80 °C gab es 704 Phasen von mindestens 1 Minute (die CPU springt kurz auf Spitzen und fällt wieder), ab 90 °C und 3 Minuten 7, ab 93 °C 1, **ab 95 °C und 3 Minuten keine**. Der `thermal_watchdog` schaltet bei 100 °C nach 90 Sekunden ab und schickt davor eine eigene ntfy-Meldung (Topic `Home-Lab-System`). 95 °C über 3 Minuten ist also die Vorwarnung, die nur bei einer echten Dauerlage kommt. Der NAS erreicht höchstens 63 °C. |
| `DeploymentUnavailable` und `StatefulSetUnavailable`: `for` von 1 auf 5 Minuten | Jeder Rollout einer App mit `strategy: Recreate` (isc-news-bot, alert-caller, …) hat kurz keinen verfügbaren Pod und löste nach 1 Minute aus, dazu kam das Auf und Ab beim Abbau von Authentik. Fünf Minuten ohne Pod sind ein echter Ausfall. Die Erkennung verzögert sich um 4 Minuten. |
| Standardregel `TooHighMemoryUsage` (VictoriaMetrics): `severity: warning`, `for: 15m` (vorher `critical`, 5 min) über `defaultRules.rules.TooHighMemoryUsage.spec` in `values.yaml` | Die Regel hat nicht fälschlich ausgelöst, sondern lag an ihrer Schwelle: Der `vmsingle`-Pod nutzte am Testtag 906 MiB von 1024 MiB (83 %, Spitze der letzten 24 h: 91 %) und die Regel springt bei 80 %. Als `warning` erscheint sie weiter in Alertmanager und Grafana, geht aber nicht mehr als Push raus. **Das Grundproblem bleibt:** `vmsingle` sitzt knapp unter seinem Speicherlimit. VictoriaMetrics richtet seine Caches nach dem Limit (`memory.allowedPercent: 60`), mehr Limit kann deshalb zu mehr Verbrauch führen. Entweder `resources.limits.memory` erhöhen und beobachten, oder `allowedPercent` senken. Der Override kommt über den Sync-Job des Charts (`rules.rules` in dessen ConfigMap), erst der nächste Sync wendet ihn auf die VMRule `…-rule-vm-health` an. |
| ntfy-Receiver: `send_resolved: false` | Die „✅ erledigt“-Nachrichten machten rund 40 % der Menge aus. Wer wissen will, ob ein Alarm vorbei ist, sieht es in Grafana oder im Alertmanager. Wieder einschalten: `send_resolved: true` beim Receiver `ntfy`. |

Nicht angefasst, aber als Hebel vorhanden: Die ntfy-Bridge schickt bei jeder Änderung einer Alarm-Gruppe **alle** Alarme der Gruppe erneut (eine Nachricht je Alarm im Webhook-Body), auch die bereits gemeldeten. Ein Zwischenspeicher nach Fingerprint in `ntfy-bridge` würde das abstellen. Der Telefon-Weg (`phone`)
ist davon nicht betroffen: Er meldet je Gruppe erst nach der Pause (`CALL_COOLDOWN`) erneut.

## Telefon-Alarm

Bedienung und Einrichtung: [10020](../1-benachrichtigungen/10020-telefon-alarm.md). Der Caller als Chart: [60040](60040-helm-charts-tech.md#alert-caller), als Ansible-Rolle für eine externe VM: [60020](60020-ansible-rollen.md#alert_caller).

**Routing** (`argocd/apps/tech/monitoring/values.yaml`)

- Die drei neuen Routen stehen **vor** den bestehenden, die bestehenden sind unverändert. Die alte Route `InfoInhibitor|Watchdog` → `blackhole` bleibt stehen und ist für `Watchdog` jetzt unerreichbar, sie fängt weiterhin
  `InfoInhibitor` ab.
- `Watchdog` hat eigene Takte (`group_wait: 0s`, `group_interval: 1m`, `repeat_interval: 1m`), damit der Caller jede Minute einen Ping bekommt. Der Wachhund-Timeout am Caller ist 10 min, ein einzelner verspäteter Ping stört also nicht.
- `page=true` hat `continue: true`: Der Anruf kommt **zusätzlich** zu ntfy (`severity=critical`) und, beim Banana-Pi-Alarm, zu n8n. `send_resolved: false`, weil das Telefon bei Entwarnung nicht klingeln soll.
- Geprüft mit `amtool config routes test` gegen Alertmanager 0.32.1: `Watchdog` → nur `watchdog`; `page=true` + `critical` → `phone`, `ntfy`; Banana-Pi mit `page=true` → `phone`, `n8n-banana-pi-down`, `ntfy`; alles ohne `page` unverändert.
- Beide Receiver zeigen auf den Service des Callers im Cluster (`http://alert-caller.alert-caller.svc.cluster.local:9310/watchdog` und `/alert`). Läuft der Pod nicht, ruft Alertmanager jede Minute ins Leere (Warnung `AlertmanagerFailedToSendAlerts`, die nirgends zugestellt wird).
  Der Caller läuft vorerst **im selben Cluster**, ein Totalausfall führt deshalb zu keinem Anruf (Entscheidung, siehe 10020). Für eine externe VM zeigen die URLs auf deren Tailscale-IP. Der Weg Pod → Tailnet funktioniert dafür (Flannel maskiert auf die Tailnet-IP des Homeservers,
  mit `tcpdump` auf `tailscale0` nachgewiesen), die Pods kommen bei der Gegenstelle als `homeserver` an. Offen ist nur die ACL zur VM.
  Das relativiert die Aussage zum Alarmmonitor unter [Scrapes und Labels](#scrapes-und-labels): Der Pi wird per Push angebunden, weil seine Ports vom Homeserver aus nicht antworten, nicht weil der Pod-Pfad fehlt.

**Regeln in `vmrule-paging.yaml`** (alle vier am 2026-10-11 gegen den Live-VictoriaMetrics abgefragt, keine feuerte)

- Alle Ausdrücke nutzen das Label `host`, nicht `job` oder `instance`: Der DaemonSet-Scrape hat `job="node-exporter"`, die statischen Scrapes tragen ihren `jobName` (`prod-vm-node-exporter`, `ugreen-nas-node-exporter`), obwohl in der
  `VMStaticScrape` ein anderes `job` steht. `instance` ist beim DaemonSet IP:Port, bei den statischen Scrapes der Hostname. Nur `host` ist überall gleich.
- **`NodeDownPaging`** erfasst nur `homeserver`, `prod-vm` und `ugreen-nas`. Die Worker schlafen im Normalbetrieb (cordoned, `up == 0`), `entw-vm` läuft auf worker-1, `infotafel` ist ein Kiosk. Ohne den Filter hätte die Regel am Testtag
  vier Alarme geliefert. `homeserver` ist trotzdem drin: Es deckt den Fall, dass nur der Exporter ausfällt. Fällt der ganze Homeserver aus, sterben vmalert und Alertmanager mit, das erkennt der Watchdog.
- **`PodCrashLoopPaging`:** `group_left(reason)` ersetzt das Label `reason` der linken Seite (`CrashLoopBackOff`) durch die letzte Abbruchursache (`OOMKilled`, `Error`, …), weil `group_left` gleichnamige Labels der linken Seite überschreibt.
  Beim Test mit dem real abstürzenden `vlagent`-Pod wurde aus `CrashLoopBackOff` korrekt `Error`. Der Zweig `or on(namespace, pod, container)` liefert den Alarm trotzdem, falls es keine letzte Abbruchursache gibt, dann bleibt `reason` bei
  `CrashLoopBackOff`. Erfasst ist nur `vaultwarden`: Authentik, das zweite Ziel aus der Aufgabe, gibt es im Repo nicht mehr. Weitere Namespaces kommen in den Regex `namespace=~"…"` (beide Stellen).
- **`DiskFailurePaging`:** `smartctl_device_smart_status` ist 1 bei „bestanden“. `smartctl_device_critical_warning` gibt es nur bei NVMe. Beide Metriken tragen `host` und `device`. Ein schlafender Worker liefert nach dem Staleness-Zeitraum keine Reihe mehr und
  löst nichts aus.
- **`KubeApiDownPaging`:** `absent(up{job="apiserver"} == 1)` deckt „Ziel auf 0“ und „Ziel verschwunden“ ab. Die Default-Regel `KubeAPIDown` bleibt unverändert und geht weiter nur an ntfy.
- **Helm-Escaping:** vmalert-Platzhalter stehen in `templates/` als `{{`{{ $labels.host }}`}}`. Die Rohstring-Schreibweise braucht keine Maskierung der `"` in PromQL (`host="…"`), anders als die `{{ "…" }}`-Form der älteren Regeln.
- Die Annotationen `ansage`, `grund`, `kontext` und `kontext_text` liest nur der Caller. Der ntfy-Pfad kennt sie nicht und zeigt weiter `summary`.
**Webhook-Authentifizierung** (`argocd/apps/tech/monitoring/values.yaml`)

- Die drei Webhooks zum Caller (`watchdog` an Pod und Pi, `phone`) tragen `http_config.authorization.credentials_file`. Der Alertmanager liest den Token aus `/etc/vm/secrets/alert-caller-token/token`, das der Operator aus
  `spec.secrets: [alert-caller-token]` mountet. Der Token steht **nicht** in der Konfiguration, die inline im Repo liegt. ntfy-Bridge und n8n bleiben ohne Token.
- **Reihenfolge ist riskant:** Ein VMAlertmanager mit `spec.secrets`, dessen Secret fehlt, startet nicht (`ContainerCreating`), und dann fallen alle Alarme aus. Das SealedSecret liegt deshalb im selben Chart (`templates/sealedsecret-alert-caller-token.yaml`)
  und kommt im selben Sync. Der Sealed-Secrets-Controller entschlüsselt es binnen Sekunden, das Mounten wiederholt sich von selbst. Nach einer Änderung die Alertmanager-Logs und `amtool config show` prüfen.
- Der Token darf keinen Zeilenumbruch enthalten (`printf '%s'` beim Versiegeln, das Skript `scripts/seal-alert-caller-token.sh` tut das), sonst würde der Header ungültig.

## Regeln (VMRule)

| Regel | Begründung |
|---|---|
| `vmrule-paging` (Telefon-Alarm) | Die einzigen Regeln mit dem Label `page: "true"`. Begründungen je Regel: Abschnitt [Telefon-Alarm](#telefon-alarm). |
| `vmrule-argocd` (GitOps-Gesundheit) | Anlass: Die Sync-Operation von `monitoring` hing vom 2026-09-15 bis 2026-09-19 unbemerkt (sie wartete auf einen nie gesunden DaemonSet), aufgefallen ist es nur von Hand. Grundlage sind die Metriken des `application-controller` (`argocd_app_info` mit `health_status`, `sync_status`, `operation`, Scrape in `vmscrape-argocd.yaml`). Das Label `operation` ist leer, solange keine Sync-Operation läuft. Der Controller-Pod öffnet den Port `metrics` (8082) immer, und die NetworkPolicy `argocd-application-controller` erlaubt Zugriff aus jedem Namespace, dafür ist keine Änderung an ArgoCD nötig. Erfasst wird der **Hub (TECH + PROD)**, der separate ENTW-ArgoCD (eigener Cluster) nicht. Alle Alerts laufen über die vorhandene Route (Gotify + ntfy). |
| `vmrule-cronjobs` (Backups) | Alert, wenn der letzte **erfolgreiche** Lauf zu lange her ist. Bewusst **nicht** `kube_job_status_failed > 0`: Fehlgeschlagene Jobs bleiben in der Historie stehen und würden nach der Reparatur weiter feuern. Anlass: Die Authentik-Backups schlugen in den Nächten auf den 17. und 18.09.2026 fehl (`BackoffLimitExceeded`) und wurden nur zufällig bemerkt. Datensicherungen laufen täglich (nachts), nach **30 h** ohne Erfolg fehlt mindestens eine Sicherung. Gilt für den Hub-Cluster (TECH), `kube-state-metrics`-Daten anderer Cluster sind nicht enthalten. |
| `vmrule-banana-pi` (Ausfall des Alarmmonitors) | Host-Ebene, unabhängig vom App-Level-Heartbeat in alamos-apager (der nur ntfy auslöst). **`absent_over_time` statt `up == 0`:** Der Pi wird nicht vom Cluster gescrapt (Pods haben keinen Pfad zu Tailscale-Peers), sondern pusht seine Metriken per `remote_write`. Fällt er aus, wird `up` nicht auf 0 gesetzt (das setzte eine laufende Scrape-Verbindung voraus), die Zeitreihe hört einfach auf und gilt nach der Staleness-Frist als fehlend. `up == 0` würde deshalb **nie** feuern. `absent_over_time` erkennt „seit 10 Minuten kein einziger Sample mehr“ (Pi **oder** Push-Pfad down). `for: 10m` ist bewusst träge (deutlich über einem kurzen Reboot), damit nicht jeder Neustart ein Ticket erzeugt. `severity=critical` löst die bestehenden Routen (Gotify, ntfy) **und** die n8n-Route aus. |
| `vmrule-temperature` | Vorwarnung kurz vor dem Abschalten: Der heißeste Sensor eines Hosts (`max by (host)`, **eine** Meldung je Host statt einer je Sensor) liegt mindestens 3 Minuten lang bei 95 °C. Vorher stand die Schwelle bei 80 °C für 1 Minute, das löste bei den Lastspitzen des Homeservers dauernd aus (Begründung: [Lautstärke der ntfy-Meldungen](#lautstärke-der-ntfy-meldungen)). `severity: critical` geht an ntfy. Das eigentliche Herunterfahren bei 100 °C läuft **nicht** über diesen Alert, sondern über den lokalen `thermal_watchdog` auf dem Host, der auch dann noch funktioniert, wenn der Cluster wegen der Hitze schon klemmt ([60020](60020-ansible-rollen.md#thermal_watchdog-und-resource_watchdog)). |
| `vmrule-host-services` (`JournalUploadFailed`) | `node_systemd_unit_state{name="systemd-journal-upload.service", state="failed"} == 1` seit 15 Minuten, `severity: warning`. Anlass: Der Journal-Upload war auf dem Homeserver vom 2026-10-02 bis 2026-10-18 und auf worker-1 und beiden Pis ausgefallen, ohne dass es jemand merkte; die Host-Logs fehlten in VictoriaLogs. Als Metrik des node_exporter-Systemd-Collectors unabhängig von VictoriaLogs selbst. Warnstufe, weil `warning` nur im Alertmanager-Verlauf und nicht per ntfy ankommt (Abschnitt [Lautstärke der ntfy-Meldungen](#lautstärke-der-ntfy-meldungen)). Wiederherstellung: [60020](60020-ansible-rollen.md#journal_upload). |
| `vmrule-resources` | Reine Warnstufen (`severity: warning`, werden seit dem Entfernen von Gotify nirgends zugestellt). Die Shutdown-Schwellen für CPU/RAM (90 %) laufen **nicht** über Alertmanager, sondern über den lokalen `resource_watchdog`. |
| k3s-Komponenten | Regeln für controller-manager, scheduler und etcd sind **deaktiviert**: Sie laufen im einen k3s-Serverprozess und sind nicht als eigene Pods erreichbar (an `127.0.0.1` gebunden, kube-proxy ist eingebaut, k3s nutzt eine eingebettete SQLite-Datenbank, es gibt kein etcd). Gescrapt wird nur, was k3s tatsächlich exponiert. |

## Schreib-Endpunkte `vm-write` und `logs-write` (Basic-Auth)

Hosts außerhalb des Clusters schicken Metriken (`vmagent` → `https://vm-write.tech.homeserver/api/v1/write`) und Journal-Logs (`systemd-journal-upload` → `https://logs-write.tech.homeserver/insert/journald`) über Traefik in den Cluster. Beide Ingresses waren ohne jede Authentifizierung für das ganze LAN und Tailnet offen: Wer sie erreichte, konnte gefälschte Metriken (zum Beispiel `up`-Reihen) oder Log-Zeilen einspeisen oder den Speicher füllen. Eine IP-Allowlist scheidet aus, weil Traefik die Client-Adresse hinter dem ServiceLB nicht sieht ([Incident 024](60080-carplay-api-und-ios-app.md#absicherung)).

- **Traefik-Middleware `basicAuth`** je Namespace (`vm-write-auth` in `monitoring`, `logs-write-auth` in `logging`), Benutzerdatei als SealedSecret (`writeAuth.encryptedUsers` in den `values.yaml`). Die Middleware hängt per Annotation `traefik.ingress.kubernetes.io/router.middlewares` am Ingress und wird nur gerendert, wenn **`writeAuth.enabled: true` und** `encryptedUsers` gesetzt sind. Standard ist `false`: Der Code ist ausgerollt, ohne dass sich etwas ändert.
- **Zwei getrennte Zugänge** (`vm-writer`, `logs-writer`). `systemd-journal-upload` kann Zugangsdaten nur in der URL (`https://logs-writer:<pw>@…`) mitgeben und schreibt die URL bei Fehlern ins Journal; das Passwort kann also in den Logs landen. Ein Leck des Log-Zugangs gibt damit nicht den Metrik-Zugang frei. `/etc/systemd/journal-upload.conf` ist `0640 root:jupload-cred`, der Dienst bekommt die Gruppe per `SupplementaryGroups` (Drop-in `credentials.conf`).
- **Clients:** Rolle `vmagent` (`-remoteWrite.basicAuth.username`/`passwordFile`, Datei `/etc/vmagent/write-auth-password`, `0640 root:vmagent`) und Rolle `journal_upload` aus den Vault-Variablen `vault_vm_write_auth_user/_password` und `vault_logs_write_auth_user/_password` (per `default('')`: ohne Variablen bleibt alles wie vorher). Der Cluster-interne vmagent und der Log-Collector schreiben direkt auf die Services und sind nicht betroffen.
- **Reihenfolge ohne Lücke:** (1) `scripts/seal-write-auth.sh` erzeugt Zugangsdaten, versiegelt sie in beide `values.yaml` und schreibt die Vault-Variablen in eine Datei. (2) Merge, Vault-Variablen eintragen, Rollenläufe mit Tags `vmagent` und `journal-upload` auf allen Hosts (die Clients senden die Zugangsdaten, der Server ignoriert sie noch). (3) Prüfen: `curl -u vm-writer:<pw> -X POST https://vm-write.tech.homeserver/api/v1/write` liefert nicht `401`. (4) `writeAuth.enabled: true` in beiden `values.yaml`, Merge. Ab dann liefert der Aufruf ohne Zugangsdaten `401`. **Rollback:** `enabled: false`.

## Scrapes und Labels

| Ziel | Hintergrund |
|---|---|
| ugreen-nas (`192.168.178.97`) | Eigene UGOS-Firmware, nicht Teil des k3s-Clusters, daher kein `VMNodeScrape`/DaemonSet. Stattdessen zwei manuell auf dem NAS laufende Docker-Container (node-exporter und smartctl-exporter, [20000](../2-betrieb-hardware/20000-nas-storage.md), „Monitoring“) per `VMStaticScrape`. `host: ugreen-nas` und `kind: nas` sind der Filter der Hardware-Dashboards. |
| prod-vm (`.99`) und entw-vm (`.100`) | Eigenständige k3s-Cluster (kein Beitritt zu TECH), deshalb wie ugreen-nas/infotafel per `VMStaticScrape` als Gast-OS über `node_exporter` (Rolle, aktiviert in `prod.yml`/`entw.yml`, Port 9100) erfasst. Es sind Metriken aus Sicht des Gastes (CPU/RAM/Disk/Netz), die Sicht des Hypervisors (qemu-Prozess) liefert der jeweilige Host. `host` plus `kind: vm` sind der Dashboard-Filter. |
| infotafel (`192.168.178.98`, Xibo-Pi) | Hängt am normalen Heim-LAN, anders als der Vereinsheim-Pi (Tailscale-only, vmagent-Push). Der Cluster kann `node_exporter` deshalb direkt per `VMStaticScrape` scrapen. `instance: infotafel` matcht die eigenen Panels im „1002011-pis“-Dashboard, `host: infotafel` (`kind: pi`) die Hardware-Dashboards, kein weiterer Dashboard-Change nötig. |
| smartctl-Exporter (Port 9633) | Speist die Panels „Laufwerke“/„S.M.A.R.T.“. Das NAS hat seinen eigenen Exporter. **worker-0 ist nicht enthalten**: Der Node schläft laut `cluster_power_manager` den Großteil der Zeit, ein dauerhaft „down“ stehendes Target würde (wie beim node-exporter-Job) zusätzlich den `TargetDown`-Alert der Default-Regeln auslösen. Bei Bedarf `192.168.178.95:9633` (`host: worker-0`) ergänzen. `instance` ist hier der Hostname (wie bei den anderen Static-Scrapes), `host`/`kind` der einheitliche Dashboard-Filter. |
| Node-exporter-DaemonSet: `host`/`kind` | `host` (= k8s-Nodename) und `kind` tragen dieselben Labels wie die `VMStaticScrape`s der Nicht-Cluster-Hosts, damit alle Server einheitlich über `host` gefiltert werden. **`instance` bleibt bewusst IP:Port**, Alert-Regeln wie `worker-0Down` matchen darauf. Die Werte überschreiben die **komplette** Default-`spec` des Charts (Listen werden nicht gemergt), Selector und Endpoint stehen deshalb vollständig in den Values. |
| DaemonSet-Rollout mit schlafenden Workern | worker-0/worker-1 werden nur bei Bedarf geweckt und sind sonst absichtlich aus, für k8s dauerhaft „unreachable“. Jedes DaemonSet toleriert `unreachable`/`not-ready` **ohne** `tolerationSeconds` (Kubernetes-Default, nicht konfigurierbar), der alte Pod auf einem schlafenden Worker bleibt beim Chart-Update dauerhaft „Terminating“. Beim Default `maxUnavailable: 1` blockiert genau dieser eine Pod **jeden** weiteren Rollout, auch auf gesunden Nodes (homeserver), und die App bleibt dauerhaft „Progressing“ statt „Healthy“ ([d0000](../d-sicherheit/d0000-incident-2026-08-12.md), „Grafana zeigte nach Recovery nur noch UGREEN-NAS-Werte“). Fix: genug Unavailable-Budget, dass beide Worker gleichzeitig „stuck“ sein können, ohne den Rollout auf dem Homeserver zu blockieren. |
| Push-Endpunkt `vm-write` (`ingress-vm-write.yaml`) | Für Tailscale-only-Hosts, die ihre Metriken selbst pushen (aktuell nur der Vereinsheim-Pi), weil Pods keinen Pfad zu Tailscale-Peers haben. Freigegeben ist **nur** `/api/v1/write`, nicht die volle VictoriaMetrics-API (Query bleibt cluster-intern). Davor liegt **keine Auth**, der Schutz ist die LAN-/Tailscale-Netzwerkgrenze (gleiches Prinzip wie bei alamos-apager). `https://` ist Pflicht ([60020](60020-ansible-rollen.md#vmagent-node_exporter-und-smartctl_exporter)). |
| Relabeling beim Empfang (`configmap-vmsingle-relabel.yaml`) | VMSingle-`-relabelConfig` setzt `host`/`kind` für den Vereinsheim-Alarmmonitor. Der Pi bekommt beides nicht beim Scrapen (er pusht), und ein Ansible-Lauf gegen den produktiven Alarmmonitor soll dafür nicht nötig sein. Die vmagent-Rolle setzt beide Labels inzwischen selbst. Die Regeln greifen nur, solange `host`/`kind` **nicht** gesetzt sind (`host=""` = Label fehlt) und werden dann von selbst wirkungslos. Betroffen sind nur Serien mit `instance="vereinsheim-alarmmonitor"`, alle anderen laufen unverändert durch. |
| `maxConcurrentInserts: "16"` | Der Default ist an das CPU-Limit gekoppelt (hier 2 bei `1000m`). Ein Insert hält seinen Slot, solange der Client den Body noch sendet: Der über Tailscale pushende Vereinsheim-Pi (viele parallele vmagent-Queues, hängende http→https-Umleitung) belegte die Slots, sodass `vmalert` nicht mehr schreiben konnte (Alert `RemoteWriteDroppingData`, `vm_concurrent_insert_limit_reached_total` steigt). Die Requests sind klein und warten nur auf I/O, daher kaum Speicher-/CPU-Mehrbedarf. |
| Traefik-Metriken | Siehe [60040](60040-helm-charts-tech.md#traefik-metriken-und-helmchartconfig) (`traefik-metrics`-Service, `honorLabels`). |

## VictoriaMetrics und Grafana

- **Ein-Knoten-TSDB reicht** für einen Heimserver. Erst bei mehr als 1 Mio. aktiven Serien wäre `vmcluster` sinnvoll. Ein Limit verwirft Scrapes fehlerhafter
  Targets, statt den Speicher zu sprengen.
- **Speicher der VMSingle:** Lag auf `nas` (NFS), bis das UGREEN-NAS `all_squash` erzwang und VictoriaMetrics beim Öffnen bestehender Storage-Parts mit
  „permission denied“ abstürzte ([20000](../2-betrieb-hardware/20000-nas-storage.md)). TSDB-Daten sind reiner State, daher lokaler Storage (fest auf `homeserver`).
  Bewusst **ohne Datenmigration** neu aufgesetzt (nur 15 Tage Retention, Verdacht auf teilbeschädigte Parts durch die vorherigen Schreibfehler).
  `retentionPeriod` akzeptiert `h`/`d`/`w`/`y`, ein Wert **ohne Einheit** gilt als **Monate** (`15d`, nicht `15`).
- **CRDs:** `crds.plain: true` rendert die VictoriaMetrics-CRDs (`VMSingle`, `VMAgent`, `VMAlert`, `VMServiceScrape`, …) als normale Templates, weil ArgoCD den
  `crds/`-Ordner von Helm standardmäßig ignoriert. Beim Löschen des Charts bleiben die CRDs erhalten (sicherer Default). Die Admission-Webhook-Policy steht auf
  `Ignore`, um Sync-Loop-Races gegen den Operator-Webhook bei der Erstinstallation zu vermeiden. Prometheus-`ServiceMonitor` werden automatisch in
  `VMServiceScrape` konvertiert, damit Apps mit Prometheus-Monitoren ohne Umbau funktionieren. **Hand geschriebene** Monitore sind trotzdem `VMServiceScrape`,
  weil die CRD `monitoring.coreos.com/v1` im Cluster nicht installiert ist (Lehre aus der Authentik-Runde, dort erst nachträglich korrigiert).
- **Grafana:** Erreichbar unter `https://grafana.tech.homeserver` über Traefik. Das Admin-Passwort wird automatisch erzeugt und liegt im Secret `monitoring-grafana`
  (`kubectl -n monitoring get secret monitoring-grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo`). **Bewusst kein SSO** davor (Nutzerentscheidung
  22.08.2026, gilt unverändert, auch nach dem Entfernen von Authentik): keine wichtigen Daten hinter Grafana, der eigene Login reicht.
  Plugins: **Infinity** (direkte HTTP/JSON-Abfragen in Panels, für die Dashboards Pegelonline, DWD, ELWIS), die VictoriaLogs-Datasource und **Polystat** (Waben-Übersicht im
  Ordner „Hardware“).
- **Speicher:** 512Mi waren zu knapp (OOMKilled am 2026-09-19, RSS 488 MB beim Kill). Grafana 12 baut Suchindizes (bleve) im Speicher auf und startet vier Plugin-Prozesse
  (`gpx_*`), die im selben cgroup zählen.
- **Grafana-ServiceAccount liest nur ConfigMaps, in zwei Namespaces.** Das Grafana-Chart hängt an den ServiceAccount `monitoring-grafana` eine ClusterRole mit `get/list/watch` auf `configmaps` **und `secrets`** aller Namespaces, sobald ein Sidecar aktiv ist, und zwar unabhängig von `sidecar.*.resource`. Grafana ist über `grafana-tech.pke-lab.de` öffentlich, das Token liegt im Pod: Ein Fehler im Grafana-Prozess (Dateilesen, SSRF) hätte damit den Schlüssel von Sealed Secrets und alle Datenbankpasswörter des Clusters preisgegeben. Gegenmaßnahmen: `grafana.sidecar.dashboards/datasources.resource: configmap` (die Sidecars suchen keine Secrets mehr), `grafana.rbac.create: false` und eine eigene ClusterRole `monitoring-grafana-sidecar` mit nur `configmaps` samt eigenem Binding (`templates/rbac-grafana-sidecar.yaml`). Ein anderes Binding statt `rbac.useExistingClusterRole`, weil sich die `roleRef` eines bestehenden ClusterRoleBindings nicht ändern lässt. Die Dashboard-Suche ist von allen Namespaces auf `monitoring,pacman` begrenzt (dort liegen alle 72 ConfigMaps mit dem Label). Ein Dashboard in einem neuen Namespace braucht den Eintrag in `sidecar.dashboards.searchNamespace`. Das Token landet weiterhin auch im Grafana-Hauptcontainer, das Chart kann es nicht pro Container verteilen.
- **Dashboard-Ordner:** Der Sidecar lädt jede ConfigMap mit dem Label `grafana_dashboard=1` (in `monitoring` und `pacman`). `folderAnnotation` plus
  `provider.foldersFromFilesStructure` machen aus der Annotation `grafana_folder` einen echten Grafana-Ordner („Plattform (TECH)“, „Anwendungen (TECH)“, „Hardware“, „Kubernetes (TECH)“,
  „Monitoring-Stack“; live verifiziert 2026-09-20). Wird ein Ordner **umbenannt**, entsteht ein neuer Grafana-Ordner, der alte leere muss von Hand gelöscht werden.
- **`job-dashboard-folders`** sortiert die vom Chart `victoria-metrics-k8s-stack` gezogenen Standard-Dashboards („Kubernetes / …“ → „Kubernetes (TECH)“, „Node Exporter …“ →
  „Hardware“, „VictoriaMetrics …“/„Prometheus …“/„Alertmanager …“/„Grafana …“ → „Monitoring-Stack“) in eigene Ordner. Warum ein eigener Job: Der eingebaute Sync-Job unterstützt **keine**
  Ordner-Zuweisung pro Dashboard (geprüft gegen die deployte Chart-Version 0.91.2 und Upstream 0.92.1, `defaultDashboards.annotations` gilt nur global für alle). Der Job trägt die
  Annotation anhand des JSON-Feldes `.title` nachträglich ein (robuster als Key-Matching, das Titel-Präfix bleibt über Chart-Versionen stabil). **Hook-Weight 5** (größer als 0 des Sync-Jobs)
  stellt sicher, dass er erst **nach** dem Sync-Job läuft, sonst würde jeder Sync-Job-Lauf (bei jedem Helm-Upgrade) die Annotationen wieder zurücksetzen. Das Job-Image bündelt `kubectl` und
  `jq` (exakte Version unkritisch, nur `get`/`patch` auf ConfigMaps). **Tag `1.30.1` existiert auf Docker Hub nicht** (`ImagePullBackOff`, der Hook blockierte den ArgoCD-Sync von
  `monitoring` seit 2026-09-19), daher `1.30.14`.
- **`dashboardApps`** erzeugt je Eintrag ein Grafana-Dashboard (CPU/RAM/Pod-Restarts, bei `hasIngress` zusätzlich Request-Rate/Fehlerrate/Latenz):
  - Namespace = Ordnername für jede `argocd/apps/tech/<name>`-App (siehe `destination.namespace` im ApplicationSet), Ausnahmen nur für die unten ausgeschlossenen Apps.
  - **Nur Apps im TECH-Cluster**: PROD-/ENTW-Workloads werden von dieser VictoriaMetrics nicht gescrapt, ihre Dashboards blieben leer (am 2026-09-20 entfernt: demo-app, example-whoami,
    immich, mealie, nextcloud, paperless-ngx, tinyteller, wikijs, xibosignage, da nach PROD umgezogen).
  - `hasIngress: true` nur, wenn die App ein k8s-Ingress/IngressRoute definiert, es steuert das Panel „User Requests/s“ (`traefik_service_requests_total{service=~"^<namespace>-.*"}`). Nach
    dem Deploy gegen den Live-Cluster prüfen (`curl :9100/metrics` am Traefik-Pod oder Abfrage in Grafana), denn der Regex folgt Traefiks Namenskonvention und ist nicht gegen dieses Cluster bestätigt.
  - Bewusst ausgeschlossen: `github-release-watcher` und `wiki-docs-sync` (nur CronJobs, kein dauerhafter Pod), `zammad` (hat ein handgebautes Dashboard), `monitoring` (abgedeckt durch die
    `defaultDashboards` des Charts), `coredns-custom` und `traefik-config` (reine Konfiguration in `kube-system`).

---

## Logging (VictoriaLogs)

- Der Grafana-Sidecar im Namespace `monitoring` sucht per `searchNamespace: ALL` nach ConfigMaps mit dem Datasource-Label, daher findet er die VictoriaLogs-Datasource aus dem
  Logging-Chart.
- VictoriaLogs liegt wie VMSingle auf `local-path`, fest auf `homeserver`. Der Collector (DaemonSet, ein Pod pro Node) hängt bei einer URL **ohne Pfad** automatisch `/insert/native` an.
- Journal-Upload der Hosts: [60020](60020-ansible-rollen.md#journal_upload).
