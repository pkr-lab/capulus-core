# Zentrales Logging (VictoriaLogs)

Bündelt zwei unabhängig gewachsene Teile zu einem Gesamtbild:

1. **Container-Logs** (bereits länger im Einsatz): `argocd/apps/tech/logging`
   deployt VictoriaLogs (single-node, Filesystem-Storage) plus
   `victoria-logs-collector` (DaemonSet), der auf jedem k3s-Node
   Container-/Pod-Logs einsammelt und weiterleitet.
2. **Host-journald** (neu, siehe [Anlass](#anlass)): `ansible/roles/journal_upload`
   pusht das systemd-Journal jedes Ansible-verwalteten Hosts — egal ob
   k3s-Cluster-Mitglied oder eigenständiger Kiosk-Pi — zusätzlich an
   dieselbe VictoriaLogs-Instanz.

Beides landet in derselben Grafana-Datasource "VictoriaLogs" (LogsQL),
Namespace `logging`.

## Inhaltsverzeichnis

1. [Anlass](#anlass)
2. [Architektur](#architektur)
3. [Cluster-Komponente: Helm Chart `logging`](#cluster-komponente-helm-chart-logging)
4. [Ansible-Rolle `journal_upload`](#ansible-rolle-journal_upload)
5. [Logs in Grafana abfragen](#logs-in-grafana-abfragen)
6. [Fehlerbehebung](#fehlerbehebung)

---

## Anlass

Bei einem Einsatzalarm am Vereinsheim-Alarmmonitor
([docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md](30020-vereinsheim-alarmmonitor.md))
wurde nachträglich versucht, per `journalctl` auf dem Pi zu rekonstruieren,
was zum Zeitpunkt des Alarms lief. Ergebnis: **das lokale journald reicht
nur ~3,5 Tage zurück** (täglicher Reboot + 20 MB Journal-Limit), der
Vorfall war zum Zeitpunkt der Analyse schon rausrotiert. Gleichzeitig gab
es bereits eine zentrale Log-Senke im Cluster (VictoriaLogs, siehe oben)
— die aber nur Container-Logs einsammelt, nicht das journald der
Ansible-Hosts selbst (auch nicht das der k3s-Nodes homeserver/worker-0/
worker-1: der Collector liest ausschließlich Pod-/Container-Logs über die
Container-Runtime, nicht `/var/log/journal`). `journal_upload` schließt
genau diese Lücke, für **alle** Ansible-verwalteten Hosts.

## Architektur

```
Ansible-Host (jeder: homeserver, worker-0/1, Kiosk-Pis)
  systemd-journal-upload (Paket systemd-journal-remote)
    │  liest lokales journald, --save-state (Cursor persistiert,
    │  ueberlebt Restarts ohne Duplikate/Luecken)
    ▼
  POST https://logs-write.tech.homeserver/insert/journald
    │  (Traefik Ingress, *.homeserver Wildcard-DNS, gleiches
    │  Netzwerkgrenzen-Prinzip wie vm-write/alamos-apager: kein Auth,
    │  Schutz ist LAN/Tailscale)
    ▼
  VictoriaLogs (Namespace logging, /insert/journald nativ unterstuetzt)
    │  Stream-Felder automatisch: _HOSTNAME, _SYSTEMD_UNIT, _MACHINE_ID
    │  Level automatisch aus PRIORITY
    ▼
  Grafana-Datasource "VictoriaLogs" (LogsQL)
```

Parallel dazu, unveraendert:

```
k3s-Node (homeserver, worker-0, worker-1)
  victoria-logs-collector (DaemonSet)
    │  liest Container-/Pod-Logs
    ▼
  http://logging-victoria-logs-single-server:9428/insert/native (cluster-intern)
```

## Cluster-Komponente: Helm Chart `logging`

Liegt unter `argocd/apps/tech/logging/`, automatisch von ArgoCD erkannt
(siehe [docs/b-kubernetes-gitops/b0010-argocd.md](../b-kubernetes-gitops/b0010-argocd.md)).

| Datei | Zweck |
|---|---|
| `values.yaml` | VictoriaLogs-Storage (14 Tage Retention, `local-path` fest an `homeserver` gepinnt, analog `vmsingle`) und Collector-Konfiguration |
| `templates/datasource-victorialogs.yaml` | Grafana-Datasource (ConfigMap mit `grafana_datasource: "1"`-Label, vom Sidecar in `monitoring` per `searchNamespace: ALL` gefunden) |
| `templates/ingress-journal-push.yaml` | **Neu** — externer Ingest-Endpunkt für `journal_upload`, siehe unten |

**Bewusst kein eigener Helm-Chart-Dependency für Loki/Promtail o. Ä.
hinzugefügt** — VictoriaLogs unterstützt das Journald-Push-Protokoll nativ
unter `/insert/journald` (siehe
[VictoriaLogs-Doku, Journald Setup](https://docs.victoriametrics.com/victorialogs/data-ingestion/journald/)),
ein zweites Log-Backend neben dem bereits laufenden wäre unnötige
Redundanz gewesen.

**`ingress-journal-push.yaml`:** exponiert **nur** `/insert/journald` auf
`logs-write.tech.homeserver` → `logging-victoria-logs-single-server:9428`.
Kein Auth vor diesem Endpunkt, wie bei `vm-write`/`alamos-apager` auch —
Schutz ist die LAN/Tailscale-Netzwerkgrenze, nicht Kryptografie.

## Ansible-Rolle `journal_upload`

`ansible/roles/journal_upload/` — in **allen** Playbooks eingebunden, die
einen Host provisionieren (`site.yml`, `worker-0.yml`, `worker-1.yml`,
`xibo-kiosks.yml`, `banana-pi-kiosks.yml`, `alarm-kiosks.yml`).

**Bewusst `systemd-journal-upload` (Paket `systemd-journal-remote`) statt
Promtail/Grafana Alloy/Vector:**

- **Promtail** wurde von Grafana eingestellt — aktuelle Loki-Releases
  liefern keine Binary mehr aus (letztes Release mit `promtail-linux-*`-
  Assets war vor der Migration zu Grafana Alloy).
- **Grafana Alloy** baut kein ARMv7 (nur `arm64`/`amd64`/`ppc64le`/`s390x`)
  — der Banana Pi M2 Ultra
  ([docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md](30020-vereinsheim-alarmmonitor.md))
  ist reines ARMv7/32-Bit, faellt also raus.
- **`systemd-journal-upload`** ist Teil von systemd selbst, kommt direkt
  aus den Debian/Ubuntu/Armbian-Paketquellen (kein Architektur-Problem,
  kein Versions-Pinning/Binary-Download wie bei `vmagent`), und
  persistiert seinen Cursor (`--save-state`, Chart-Default des
  mitgelieferten Units) — ein Neustart des Dienstes verliert oder
  dupliziert keine Zeilen.

| Key | Bedeutung |
|---|---|
| `journal_upload_enabled` | Kill-switch, Default `true` |
| `journal_upload_push_url` | Ziel-URL, Default `https://logs-write.tech.homeserver:443/insert/journald` (HTTPS **und** Port sind Pflicht, siehe unten) — bewusst ein **globaler** Default für alle Hosts (anders als `vmagent_remote_write_url`, das nur für Tailscale-only-Hosts gilt, siehe [ansible/roles/vmagent](30020-vereinsheim-alarmmonitor.md)) |

Die Rolle installiert nur das Paket, templated `/etc/systemd/journal-upload.conf`
(`[Upload]\nURL=...`) und aktiviert `systemd-journal-upload.service` — kein
eigenes systemd-Unit, kein dedizierter Nutzer, das Paket bringt beides
bereits mit.

**TLS, CA und Namensauflösung (Stand 2026-09-20):** Der TECH-Traefik
leitet HTTP global per `308` auf HTTPS um, und `systemd-journal-upload`
folgt keiner Weiterleitung. Bis dahin stand die URL auf `http://` — der
Dienst lief auf jedem Host in eine Fehlerschleife
(`Upload … failed with code 308`), und **von keinem Host kam je ein Journal
in VictoriaLogs an**. Die Rolle setzt jetzt:

- `URL=https://logs-write.tech.homeserver:443/insert/journald` (der Port ist Pflicht: ohne Port hängt `systemd-journal-upload` selbst `:19532/upload` an den Pfad und trifft `/insert/journald:19532/upload`, den VictoriaLogs nicht kennt; mit Port wird `/insert/journald/upload` getroffen), `ServerKeyFile=-`/`ServerCertificateFile=-` (kein Client-Zertifikat; sonst bricht der Dienst mit `could not load PEM client certificate` ab) und
  `TrustedCertificateFile=` auf die interne Root-CA
  (`docs/assets/homeserver-root-ca.pem` → `/usr/local/share/ca-certificates/homeserver-root-ca.crt`,
  gleiche Datei wie in den Kiosk-Rollen; `update-ca-certificates` läuft per Handler).
- Das Zertifikat hat **keine Wildcard**, nur die feste SAN-Liste in
  `argocd/apps/tech/cert-manager/templates/certificate-homeserver-wildcard.yaml`.
  `logs-write.tech.homeserver` musste dort ergänzt werden, sonst schlägt
  die Prüfung mit Hostname-Mismatch fehl. Ein neuer Endpunkt braucht immer
  einen Eintrag dort (cert-manager stellt das Zertifikat danach selbst neu aus).
- Einen festen `/etc/hosts`-Eintrag `192.168.178.94 logs-write.tech.homeserver`
  (`journal_upload_hosts_entry_*`), weil `worker-0`/`worker-1` `*.homeserver`
  nicht per DNS auflösen (kein dnsmasq als Resolver) und die Tailscale-only-Pis
  sonst von Split-DNS abhängen.

**Reihenfolge beim Ausrollen:** (1) Zertifikat-Änderung nach `main` mergen
und in ArgoCD synchronisieren; prüfen:
`echo | openssl s_client -connect 192.168.178.94:443 -servername logs-write.tech.homeserver 2>/dev/null | openssl x509 -noout -ext subjectAltName | grep logs-write`;
(2) erst dann die Hosts provisionieren (`--tags journal-upload`, siehe
Fehlerbehebung). Umgekehrt scheitert der Upload bis zum neuen Zertifikat
an der Hostname-Prüfung (harmlos, der Dienst versucht es weiter).
Nicht angebunden sind bewusst die PROD-VM und die ENTW-VM.

## Logs in Grafana abfragen

Grafana → Explore → Datasource "VictoriaLogs". LogsQL-Beispiele:

```logsql
# Alles vom Vereinsheim-Alarmmonitor
_HOSTNAME:"vereinsheim-alarmmonitor"

# Nur der Kiosk-Supervisor, letzte 24h
_HOSTNAME:"vereinsheim-alarmmonitor" AND _SYSTEMD_UNIT:"banana-pi-kiosk*"

# Alles mit PRIORITY <= 3 (error und schlimmer) uber alle Hosts
level:error OR level:crit OR level:alert OR level:emerg
```

Retention: 14 Tage (`values.yaml`, `victoria-logs-single.server.retentionPeriod`)
— deutlich mehr als die ~3,5 Tage, die das lokale journald auf den Kiosk-Pis
vorher bot.

## Fehlerbehebung

| Symptom | Check |
|---|---|
| Host taucht in Grafana/VictoriaLogs nicht auf | `systemctl status systemd-journal-upload` auf dem Host — läuft der Dienst? `journalctl -u systemd-journal-upload` — Verbindungsfehler zu `logs-write.tech.homeserver`? |
| `journalctl -u systemd-journal-upload`: `failed with code 308: Permanent Redirect` | Die Upload-URL steht noch auf `http://` — Rolle neu ausrollen (`journal_upload_push_url` ist `https://`). |
| `journalctl -u systemd-journal-upload`: Zertifikatsfehler / `SSL certificate problem` | (a) steht `logs-write.tech.homeserver` in der SAN-Liste des ausgelieferten Zertifikats (Befehl siehe Abschnitt Rolle)? Sonst `certificate-homeserver-wildcard.yaml` prüfen und ArgoCD syncen. (b) liegt `/usr/local/share/ca-certificates/homeserver-root-ca.crt` auf dem Host und zeigt `TrustedCertificateFile=` in `/etc/systemd/journal-upload.conf` darauf? |
| Worker: `Could not resolve host: logs-write.tech.homeserver` | `/etc/hosts`-Eintrag fehlt — Rolle ausrollen (`journal_upload_hosts_entry_enabled: true`). Die Worker lösen `*.homeserver` nicht per DNS auf. |
| Ausrollen auf einzelne Hosts | Homeserver: `ansible-playbook -i ansible/inventory/hosts.yml ansible/site.yml --limit homeserver --tags journal-upload`; Pi: `ansible-playbook … ansible/banana-pi-kiosks.yml --tags journal-upload`; worker: `… worker-1.yml --tags journal-upload` (jeweils mit `--vault-password-file`). |
| `logs-write.tech.homeserver` löst nicht auf / Timeout | Gleiche Checks wie bei `alamos-apager.prod.homeserver` (Wildcard-DNS, bei Tailscale-only-Hosts zusätzlich Split-DNS + Subnetz-Route), siehe [docs/3-apps-workloads/30010-alamos-apager.md, Fehlerbehebung](30010-alamos-apager.md#fehlerbehebung) |
| Dienst läuft, aber keine neuen Logs seit Neustart | `/var/lib/systemd/journal-upload/state` prüfen (Cursor) — bei sehr altem Cursor kann ein initialer Nachtrag laenger dauern, bis aktuelle Zeilen erscheinen |
| `journalctl -u systemd-journal-upload`: `Buffer space is too small to write entry` + `operation aborted by callback`, Dienst im Restart-Loop bis `Start request repeated too quickly`, **keine** State-Datei unter `/var/lib/private/systemd/journal-upload/` | Ohne State startet der Uploader am Journal-**Anfang** und schickt das ganze Alt-Journal (homeserver: ~5 GB) als einen Request — bricht ab, bevor je ein Cursor gespeichert wird (Vorfall 2026-09-24). Rolle ausrollen: sie setzt bei fehlender State-Datei den Startpunkt auf das Journal-Ende (`--tags journal-upload`). Manuell: Datei mit `LAST_CURSOR=<Ausgabe von journalctl -q -n 1 --show-cursor>` anlegen, **Besitzer = Besitzer des State-Verzeichnisses** (sonst `Failed to read state file: Permission denied`), dann `systemctl reset-failed systemd-journal-upload && systemctl start systemd-journal-upload`. |
| VictoriaLogs selbst down | `kubectl -n logging get pods`, `kubectl -n logging logs -l app.kubernetes.io/name=victoria-logs-single` |
| `helm template`/ArgoCD-Diff auf `ingress-journal-push.yaml` schlägt fehl | Service-Name `logging-victoria-logs-single-server` muss zum tatsächlichen Release-Namen passen (Release = Verzeichnisname `logging`, siehe `argocd/bootstrap/root-applicationset.yaml`) |

## Relevante Links

- [docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md](30020-vereinsheim-alarmmonitor.md) — Vorfall, der diese Rolle ausgelöst hat
- [docs/3-apps-workloads/30010-alamos-apager.md](30010-alamos-apager.md) — analoges Netzwerkgrenzen-Muster (`vm-write`/`alamos-apager`: kein Auth, Schutz per LAN/Tailscale)
- [VictoriaLogs — Journald Setup](https://docs.victoriametrics.com/victorialogs/data-ingestion/journald/)
- [VictoriaLogs — Quick Start](https://docs.victoriametrics.com/victorialogs/quickstart/)
