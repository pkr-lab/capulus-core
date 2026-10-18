# 016 carplay-api: Go-Abhängigkeiten mit bekannten Schwachstellen (x/crypto, x/net, x/text, quic-go)

- Severity: Medium
- Bereich: Repo
- Betroffen: `argocd/apps/tech/carplay-api/src/go.mod:27,32,33,35` (indirekte Abhängigkeiten von `gin`)
- Status: Behoben am 2026-10-17

## Beschreibung

`govulncheck` (Go 1.27.2, Datenbank vom Audit-Tag) meldet 5 erreichbare Schwachstellen in 2 Modulen, `trivy fs` insgesamt 17 HIGH-Funde in `go.mod`. Betroffen sind die indirekten Abhängigkeiten `golang.org/x/net v0.51.0`, `golang.org/x/crypto v0.48.0`, `golang.org/x/text v0.34.0` und `github.com/quic-go/quic-go v0.59.0`. Die gemeldeten HTTP/2- und HTTP/3-Funde (HPACK-Race, Flow-Control-Fehler, CPU-/Speicherauslastung durch Trailer/QPACK) betreffen die Serverseite von `net/http`; `carplay-api` setzt keinen HTTP/2- oder HTTP/3-Server ein, der Callgraph erreicht den Code über Client-Aufrufe (`json.Decoder.Decode`, `fmt.Sprintf`), die Praxisrelevanz ist also gering. Der Dienst ist nur im LAN/VPN erreichbar. pacman (Go) und isc-news-bot (npm) sind sauber.

Ursache für den Stau: Renovate hat `vulnerabilityAlerts` abgeschaltet, Dependabot-Security-Updates sind aus (Incidents 014 und 031).

## Nachweis

```
$ cd argocd/apps/tech/carplay-api/src && govulncheck ./...
Your code is affected by 5 vulnerabilities from 2 modules.
GO-2026-6617  Found in: golang.org/x/net@v0.51.0     Fixed in: golang.org/x/net@v0.60.0
GO-2026-6612  Found in: golang.org/x/net@v0.51.0     Fixed in: golang.org/x/net@v0.60.0
GO-2026-6611  Found in: golang.org/x/net@v0.51.0     Fixed in: golang.org/x/net@v0.60.0
GO-2026-6603  Found in: golang.org/x/net@v0.51.0     Fixed in: golang.org/x/net@v0.60.0
GO-2026-5676  Found in: github.com/quic-go/quic-go@v0.59.0   Fixed in: github.com/quic-go/quic-go@v0.59.1

$ cd argocd/apps/tech/pacman/server && govulncheck ./...
No vulnerabilities found.
$ cd argocd/apps/tech/isc-news-bot && npm audit --package-lock-only
found 0 vulnerabilities

$ trivy fs (go.mod, carplay-api):  x/crypto 0.48.0 → 0.52.0/0.55.0 (10× HIGH), x/net 0.51.0 → 0.53–0.60.0 (6× HIGH), x/text 0.34.0 → 0.39.0 (1× HIGH)
```

## Risiko / Angriffsszenario

Remote-Denial-of-Service gegen den API-Dienst und indirekt gegen die iOS-App (Dashboard fällt aus), wenn ein Angreifer den Dienst im LAN erreicht und die Server-Code-Pfade der Bibliotheken tatsächlich genutzt werden. Kein Hinweis auf Codeausführung oder Datenabfluss.

## Empfohlene Behebung

```
cd argocd/apps/tech/carplay-api/src
go get golang.org/x/net@v0.60.0 golang.org/x/crypto@v0.55.0 golang.org/x/text@v0.39.0 github.com/quic-go/quic-go@v0.59.1
go mod tidy
go build ./... && go vet ./... && go test ./...
```
Danach Image neu bauen lassen (`build-images.yml`); der Bump-PR setzt `image.tag`. Dependabot/Renovate-Security-Updates aktivieren (Incidents 014, 031).

## Rollback

`go.mod`/`go.sum` aus Git zurückholen, vorheriges Image-Tag in `values.yaml` setzen.

## Verifikation

```
cd argocd/apps/tech/carplay-api/src && govulncheck ./...
```
Ausgabe: `No vulnerabilities found.`; `go test ./...` grün; `/health` und `/api/dashboard` liefern nach dem Rollout 200.

## Risiko der Behebung

Niedrig: Minor-Updates von Hilfsbibliotheken. Build und Tests laufen in CI.

## Behebung (2026-10-17)

**Fix.**

- **Zwischenstand (live):** Der Dependabot-PR #476 (`fix(deps): bump the go-security group …`) hob `x/crypto` auf 0.52.0, `x/net` auf 0.54.0, `x/text` auf 0.37.0, `x/sys` auf 0.45.0 und `quic-go` auf 0.59.1. Er wurde gemergt, das Image `sha-4e05141` läuft seit dem Rollout (`/health` `200`). Von 15 Dependabot-Alerts blieb einer (`x/net` Fix 0.55.0, Folge-PR #481). `govulncheck` meldete auf diesem Stand weiter **7 erreichbare Schwachstellen** (GO-2026-6617, -6612, -6611, -6610, -6603 in `x/net` bis 0.60.0, GO-2026-5970 in `x/text` bis 0.39.0, GO-2026-5026 in `x/net` bis 0.55.0).
- **Endstand (Code):** `go get golang.org/x/net@v0.60.0 github.com/quic-go/quic-go@v0.59.1`, `go mod tidy`. Go löste die kleinste konsistente Menge auf: `x/net` 0.60.0, `x/crypto` 0.57.0, `x/sys` 0.48.0, `x/text` 0.42.0, `quic-go` 0.59.1. Die im Incident genannten Einzelversionen (`x/crypto` 0.55.0, `x/text` 0.39.0) passen nicht zu `x/net` 0.60.0 (`x/net` verlangt `x/crypto` 0.57.0, `x/crypto` 0.55.0 verlangt `x/text` 0.41.0). Die `go`-Direktive steigt dabei von 1.25.0 auf 1.26.0; CI (`go-version: stable`) und Dockerfile (`golang:1.27-alpine`) erfüllen das.

**Nachweis** (lokal, Go 1.27.2 und govulncheck 1.9.0, Datenbank vom 2026-10-08):

| Test | Ergebnis |
|---|---|
| `govulncheck ./...` vor dem Endstand (Stand `main` nach #476) | 7 Schwachstellen |
| `govulncheck ./...` nach dem Endstand | `No vulnerabilities found` |
| `go build ./... && go vet ./...` | ok |
| `go test ./...` | ok (der Dienst hat keine Unit-Tests, es wird nur übersetzt) |
| `go mod tidy -diff` | leer |
| `pacman/server`: `go build ./...` | ok, unverändert |
| Zwischenstand live (Image `sha-4e05141`) | Pod `Running`, `/health` `200`, keine Fehler in den Logs |
| Endstand live (Image `sha-56572bd`, Bump-PR #488) | Pod `Running` nach Rollout, ArgoCD `Synced`/`Healthy`, `/health` `200`, 0 Warnungen oder Fehler in den letzten 40 Logzeilen |
| Dependabot-Alerts | 0 offen, 15 behoben |

**Geänderte Dateien.**

- `argocd/apps/tech/carplay-api/src/go.mod`, `go.sum`
- Doku: `docs/6-hintergruende/60080-carplay-api-und-ios-app.md` (Abschnitt „Abhängigkeiten und Schwachstellen“), `docs/d-sicherheit/d0080-codeql-dependabot.md`

**Rollback.** `go.mod` und `go.sum` aus Git zurückholen und das vorherige Image-Tag in `values.yaml` setzen (`sha-4e05141`, davor `sha-04f6d88`). Die Sicherungskopien der Dateien vor dem Endstand liegen im Scratchpad der Sitzung.

**Offen.**

- Der Rollout ist abgeschlossen (PR mit dem Endstand, Image-Build, Bump-PR #488). Der Dependabot-PR #481 (`x/net` 0.55.0) war vorher schon gemergt, der Endstand hat ihn überschrieben.
- Die Anbindung der iOS-App an `carplay-api` ist ein eigenes Thema (siehe Nachtrag bei Incident 018).
- Der Dienst hat keine Unit-Tests: `go test` übersetzt nur. Ein Funktionstest der Endpunkte mit Token steht aus.

