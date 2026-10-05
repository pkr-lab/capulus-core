# Code-Scanning und Abhängigkeits-Alerts — CodeQL, Dependabot, Security-Issues

Drei Bausteine prüfen das Repo laufend auf Sicherheitslücken und melden sich von selbst:
**CodeQL** sucht Schwachstellen im eigenen Code, **Dependabot** erkennt verwundbare Abhängigkeiten und
öffnet dafür Fix-PRs, und ein täglicher Workflow macht aus den offenen Funden **Issues**, die sich
wieder schließen, sobald der Fund behoben ist. Vorher gab es mit [gitleaks](../f-cicd-automatisierung/f0070-ci-lint.md#gitleaks-konfiguration)
nur eine Secret-Prüfung und mit [Renovate](../f-cicd-automatisierung/f0020-renovate.md) Versions-Updates im
Wochenrhythmus, aber keine Prüfung des Codes selbst und keinen Hinweis, wenn eine eingesetzte Version eine
bekannte Lücke hat.

> **Gilt für:** das GitHub-Repo `pkr-lab/capulus-core` (kein Cluster). Ergebnisse unter
> *Security → Code scanning / Dependabot*, Issues mit dem Label `security`.
> Begründungen zu einzelnen Entscheidungen: [600a0](../6-hintergruende/600a0-ci-workflows-und-skripte.md).

---

## Architektur

```
 PR / Push auf main / Wochenlauf
        │
        ▼
 codeql.yml ──► Code-Scanning-Alerts (main) ──┐      im PR: Check "CodeQL", Annotationen,
                                              │      Fix-Vorschläge (Copilot Autofix)
 Dependency Graph ──► Dependabot-Alerts ──────┤
                         │                    │
                         ▼                    ▼
              Dependabot-Fix-PR      security-issues.yml (täglich 06:35 UTC)
              (fix(deps): …)                  │
                                              ▼
                                   Issues mit Label `security`
                                   (anlegen, ergänzen, schließen, wieder öffnen)
```

| Baustein | Findet | Ergebnis | Dateien |
|---|---|---|---|
| CodeQL | Schwachstellen im eigenen Code: Go, JavaScript, Python, Swift, GitHub-Actions-Workflows | Alerts im Security-Tab, Check und Annotationen im PR | [`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml) |
| Dependabot alerts + security updates | bekannte Lücken in Go-Modulen und GitHub Actions (GitHub Advisory Database) | Alerts im Security-Tab und **automatischer Fix-PR** | [`.github/dependabot.yml`](../../.github/dependabot.yml) + Repo-Einstellungen |
| Security-Issues | spiegelt beide Quellen | **ein Issue je Regel bzw. je Manifest**, schließt sich selbst | [`.github/workflows/security-issues.yml`](../../.github/workflows/security-issues.yml), [`scripts/security-issues.py`](../../scripts/security-issues.py) |
| Renovate (bestehend) | neue Versionen | Versions-PRs, unverändert | [`renovate.json`](../../renovate.json), [f0020](../f-cicd-automatisierung/f0020-renovate.md) |

---

## Bewertung: CodeQL und Dependabot gegen freie Alternativen

Geprüft im Oktober 2026 nach vier Kriterien: kostenlos, Open Source, deckt die Sprachen des Repos ab,
öffnet PRs/Issues ohne zusätzliche Infrastruktur. Das Repo ist **öffentlich**, das entscheidet die
Kostenfrage: CodeQL, Dependabot, Copilot Autofix und Secret Scanning kosten hier nichts. Für ein
privates Repo wäre CodeQL kostenpflichtig (GitHub Code Security), dann wäre Opengrep die erste Wahl.

### Code-Scanning (SAST)

| Werkzeug | Lizenz und Kosten | Stärken | Schwächen für dieses Repo | Entscheidung |
|---|---|---|---|---|
| **CodeQL** | Abfragen MIT, Engine proprietär, für öffentliche Repos kostenlos | Datenfluss-Analyse über Funktions- und Dateigrenzen, alle fünf Sprachen des Repos inkl. Workflows, native PR-Annotationen, Copilot Autofix | Engine nicht Open Source | **eingesetzt** |
| [Opengrep](https://github.com/opengrep/opengrep) | LGPL-2.1, Community-Fork von Semgrep CE (Januar 2025) | vollständig Open Source, schnelle Musterregeln, eigene Regeln leicht | flachere Analyse, Regelsatz muss selbst gepflegt werden | Alternative, falls das Repo privat wird |
| Semgrep CE | Engine LGPL-2.1, offizielle Regeln seit Dezember 2024 unter der eigenen „Semgrep Rules License“ | wie Opengrep | Analyse über Dateigrenzen nur in der kommerziellen Version, Regel-Lizenz nicht Open Source | nicht eingesetzt |
| gosec, Bandit | Apache-2.0 | spezialisiert auf Go bzw. Python | je eine Sprache, kein Swift/JS/Workflows | neben CodeQL überflüssig |
| [zizmor](https://docs.zizmor.sh/) | MIT | sehr gründlich für GitHub-Actions-Workflows | nur Workflows, meldet für die bestehenden Workflows 107 Funde (vor allem nicht per SHA gepinnte Actions) | Empfehlung für später, siehe [Lücken](#was-das-setup-nicht-abdeckt) |

### Abhängigkeiten (SCA) und Fix-PRs

| Werkzeug | Lizenz und Kosten | Stärken | Schwächen für dieses Repo | Entscheidung |
|---|---|---|---|---|
| **Dependabot** alerts + security updates | kostenlos für alle Repos, Kern (`dependabot-core`) seit Mai 2024 MIT | GitHub Advisory Database, Fix-PR meist innerhalb von Stunden, kein Token nötig | kennt keine Container-Images und Helm-Charts, keine Erreichbarkeitsanalyse | **eingesetzt, nur für Sicherheits-PRs** |
| Renovate | AGPL-3.0, schon im Repo | beste Versions-Updates (Helm-Values, Charts, Dockerfiles), Gruppierung, Dashboard | läuft hier nur montags (PAT-Fallback, [f0020](../f-cicd-automatisierung/f0020-renovate.md#self-hosted-fallback-github-actions)); seine Sicherheits-PRs (`vulnerabilityAlerts`) lesen ohnehin die Dependabot-Alerts | bleibt für Versions-Updates zuständig, Sicherheits-PRs abgeschaltet |
| [OSV-Scanner](https://github.com/google/osv-scanner) | Apache-2.0 | offene OSV-Datenbank, auch Container-Images | keine Fix-PRs für Go | Option |
| [govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck) | BSD-3 (Go-Team) | Erreichbarkeitsanalyse, prüft auch die Standardbibliothek | nur Go, keine PRs | Option, für die Abschätzung unten genutzt |
| Trivy | Apache-2.0 | Images, IaC, Secrets | am 2026-03-19 kompromittiert (TeamPCP: `trivy-action`, `setup-trivy`, Release v0.69.4 mit Credential-Stealer) | Option für Image-Scans, dann nur mit per SHA gepinnter Action |

### Ergebnis

- **CodeQL** bleibt: Keine freie Alternative erreicht dieselbe Analysetiefe über alle Sprachen des Repos, und für
  ein öffentliches Repo ist es kostenlos.
- **Dependabot** kommt dazu, aber **nur für Sicherheitslücken**. Die Open-Source-Alternative für Versions-Updates,
  Renovate, ist schon im Einsatz und bleibt zuständig (Versions-Updates in `dependabot.yml` per
  `open-pull-requests-limit: 0` aus). Für Sicherheits-PRs ist Dependabot hier besser als Renovate, weil er
  innerhalb von Stunden reagiert statt im Wochenrhythmus des Renovate-Fallbacks. Damit es keine doppelten
  Sicherheits-PRs gibt, sind Renovates `vulnerabilityAlerts` abgeschaltet.
- **Issues** öffnet keines der Werkzeuge von selbst, dafür gibt es den Workflow `security-issues.yml`.

---

## 1. CodeQL

[`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml), erweiterte Einrichtung („advanced
setup“): Konfiguration und Sprachen sind im Repo versioniert statt in den Repo-Einstellungen.

| Trigger | Wirkung |
|---|---|
| Push auf `main` | Alerts für `main`, daraus entstehen die Issues |
| PR gegen `main` (nicht bei reinen Doku-Änderungen: `docs/**`, `*.md`) | Check „Code scanning results / CodeQL“, Annotationen nur für **neu eingeführte** Funde, Fix-Vorschläge per Copilot Autofix |
| montags 03:41 UTC | neue Abfragen neuerer CodeQL-Versionen greifen auch ohne Code-Änderung |
| manuell (`workflow_dispatch`) | — |

| Sprache | Build-Modus | Runner | Analysiert |
|---|---|---|---|
| `actions` | `none` | ubuntu | alle Workflows unter `.github/workflows/` |
| `go` | `autobuild` | ubuntu | beide Go-Module (`argocd/apps/tech/pacman/server`, `argocd/apps/tech/carplay-api/src`), der Autobuilder findet beide `go.mod` selbst |
| `javascript-typescript` | `none` | ubuntu | pacman-Frontend, Xibo-Slideshow, `n8n/scripts/whatsapp-pair.js`; minifizierte Dateien (`*.min.js`) überspringt CodeQL von sich aus |
| `python` | `none` | ubuntu | `scripts/*.py` und die Python-Dateien der Ansible-Rollen |
| `swift` | `autobuild` | macos | iOS-App unter `ios/`; vorher erzeugt XcodeGen das (nicht eingecheckte) Xcode-Projekt |

**Abfragesatz:** der Standardsatz („default“, hohe Treffsicherheit). Lokal mit CodeQL 2.26.2 gemessen
(Oktober 2026, ohne Swift): der Standardsatz meldet **2** Funde, `security-extended` **46**. Die 44 zusätzlichen
sind überwiegend Fehlalarme: 30× `go/log-injection` auf strukturierte `slog`-Ausgaben, 6× `actions/untrusted-checkout/medium`
auf `ci.yml` (Workflow ohne Rechte und Secrets) und 8× `actions/unpinned-tag` (berechtigt, aber ein Repo-weites Thema, siehe
[Lücken](#was-das-setup-nicht-abdeckt)). Umschalten: im Schritt `Initialize CodeQL` `queries: security-extended` ergänzen.

**Kein Pflicht-Check:** CodeQL steht nicht im Ruleset „main: PR + CI“ ([f0090](../f-cicd-automatisierung/f0090-branch-schutz-main.md)).
Der Check „Code scanning results“ wird bei neuen Funden ab `high` trotzdem rot und ist im PR sichtbar.

### Erwartete Erstbefüllung

| Quelle | Erwartung | Hinweis |
|---|---|---|
| CodeQL `py/path-injection` | 2 Alerts in [`power-agent.py`](../../ansible/roles/power_agent/files/power-agent.py) (Zeilen 67 und 92), 1 Issue | `name` kommt aus der HTTP-Anfrage, `TARGETS[name]` wirkt davor als Allowlist. Vermutlich Fehlalarm: im Alert mit Begründung verwerfen oder den Namen ausdrücklich prüfen, dann verschwindet der Fund. |
| Dependabot `carplay-api/src/go.mod` | rund 28 Advisories in indirekten Abhängigkeiten von gin: `golang.org/x/crypto` (17), `x/net` (8), `x/text`, `x/sys`, `quic-go` (je 1), 1 Issue und 1 gruppierter Fix-PR | Abschätzung mit govulncheck gegen vuln.go.dev (Stand 2026-10-01). Nur der `quic-go`-Fund ist laut govulncheck vom Code aus erreichbar. |
| Dependabot `pacman/server/go.mod` | keine | — |
| Swift | unbekannt | lokal nicht prüfbar (braucht macOS) |

---

## 2. Dependabot

[`.github/dependabot.yml`](../../.github/dependabot.yml) plus zwei Schalter in den Repo-Einstellungen
(siehe [Einrichtung](#einmalige-einrichtung-github-einstellungen)).

- **Dependabot alerts** vergleichen den Dependency Graph mit der GitHub Advisory Database und legen Alerts im
  Security-Tab an. Abgedeckt sind hier **Go-Module** und **GitHub Actions** (die Workflows).
- **Dependabot security updates** öffnen für jeden behebbaren Alert einen PR auf die kleinste Version ohne Lücke.
  Gruppiert je Verzeichnis (`go-security`, `actions-security`): ein PR je `go.mod` statt einer pro Paket,
  sonst müsste nach jedem Merge der nächste PR neu aufgebaut werden (`go.sum`-Konflikte).
- **Versions-Updates sind aus** (`open-pull-requests-limit: 0`), die macht Renovate. Sicherheits-PRs zählen nicht
  gegen dieses Limit.
- PR-Titel `fix(deps): bump …`, Labels `dependencies` und `security`. Der Präfix `fix` löst nach dem Merge ein
  Patch-Release aus ([f0030](../f-cicd-automatisierung/f0030-release-automation.md)).
- Ein Dependabot-PR durchläuft die Pflicht-Checks wie jeder PR ([f0090](../f-cicd-automatisierung/f0090-branch-schutz-main.md)),
  der Go-Check prüft dabei auch `go mod tidy`. **Gemergt wird von Hand**, wie bei Renovate.
- **Neues Go-Modul:** Verzeichnis in `dependabot.yml` unter `directories` ergänzen. Ohne Eintrag kommen
  Sicherheits-PRs trotzdem, aber ungruppiert und ohne die Labels.

---

## 3. Security-Issues

[`.github/workflows/security-issues.yml`](../../.github/workflows/security-issues.yml) läuft täglich um
06:35 UTC (und manuell) und gleicht mit [`scripts/security-issues.py`](../../scripts/security-issues.py) die
offenen Alerts auf `main` mit den Issues ab. Ein Issue fasst zusammen, was gemeinsam behoben wird:

- **Code-Scanning:** ein Issue je Werkzeug und Regel (z. B. alle `py/path-injection`-Funde), Tabelle mit Link je Fundstelle.
- **Dependabot:** ein Issue je Manifest (`go.mod` bzw. Workflow-Datei), Tabelle mit Paket, Advisory, betroffenen
  und behobenen Versionen. Ein offener Dependabot-PR für dieses Manifest wird im Issue verlinkt.

| Situation | Aktion |
|---|---|
| Gruppe mit Alerts ab `MIN_SEVERITY`, noch kein Issue | Issue anlegen (Label `security`, wird bei Bedarf angelegt) |
| neue Alerts in einer Gruppe mit offenem Issue | Tabelle aktualisieren und Kommentar „Neue Alerts: …“ (löst eine Benachrichtigung aus) |
| Alerts behoben, andere noch offen | Tabelle still aktualisieren |
| keine Alerts ab `MIN_SEVERITY` mehr | Issue mit Kommentar schließen (Grund *completed*) |
| Issue geschlossen, Alerts aber noch offen | Issue mit Kommentar wieder öffnen |
| eine Quelle nicht abrufbar | deren Issues bleiben unverändert, der Lauf wird rot |

**Schwelle:** `MIN_SEVERITY: medium` in der Workflow-Datei. Kleinere Funde bleiben im Security-Tab sichtbar, bekommen
aber kein Issue. Bei Code-Scanning-Regeln ohne Sicherheits-Schweregrad gilt `error` als `high`, `warning` als
`medium`, `note` als `low`.

**Bedienung:**

- Einen Fund **beheben**: Fix-PR mergen (Dependabot) bzw. Code korrigieren; nach dem nächsten Lauf schließt sich das Issue.
- Einen Fund **bewusst nicht beheben**: den Alert im Security-Tab verwerfen („Dismiss alert“, mit Grund), nicht nur das
  Issue schließen. Ein Issue, dessen Alerts noch offen sind, öffnet der nächste Lauf wieder.
- **Notizen** als Kommentar schreiben: Titel und Text des Issues werden bei jedem Lauf überschrieben.

**Rechte:** nur der Standard-`GITHUB_TOKEN` (`issues: write`, `pull-requests: read`, `security-events: read` für
Code-Scanning, `vulnerability-alerts: read` für Dependabot-Alerts). Die letzte Berechtigung gibt es seit dem
2026-09-03; vorher brauchte das Lesen von Dependabot-Alerts im Workflow ein PAT.

**Lokal testen** (braucht ein `gh`-Login mit Lesezugriff auf die Alerts, also als Repo-Admin):

```bash
DRY_RUN=1 GH_REPO=pkr-lab/capulus-core GITHUB_REPOSITORY=pkr-lab/capulus-core python3 scripts/security-issues.py
```

`DRY_RUN=1` liest alles, gibt die geplanten Issue-Änderungen samt Text aus und schreibt nichts.

---

## Einmalige Einrichtung (GitHub-Einstellungen)

Die Workflows wirken mit dem Merge. Zusätzlich unter **Settings → Advanced Security** (Bereich „Security“ der
Seitenleiste, früher „Code security“):

| Einstellung | Wert | Warum |
|---|---|---|
| Dependency graph | an (für öffentliche Repos Standard) | Grundlage für Dependabot |
| Dependabot alerts | **Enable** | ohne sie wird `security-issues.yml` rot („Dependabot alerts are disabled“) |
| Dependabot security updates | **Enable** | erst damit öffnet Dependabot Fix-PRs |
| Grouped security updates | egal | die Gruppen stehen bereits in `dependabot.yml` |
| Code scanning → CodeQL analysis | **nicht** auf „Default setup“ stellen | die erweiterte Einrichtung per Workflow ist aktiv; mit „Default setup“ weist GitHub die Uploads des Workflows ab |
| Copilot Autofix | an | Fix-Vorschläge im PR, kostenlos für öffentliche Repos |
| Secret Protection (Secret Scanning, Push Protection) | an | kostenlos für öffentliche Repos, ergänzt gitleaks |

Danach einmal **Actions → CodeQL → Run workflow** (füllt die Alerts für `main`) und anschließend
**Actions → Security issues → Run workflow** starten, statt auf den nächsten Zeitplan zu warten.

---

## Was das Setup nicht abdeckt

| Lücke | Hinweis |
|---|---|
| **Container-Images** (Drittanbieter-Images aus den `values.yaml`, eigene Images pacman, carplay-api, n8n-custom samt der im Dockerfile installierten npm-Pakete wie `whatsapp-web.js`) | Dependabot und CodeQL sehen keine Images. Option: Image-Scan mit Grype oder (per SHA gepinntem) Trivy nach dem Build in [`build-images.yml`](../f-cicd-automatisierung/f0060-build-images.md). |
| **Fehlkonfigurationen in Helm-Charts, Manifesten, Ansible** | kubeconform prüft nur das Schema ([f0070](../f-cicd-automatisierung/f0070-ci-lint.md)). Option: Checkov, KICS oder kube-linter. |
| **Vendorte Bibliotheken**: [`jquery-1.10.2.min.js`](../../argocd/apps/tech/pacman/src/js/jquery-1.10.2.min.js) im pacman-Frontend | jQuery 1.10.2 hat bekannte XSS-Lücken (CVE-2015-9251, CVE-2019-11358, CVE-2020-11022, CVE-2020-11023). Kein Scanner sieht vendorte Dateien, CodeQL überspringt `*.min.js`. Von Hand aktualisieren oder ersetzen. |
| **Nicht gepinnte Actions** in den bestehenden Workflows (Tags statt Commit-SHAs) | CodeQL meldet das erst mit `security-extended`, zizmor in jedem Workflow. Nach den Vorfällen um `tj-actions` (2025) und Trivy (2026) empfohlen: Renovate-Preset `helpers:pinGitHubActionDigests`, das SHAs setzt und aktuell hält. |
| **n8n-Workflows** (JavaScript in JSON-Dateien) | werden nicht analysiert |
| **Secret-Scanning-Alerts** | landen nicht als Issue (der `GITHUB_TOKEN` darf sie nicht lesen); GitHub benachrichtigt selbst, gitleaks prüft jeden PR |
| **Go-Standardbibliothek** | Dependabot meldet keine Lücken der Go-Version. Die Images bauen mit `golang:1.27-alpine`, Renovate hält das Basis-Image aktuell. |

---

## Troubleshooting

| Symptom | Hinweis |
|---|---|
| CodeQL-Lauf rot: „CodeQL analyses from advanced configurations cannot be processed when the default setup is enabled“ | Settings → Advanced Security → CodeQL analysis: „Default setup“ abschalten |
| Swift-Job rot: „We were unable to automatically build your code“ oder `xcodebuild`-Fehler | Auf einem Mac nachstellen: `cd ios && xcodegen generate && xcodebuild build -project HomeserverDashboard.xcodeproj -target HomeserverDashboard CODE_SIGNING_ALLOWED=NO`. Baut die App dort, im Workflow auf `build-mode: manual` mit genau diesem Befehl umstellen. |
| `security-issues.yml` rot: „Dependabot alerts are disabled for this repository“ | Settings → Advanced Security → Dependabot alerts aktivieren |
| `security-issues.yml` rot: „Resource not accessible by integration“ bei `dependabot/alerts` | Berechtigung `vulnerability-alerts: read` fehlt im Job. Notlösung: fine-grained PAT mit „Dependabot alerts: Read-only“ als `GH_TOKEN` |
| Kein Dependabot-PR trotz Alert | Dependabot security updates aktiv? Gibt es eine gepatchte Version (Spalte „behoben in“)? Scheitert das Update, zeigt der Alert selbst den Grund („Dependabot cannot update …“). |
| Renovate- und Dependabot-PR für dasselbe Paket | Kann vorkommen, wenn das Sicherheits-Update zugleich ein normales Versions-Update ist. Einen mergen, der andere schließt sich selbst. |
| Ein Issue öffnet sich immer wieder | Der Alert ist noch offen: beheben oder im Security-Tab verwerfen |
| `actionlint` meldet `unknown permission scope "vulnerability-alerts"` | actionlint 1.7.12 kennt die Berechtigung noch nicht. GitHub akzeptiert sie (dokumentiert seit 2026-09-03). |
