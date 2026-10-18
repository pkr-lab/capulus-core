# 040 Patchstand: worker-1 mit 61 offenen Updates und älterem Kernel, entw-vm wartet auf Reboot

- Severity: Low
- Bereich: worker1
- Betroffen: worker-1 (61 Pakete, Kernel 7.0.0-34), entw-vm (4 Pakete, Reboot nötig), worker-0 (ungeprüft)
- Status: Behoben am 2026-10-18 (Stand geprüft: Kernel und Sicherheits-Updates aktuell; worker-0 und Reboot-Alarm offen)

## Beschreibung

homeserver und prod-vm sind aktuell (0 bzw. 1 offenes Paket, aktuellster Kernel 7.0.0-38). worker-1 meldet 61 aktualisierbare Pakete (darunter curl/libcurl, libpng, libarchive, bind9-Bibliotheken, FreeType, librsvg) und läuft mit Kernel 7.0.0-34, während Version -38 auf dem homeserver bereits läuft. entw-vm hat 4 offene Pakete und eine Reboot-Pflicht. `unattended-upgrades` ist auf allen Hosts aktiv, spielt aber nur Sicherheits-Updates ein und startet nicht neu. worker-0 war zum Prüfzeitpunkt ausgeschaltet. Stand der Paketlisten: 2026-10-16 18:23 UTC (worker-1).

## Nachweis

```
$ ssh worker-1 'apt list --upgradable 2>/dev/null | tail -n +2 | wc -l; uname -r'
61
7.0.0-34-generic
$ ssh homeserver 'uname -r; apt list --upgradable 2>/dev/null | tail -n +2 | wc -l'
7.0.0-38-generic
0
$ ssh entw-vm 'ls /var/run/reboot-required; apt list --upgradable 2>/dev/null | tail -n +2 | wc -l'
/var/run/reboot-required
4
```

## Risiko / Angriffsszenario

Bekannte Schwachstellen in Bibliotheken und im Kernel bleiben bis zum nächsten Update-Lauf ausnutzbar. Das Risiko ist gering, solange das nächtliche Update-Fenster verlässlich läuft.

## Empfohlene Behebung

Nächtliches Update-Fenster abwarten oder manuell auslösen (`sudo apt-get update && sudo apt-get -y upgrade`), danach Neustart in einem Wartungsfenster (Worker `cordon`/`drain`, dann `reboot`). Mit `needrestart` oder einem Alarm auf `/var/run/reboot-required` den Neustartbedarf sichtbar machen.

## Rollback

Nicht erforderlich (Paket-Rollback über `apt install paket=version`).

## Verifikation

```
apt list --upgradable 2>/dev/null | tail -n +2 | wc -l
uname -r; ls /var/run/reboot-required
```
`0`, aktueller Kernel, keine `reboot-required`-Datei.

## Risiko der Behebung

Niedrig: Neustart der Worker fügt sich in das nächtliche Update-Fenster (`nightly-worker-wake`).

## Bearbeitung (2026-10-18)

Keine Änderung nötig, der Stand hat sich seit dem Audit durch die Neustarts und das Nacht-Update erledigt. Gemessen am 2026-10-18 (nur lesend, SSH als `ubuntu`):

| Host | offene Pakete | Kernel (läuft / neuester installiert) | `reboot-required` | Betriebszeit |
|---|---|---|---|---|
| homeserver | 0 | 7.0.0-38 / 7.0.0-38 | nein | 6 Tage |
| prod-vm | 0 | 7.0.0-38 / 7.0.0-38 | nein | 6 Tage |
| worker-1 | 16 (vorher 61) | 7.0.0-38 / 7.0.0-38 | nein | 1 Stunde |
| entw-vm | 0 (vorher 4) | 7.0.0-38 / 7.0.0-38 | nein | 1 Stunde |

Die ENTW-VM läuft (`virsh list`: `entw-vm` running). `unattended-upgrades` ist aktiv (`Update-Package-Lists "1"`, `Unattended-Upgrade "1"`).

**Die 16 verbleibenden Pakete auf worker-1** (`alsa-ucm-conf`, `dnsmasq-base`, `glycin-*`, `libmp3lame0`, `open-iscsi`, `open-vm-tools`, `snapd`, `tailscale`, `tzdata`, `ubuntu-release-upgrader-core` und weitere) sind keine Sicherheits-Updates, die `unattended-upgrades` einspielt. Ich habe sie nicht manuell installiert: `tailscale` und `snapd` starten bei der Installation ihre Dienste neu, `dnsmasq-base` gehört zu libvirt. Sie gehören ins Nacht-Update (`nightly-worker-update`, Semaphore-Template „Deploy worker-*“ mit `worker_apt_update`).

**Offen.**

- **worker-0** war zum Prüfzeitpunkt ausgeschaltet und ist ungeprüft; nach dem nächsten Einschalten dieselbe Messung.
- **Reboot-Hinweis sichtbar machen:** Der node_exporter liefert kein `node_reboot_required`. Ein Alarm bräuchte den Textfile-Collector mit einem kleinen Skript (`/var/run/reboot-required` prüfen); das ist eine eigene Ergänzung der Rolle `node_exporter` und ich habe sie nicht umgesetzt.

**Geänderte Dateien.** Keine.
