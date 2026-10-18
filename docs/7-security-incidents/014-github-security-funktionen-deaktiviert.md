# 014 GitHub-Sicherheitsfunktionen im öffentlichen Repo deaktiviert (Secret Scanning, Push Protection, Dependabot Security Updates)

- Severity: Medium
- Bereich: Repo
- Betroffen: Repository-Einstellungen `pkr-lab/capulus-core`, Doku `docs/d-sicherheit/d0080-codeql-dependabot.md`
- Status: Behoben am 2026-10-17 (Non-Provider-Patterns nicht aktivierbar, Push-Protection-Test mit Dummy-Token steht aus, Workflow `security-issues.yml` bewusst deaktiviert)

## Beschreibung

Die Repository-Einstellungen melden alle Funktionen als `disabled`, obwohl `docs/d-sicherheit/d0080-codeql-dependabot.md` sie als aktiv beschreibt (Dependabot-Alerts und Fix-PRs, Secret Scanning). Für öffentliche Repositories sind Secret Scanning und Push Protection kostenlos. Das fehlende Push-Blocking ist die direkte Lücke, durch die der Schlüssel aus Incident 001 ins Repo gelangt ist. `renovate.json` hat `vulnerabilityAlerts.enabled: false` (Incident 031), sodass auch dort keine Fix-PRs für Sicherheitslücken entstehen; Folge: Incident 016.

Der Ruleset „main: PR + CI“ verlangt keine Reviews (`required_approving_review_count: 0`) und lässt die Admin-Rolle im `pull_request`-Modus umgehen. Bei einer Person als Betreiber ist das pragmatisch, die Pflicht-CI bleibt die einzige Schranke.

## Nachweis

```
$ gh api repos/pkr-lab/capulus-core --jq '.security_and_analysis'
{"dependabot_security_updates":{"status":"disabled"},
 "secret_scanning":{"status":"disabled"},
 "secret_scanning_non_provider_patterns":{"status":"disabled"},
 "secret_scanning_push_protection":{"status":"disabled"},
 "secret_scanning_validity_checks":{"status":"disabled"}}

$ gh api repos/pkr-lab/capulus-core/rulesets --jq '.[] | {name,enforcement}'
{"enforcement":"active","name":"Protect MAIN"} {"enforcement":"active","name":"entw-1"} {"enforcement":"active","name":"main: PR + CI"}
```

## Risiko / Angriffsszenario

Neue Secrets im Klartext werden beim Push nicht geblockt, bekannte verwundbare Abhängigkeiten erzeugen weder Alerts noch Fix-PRs. Auf einem öffentlichen Repo sind versehentlich eingecheckte Zugangsdaten binnen Minuten von Bots geerntet.

## Empfohlene Behebung

```
gh api -X PATCH repos/pkr-lab/capulus-core \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_non_provider_patterns][status]=enabled'
gh api -X PUT repos/pkr-lab/capulus-core/vulnerability-alerts
gh api -X PUT repos/pkr-lab/capulus-core/automated-security-fixes
```
Danach `d0080-codeql-dependabot.md` auf den tatsächlichen Stand bringen und prüfen, dass CodeQL-Läufe im Security-Tab Ergebnisse liefern.

## Rollback

Dieselben Aufrufe mit `status=disabled` bzw. `DELETE`.

## Verifikation

```
gh api repos/pkr-lab/capulus-core --jq '.security_and_analysis'
```
alle genannten Einträge `enabled`; ein Test-Push mit einem Dummy-Token (`ghp_` + Zufallszeichen) wird von der Push Protection geblockt.

## Risiko der Behebung

Keins: reine Einstellung.

## Behebung (2026-10-17)

**Fix.** Reine Repo-Einstellungen, per `gh api` gesetzt:

- `secret_scanning` und `secret_scanning_push_protection`: `enabled` (`PATCH repos/pkr-lab/capulus-core`).
- Dependabot-Alerts: `PUT repos/pkr-lab/capulus-core/vulnerability-alerts` (`204`).
- Dependabot Security Updates: `PUT repos/pkr-lab/capulus-core/automated-security-fixes` (`enabled: true`).
- **Nicht umgesetzt:** `secret_scanning_non_provider_patterns`. Die API nimmt den Aufruf an, der Wert bleibt aber `disabled` (vermutlich Funktion der kostenpflichtigen GitHub Secret Protection). `secret_scanning_validity_checks` bleibt bewusst aus (Prüfung gefundener Schlüssel beim Anbieter).
- **Workflow `security-issues.yml` deaktiviert** (`gh workflow disable`, Wunsch des Betreibers): Er hätte sonst öffentliche Issues zu den Abhängigkeitslücken angelegt. Er war zuvor seit mindestens 15.10. rot, weil die Dependabot-Alerts aus waren.
- `renovate.json` (`vulnerabilityAlerts.enabled: false`) und der Ruleset ohne Pflicht-Review bleiben unverändert.

**Nachweis** (live):

| Test | Ergebnis |
|---|---|
| `gh api repos/pkr-lab/capulus-core --jq '.security_and_analysis'` | `secret_scanning`, `secret_scanning_push_protection`, `dependabot_security_updates`: `enabled`; Non-Provider-Patterns und Validity Checks `disabled` |
| `GET …/vulnerability-alerts`, `GET …/automated-security-fixes` | `204`, `enabled: true` |
| Dependabot-Alerts | 15 offen, alle in `argocd/apps/tech/carplay-api/src/go.mod` (7 kritisch, 2 hoch, 6 mittel); `pacman/server/go.mod` ohne Funde |
| Dependabot-Fix-PR | #476 `fix(deps): bump the go-security group across 1 directory with 3 updates` automatisch geöffnet, nicht gemergt (Bezug: Incident 016) |
| Secret-Scanning-Alerts nach dem ersten Scan der Historie | 0 offen |
| CodeQL | liefert Ergebnisse (6 offene Alerts auf `main`: `py/path-injection` in `power-agent.py`, `actions/cache-poisoning/poisonable-step` in `ci.yml`) |

**Geänderte Dateien.** Nur die Doku: `docs/d-sicherheit/d0080-codeql-dependabot.md` (Stand der Einstellungen, Hinweis zum deaktivierten Workflow, Non-Provider-Patterns, Validity Checks).

**Rollback.** `gh api -X PATCH repos/pkr-lab/capulus-core -f 'security_and_analysis[secret_scanning][status]=disabled' -f 'security_and_analysis[secret_scanning_push_protection][status]=disabled'`, `gh api -X DELETE repos/pkr-lab/capulus-core/automated-security-fixes`, `gh api -X DELETE repos/pkr-lab/capulus-core/vulnerability-alerts`. Der Ausgangszustand (alles `disabled`, Workflow aktiv) liegt als JSON im Scratchpad der Sitzung.

**Offen.**

- **Push-Protection-Test:** Wegwerf-Branch mit einer Datei, die ein gültig aufgebautes GitHub-Token-Muster enthält, pushen. Der Push muss abgelehnt werden. Ich teste das nicht selbst, weil ein Fehlschlag das Muster öffentlich in die Historie legen würde.
- **`security-issues.yml` wieder einschalten** (`gh workflow enable security-issues.yml`), sobald der Dependabot-PR #476 eingespielt ist (Incident 016) und die Veröffentlichung der Funde als Issue gewollt ist.
- **Secret-Scanning-Historie:** Es gab beim ersten Scan keine Funde. Der Scan kann später weitere Muster melden, die Prüfung ist mit `gh api 'repos/pkr-lab/capulus-core/secret-scanning/alerts?state=open'` möglich (die Antwort enthält die Werte im Klartext).
- Der Ruleset „main: PR + CI“ verlangt weiter keine Reviews und lässt die Admin-Rolle im `pull_request`-Modus umgehen, bei einer Person als Betreiber bewusst so.

