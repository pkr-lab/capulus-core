# 024 carplay-api: Rate-Limit und IP-Allowlist greifen hinter Traefik auf die Proxy-IP, Authentifizierung ist optional, `/metrics` offen

- Severity: Low
- Bereich: Repo
- Betroffen: `argocd/apps/tech/carplay-api/src/cmd/server/main.go:69,87,94`, `argocd/apps/tech/carplay-api/values.yaml:82-86`
- Status: Teilweise behoben am 2026-10-18 (Punkte 2 und 3 live bestätigt; Punkt 1 wirkt nicht, weil die Client-Adresse schon vor Traefik verloren geht)

## Beschreibung

`trustedProxies` ist leer, damit vertraut Gin keinem Proxy und `ClientIP()` liefert die TCP-Gegenstelle, also die Traefik-Pod-IP. Folgen:

- Das Rate-Limit (100 Anfragen/Minute) zählt alle Clients zusammen. Ein einzelner lauter Client sperrt die iOS-App aus (429).
- Die IP-Allowlist (derzeit `enabled: false`) würde nur die Proxy-IP prüfen und damit wirkungslos sein.
- Fehlt das Token-Secret, startet der Server ohne Authentifizierung (nur eine Warnzeile). Aktuell ist das Secret aktiv (`secrets.apiToken.enabled: true`).
- `/metrics` und `/health` sind ohne Token erreichbar (Request-Statistik, Zustand der Upstreams).
- Das Rate-Limit wird vor der Token-Prüfung angewendet, aber nicht pro fehlgeschlagenem Versuch; gegen schwache Token wäre das kein Lockout.

## Nachweis

```
$ sed -n 69p argocd/apps/tech/carplay-api/src/cmd/server/main.go
	if err := router.SetTrustedProxies(cfg.trustedProxies); err != nil {
$ sed -n 82p argocd/apps/tech/carplay-api/values.yaml
  trustedProxies: ""
$ sed -n 87,94p argocd/apps/tech/carplay-api/src/cmd/server/main.go
	router.GET("/metrics", stats.Handler())
	...
		logger.Warn("CARPLAY_API_TOKEN not set — /api/dashboard is running WITHOUT authentication")
```

## Risiko / Angriffsszenario

Verfügbarkeit der App durch einen einzelnen Client beeinträchtigbar; bei aktivierter Allowlist trügerische Sicherheit. Ein Konfigurationsfehler (Secret fehlt) schaltet die Authentifizierung still ab.

## Empfohlene Behebung

1. `trustedProxies` auf die Traefik-Pod-CIDR (bzw. `10.42.0.0/16`) setzen, damit `X-Forwarded-For` korrekt ausgewertet wird.
2. Start abbrechen, wenn `CARPLAY_API_TOKEN` leer ist (`return fmt.Errorf(...)`) statt nur zu warnen.
3. `/metrics` per Token oder per NetworkPolicy auf den Scraper beschränken.

## Rollback

Vorheriges Image-Tag und Werte wiederherstellen.

## Verifikation

```
kubectl -n carplay-api logs deploy/carplay-api | grep -i 'WITHOUT authentication'
curl -s -o /dev/null -w '%{http_code}\n' http://carplay-api.prod.homeserver/metrics
```
Keine Warnzeile, `/metrics` ohne Token → `401`.

## Risiko der Behebung

Niedrig.

## Behebung (2026-10-18)

**Fix.**

- **Punkt 1, Proxy-IP:** `config.trustedProxies` steht auf dem Pod-CIDR `10.42.0.0/16` (`values.yaml`). Gin wertet `X-Forwarded-For` von Traefik damit aus; Rate-Limit, Access-Log und eine spätere Allowlist sehen den echten Client. Die Allowlist bleibt wie bisher aus (`ipAllowlist.enabled: false`).
- **Punkt 2, Token Pflicht:** `newRouter` bricht ohne `CARPLAY_API_TOKEN` mit `errMissingToken` ab, `run` gibt den Fehler weiter, der Prozess endet mit Exit-Code 1. Es gibt keinen Betrieb ohne Authentifizierung mehr.
- **Punkt 3, `/metrics`:** hängt hinter `BearerAuth`. `/health` bleibt offen (Probes des kubelet); niemand scrapt `/metrics`, es gab keinen Verbraucher.
- Der Router-Aufbau liegt in `newRouter(cfg, logger)`, damit er testbar ist.

**Nachweis** (vor dem Merge, in `golang:1.27-alpine`, weil Go auf dem Rechner fehlt):

| Test | Ergebnis |
|---|---|
| `gofmt -l`, `go build ./...`, `go vet ./...`, `go mod tidy -diff` | sauber |
| `go test ./...` (neu: `cmd/server/main_test.go`) | ok: `run` ohne Token liefert `errMissingToken`; `/metrics` ohne Header 401, falscher Token 401, richtiger Token 200; `/api/dashboard` ohne Token 401; Request mit `RemoteAddr` 10.42.2.5 und `X-Forwarded-For` wird bei `trustedProxies=10.42.0.0/16` akzeptiert |
| `helm template` | `TRUSTED_PROXIES: "10.42.0.0/16"` in der ConfigMap |
| Doc-Link-Check | 0 kaputte Links |

**Geänderte Dateien.**

- `argocd/apps/tech/carplay-api/src/cmd/server/main.go`, `src/cmd/server/main_test.go` (neu), `values.yaml`, `README.md`
- Doku: `docs/3-apps-workloads/300d0-carplay-api.md`, `docs/6-hintergruende/60080-carplay-api-und-ios-app.md`

**Rollback.** `git revert`; alternativ das Image-Tag auf den vorherigen `sha-…` zurücksetzen (aktuell `sha-4e05141`) und `trustedProxies: ""` setzen.

## Messung nach dem Rollout (2026-10-18)

| Test | Ergebnis |
|---|---|
| `curl https://carplay-api.prod.homeserver/metrics` ohne Token | `401`, im Log `path=/metrics status=401` (Image `sha-7bebe51`): Punkt 3 wirkt |
| Start ohne Token | im Test belegt, im Cluster nicht ausprobiert (Secret ist gesetzt) |
| `client_ip` im Log für diese Anfrage | `10.42.2.102`, das ist der Pod `svclb-traefik-…` (K3s-ServiceLB), nicht mein PC (192.168.178.66) und nicht der Traefik-Pod (`10.42.2.132`) |

**Folgerung.** `trustedProxies: 10.42.0.0/16` ist korrekt gesetzt, bringt aber nichts: Der ServiceLB-Pod vor Traefik übersetzt die Quelladresse (`externalTrafficPolicy: Cluster` am Service `traefik`), Traefik und damit `carplay-api` sehen nie die echte Client-IP. Rate-Limit und eine spätere Allowlist arbeiten damit weiter auf einer einzigen Adresse (alle Clients teilen sich 100 Anfragen pro Minute). Punkt 1 ist nicht erreicht.

**Weg zur Behebung (braucht dich, betrifft alle Dienste hinter Traefik).** `externalTrafficPolicy: Local` am Traefik-Service (HelmChartConfig `service.spec.externalTrafficPolicy: Local`), geprüft werden müsste, ob die Quelladresse dann bis Traefik erhalten bleibt (MetalLB und ServiceLB laufen beide). Das ändert den Eingangspfad aller Hosts und braucht ein Zeitfenster; ohne diese Änderung bleibt die IP-Allowlist wirkungslos und gehört ausgeschaltet (`ipAllowlist.enabled: false`, ist sie).

