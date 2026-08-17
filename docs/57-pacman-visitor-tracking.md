# pacman — Besucher-Tracking (IP/GeoIP) für die Schulung

`argocd/apps/workloads/pacman/` liefert neben dem eigentlichen Spiel
(siehe [dessen README](../argocd/apps/workloads/pacman/README.md)) auch
eine bewusst sichtbare Demonstration dessen, was ein gewöhnlicher
Webserver über einen Besucher herausfindet — Client-IP (v4 **und** v6),
User-Agent und (optional) der aus der IP abgeleitete GeoIP-Standort. Zweck
ist eine IT-Security-Schulung mit informierten, einverstandenen
Teilnehmenden (vgl. den bewussten Seitenhieb "IT-Security kennen wir
nicht!" in `argocd/apps/workloads/demo-app/`) — **kein** heimliches
Tracking von Endnutzern.

> **Datenschutz-Hinweis:** IP-Adressen sind personenbezogene Daten. Dieses
> Setup ist nur für einen abgegrenzten Schulungskontext mit informierten
> Teilnehmenden gedacht, nicht für den produktiven Betrieb einer
> öffentlichen Seite ohne Hinweis. Aufbewahrung ist an die
> VictoriaLogs-Retention gekoppelt (`argocd/apps/platform/logging/values.yaml`,
> aktuell 14 Tage) — es gibt keine zusätzliche, längerfristige Speicherung.

## Architektur

```
Besucher (IPv4/IPv6)
  → Cloudflare Edge (setzt CF-Connecting-IP)
  → cloudflared (Tunnel)
  → Traefik (Ingress, Host-Header-Routing)
  → pacman-server (Go, siehe server/cmd/server/main.go)
      - liest CF-Connecting-IP (Fallback: X-Forwarded-For, dann TCP-Peer)
      - optional: GeoIP-Lookup gegen lokale DB-IP-City-Lite-DB
      - loggt eine JSON-Zeile pro Request nach stdout
  → victoria-logs-collector (DaemonSet, liest Container-stdout)
  → VictoriaLogs (argocd/apps/platform/logging/)
  → Grafana-Dashboard "pacman — Besucher (IP/GeoIP)"
```

Warum `CF-Connecting-IP` und nicht nur `X-Forwarded-For`: Cloudflare setzt
diesen Header einmalig und verbindlich an seiner Edge auf die tatsächliche
Client-IP (v4 oder v6) — im Gegensatz zu `X-Forwarded-For`, das über
mehrere Hops akkumulieren kann. `pacman-server` nutzt ihn deshalb
vorrangig, siehe `clientIP()` in `main.go`.

Warum kein Eingriff an Traefik/cloudflared nötig war: Beide Komponenten
reichen die von Cloudflare gesetzten Header unverändert an das Backend
weiter — die Erfassung passiert komplett in `pacman-server` selbst, andere
Apps im Cluster sind davon nicht betroffen (bewusste Entscheidung: nur
`pacman`, nicht zentral am Ingress, siehe Commit-Historie).

## GeoIP: lokale DB-IP-Lite-DB statt Live-API

Bewusste Wahl gegen eine externe Lookup-API (z. B. ip-api.com): Mit einer
lokalen City-DB verlässt keine Besucher-IP das Cluster für die
Standortauflösung. Ebenso bewusste Wahl gegen MaxMind GeoLite2 (das einen
Account + License-Key verlangt): [DB-IP City Lite](https://db-ip.com/db/lite.php)
(CC BY 4.0) ist komplett kostenlos und braucht **keinen** Account/Key —
direkter monatlicher Download ohne Auth, verifiziert per `curl` gegen die
echte DB-IP-URL beim Erstellen dieses Setups (siehe Commit-Historie).
Gleiches MMDB-Format wie MaxMind, `oschwald/geoip2-golang` in `main.go`
liest beide unverändert.

Standardmäßig aktiv (`geoip.enabled: true`), da das der eigentliche Zweck
dieser App ist — bei Bedarf abschaltbar, siehe
[Chart-README](../argocd/apps/workloads/pacman/README.md#geoip-anreicherung).

Ein `initContainer` (`curlimages/curl`) lädt bei **jedem Pod-Start** die
aktuelle DB-IP-City-Lite-DB neu in ein gemeinsames `emptyDir` — kein
CronJob, keine PVC, bewusst einfach gehalten für diesen
Schulungs-Anwendungsfall. Schlägt der Download fehl, läuft der Pod
trotzdem an: `pacman-server` erkennt die fehlende `.mmdb`-Datei beim Start
und loggt dann nur die rohe IP ohne Standort (siehe `openGeoIP()` in
`main.go`) — kein CrashLoop.

## Grafana-Dashboard

`templates/dashboard-pacman-visitors.yaml` (nur gerendert, wenn
`geoip.enabled: true`) liefert vier Panels gegen die vorhandene
`VictoriaLogs`-Datasource (`argocd/apps/platform/logging/`):

- **Requests** / **Eindeutige Besucher-IPs** im gewählten Zeitraum (Stat-Panels).
- **Besucher-Standorte** — Geomap-Panel, Marker aus `geo_lat`/`geo_lon`.
- **Letzte Zugriffe** — Tabelle mit Zeit, IP, Land/Stadt, Pfad, Status, User-Agent.

Alle Panels filtern auf `{namespace="pacman"} msg:"http_access"` und
entpacken die JSON-Logzeile per LogsQL `| unpack_json`/Feld-Zugriff.

> **Nicht gegen eine echte VictoriaLogs-Instanz getestet** — beim Erstellen
> bestand kein Cluster-Zugriff von der Entwicklungsumgebung aus. Nach dem
> ersten Sync in Grafana öffnen und insbesondere das Stream-Label für den
> Namespace (`namespace="pacman"` — je nach `victoria-logs-collector`-
> Konfiguration könnte das Feld anders heißen, z. B. `kubernetes_namespace`)
> im Query-Editor gegen echte Daten verifizieren. Bei Bedarf per Grafana
> Explore (`VictoriaLogs`-Datasource, `{namespace="pacman"}` bzw. direkt
> `_stream`-Suche) die tatsächlichen Feldnamen nachschlagen und die
> `expr`-Werte im Dashboard-ConfigMap anpassen.

## Bekannte Grenzen

- Nur `pacman` ist erfasst, nicht der restliche Cluster-Traffic — bewusste
  Entscheidung, um den Eingriff auf eine isolierte Demo-App zu begrenzen.
- GeoIP-Auflösung ist so genau wie DB-IPs kostenlose City-Lite-DB (reduzierte
  Genauigkeit gegenüber der kommerziellen DB-IP-Datenbank; Stadt-Ebene ist
  eine Schätzung, keine exakte Ortung).
- IPv6-Besucher werden korrekt geloggt (`net.ParseIP` in `main.go`
  unterstützt beide Familien) und lokal gegen die IPv6-Ranges der DB-IP-DB
  aufgelöst — beim Erstellen dieses Setups gegen `2001:4860:4860::8888`
  verifiziert (siehe Commit-Historie).
