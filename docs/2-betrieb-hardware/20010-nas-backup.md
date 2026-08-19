# NAS-Backup auf externe USB-Platte

Löst den in [docs/2-betrieb-hardware/20000-nas-storage.md → Backups auf externer NAS-Platte](20000-nas-storage.md#backups-auf-externer-nas-platte)
angekündigten Punkt ein: eine externe USB-Festplatte, direkt am UGREEN NAS
angeschlossen, sichert regelmäßig **beide** Storage-Pools (`volume1` und
`volume2`) — also sowohl den generischen Cluster-Storage
(`k8s-storage`, StorageClass `nas`) als auch den dedizierten
Immich-Storage (`immich-storage`, StorageClass `immich-nas`, siehe
[docs/3-apps-workloads/300c0-immich.md](../3-apps-workloads/300c0-immich.md)).

Wie bei der NFS-Einrichtung in docs/2-betrieb-hardware/20000-nas-storage.md gibt es dafür bewusst **kein**
Ansible-Playbook — UGOS ist eine eigene Firmware ohne SSH-Ansible-Support
für diese Art Task, die Einrichtung läuft über UGOS Task Scheduler +
Docker (Container Manager), analog zu den bereits dokumentierten
node_exporter/smartctl_exporter-Containern.

---

## Architektur

```
┌─────────────────────────────── UGREEN NAS (UGOS) ───────────────────────────────┐
│                                                                                   │
│   /volume1  (k8s-storage, RAID1, 2×4TB)  ──┐                                     │
│                                             ├──▶  restic backup  ──▶  externe    │
│   /volume2  (immich-storage)  ─────────────┘      (Docker-Container,             │
│                                                     via UGOS Task Scheduler)      │
│                                                            │                      │
│                                                            ▼                      │
│                                              USB-Platte (z.B. /volumeUSB1/...)   │
│                                              verschlüsseltes restic-Repository    │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **restic** statt rsync: inkrementell + dedupliziert (nur geänderte Blöcke
  werden übertragen/gespeichert), Snapshots mit Zeitstempel, eingebaute
  Verschlüsselung (relevant für Vaultwarden-/Immich-/Nextcloud-Daten auf
  der externen Platte), eingebaute Retention/Prune-Logik.
- Läuft **direkt auf dem NAS** als einmaliger `docker run`-Aufruf pro
  Snapshot, angestoßen durch die UGOS Task-Scheduler-Cron — nicht als
  CronJob im k3s-Cluster, weil die USB-Platte ein lokal am NAS
  angeschlossenes Gerät ist und nicht über NFS in den Cluster exportiert
  werden muss (spart einen unnötigen Netzwerk-Hop NAS→k3s-Node→NAS).

---

## Voraussetzungen

1. Externe USB-Platte am NAS angeschlossen, in UGOS unter
   **Speicher-Manager → Externe Geräte** formatiert (ext4 oder btrfs,
   keine NTFS-Berechtigungsprobleme unter Linux-Docker) und eingehängt.
   Den Mount-Pfad notieren — UGOS hängt externe Laufwerke typischerweise
   unter `/volumeUSB1/usbshare1` o. ä. ein; **exakten Pfad in UGOS unter
   Speicher-Manager prüfen**, das Beispiel unten ist ein Platzhalter.
2. Kapazität der USB-Platte ≥ tatsächlich genutzter Speicher auf
   `volume1` + `volume2` (nicht die Rohkapazität) **plus Puffer** für
   mehrere retinierte Snapshots (siehe [Aufbewahrung](#aufbewahrung-retention)
   unten — bei täglichen Backups mit restic-Dedup meist 20–40 % Aufschlag,
   nicht ein Vielfaches, da nur geänderte Blöcke zusätzlich Platz kosten).
3. Docker (Container Manager) auf dem NAS aktiv — bereits Voraussetzung
   für die Exporter in [docs/2-betrieb-hardware/20000-nas-storage.md → Monitoring](20000-nas-storage.md#monitoring-grafana-home-server-auslastung).

---

## Schritt 1 — restic-Repository einmalig anlegen

Passwort generieren und **sicher aufbewahren** (Passwort-Manager) — ohne
dieses Passwort ist das Backup nicht wiederherstellbar, auch nicht vom
NAS-Admin selbst:

```bash
openssl rand -base64 32
```

Repository auf der externen Platte initialisieren (Pfad an den echten
Mount-Punkt aus den Voraussetzungen anpassen):

```bash
docker run --rm \
  -v /volumeUSB1/usbshare1/nas-backup:/repo \
  -e RESTIC_REPOSITORY=/repo \
  -e RESTIC_PASSWORD='<generiertes-Passwort>' \
  restic/restic:latest init
```

---

## Schritt 2 — Backup-Skript für den UGOS Task Scheduler

**Systemsteuerung → Task Scheduler → Erstellen → Geplante Aufgabe →
Benutzerdefiniertes Skript.** Zeitplan siehe [Wie oft?](#wie-oft-empfehlungen)
unten, Skript-Inhalt:

```bash
#!/bin/sh
set -eu

REPO=/volumeUSB1/usbshare1/nas-backup   # ← an echten Mount-Pfad anpassen
PASSWORD='<generiertes-Passwort-aus-Schritt-1>'

docker run --rm \
  -v /volume1:/data/volume1:ro \
  -v /volume2:/data/volume2:ro \
  -v "$REPO":/repo \
  -e RESTIC_REPOSITORY=/repo \
  -e RESTIC_PASSWORD="$PASSWORD" \
  restic/restic:latest \
  backup /data/volume1 /data/volume2 \
  --exclude='/data/volume1/@eaDir' \
  --exclude='/data/volume2/@eaDir'

# Alte Snapshots gemäß Aufbewahrungsrichtlinie entfernen + Speicher freigeben
docker run --rm \
  -v "$REPO":/repo \
  -e RESTIC_REPOSITORY=/repo \
  -e RESTIC_PASSWORD="$PASSWORD" \
  restic/restic:latest \
  forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

> `@eaDir` sind UGOS/Synology-typische versteckte Thumbnail-/Metadaten-
> Verzeichnisse — Ausschluss spart Platz und vermeidet unnötige Backup-Last.
> Falls UGOS einen anderen Namen für diese Verzeichnisse verwendet, per
> `ls -la /volume1` prüfen und die `--exclude`-Pfade anpassen.

> **Read-only Mounts (`:ro`):** Der Backup-Container kann die
> Quell-Volumes nicht verändern — ein Bug im Skript kann bestenfalls die
> externe Platte, nie die Produktivdaten beschädigen.

**Task Scheduler → Einstellungen:** "Nur bei Fehler benachrichtigen"
zusätzlich per E-Mail/NAS-eigene Push-Funktion aktivieren, falls
verfügbar, damit ein fehlgeschlagener Backup-Lauf nicht unbemerkt bleibt.

---

## Wie oft? Empfehlungen

restic dedupliziert Blöcke — nach dem ersten vollständigen Backup kostet
ein weiterer Lauf nur die tatsächlich **geänderten** Daten, nicht die
komplette Datenmenge erneut. Häufigere Backups sind mit restic also
deutlich günstiger als bei klassischem rsync-Vollkopie-Ansatz. Drei
sinnvolle Optionen:

| Option | Zeitplan | Max. Datenverlust (RPO) | Wann sinnvoll |
|---|---|---|---|
| **Täglich (empfohlen)** | Jede Nacht, z. B. 02:00 Uhr | ≤ 24 Stunden | Standardfall — Immich-Fotos, Nextcloud-Dateien und Vaultwarden-Tresor ändern sich laufend, dank Dedup kostet der tägliche Lauf kaum mehr als ein wöchentlicher |
| **Zweimal wöchentlich** | z. B. Mi + So, 02:00 Uhr | ≤ 3–4 Tage | Kompromiss, falls die USB-Platte über eine langsame Schnittstelle (USB 2.0) angebunden ist und ein täglicher Lauf spürbar Last erzeugt |
| **Wöchentlich** | z. B. So, 03:00 Uhr | ≤ 7 Tage | Nur falls Kapazität/Performance der Platte stark eingeschränkt ist — höheres Risiko, eine ganze Woche Fotos/Dokumente bei einem Ausfall zwischen zwei Läufen zu verlieren |

**Empfehlung: täglich um 02:00 Uhr**, mit der Aufbewahrungsrichtlinie aus
Schritt 2 (7 Tage täglich, 4 Wochen wöchentlich, 6 Monate monatlich —
danach werden ältere Snapshots automatisch durch `forget --prune`
entfernt). Nachts, weil dann sowohl Cluster- als auch NAS-Last (SMB/NFS-
Zugriffe, Immich-Uploads) am geringsten sind.

### Aufbewahrung (Retention)

Die `--keep-*`-Flags in `forget` bestimmen, wie viele Snapshots erhalten
bleiben, unabhängig vom gewählten Backup-Intervall:

- `--keep-daily 7` — letzte 7 tägliche Snapshots
- `--keep-weekly 4` — dazu ein Snapshot pro Woche für die letzten 4 Wochen
- `--keep-monthly 6` — dazu ein Snapshot pro Monat für die letzten 6 Monate

Damit lässt sich z. B. eine versehentlich vor 3 Wochen gelöschte Datei
noch wiederherstellen, ohne dass die Platte mit täglichen Snapshots über
Monate hinweg vollläuft.

---

## Wiederherstellung

> **Vaultwarden-Redeploy:** Für den häufigsten Fall — die
> `vaultwarden-data`-PVC ist weg, die NAS-seitige `vaultwarden-backup`-PVC
> (gefüllt vom nächtlichen `backup-cronjob.yaml`) aber noch da — gibt es
> einen automatisierten Ansible-Weg, der nicht über restic/USB geht:
> [docs/3-apps-workloads/300a0-vaultwarden.md → Restore nach Redeploy / Disaster
> Recovery](../3-apps-workloads/300a0-vaultwarden.md#8-restore-nach-redeploy--disaster-recovery)
> (`make vaultwarden-restore FORCE_RESTORE=true`). Der restic-Restore hier
> unten bleibt der Fallback, falls auch der NAS-Stand selbst verloren ist.

**Einzelne Datei/Ordner** (z. B. ein aus Nextcloud gelöschtes Dokument):

```bash
docker run --rm \
  -v /volumeUSB1/usbshare1/nas-backup:/repo \
  -v /volume1:/restore-target \
  -e RESTIC_REPOSITORY=/repo \
  -e RESTIC_PASSWORD='<Passwort>' \
  restic/restic:latest \
  restore latest --target /restore-target/RESTORE \
  --include /data/volume1/k8s-storage/<pfad-zur-datei>
```

**Snapshots auflisten** (um einen bestimmten Zeitpunkt statt `latest` zu wählen):

```bash
docker run --rm \
  -v /volumeUSB1/usbshare1/nas-backup:/repo \
  -e RESTIC_REPOSITORY=/repo \
  -e RESTIC_PASSWORD='<Passwort>' \
  restic/restic:latest snapshots
```

**Vollständiger Restore** (z. B. nach Verlust von `volume1`): analog mit
`--target` auf den wiederhergestellten Mount-Punkt, ohne `--include`-Filter.

---

## Integritätsprüfung

Monatlich empfehlenswert (separater Task-Scheduler-Eintrag oder manuell),
prüft Metadaten + optional Datenintegrität des Repositories:

```bash
docker run --rm \
  -v /volumeUSB1/usbshare1/nas-backup:/repo \
  -e RESTIC_REPOSITORY=/repo \
  -e RESTIC_PASSWORD='<Passwort>' \
  restic/restic:latest check
```

---

## Hinweis: Konsistenz laufender Datenbanken

Der Backup-Task sichert `volume1`/`volume2` auf Dateisystem-Ebene, auch
während PostgreSQL-Container (Wiki.js, Zammad, Nextcloud, Immich, …)
aktiv darauf schreiben. Das entspricht dem Zustand nach einem
Stromausfall — PostgreSQL erholt sich davon dank WAL-basiertem
Crash-Recovery beim nächsten Start, es ist aber **kein**
transaktions-konsistenter Snapshot wie bei einem `pg_dump`. Für die
meisten Home-Lab-Fälle ist das ausreichend; falls später ein stärkeres
Konsistenz-Garantie gewünscht ist, lässt sich das Skript in Schritt 2 um
`pg_dump`-Aufrufe (z. B. via `kubectl exec`) vor dem `restic backup`
erweitern — bewusst nicht Teil dieser ersten Iteration.

---

## Fehlerbehebung

**Task Scheduler zeigt Fehler / Backup läuft nicht:**

```bash
# UGOS-Task-Log prüfen (Systemsteuerung → Task Scheduler → Aufgabe → Ergebnis anzeigen)
# Manueller Testlauf per SSH, um die konkrete Fehlermeldung zu sehen:
ssh admin@192.168.178.97
sh /pfad/zum/backup-skript.sh
```

**`restic: repository not found` / falsches Passwort:**

Pfad in `RESTIC_REPOSITORY` und das in Schritt 1 vergebene Passwort
gegenprüfen — beides muss exakt zum ursprünglichen `init`-Aufruf passen.

**USB-Platte nicht eingehängt nach NAS-Neustart:**

UGOS-Einstellung für automatisches Einhängen externer Geräte prüfen
(Speicher-Manager → Externe Geräte → Automatisch einhängen), sonst
schlägt der nächste geplante Task fehl, weil der Mount-Pfad fehlt.

---

## Relevante Links

- [restic-Dokumentation](https://restic.readthedocs.io)
- [NAS-Storage (UGREEN NAS)](20000-nas-storage.md)
- [Immich](../3-apps-workloads/300c0-immich.md)
- [Vaultwarden](../3-apps-workloads/300a0-vaultwarden.md)
