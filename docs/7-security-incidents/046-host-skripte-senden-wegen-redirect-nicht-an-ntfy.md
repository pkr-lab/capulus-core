# 046 Host-Skripte melden seit 2026-09-13 nichts mehr an ntfy: der HTTP-Aufruf wird per 308 umgeleitet und nicht verfolgt

- Severity: Medium
- Bereich: Repo
- Betroffen: `ansible/roles/thermal_watchdog/files/thermal-watchdog.sh`, `ansible/roles/resource_watchdog/files/resource-watchdog.sh`, `ansible/roles/cluster_power_manager/files/cluster-power-manager.sh`, `ansible/roles/nightly_worker_wake/files/nightly-worker-wake.sh`; Ursache: `argocd/apps/tech/traefik-config/helmchartconfig.yaml` (Commit `a2fddac`, 2026-09-13)
- Status: Im Code behoben am 2026-10-18 (gestaged; wirkt erst nach dem Rollenlauf auf den Hosts, Weg auf dem homeserver getestet)

## Beschreibung

Die vier Skripte senden ihre ntfy-Meldungen per `curl --fail … "http://${NTFY_HOST}/${NTFY_TOPIC}" || true`. Der TECH-Traefik leitet HTTP seit 2026-09-13 global per `308` auf HTTPS um. `curl` folgt der Weiterleitung nicht (kein `-L`), `--fail` greift erst ab Status 400, und `|| true` verschluckt jeden Fehler. Die Meldungen erreichen ntfy deshalb nicht, ohne dass ein Skript oder eine Unit einen Fehler zeigt. Betroffen sind die Warnung und die Abschaltankündigung des Hitze- und Lastschutzes sowie die Meldungen von Stromverwaltung und nächtlichem Wake.

Die gleiche Ursache wurde für vmagent, `systemd-journal-upload` und die Semaphore-API bereits behoben (siehe `docs/6-hintergruende/60020-ansible-rollen.md`). Die ntfy-Skripte blieben liegen, weil ihr Fehler stumm ist. Aufgefallen ist es beim Test der Host-Skripte für Incident 002.

## Nachweis

```
$ curl -sI --resolve ntfy.tech.homeserver:80:<homeserver-ip> http://ntfy.tech.homeserver/Home-Lab-System | grep -iE '^(HTTP|location)'
HTTP/1.1 308 Permanent Redirect
Location: https://ntfy.tech.homeserver/Home-Lab-System

(Testmeldung mit dem Skriptweg von homeserver, worker-0, vereinsheim-alarmmonitor, infotafel; curl meldet Erfolg)
$ curl … "$ntfy/Home-Lab-System/json?poll=1&since=all"   (nur Titel und Alter)
keine der vier Testmeldungen im Cache
```
HTTPS mit gültigem Zertifikat funktioniert von homeserver, vereinsheim-alarmmonitor und infotafel (`ssl_verify=0`, `200`). Auf worker-0 fehlt die Homeserver-Root-CA (`ssl_verify=20`), worker-1 war ausgeschaltet und ungeprüft.

## Risiko / Angriffsszenario

Kein Angriff, sondern ein stiller Ausfall der Warnwege: Ein Host schaltet sich nach Überhitzung oder Überlast ab, ohne dass vorher oder nachher eine ntfy-Meldung kommt. Abgemildert wird das teilweise durch die Alertmanager-Regeln (zum Beispiel `HostHighTemperature` ab 95 °C), die über die ntfy-Bridge laufen. Die lokale Abschaltlogik funktioniert unabhängig davon weiter.

## Empfohlene Behebung

1. In den vier Skripten auf `https://` mit `--resolve "${NTFY_HOST}:443:${NTFY_IP}"` umstellen. Optional ein `-w '%{http_code}'`-Check mit Eintrag ins Journal (`logger`), damit ein Fehlschlag nicht mehr stumm bleibt.
2. Die Rolle `ntfy_publisher` deployt die Homeserver-Root-CA auf alle Hosts (wie `banana_pi_kiosk` es für die Pis tut), sonst scheitert die TLS-Prüfung auf worker-0 und worker-1.
3. Mit `DRY_RUN=1` je Host eine Testmeldung auslösen und in `Home-Lab-System` prüfen.

## Rollback

Die Skripte per `git revert` zurücksetzen und die Rolle neu ausrollen. Die zusätzliche CA im Systemspeicher schadet nicht.

## Verifikation

```
ssh <host> 'sudo systemctl edit --runtime thermal-watchdog'   (DRY_RUN=1, danach Dienst neu starten)
curl -s -H "Authorization: Bearer $READER_TOKEN" "https://ntfy-tech.pke-lab.de/Home-Lab-System/json?poll=1&since=all"
```
Die Testmeldung des Hosts muss im Ergebnis stehen.

## Risiko der Behebung

Niedrig: Eine fehlende CA lässt die Meldung wie heute stumm scheitern, ohne den Schutz selbst zu stören.

## Behebung (2026-10-18)

**Fix.**

- **Punkt 1, Skripte:** `thermal-watchdog.sh`, `resource-watchdog.sh` (zwei Stellen), `cluster-power-manager.sh` und `nightly-worker-wake.sh` senden per `https://${NTFY_HOST}/${NTFY_TOPIC}` mit `--resolve "${NTFY_HOST}:443:${NTFY_IP}"` und `--cacert "$NTFY_CA_FILE"` (Standard `/etc/ntfy-publisher/ca.pem`). `|| true` ist durch `|| logger -t <skript> "ntfy-Meldung fehlgeschlagen"` ersetzt: Ein Fehlschlag steht im Journal, die Abschaltlogik läuft weiter.
- **Punkt 2, CA:** Die Rolle `ntfy_publisher` legt `docs/assets/homeserver-root-ca.pem` als `/etc/ntfy-publisher/ca.pem` ab (Variable `ntfy_publisher_ca_src`). Bewusst nur diese Datei und nicht der System-Trust-Store: Das funktioniert auch auf worker-0 und worker-1 ohne `update-ca-certificates`.

**Nachweis** (vor dem Rollenlauf).

| Test | Ergebnis |
|---|---|
| `bash -n` aller vier Skripte | ok |
| `curl --resolve ntfy.tech.homeserver:80:… -d x http://ntfy.tech.homeserver/Home-Lab-System` (alter Weg) | `308` (der Fehler aus dem Incident) |
| `curl --resolve ntfy.tech.homeserver:443:… --cacert docs/assets/homeserver-root-ca.pem -d x https://…/Home-Lab-System` ohne Token (neuer Weg) | `403` (ntfy erreicht, anonym abgewiesen, wie gewollt) |
| neuer Skriptweg auf dem homeserver: `ca.pem` abgelegt, `curl` mit denselben Optionen und dem Publisher-Header aus `/etc/ntfy-publisher/auth-header`, Priorität 1 | `HTTP 200`, eine Testmeldung „[Test] Incident 046 Skriptweg“ in `Home-Lab-System` |
| `ansible-playbook … --syntax-check` (worker-1) | ok |

**Geänderte Dateien.**

- `ansible/roles/thermal_watchdog/files/thermal-watchdog.sh`, `ansible/roles/resource_watchdog/files/resource-watchdog.sh`, `ansible/roles/cluster_power_manager/files/cluster-power-manager.sh`, `ansible/roles/nightly_worker_wake/files/nightly-worker-wake.sh`
- `ansible/roles/ntfy_publisher/tasks/main.yml`, `ansible/roles/ntfy_publisher/defaults/main.yml`
- Doku: `docs/6-hintergruende/60020-ansible-rollen.md`

**Live-Stand.** Nur auf dem homeserver liegt `/etc/ntfy-publisher/ca.pem` bereits (von Hand, gleicher Inhalt wie die Rolle). Die laufenden Skripte verwenden noch die alte Fassung, bis die Rollen laufen.

**Rollback.** `git revert` und die Rollen neu ausrollen; die zusätzliche Datei `ca.pem` schadet nicht.

**Offen (du, Vault-Passwort nötig).** Ausrollen der geänderten Skripte und der CA auf allen Hosts, ohne Kiosk-Neustart (nur diese Tags):

```
ansible-playbook -i ansible/inventory/hosts.yml ansible/site.yml --tags ntfy-publisher,thermal-watchdog,resource-watchdog,cluster-power-manager,nightly-worker-wake --limit homeserver --ask-vault-pass
ansible-playbook -i ansible/inventory/hosts.yml ansible/worker-0.yml --tags ntfy-publisher,thermal-watchdog,resource-watchdog --ask-vault-pass
ansible-playbook -i ansible/inventory/hosts.yml ansible/worker-1.yml --tags ntfy-publisher,thermal-watchdog,resource-watchdog --ask-vault-pass
ansible-playbook -i ansible/inventory/hosts.yml ansible/banana-pi-kiosks.yml --limit vereinsheim-alarmmonitor --tags ntfy-publisher,thermal-watchdog,resource-watchdog --ask-vault-pass
ansible-playbook -i ansible/inventory/hosts.yml ansible/xibo-kiosks.yml --tags ntfy-publisher,thermal-watchdog,resource-watchdog --ask-vault-pass
```

Prüfen je Host: `sudo systemctl edit --runtime thermal-watchdog` mit `[Service]`/`Environment=DRY_RUN=1`, Dienst neu starten, in `Home-Lab-System` muss die Testmeldung `[DRY RUN]` des Hosts erscheinen. worker-1 und worker-0 sind oft ausgeschaltet, dann nach dem Einschalten.
