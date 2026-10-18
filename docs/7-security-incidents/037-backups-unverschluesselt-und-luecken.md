# 037 Backups: Vaultwarden-Spiegel ohne Verschlüsselung und Versionierung, DB-Dumps nur für Immich, übrige Dienste nicht belegt

- Severity: Medium
- Bereich: Repo
- Betroffen: `argocd/apps/tech/vaultwarden` (CronJob `vaultwarden-backup`), `argocd/apps/prod/immich` (`immich-postgres-backup`), `docs/2-betrieb-hardware/20010-nas-backup.md`
- Status: Offen

## Beschreibung

Im Cluster laufen genau zwei Backup-CronJobs: `vaultwarden-backup` (TECH, täglich 01:30) und `immich-postgres-backup` (PROD, täglich 01:50), beide zuletzt erfolgreich am 2026-10-15. Der Vaultwarden-Job kopiert `db.sqlite3` per `sqlite3 .backup` und spiegelt den Rest des Datenverzeichnisses (`rsa_key*`, Anhänge, Sends, `config.json`) mit `rsync -a --delete` auf ein NFS-Volume des NAS, **unverschlüsselt und ohne Versionierung**: `mv` überschreibt die Vorgängerkopie, `--delete` überträgt Löschungen und Beschädigungen der Quelle am nächsten Lauf. Die Tresordaten sind clientseitig verschlüsselt (auch Anhänge und Sends), die Begleitdateien `rsa_key*` und `config.json` (SMTP-Zugang, ggf. Admin-Token) nicht.

Für Nextcloud, Paperless-ngx, Wiki.js, Zammad (PostgreSQL), Xibo (MariaDB), n8n (SQLite), Semaphore, lldap und Uptime Kuma gibt es im Cluster keinen Dump-Job. Die Doku beschreibt ein NAS-seitiges restic-Backup zu einem externen Ziel (`20010-nas-backup.md`). Das NAS ist nicht Teil dieses Auftrags: Funktion, Verschlüsselung und Wiederherstellbarkeit sind **ungeprüft**. Auf den Hosts selbst (homeserver, worker-1) gibt es keinen Backup-Timer außer `dpkg-db-backup`.

## Nachweis

```
$ kubectl get cronjobs -A
github-release-watcher  github-release-watcher  0 */2 * * *   OK 2026-10-16T18:00:10Z
vaultwarden             vaultwarden-backup       30 1 * * *    OK 2026-10-15T23:30:04Z
zammad                  zammad-cronjob-reindex   @weekly       suspend: true
$ ssh prod-vm 'sudo k3s kubectl get cronjobs -A'
immich          immich-postgres-backup   50 1 * * *     OK 2026-10-15T23:50:10Z
wiki-docs-sync  wiki-docs-sync           */15 * * * *

$ kubectl -n vaultwarden get cronjob vaultwarden-backup -o jsonpath='{...command}'
sqlite3 -readonly /source/db.sqlite3 ".backup '/backup/db.sqlite3.new'"
mv /backup/db.sqlite3.new /backup/db.sqlite3
rsync -a --no-owner --no-group --delete --exclude 'db.sqlite3*' ... /source/ /backup/
```

## Risiko / Angriffsszenario

Ransomware oder ein Fehler in einer Anwendung, die ihre Daten beschädigt, zerstört beim nächsten Lauf auch die einzige Backup-Generation von Vaultwarden. Wer das NFS-Volume mounten kann, liest die Begleitdateien und `config.json` im Klartext. Fehlende Dumps für Nextcloud, Paperless und Zammad machen Wiederherstellungen von Datenbank und Dateien nur über Volume-Snapshots des NAS möglich, deren Konsistenz ungewiss ist.

## Empfohlene Behebung

1. Vaultwarden: Backup verschlüsseln und versionieren, z. B. `restic` mit Passwort aus SealedSecret auf das NAS-Volume (inkrementell, Aufbewahrung 7 tägliche, 4 wöchentliche, 6 monatliche) oder `tar | age -r <Public-Key>`.
2. PostgreSQL/MariaDB/SQLite-Dumps (`pg_dump`, `mariadb-dump`, `sqlite3 .backup`) als CronJobs für alle Dienste mit Daten, Ergebnisse in dasselbe verschlüsselte Repository.
3. Alarm, wenn der letzte erfolgreiche Lauf älter als 36 Stunden ist (`docs/2-betrieb-hardware/20050-gitops-und-backup-alerts.md` beschreibt den Mechanismus für TECH; für PROD ergänzen).
4. Vierteljährlicher Restore-Test auf ENTW; Ziel der NAS-Sicherung (extern) mit Verschlüsselungs- und Schlüsselablage prüfen.

## Rollback

Neue Jobs entfernen; bestehende Jobs bleiben unverändert.

## Verifikation

```
kubectl get cronjobs -A
restic -r <repo> snapshots
restic -r <repo> check --read-data-subset=5%
```
Mehrere Snapshots je Dienst, Passwort nur im SealedSecret, Restore-Test dokumentiert.

## Risiko der Behebung

Niedrig: zusätzliche Jobs, keine Änderung an laufenden Diensten.

## Bearbeitungsstand (2026-10-18)

Nicht umgesetzt. Die Maßnahme führt ein neues Backup-System mit eigenem Verschlüsselungsschlüssel ein; dafür braucht es Entscheidungen und Geheimnisse, die ich nicht allein treffe (und `kubeseal` ist in dieser Umgebung gesperrt). Mein Entwurf, damit du nur noch zustimmen musst:

- **Ziel und Werkzeug:** `restic` auf das vorhandene NFS-Volume des NAS (`nas`-StorageClass, wie der Vaultwarden-Job). Repository-Passwort als SealedSecret `restic-password` je Namespace (zufällig, 32 Byte, in `ops/token-register.yaml` als `password` mit `max_age_days: 0`-Sonderfall, da ein Wechsel die Snapshots unlesbar macht, siehe Eintrag `restic` in `d0060`). Aufbewahrung `--keep-daily 7 --keep-weekly 4 --keep-monthly 6`.
- **Vaultwarden:** den bestehenden CronJob um `restic backup /source` ersetzen (Datenbank weiter per `sqlite3 .backup`, danach ins Repository). `vaultwarden_restore` (Rolle) müsste auf `restic restore latest` umgestellt werden; bis dahin den heutigen Weg parallel laufen lassen.
- **Weitere Dienste (Reihenfolge nach Schaden):** Zammad (`pg_dump`), Nextcloud (Datenbank-Dump plus Datenverzeichnis, liegt bereits auf dem NAS), Paperless (`document_exporter`), Wiki.js (`pg_dump`), Xibo (`mariadb-dump`), n8n (SQLite auf dem NAS: Kopie per `sqlite3 .backup`), Semaphore (BoltDB/SQLite), lldap (SQLite), Uptime Kuma (SQLite).
- **Alarm:** `time() - kube_job_status_completion_time > 36h` je Job; PROD-Variante ergänzen, wie in `20050-gitops-und-backup-alerts.md` beschrieben.
- **Restore-Test:** vierteljährlich auf ENTW, Ergebnis in `20010-nas-backup.md` eintragen.

Nächster Schritt: Sag, ob `restic` auf dem NAS-Volume in Ordnung ist und für welchen Dienst ich anfangen soll (Vorschlag: Vaultwarden). Das Repository-Passwort versiegelst du bitte selbst (`printf '%s' "$PW" | kubeseal --raw …`), ich bereite Chart und CronJob vor.

