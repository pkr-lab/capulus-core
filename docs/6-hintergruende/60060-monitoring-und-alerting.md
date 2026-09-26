# Monitoring und Alerting — Hintergründe

Begründungen zu `argocd/apps/tech/monitoring/` (VictoriaMetrics, Grafana, Alertmanager, Scrapes, Regeln), zum Logging-Stack und zu den
Anbindungen nicht-clusterinterner Hosts. Bedienung: [20060](../2-betrieb-hardware/20060-hardware-monitoring.md),
[20050](../2-betrieb-hardware/20050-gitops-und-backup-alerts.md), [300j0](../3-apps-workloads/300j0-logging.md).
Die Push-Seite auf den Hosts (Rolle `vmagent`) steht in [60020](60020-ansible-rollen.md#vmagent-node_exporter-und-smartctl_exporter).
Übersicht dieser Kategorie: [60000](60000-uebersicht.md).

---

## Alertmanager-Routing

Alle Alerts außer `InfoInhibitor`/`Watchdog` gehen an **gotify-bridge** (übersetzt Alertmanager-JSON in Gotifys Message-API, Token als Secret
`gotify-bridge-token`). Zusätzlich:

| Bedingung | Zusätzlicher Empfänger |
|---|---|
| `severity=critical` | ntfy `/Home-Lab` (iOS-Push, der Alertmanager-Webhook wird direkt von ntfy empfangen) |
| **nur** `alertname=BananaPiAlarmmonitorDown` | n8n-Webhook des Workflows „Banana-Pi-Down → Zammad-Ticket“ ([30020](../3-apps-workloads/30020-vereinsheim-alarmmonitor.md)) |

- Der Pfad ist **rein additiv**: Die anderen Alamos-Raspberry-Pis bekommen bewusst weiterhin **kein** Ticket pro Ausfall
  ([30010](../3-apps-workloads/30010-alamos-apager.md)), nur dieser eine Alertname bekommt den zusätzlichen Weg.
- **Warum explizite Geschwister-Routen:** Ein nacktes Top-Level-Receiver wird **nicht** mit einer passenden Kind-Route kombiniert, Alertmanager fällt nur darauf
  zurück, wenn gar keine Kind-Route passt. Der Fan-out „Default + critical (+ Banana Pi)“ ist deshalb als explizite Geschwister-Routen modelliert. Die
  Match-all-Route an gotify hat `continue: true` und fällt so zur nächsten passenden Route durch.
- **Reihenfolge:** Die n8n-Route (nur dieser Alertname) muss **vor** der `severity=critical`-Route stehen. Die hat kein `continue: true` und würde die Auswertung sonst
  dort beenden.

## Regeln (VMRule)

| Regel | Begründung |
|---|---|
| `vmrule-argocd` (GitOps-Gesundheit) | Anlass: Die Sync-Operation von `monitoring` hing vom 2026-09-15 bis 2026-09-19 unbemerkt (sie wartete auf einen nie gesunden DaemonSet), aufgefallen ist es nur von Hand. Grundlage sind die Metriken des `application-controller` (`argocd_app_info` mit `health_status`, `sync_status`, `operation`, Scrape in `vmscrape-argocd.yaml`). Das Label `operation` ist leer, solange keine Sync-Operation läuft. Der Controller-Pod öffnet den Port `metrics` (8082) immer, und die NetworkPolicy `argocd-application-controller` erlaubt Zugriff aus jedem Namespace, dafür ist keine Änderung an ArgoCD nötig. Erfasst wird der **Hub (TECH + PROD)**, der separate ENTW-ArgoCD (eigener Cluster) nicht. Alle Alerts laufen über die vorhandene Route (Gotify + ntfy). |
| `vmrule-cronjobs` (Backups) | Alert, wenn der letzte **erfolgreiche** Lauf zu lange her ist. Bewusst **nicht** `kube_job_status_failed > 0`: Fehlgeschlagene Jobs bleiben in der Historie stehen und würden nach der Reparatur weiter feuern. Anlass: Die Authentik-Backups schlugen in den Nächten auf den 17. und 18.09.2026 fehl (`BackoffLimitExceeded`) und wurden nur zufällig bemerkt. Datensicherungen laufen täglich (nachts), nach **30 h** ohne Erfolg fehlt mindestens eine Sicherung. Gilt für den Hub-Cluster (TECH), `kube-state-metrics`-Daten anderer Cluster sind nicht enthalten. |
| `vmrule-banana-pi` (Ausfall des Alarmmonitors) | Host-Ebene, unabhängig vom App-Level-Heartbeat in alamos-apager (der nur ntfy auslöst). **`absent_over_time` statt `up == 0`:** Der Pi wird nicht vom Cluster gescrapt (Pods haben keinen Pfad zu Tailscale-Peers), sondern pusht seine Metriken per `remote_write`. Fällt er aus, wird `up` nicht auf 0 gesetzt (das setzte eine laufende Scrape-Verbindung voraus), die Zeitreihe hört einfach auf und gilt nach der Staleness-Frist als fehlend. `up == 0` würde deshalb **nie** feuern. `absent_over_time` erkennt „seit 10 Minuten kein einziger Sample mehr“ (Pi **oder** Push-Pfad down). `for: 10m` ist bewusst träge (deutlich über einem kurzen Reboot), damit nicht jeder Neustart ein Ticket erzeugt. `severity=critical` löst die bestehenden Routen (Gotify, ntfy) **und** die n8n-Route aus. |
| `vmrule-temperature` | Warnung, wenn irgendein Sensor mindestens 1 Minute lang 80 °C erreicht (`for: 1m` entprellt kurze Sensor-Spitzen). `severity: critical` geht an Gotify **und** ntfy. Das eigentliche Herunterfahren bei 100 °C läuft **nicht** über diesen Alert, sondern über den lokalen `thermal_watchdog` auf dem Host, der auch dann noch funktioniert, wenn der Cluster wegen der Hitze schon klemmt ([60020](60020-ansible-rollen.md#thermal_watchdog-und-resource_watchdog)). |
| `vmrule-resources` | Reine Warnstufen (`severity: warning`, nur Gotify). Die Shutdown-Schwellen für CPU/RAM (90 %) laufen **nicht** über Alertmanager, sondern über den lokalen `resource_watchdog`. |
| k3s-Komponenten | Regeln für controller-manager, scheduler und etcd sind **deaktiviert**: Sie laufen im einen k3s-Serverprozess und sind nicht als eigene Pods erreichbar (an `127.0.0.1` gebunden, kube-proxy ist eingebaut, k3s nutzt eine eingebettete SQLite-Datenbank, es gibt kein etcd). Gescrapt wird nur, was k3s tatsächlich exponiert. |

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
- **CRDs:** `crds.plain: true` rendert die VictoriaMetrics-CRDs (`VMSingle`, `VMAgent`, `VMAlert`, `VMServiceScrape`, …) als normale Templates, weil ArgoCD den
  `crds/`-Ordner von Helm standardmäßig ignoriert. Beim Löschen des Charts bleiben die CRDs erhalten (sicherer Default). Die Admission-Webhook-Policy steht auf
  `Ignore`, um Sync-Loop-Races gegen den Operator-Webhook bei der Erstinstallation zu vermeiden. Prometheus-`ServiceMonitor` werden automatisch in
  `VMServiceScrape` konvertiert, damit Apps mit Prometheus-Monitoren ohne Umbau funktionieren. **Hand geschriebene** Monitore sind trotzdem `VMServiceScrape`,
  weil die CRD `monitoring.coreos.com/v1` im Cluster nicht installiert ist (Lehre aus der Authentik-Runde, dort erst nachträglich korrigiert).
- **Grafana:** Erreichbar unter `https://grafana.tech.homeserver` über Traefik. Das Admin-Passwort wird automatisch erzeugt und liegt im Secret `monitoring-grafana`
  (`kubectl -n monitoring get secret monitoring-grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo`). **Bewusst kein SSO** davor (Nutzerentscheidung
  22.08.2026, gilt nach der Authentik-Ablösung unverändert): keine wichtigen Daten hinter Grafana, der eigene Login reicht ([d0073](../d-sicherheit/d0073-authentik-sso.md)).
  Plugins: **Infinity** (direkte HTTP/JSON-Abfragen in Panels, für die Dashboards Pegelonline, DWD, ELWIS), die VictoriaLogs-Datasource und **Polystat** (Waben-Übersicht im
  Ordner „Hardware“).
- **Speicher:** 512Mi waren zu knapp (OOMKilled am 2026-09-19, RSS 488 MB beim Kill). Grafana 12 baut Suchindizes (bleve) im Speicher auf und startet vier Plugin-Prozesse
  (`gpx_*`), die im selben cgroup zählen.
- **Dashboard-Ordner:** Der Sidecar lädt jede ConfigMap mit dem Label `grafana_dashboard=1` (in allen Namespaces). `folderAnnotation` plus
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
