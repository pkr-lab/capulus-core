# 027 pacman-Server: keine HTTP-Timeouts, ungebremster Log-Endpunkt `/api/fingerprint`, vertraut `CF-Connecting-IP` ungeprüft

- Severity: Low
- Bereich: Extern
- Betroffen: `argocd/apps/tech/pacman/server/cmd/server/main.go:44,205-217`
- Status: Behoben am 2026-10-18 (im Code, gestaged; wirkt nach Merge, Image-Build und Tag-Bump-PR)

## Beschreibung

Der öffentliche Go-Server nutzt `http.ListenAndServe` ohne `ReadHeaderTimeout`/`ReadTimeout` (Slowloris). `POST /api/fingerprint` nimmt bis zu 8 KB pro Aufruf an und schreibt jede Anfrage ins Log, ohne Rate-Limit. `clientIP()` vertraut `CF-Connecting-IP` und `X-Forwarded-For` jedes Absenders, auch bei direktem Zugriff aus dem LAN: Absender-IPs im Log und in GeoIP-Daten sind fälschbar. Die Bestenliste speichert nur bereinigte Nicknames (Regex) und plausible Scores. Positiv: `MaxBytesReader` auf beiden POST-Endpunkten, JSON-Escaping der Logs durch `slog`.

## Nachweis

```
$ sed -n 44p argocd/apps/tech/pacman/server/cmd/server/main.go
	if err := http.ListenAndServe(listenAddr, mux); err != nil {
$ sed -n 205,212p argocd/apps/tech/pacman/server/cmd/server/main.go
func clientIP(r *http.Request) string {
	if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
		return ip
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
```

## Risiko / Angriffsszenario

Log-Flutung füllt VictoriaLogs; langsame Verbindungen belegen Server-Ressourcen; gefälschte IPs verfälschen Auswertungen.

## Empfohlene Behebung

```diff
-	if err := http.ListenAndServe(listenAddr, mux); err != nil {
+	srv := &http.Server{Addr: listenAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
+	if err := srv.ListenAndServe(); err != nil {
```
Rate-Limit (z. B. `golang.org/x/time/rate` je IP) für `/api/fingerprint` und `/api/leaderboard`. `CF-Connecting-IP` nur auswerten, wenn die Anfrage aus dem Cloudflare-Tunnel (Pod-CIDR von cloudflared) kommt.

## Rollback

Vorheriges Image-Tag in `values.yaml` setzen.

## Verifikation

```
cd argocd/apps/tech/pacman/server && go build ./... && go vet ./... && go test ./...
for i in $(seq 1 200); do curl -s -o /dev/null -w '%{http_code} ' -X POST https://pacman-prod.pke-lab.de/api/fingerprint -d '{}'; done
```
Ab einem Schwellwert müssen `429`-Antworten erscheinen.

## Risiko der Behebung

Niedrig.

## Behebung (2026-10-18)

**Fix.**

- `http.Server` mit `ReadHeaderTimeout` 5 s, `ReadTimeout` 10 s, `WriteTimeout` 15 s und `IdleTimeout` 60 s statt `http.ListenAndServe`.
- Rate-Limit je Client-IP (neu `ratelimit.go`, Fixed-Window, ohne neue Abhängigkeit) für `/api/fingerprint` und `/api/leaderboard`: Standard 60 Anfragen pro Minute (`RATE_LIMIT_PER_MINUTE`), danach `429` mit `Retry-After`. Höchstens 10.000 Schlüssel im Speicher.
- `clientIP` wertet `CF-Connecting-IP` und `X-Forwarded-For` nur aus, wenn die TCP-Gegenstelle in `TRUSTED_PROXY_CIDRS` liegt (Standard `10.42.0.0/16`, im Chart gesetzt) und der Wert eine gültige IP ist. Sonst gilt die TCP-Gegenstelle.
- `go.mod`/`go.sum` per `go mod tidy` bereinigt: Das ungenutzte `github.com/oschwald/geoip2-golang/v2` war eingetragen, `go mod tidy -diff` (Prüfung in der CI) schlug dadurch schon vor dieser Änderung an.
- Chart: Env `TRUSTED_PROXY_CIDRS` und `RATE_LIMIT_PER_MINUTE` aus `values.yaml` (`config.*`).

**Nachweis** (vor dem Merge, in `golang:1.27-alpine`):

| Test | Ergebnis |
|---|---|
| `gofmt -l`, `go build ./...`, `go vet ./...`, `go mod tidy -diff` | sauber |
| `go test ./...` (neu: `main_test.go`) | ok: Header nur von vertrauten Proxys, Header von fremder Quelle und Müllwerte ignoriert; Limiter blockiert nach dem Limit, andere Clients unberührt, Fenster läuft ab; Middleware liefert `429` mit `Retry-After` |
| `helm template` | `TRUSTED_PROXY_CIDRS: "10.42.0.0/16"`, `RATE_LIMIT_PER_MINUTE: "60"` |
| Doc-Link-Check | 0 kaputte Links |

**Geänderte Dateien.**

- `argocd/apps/tech/pacman/server/cmd/server/main.go`, `ratelimit.go` (neu), `main_test.go` (neu), `server/go.mod`, `server/go.sum`
- `argocd/apps/tech/pacman/templates/deployment.yaml`, `values.yaml`
- Doku: `docs/6-hintergruende/60090-pacman-schulungsobjekt.md`, `docs/3-apps-workloads/300f0-pacman-visitor-tracking.md`

**Rollback.** `git revert` bzw. in `values.yaml` den vorherigen `image.tag` (aktuell `sha-4888771`) setzen.

**Offen.**

- **Nach dem Rollout prüfen:** In VictoriaLogs/Grafana (Dashboard „pacman — Besucher“) müssen weiter echte Besucher-IPs stehen, nicht die Traefik-Pod-IP. Sonst ist `TRUSTED_PROXY_CIDRS` falsch; der Pod-CIDR TECH ist `10.42.0.0/16`.
- **Restlücke:** Traefik reicht `CF-Connecting-IP` ungeprüft weiter; wer Traefik im LAN direkt anspricht, kann die IP weiter setzen. Ein Ausfiltern müsste in Traefik (Middleware) geschehen.
- Der Rate-Limit-Test mit 200 `curl`-Aufrufen gegen die öffentliche URL aus der Verifikation oben habe ich nicht ausgeführt, er setzt den neuen Image-Stand voraus.
