# GitOps- und Backup-Alerts

Zwei Regelgruppen im Monitoring-Chart melden Störungen, die bisher nur von Hand aufgefallen sind:
ArgoCD-Anwendungen, die nicht gesund werden oder hängen, und CronJobs (vor allem Datensicherungen), die
nicht mehr erfolgreich laufen. Beide laufen über die vorhandene Alertmanager-Route und erreichen damit
[Gotify](../1-benachrichtigungen/10000-gotify.md) und [ntfy](../1-benachrichtigungen/10010-ntfy.md).

Anlass waren zwei reale Vorfälle:

- Die Sync-Operation der App `monitoring` hing vom 2026-09-15 bis 2026-09-19 (sie wartete auf einen nie
  gesunden node-exporter-DaemonSet). Aufgefallen ist es von Hand.
- Die Authentik-Datensicherung schlug in den Nächten auf den 17. und 18.09. fehl (`BackoffLimitExceeded`; die
  Pod-Logs sind nicht mehr vorhanden, die Ursache ist daher nicht belegt). Kurz zuvor war ein Netzwerk-Startup-Race
  als Ursache für 0-Byte-Dumps gefunden worden (Kommentar im Backup-Chart). Erst der dritte Lauf gelang wieder;
  bemerkt wurde es nur zufällig in der Job-Historie.

## Geltungsbereich

Beide Gruppen gehören zur Hub-Instanz (TECH). Der **Hub-ArgoCD** verwaltet auch die PROD-Applications
(`prod-<app>`), sie sind mit erfasst. **Nicht** erfasst: die eigenständige ENTW-ArgoCD-Instanz (Trainingsumgebung) und
CronJobs im PROD-Cluster, etwa das Immich-Backup: in der Hub-VictoriaMetrics existieren nur die drei TECH-CronJobs
(`authentik-postgres-backup`, `vaultwarden-backup`, `github-release-watcher`, geprüft am 2026-09-20).

## ArgoCD ([vmrule-argocd.yaml](../../argocd/apps/tech/monitoring/templates/vmrule-argocd.yaml))

Grundlage ist `argocd_app_info` des application-controllers. Der Controller öffnet den Port `metrics` (8082)
immer, und seine NetworkPolicy erlaubt Zugriff aus jedem Namespace: nötig war nur ein
[`VMPodScrape`](../../argocd/apps/tech/monitoring/templates/vmscrape-argocd.yaml), keine Änderung an ArgoCD.

| Alert | Bedingung | Schwere |
|---|---|---|
| `ArgoAppDegraded` | `health_status` = `Degraded` oder `Missing`, seit 10 min | critical |
| `ArgoAppOutOfSync` | `sync_status` = `OutOfSync`, seit 1 h | warning |
| `ArgoAppProgressing` | `health_status` = `Progressing`, seit 30 min | warning |
| `ArgoSyncOperationStuck` | Label `operation` nicht leer (Sync läuft), seit 30 min | warning |
| `ArgoMetricsMissing` | `absent(argocd_app_info)`, seit 10 min | warning |

`ArgoMetricsMissing` ist der Totmannschalter: ohne Metriken schweigen alle anderen. Direkt nach dem Ausrollen
kann er kurz feuern, bis vmagent den neuen Scrape übernommen hat.

## CronJobs und Backups ([vmrule-cronjobs.yaml](../../argocd/apps/tech/monitoring/templates/vmrule-cronjobs.yaml))

Bewusst auf den **letzten erfolgreichen Lauf** und nicht auf `kube_job_status_failed`: fehlgeschlagene Jobs
bleiben in der Historie und würden nach der Reparatur weiter feuern.

| Alert | Bedingung | Schwere |
|---|---|---|
| `BackupJobStale` | CronJob mit `backup` im Namen, letzter Erfolg älter als 30 h | critical |
| `CronJobStale` | alle anderen CronJobs, letzter Erfolg älter als 36 h | warning |

Ausgesetzte CronJobs (`suspend: true`, z. B. der wöchentliche `zammad-cronjob-reindex`) sind ausgenommen. Die
Schwellen passen zu täglichen Nachtläufen (Authentik 01:45, Vaultwarden 01:30): eine ausgefallene Nacht meldet sich
am Vormittag danach. Erfasst sind nur CronJobs, die schon einmal erfolgreich waren; ein CronJob, der nie lief,
erzeugt keine Serie.

**Grenze:** die Regeln sehen nur, ob der Job erfolgreich *endete*. Ein „erfolgreicher“ Lauf mit leerem Dump
(so ein 0-Byte-Dump trat bei Authentik schon auf) fällt hier nicht auf; das prüfen die Skripte der Backups selbst.

## Geprüft

Vor dem Ausrollen gegen die laufende Hub-VictoriaMetrics: alle Ausdrücke parsen; `BackupJobStale` und
`CronJobStale` liefern für den Ist-Zustand keinen Treffer (Backups 10 h alt, Watcher 0,1 h), dieselben
Ausdrücke mit 1-h-Schwelle liefern Treffer, die Logik greift also. `absent(argocd_app_info)` trifft
erwartungsgemäß, solange der Scrape noch nicht deployt ist. Die ArgoCD-Metrik samt Labels
(`health_status`, `sync_status`, `operation`, `autosync_enabled`, `project`) wurde direkt am Controller-Port
geprüft. Die gerenderten Objekte bestehen `kubeconform` mit dem CRD-Katalog. **Nicht getestet** ist ein echtes
Feuern der ArgoCD-Alerts, da aktuell alle Applications gesund sind.
