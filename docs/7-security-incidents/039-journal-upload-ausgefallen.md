# 039 systemd-journal-upload ist auf homeserver und worker-1 ausgefallen, Host-Logs erreichen VictoriaLogs nicht

- Severity: Low
- Bereich: worker1
- Betroffen: homeserver (seit 2026-10-16 06:07 CEST), worker-1 (seit Boot 17:49 UTC), `capulus-ansible/roles/journal_upload`
- Status: Behoben am 2026-10-18 (live repariert auf homeserver, worker-1, vereinsheim-alarmmonitor, infotafel; Drop-in, Alarm und Pi-Adresse im Code gestaged, wirken nach Merge bzw. Rollenlauf)

## Beschreibung

Der Dienst `systemd-journal-upload` ist auf beiden Hosts im Zustand `failed` (`Start request repeated too quickly`, Restart-Zähler 5, danach gibt systemd auf). Die Ziel-URL ist `https://logs-write.tech.homeserver:443/insert/journald`. Damit gelangen SSH-Anmeldungen, sudo-Aufrufe und Kernelmeldungen nicht in die zentrale Protokollierung, und Sicherheitsereignisse sind nur noch auf den Hosts selbst vorhanden (Journal persistent, 818 MB bzw. 167 MB). Auf dem homeserver dauert der Ausfall seit etwa 14 Stunden; der Auslöser ist aus den Journalzeilen allein nicht erkennbar (Netzwerk beim Start, Zertifikat oder Endpunkt).

## Nachweis

```
$ ssh homeserver 'systemctl status systemd-journal-upload --no-pager | grep -E "Active|Main PID"'
   Active: failed (Result: exit-code) since Fri 2026-10-16 06:07:35 CEST; 14h ago
   Main PID: 179603 (code=exited, status=1/FAILURE)
$ ssh worker-1 'systemctl status systemd-journal-upload --no-pager | grep -E "Active"'
   Active: failed (Result: exit-code) since Fri 2026-10-16 17:49:56 UTC; 50min ago
$ ssh homeserver 'cat /etc/systemd/journal-upload.conf'
[Upload]
URL=https://logs-write.tech.homeserver:443/insert/journald
TrustedCertificateFile=/usr/local/share/ca-certificates/homeserver-root-ca.crt
```

## Risiko / Angriffsszenario

Angriffsspuren (Login-Versuche, sudo-Nutzung) liegen nicht mehr zentral und manipulationssicher vor und lösen keine Alarme aus. Ein Angreifer mit Root-Rechten löscht lokal das Journal.

## Empfohlene Behebung

1. Ursache klären: `sudo journalctl -u systemd-journal-upload -n 50`, Erreichbarkeit von `logs-write.tech.homeserver` und Vertrauen in die interne CA testen.
2. Unit mit dauerhaftem Neustart betreiben (Drop-in):
   ```
   [Unit]
   StartLimitIntervalSec=0
   [Service]
   Restart=always
   RestartSec=30
   ```
3. Alarm einrichten, wenn `up{job="journal-upload"} == 0` oder seit 15 Minuten keine neuen Zeilen eines Hosts in VictoriaLogs ankommen.

## Rollback

Drop-in löschen (`systemctl revert systemd-journal-upload`).

## Verifikation

```
systemctl is-active systemd-journal-upload
```
`active`; in Grafana/VictoriaLogs erscheinen aktuelle Zeilen des Hosts.

## Risiko der Behebung

Niedrig.

## Behebung (2026-10-18)

**Ursachen** (zwei verschiedene):

1. **Homeserver und worker-1:** Der Upload-Cursor stand auf dem 2026-10-02, danach hatten sich 1,29 Millionen Einträge angesammelt. `systemd-journal-upload` sendet das Backlog in einem Request und bricht mit „Buffer space is too small to write entry“ / „operation aborted by callback“ ab, ohne den Cursor zu bewegen; nach fünf schnellen Fehlschlägen gibt systemd auf. (Derselbe Mechanismus wie der Vorfall vom 2026-09-24 in `60020`.)
2. **vereinsheim-alarmmonitor und infotafel:** `/etc/hosts` zeigte `logs-write.tech.homeserver` auf `127.0.0.1` (Rollen-Default für den Homeserver und die k3s-Knoten). Auf den Pis läuft dort nichts: „Failed to connect … port 443“. Auch DNS hilft nicht, weil der Homeserver denselben Eintrag aus seiner eigenen `/etc/hosts` über dnsmasq/Pi-hole an alle Clients ausliefert.

**Live-Reparatur.**

- homeserver und worker-1: Cursor in `/var/lib/systemd/journal-upload/state` auf das aktuelle Journal-Ende gesetzt (Backup `/root/journal-upload-state.bak-<zeit>`), `reset-failed`, Neustart. Die Logs der Zwischenzeit liegen lokal weiter im Journal, in VictoriaLogs fehlen sie.
- vereinsheim-alarmmonitor und infotafel: Eintrag in `/etc/hosts` auf `192.168.178.94` gesetzt (Backup `/etc/hosts.bak-039-<zeit>` am Alarmmonitor), `reset-failed`, Neustart.

**Fix im Code.**

- `capulus-ansible/roles/journal_upload`: Drop-in `restart.conf` (`StartLimitIntervalSec=0`, `Restart=always`, `RestartSec=30`).
- `capulus-ansible/group_vars/banana_pis.yml` und `xibo_displays.yml`: `journal_upload_hosts_entry_ip: "192.168.178.94"`.
- `argocd/apps/tech/monitoring/templates/vmrule-host-services.yaml`: Alarm `JournalUploadFailed` (Metrik `node_systemd_unit_state`, 15 Minuten, `severity: warning`).

**Nachweis.**

| Test | Ergebnis |
|---|---|
| `systemctl is-active systemd-journal-upload`, `NRestarts` nach der Reparatur | `active`, `0` auf allen vier Hosts |
| VictoriaLogs-Abfrage `_time:3m AND _HOSTNAME:homeserver` / `worker-1` | aktuelle Journal-Zeilen (tailscaled, k3s, systemd) |
| `curl --resolve logs-write.tech.homeserver:443:192.168.178.94 -X POST https://…/insert/journald/upload` vom Pi | `400` (Endpunkt erreicht, Antwort auf den leeren Request) |
| `ansible-playbook … banana-pi-kiosks.yml --syntax-check`, `helm template monitoring` | ok, `JournalUploadFailed` im Rendering |

**Geänderte Dateien.**

- `capulus-ansible/roles/journal_upload/tasks/main.yml`, `capulus-ansible/group_vars/banana_pis.yml`, `capulus-ansible/group_vars/xibo_displays.yml`
- `argocd/apps/tech/monitoring/templates/vmrule-host-services.yaml` (neu)
- Doku: `docs/6-hintergruende/60020-ansible-rollen.md`, `docs/6-hintergruende/60060-monitoring-und-alerting.md`

**Rollback.** Drop-in `/etc/systemd/system/systemd-journal-upload.service.d/restart.conf` löschen, `systemctl daemon-reload`; Pi-Eintrag in `/etc/hosts` auf das Backup zurücksetzen; die VMRule per `git revert` entfernen.

**Offen.**

- Der nächste Rollenlauf auf den Pis (kein Kiosk-Neustart durch diese Rolle) legt Drop-in und Hosts-Eintrag an. Bis dahin ist der Eintrag von Hand gesetzt und gleich.
- Eine Unterbrechung des Log-Endpunkts über mehrere Stunden kann den Fehler wieder auslösen (Backlog zu groß). Der Alarm meldet es; ein automatisches Zurücksetzen des Cursors habe ich bewusst nicht eingebaut, weil es Logs verwirft.
- Der VictoriaLogs-Collector-Pod `logging-victoria-logs-collector` steht seit Wochen im CrashLoop (Restarts > 750); das betrifft die Pod-Logs, nicht diesen Fund, ist aber ein eigener Fehler.
