# Hardware-Monitoring (Grafana-Ordner "Hardware")

Drei Grafana-Dashboards zeigen den Zustand der gesamten Hardware: CPU, RAM,
Netzwerk, Datenträger (Füllstand, I/O, S.M.A.R.T.), Temperaturen und
Stromversorgung — für **homeserver, worker-0, worker-1, das UGREEN NAS, die
beiden KVM-VMs (prod-vm, entw-vm)** und die Raspberry Pis. Sie liegen im
Grafana-Ordner **Hardware** (`https://grafana-tech.pke-lab.de`) und lösen das
frühere Dashboard "Home Server Auslastung" ab.

Quellen im Repo: [argocd/apps/tech/monitoring/dashboards/hardware/](../../argocd/apps/tech/monitoring/dashboards/hardware),
[templates/dashboards-hardware.yaml](../../argocd/apps/tech/monitoring/templates/dashboards-hardware.yaml).

---

## Grafana-Ordner

| Ordner | Inhalt | Wie einsortiert |
|---|---|---|
| **Hardware** | die drei Dashboards oben + die "Node Exporter …"-Standard-Dashboards | `dashboards-hardware.yaml`; Node-Exporter-Dashboards per Hook-Job |
| **Kubernetes (TECH)** | "Kubernetes / …" (Compute Resources, Networking, Kubelet, …) — zeigen den TECH-Cluster | Hook-Job `monitoring-dashboard-folders` (nach Titel-Präfix) |
| **Monitoring-Stack** | VictoriaMetrics, Prometheus, Alertmanager, Grafana Overview | dito |
| **Plattform (TECH)** | Pro-App-Dashboards der Infrastruktur-Dienste (authentik, cert-manager, minio, semaphore, …) | `values.yaml` `dashboardApps` (`folder:`) |
| **Anwendungen (TECH)** | Pro-App-Dashboards der TECH-Anwendungen (n8n, vaultwarden, uptime-kuma, …), Zammad, Pacman, Pegel-Dashboard, "1002011-pis" | `dashboardApps` bzw. `grafana_folder`-Annotation im jeweiligen Template |

Apps, die nach PROD umgezogen sind (immich, nextcloud, paperless-ngx, mealie,
wikijs, xibosignage, tinyteller, demo-app, example-whoami), haben **keine**
Dashboards mehr: PROD/ENTW werden von diesem VictoriaMetrics nicht gescrapt,
die Dashboards blieben leer. Wer PROD-Monitoring aufbaut, ergänzt die Einträge
in `dashboardApps` wieder.

Ein umbenannter Ordner ist für Grafana ein **neuer** Ordner — der alte bleibt
leer stehen und muss von Hand gelöscht werden (Grafana → Dashboards → Ordner
→ Löschen).

---

## Die Dashboards

| Dashboard | uid | Wofür |
|---|---|---|
| **Hardware Übersicht** | `hardware-overview` | Einstieg: Waben (Server, Füllstand, Laufwerke), Tabelle aller Server, Verläufe |
| **Server-Detail** | `hardware-host` | Alles zu **einem** Server (Variable `Server`): CPU, RAM, Netzwerk, Datenträger, Temperaturen, Akku/Netzteil, S.M.A.R.T. |
| **Speicher & Laufwerke** | `hardware-storage` | Alle Dateisysteme inkl. NAS-Volumes, Prognose "Tage bis voll", RAID, S.M.A.R.T. aller Platten |

Die Dashboards verlinken sich gegenseitig (Kopfzeile). In den Tabellen führt
ein Klick auf einen Servernamen direkt ins Server-Detail.

### Waben (Polystat)

Die Sechsecke stammen aus dem Grafana-Plugin `grafana-polystat-panel`
(in `values.yaml` unter `grafana.plugins` installiert). Ein Sechseck je
Objekt, Farbe nach Schwellwert:

| Waben-Panel | Was ein Sechseck ist | Wert / Farbe |
|---|---|---|
| **Server** | ein Server / eine VM / das NAS / ein Pi | schlechtester Wert aus CPU-, RAM- und Dateisystem-Auslastung: grün < 70 %, gelb ≥ 70 %, rot ≥ 90 % |
| | *blau "schläft"* | Node ist gecordont **und** nicht erreichbar = absichtlich aus (`cluster_power_manager`, worker-0) |
| | *rot "offline"* | Node ist nicht erreichbar, aber nicht gecordont |
| **Füllstand** | ein Dateisystem | belegter Anteil: grün < 75 %, gelb ≥ 75 %, rot ≥ 90 % (sortiert: volle zuerst) |
| **Laufwerke** | eine physische Platte (S.M.A.R.T.) | Temperatur (gelb ≥ 45 °C, rot ≥ 55 °C); **rot "FAILED"**, wenn der S.M.A.R.T.-Selbsttest fehlschlägt |

> "Dateisysteme" ohne Boot-/Firmware-Partitionen: ausgeschlossen sind
> `/boot`, `/boot/efi`, die UGOS-Partitionen des NAS (`/rootfs`, `/ugreen`,
> `/mnt/factory`) und `/var/log*`. Der Filter steht als `FS_BASE`-Ausdruck in
> den Panel-Queries (Suche nach `mountpoint!~`).

### Was das Server-Detail zusätzlich zeigt

- **CPU nach Modus** (user/system/iowait/steal …), Load Average gegen Kerne,
  **Ressourcen-Druck (PSI)** für CPU/RAM/I/O — der ehrlichste Hinweis auf
  "zu wenig Ressourcen".
- **RAM** gestapelt (belegt/Buffers/Cache/frei), Swap und **OOM-Kills**.
- **Netzwerk** nur für physische Schnittstellen (`en*`, `eth*`, `wl*`;
  keine veth/bridge/bond): Durchsatz, Fehler/Drops, Link-Status,
  Geschwindigkeit und **Link-Abbrüche im Zeitraum** (Carrier-Changes) — der
  Indikator für Kabel-/Switch-/EEE-Probleme wie beim Link-Drop des
  homeserver am 2026-09-02 (siehe `ansible/roles/disable_eee`). Link-Status, -Geschwindigkeit und -Abbrüche
  erscheinen nur für Schnittstellen mit Traffic im gewählten Zeitraum
  (ungenutztes WLAN/`eth1` bleibt ausgeblendet).
- **Datenträger**: Füllstand je Dateisystem (auch Inodes), Durchsatz,
  Latenz und Auslastung je Platte.
- **Temperaturen** je Chip (`coretemp`/`k10temp` = CPU, `nvme` = SSD,
  `acpitz` = Mainboard, sonst PCI-Geräte) und alle Sensoren im Verlauf;
  **Akku/Netzteil** (nur homeserver — die Hardware ist ein Notebook und
  dient als Mini-USV).
- **S.M.A.R.T.-Tabelle**: Modell, Typ (NVMe = Protokoll; HDD = hat das
  Attribut `Spin_Up_Time`; sonst SATA-SSD), Größe, Health, Temperatur,
  Verschleiß (NVMe *Percentage Used* bzw. `100 −` schlechtester normalisierter
  Restwert bei SATA-SSDs), Betriebszeit, geschriebene Datenmenge,
  reallozierte/pending Sektoren, unkorrigierbare Fehler
  (`Reported_Uncorrect`/`Offline_Uncorrectable`), NVMe-Medienfehler.

### Speicher & Laufwerke

- **Alle Dateisysteme**: Größe, belegt, frei, Belegt-%, Inodes-% und
  **"Tage bis voll"** — lineare Prognose aus dem 7-Tage-Trend (nur bei
  schrumpfendem freien Platz; sonst "wächst nicht"). Rot < 14 Tage, gelb < 60 Tage.
- **Software-RAID (md)**: aktive/defekte/geforderte Platten und Resync-Fortschritt
  (aktuell nur das NAS: `md1` = Pool 1 im RAID1, `md2` = Pool 2).
- Geschriebene Datenmenge pro Stunde je Platte (SSD-Verschleiß), Füllstand-
  und Temperaturverläufe (Standardzeitraum 7 Tage, Retention 15 Tage).

---

## Datenquellen und Label-Schema

Alle Panels filtern über zwei Labels, die **jede** Quelle beim Scrapen
mitbekommt — nicht über `instance` (das ist bei den k3s-Nodes weiterhin
`IP:9100`, weil Alert-Regeln wie `worker-0Down` darauf matchen):

| Label | Werte | Zweck |
|---|---|---|
| `host` | `homeserver`, `worker-0`, `worker-1`, `ugreen-nas`, `prod-vm`, `entw-vm`, `infotafel`, `vereinsheim-alarmmonitor` | Name des Servers in den Dashboards |
| `kind` | `server`, `vm`, `nas`, `pi` | Typ-Spalte in der Übersicht |

| Host | node_exporter | S.M.A.R.T. | Wo definiert |
|---|---|---|---|
| homeserver, worker-0, worker-1 | DaemonSet `prometheus-node-exporter` (Relabeling `host` = k8s-Nodename, `kind: server`) | Ansible-Rolle [`smartctl_exporter`](../../ansible/roles/smartctl_exporter) (Port 9633) → `vmstaticscrape-smartctl.yaml` | [values.yaml](../../argocd/apps/tech/monitoring/values.yaml) `prometheus-node-exporter.vmScrape` |
| ugreen-nas | Docker-Container auf dem NAS (Port 9100) | Docker-Container (Port 9633), siehe [NAS-Storage](20000-nas-storage.md#monitoring-grafana-hardware-dashboards) | `vmstaticscrape-ugreen-nas.yaml` |
| **prod-vm** (192.168.178.99), **entw-vm** (192.168.178.100) | Ansible-Rolle [`node_exporter`](../../ansible/roles/node_exporter) (Port 9100) in `prod.yml`/`entw.yml` | — (virtuelle Platten, kein SMART) | `vmstaticscrape-vms.yaml` |
| infotafel (Pi) | `node_exporter` (Port 9100) | — | `vmstaticscrape-infotafel.yaml` |
| vereinsheim-alarmmonitor (Pi, nur Tailscale) | lokaler `vmagent` pusht per remote_write | — | [vmagent-Rolle](../../ansible/roles/vmagent) (setzt `host`/`kind` ab dem nächsten Lauf) **und** VMSingle-Relabeling [`configmap-vmsingle-relabel.yaml`](../../argocd/apps/tech/monitoring/templates/configmap-vmsingle-relabel.yaml) (setzt sie beim Empfang, solange sie fehlen) |

```
homeserver / worker-1 ──► node-exporter (DaemonSet, :9100) ─┐
homeserver / worker-1 ──► smartctl_exporter (systemd, :9633)─┤
prod-vm / entw-vm ──────► node_exporter (systemd, :9100) ────┼──► vmagent ──► VictoriaMetrics ──► Grafana
ugreen-nas ─────────────► node-exporter + smartctl (Docker) ─┤     (Label host/kind, siehe oben)
infotafel ──────────────► node_exporter (:9100) ─────────────┘
```

### Die beiden VMs

`prod-vm` und `entw-vm` sind eigenständige k3s-Cluster (siehe
[Multi-Cluster-Plan](../4-planung/40080-multi-cluster-entw-prod-tech.md)) und
gehören nicht zum TECH-Cluster. Sie tauchen deshalb wie das NAS als
**Gast-Betriebssystem** auf: CPU, RAM, Dateisystem und Netzwerk *aus Sicht der
VM*. Der `steal`-Anteil im CPU-Panel zeigt, wenn der Hypervisor der VM Rechenzeit
entzieht. **Nicht** enthalten ist die Sicht des Hypervisors (qemu-Prozess auf
homeserver/worker-1, z. B. der reale RAM-Verbrauch: der qemu-Prozess kann durch
den Page-Cache des Gastes bis zur vollen VM-Größe anwachsen, obwohl der Gast
selbst weniger "belegt" meldet); die Last der VM-Prozesse steckt aber in den
CPU-/RAM-Werten des jeweiligen Hosts.
Die Pods/Workloads *innerhalb* von PROD/ENTW werden aus TECH ebenfalls nicht
gescrapt.

---

## Ausrollen / Betrieb

Die Dashboards und Scrapes kommen per ArgoCD (App `monitoring`). Die Exporter
auf den Hosts müssen **einmalig per Ansible** installiert werden (Pakete
`prometheus-node-exporter` bzw. `smartmontools` + `prometheus-smartctl-exporter`,
beide aus dem Ubuntu-Repo, Dienste laufen per systemd):

```bash
# node_exporter in den beiden VMs
ansible-playbook -i ansible/inventory/hosts.yml ansible/prod.yml --tags node-exporter --ask-vault-pass
ansible-playbook -i ansible/inventory/hosts.yml ansible/entw.yml --tags node-exporter --ask-vault-pass

# S.M.A.R.T.-Exporter auf den physischen Nodes (worker-0 nur, wenn er gerade wach ist)
ansible-playbook -i ansible/inventory/hosts.yml ansible/site.yml     --tags smartctl-exporter --limit homeserver --ask-vault-pass
ansible-playbook -i ansible/inventory/hosts.yml ansible/worker-1.yml --tags smartctl-exporter --ask-vault-pass
ansible-playbook -i ansible/inventory/hosts.yml ansible/worker-0.yml --tags smartctl-exporter --ask-vault-pass
```

Ohne `--tags` installieren die Playbooks die Rollen ohnehin bei jedem
regulären Lauf mit (`make prod`, `make entw`, `make worker-1`, …). Prüfen:

```bash
curl -s 192.168.178.99:9100/metrics | head -3     # prod-vm
curl -s 192.168.178.100:9100/metrics | head -3    # entw-vm
curl -s 192.168.178.94:9633/metrics | grep '^smartctl_device_smart_status'   # homeserver
```

Die Ports sind per UFW nur aus dem LAN/Tailnet erreichbar (Regeln der
`common`-Rolle); die Metriken selbst sind nicht authentifiziert.

**Neuen Host aufnehmen:** `node_exporter` installieren (Rolle `node_exporter`
in dessen Playbook), ein `VMStaticScrape` nach dem Muster von
`vmstaticscrape-vms.yaml` anlegen (mit `host` **und** `kind`) — die Panels
finden ihn über das Label automatisch. Hat der Host physische Platten:
zusätzlich die Rolle `smartctl_exporter` und ein Ziel in
`vmstaticscrape-smartctl.yaml`.

**worker-0** ist bewusst *nicht* im S.M.A.R.T.-Scrape: der Node schläft laut
[Cluster Power Manager](20020-cluster-power-manager.md) meist, ein dauerhaft
"down" Ziel würde den `TargetDown`-Alert der Default-Regeln zusätzlich
auslösen (beim node-exporter-Job passiert das bereits). Wer seine Platten
sehen will, ergänzt `192.168.178.95:9633` (`host: worker-0`) in
`vmstaticscrape-smartctl.yaml`.

---

## S.M.A.R.T.-Metriken

Verwendet werden die Metriken des `smartctl_exporter` (v0.14.0, Ubuntu-Paket
und NAS-Container identisch):

| Metrik | Inhalt |
|---|---|
| `smartctl_device{model_name,protocol,…}` | Info-Metrik je Platte (Modell, Seriennummer, Firmware) |
| `smartctl_device_smart_status` | 1 = PASSED, 0 = FAILED |
| `smartctl_device_temperature` | Temperatur in °C |
| `smartctl_device_power_on_seconds` | Betriebszeit in **Sekunden** (nicht Stunden) |
| `smartctl_device_capacity_bytes`, `smartctl_device_rotation_rate` | Größe, Drehzahl (0 = SSD) |
| `smartctl_device_percentage_used`, `…_available_spare`, `…_media_errors`, `…_bytes_written` | NVMe: Verschleiß, Reserve, Medienfehler, geschriebene Daten |
| `smartctl_device_attribute{attribute_name,attribute_value_type}` | ATA-Attribute (`Reallocated_Sector_Ct`, `Current_Pending_Sector`, `Wear_Leveling_Count`, …) |

Hinweis: Attributnamen unterscheiden sich je Hersteller (z. B. heißt der
Pending-Zähler bei der Samsung-HDD in worker-1 `Total_Pending_Sectors`, sonst
`Current_Pending_Sector`; `smartctl_device_rotation_rate` liefert der Exporter
nicht für jede Platte). Das Attribut für den SATA-SSD-Verschleiß heißt je nach Hersteller
anders; die Tabelle deckt `Wear_Leveling_Count`, `Media_Wearout_Indicator`,
`SSD_Life_Left`, `Percent_Lifetime_Remain`, `Remaining_Lifetime_Perc` und
`Perc_Rated_Life_Used` ab. Fehlt der Verschleiß-Wert bei einer SSD, das
Attribut im `/metrics`-Output suchen (`curl … | grep attribute_name`) und die
Regex in der Query "Verschleiß" (`dashboards/hardware/*.json`) ergänzen.

---

## Bekannte Einschränkungen / Fehlersuche

| Symptom | Ursache / Lösung |
|---|---|
| **NAS: Laufwerke-Panels leer**, `smartctl_devices` = 5, aber kein `smartctl_device_*` | Stand 2026-09-20 liefert der smartctl-Container auf dem NAS zwar die Geräteanzahl, aber keine Werte je Platte (auch die früheren Panels waren dadurch leer). Auf dem NAS `docker logs smartctl-exporter` prüfen und `docker exec smartctl-exporter smartctl --json -a /dev/sda`; häufige Ursache: fehlender Gerätezugriff (`--privileged`, `-v /dev:/dev:ro` siehe [NAS-Storage](20000-nas-storage.md#monitoring-grafana-hardware-dashboards)) oder ein Gerätetyp, der `-d sat` braucht |
| Server fehlt in den Dashboards | Label `host` fehlt: `up{host="…"}` in Grafana Explore abfragen; bei k3s-Nodes prüfen, ob `kubectl -n monitoring get vmservicescrape monitoring-victoria-metrics-k8s-stack-prometheus-node-exporter -o yaml` die `relabelConfigs` enthält |
| `vereinsheim-alarmmonitor` fehlt in den Hardware-Dashboards | Der Pi pusht ohne `host`/`kind`; VictoriaMetrics ergänzt sie beim Empfang per `-relabelConfig` (ConfigMap `vmsingle-relabel`, Mount `/etc/vm/configs/vmsingle-relabel/`, nur für `instance="vereinsheim-alarmmonitor"`). Prüfen: `up{host="vereinsheim-alarmmonitor"}` in Grafana Explore; sonst ob das VMSingle-Pod mit dem Argument `-relabelConfig` läuft (`kubectl -n monitoring get pod -l app.kubernetes.io/name=vmsingle -o yaml`). Nur neue Datenpunkte bekommen das Label, ältere nicht. Sein eigenes Dashboard "1002011-pis" ist davon unabhängig |
| Waben-Panel zeigt "Panel plugin not found" | Plugin `grafana-polystat-panel` noch nicht installiert: Grafana-Pod nach dem Sync neu starten (Plugins werden beim Start geladen) |
| Dashboards neu / Ordner "Hardware" fehlt nach Sync | ArgoCD-Sync von `monitoring` hängt an einem Hook (`monitoring-dashboard-folders`): `kubectl -n argocd get app monitoring -o jsonpath='{.status.operationState.message}'`; ggf. mit `kubectl -n argocd patch application monitoring --type merge -p '{"status":{"operationState":{"phase":"Terminating"}}}'` beenden. Ursache am 2026-09-19/20: Image-Tag `alpine/k8s:1.30.1` existiert nicht → jetzt `1.30.14` |
| VM zeigt "Offline" obwohl sie läuft | `curl 192.168.178.99:9100/metrics` (bzw. `.100`) vom homeserver: läuft `prometheus-node-exporter` in der VM, lässt die UFW der VM das LAN zu? |
| Waben-Panel "Server": Node steht auf "offline" statt "schläft" | "schläft" erkennt das Panel am Cordon (`kube_node_spec_unschedulable`); ein absichtlich ausgeschalteter Node muss dafür gecordont sein (macht der `cluster_power_manager`) |
