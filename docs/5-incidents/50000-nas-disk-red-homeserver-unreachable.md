# Incident-Report — 02.09.2026: NAS-Platte rot, homeserver aus Tailscale verschwunden

| Zeit/Status | Ereignis |
|---|---|
| ? | UGREEN NAS 4800 Plus zeigt eine der beiden RAID1-Platten als **rot** (Fehlerstatus) |
| ? | `homeserver` in Tailscale als **offline** angezeigt |
| ? | Vor Ort geprüft: Server läuft physisch, war aber nicht per SSH erreichbar |
| — | Nicht zuhause → keine SSH-Session möglich, Diagnose bisher nur Verdacht |

Noch **nicht verifiziert** (kein SSH-Zugriff während des Vorfalls) — dieses
Doc hält die Hypothese und die Schritte fest, die beim nächsten Zugriff
(vor Ort oder sobald Tailscale/SSH wieder geht) abzuarbeiten sind.

---

## Ursache (Hypothese)

`homeserver` bezieht PVCs mehrerer Apps per NFS vom NAS (StorageClass `nas`,
siehe [docs/2-betrieb-hardware/20000-nas-storage.md](../2-betrieb-hardware/20000-nas-storage.md)) — u. a. `n8n`,
`paperless-ngx`, `wikijs`, `mealie`, `minio`. Standard-NFS-Mounts sind
**hard mounts**: hängt der NFS-Server (Platte degradiert/Pool im Fehler-
zustand), blockieren Prozesse, die auf diese Mounts zugreifen, im
Kernel-I/O-Wait (`D`-State) — **unendlich**, nicht mit Timeout. Bei
genügend blockierten Prozessen/Kernel-Threads kann das den ganzen Node
so weit lahmlegen, dass auch `tailscaled` und `sshd` nicht mehr auf
Anfragen reagieren, obwohl der Rechner selbst läuft (Strom an, Ping
eventuell noch ok, aber keine Anwendungsebene mehr erreichbar) — das
erklärt "Tailscale zeigt offline, Server steht aber an".

Eine rote Platte im RAID1 bedeutet: Array läuft **degradiert** (nur noch
1 von 2 Spiegel-Platten gesund) — kein Datenverlust an sich, aber:
- kein Redundanz-Schutz mehr, fällt die zweite Platte auch aus → Datenverlust
- je nach Fehlerbild (SMART-Warnung vs. tatsächlicher I/O-Fehler der Platte)
  kann der NAS-Storage-Controller bei jedem Lese-/Schreibversuch auf die
  defekte Platte hängen bleiben/retryen, was NFS-Antwortzeiten massiv
  verschlechtert oder ganz blockiert — genau der Trigger für obiges
  Hard-Mount-Problem auf `homeserver`.

**Fazit:** Eine defekte Platte allein sollte bei RAID1 keinen Totalausfall
verursachen — die Kettenreaktion zum kompletten Erreichbarkeitsverlust von
`homeserver` läuft vermutlich über hängende NFS-Mounts, nicht über die
Platte selbst.

---

## Diagnose-Schritte (sobald wieder Zugriff — vor Ort oder per SSH)

1. **NAS zuerst:** UGOS → Speicher-Manager → welche Platte ist rot, SMART-
   Status im Detail. Grafana-Dashboard "Home Server Auslastung" prüfen
   (`smartctl_exporter`-Panel, siehe [docs/2-betrieb-hardware/20000-nas-storage.md#monitoring-grafana-home-server-auslastung](../2-betrieb-hardware/20000-nas-storage.md#monitoring-grafana-home-server-auslastung))
   — Health/Temperatur/Power-On-Hours der betroffenen Platte, plus
   Verlauf **vor** dem Ausfallzeitpunkt (Vorwarnung verpasst?).
2. **homeserver, sobald erreichbar:**
   ```bash
   uptime                       # war der Node durchgängig an, oder gab es einen Reboot?
   dmesg -T | grep -i nfs       # "nfs: server ugreen-nas not responding" o. ä.
   journalctl -u tailscaled --since "<Ausfallzeitpunkt>"
   journalctl -u ssh --since "<Ausfallzeitpunkt>"
   ps aux | awk '$8 ~ /^D/'     # hängende Prozesse im Uninterruptible-Sleep
   mount | grep nfs             # aktuelle Mount-Optionen (hard/soft, timeo)
   ```
3. Grafana-Verlauf `homeserver` (CPU/Load/IO-Wait) über den Ausfallzeitraum
   ansehen — Load-Spike + fehlende Metriken ab Ausfallzeitpunkt stützt die
   NFS-Hang-Hypothese.
4. Prüfen, ob `nas-storage`/`nfs-subdir-external-provisioner`-Pod in dieser
   Zeit ebenfalls Fehler zeigte (`kubectl -n nas-storage logs ...`, sobald
   Cluster wieder ansprechbar ist).

---

## Sofortmaßnahmen

- **Defekte Platte ersetzen**, RAID1-Rebuild starten (UGOS führt durch den
  Austausch-Assistenten). Bis dahin Array **degradiert** — Backup-Lauf
  (externe USB-Platte, siehe [docs/2-betrieb-hardware/20010-nas-backup.md](../2-betrieb-hardware/20010-nas-backup.md))
  zeitnah manuell anstoßen/verifizieren, falls der letzte planmäßige Lauf
  vor dem Vorfall lag.
- Falls Diagnose den NFS-Hang bestätigt: Mount-Optionen für die `nas`-
  StorageClass/den Provisioner auf `soft,timeo=<n>,retrans=<n>` statt
  `hard` prüfen — verhindert, dass ein NAS-Hänger den ganzen Node lahmlegt
  (Tradeoff: `soft` kann bei kurzen Hängern zu I/O-Fehlern in Apps führen,
  statt nur zu warten — Abwägung dokumentieren, falls umgesetzt).

---

## Langfristige Verbesserungen (Ideen)

- **Out-of-Band-Zugriff** auf `homeserver`, wenn Tailscale/SSH durch genau
  so einen Hang blockiert sind (Smart-Plug für Reboot-Option, oder ein
  zweiter, unabhängiger Fernzugriffsweg).
- **SMART-Alerting**: `smartctl_exporter` liefert die Daten bereits — noch
  kein Grafana-Alert/Benachrichtigung (siehe [docs/1-benachrichtigungen/](../1-benachrichtigungen/))
  auf `smartctl_device_smart_status != 1`, damit eine rote Platte nicht
  erst beim Totalausfall auffällt.
- **Tailscale-Alerting**: Benachrichtigung, wenn ein Node offline geht,
  statt es zufällig zu bemerken (Tailscale-Webhooks oder eigener
  Uptime-Kuma-Check auf `homeserver` über den Tailscale-Namen).

---

## Offene Punkte

- [ ] Diagnose-Schritte oben nach dem nächsten Zugriff abarbeiten,
      Hypothese bestätigen oder verwerfen.
- [ ] Betroffene Platte identifizieren und ersetzen, RAID1-Rebuild
      verifizieren.
- [ ] Falls bestätigt: Mount-Optionen (`hard` → `soft`) für `nas`-
      StorageClass evaluieren.
- [ ] SMART- und Node-Offline-Alerting einrichten.
