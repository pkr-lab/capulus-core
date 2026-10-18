# 031 Lieferkette von Builds und Updates: alert-caller-Dockerfile ohne Pinning, Renovate ohne Sicherheits-Alerts und ohne `minimumReleaseAge`

- Severity: Low
- Bereich: Repo
- Betroffen: `argocd/apps/tech/alert-caller/Dockerfile:14-26`, `renovate.json:28`, `.github/dependabot.yml`
- Status: Teilweise behoben am 2026-10-18 (Dockerfile-Pinning, Karenzzeiten im Code, gestaged; Renovate-Sicherheits-PRs bewusst nicht aktiviert)

## Beschreibung

- `alert-caller/Dockerfile` klont `baresip/re` und `baresip/baresip` per Git-Tag (veränderlich, kein Commit-SHA) und installiert `piper-tts==1.8.0` mit ungepinnten Abhängigkeiten per `pip` im Build. Das Basis-Image `ubuntu:24.04` ist nur per Tag gepinnt.
- `renovate.json` setzt `vulnerabilityAlerts.enabled: false`, damit entstehen keine priorisierten Sicherheits-PRs. Es gibt kein `minimumReleaseAge`, neue Releases werden sofort vorgeschlagen (semgrep `renovate-missing-minimum-release-age`).
- `dependabot.yml` ohne `cooldown` (semgrep `dependabot-missing-cooldown`, 2 Treffer).
- Alle Dockerfiles verwenden Basis-Images per Tag, nicht per Digest.

## Nachweis

```
$ sed -n '14p;16p;26p' argocd/apps/tech/alert-caller/Dockerfile
RUN git clone --depth 1 --branch "v${BARESIP_VERSION}" https://github.com/baresip/re.git /src/re \
 && git clone --depth 1 --branch "v${BARESIP_VERSION}" https://github.com/baresip/baresip.git /src/baresip
 && /opt/piper/venv/bin/pip install --no-cache-dir "piper-tts==${PIPER_VERSION}" \
$ sed -n 28,30p renovate.json
  "vulnerabilityAlerts": {
    "enabled": false
  },
```

## Risiko / Angriffsszenario

Ein verschobener Git-Tag oder ein kompromittiertes Paket in der pip-Kette landet im Telefon-Alarm-Image. Security-Updates werden mit normaler Priorität (Montag 6 Uhr) und ohne Warnung vorgeschlagen.

## Empfohlene Behebung

1. Git-Clone auf Commit-SHA pinnen (`git fetch --depth 1 origin <sha>` + `checkout`), pip mit `--require-hashes` und einer `requirements.txt` aus `pip-compile --generate-hashes`.
2. In `renovate.json`: `"vulnerabilityAlerts": { "enabled": true, "labels": ["security"] }`, `"minimumReleaseAge": "3 days"`.
3. In `dependabot.yml` `cooldown: { default-days: 3 }`.

## Rollback

Ältere Fassungen der Dateien wiederherstellen.

## Verifikation

```
python3 -c "import json;d=json.load(open('renovate.json'));print(d['vulnerabilityAlerts'],d.get('minimumReleaseAge'))"
docker build -t alert-caller:test argocd/apps/tech/alert-caller
```
Renovate-Dashboard zeigt Sicherheits-PRs; der Docker-Build läuft reproduzierbar durch.

## Risiko der Behebung

Niedrig.

## Behebung (2026-10-18)

**Fix.**

- **alert-caller-Dockerfile (Punkt 1):** `re` und `baresip` werden per Commit-SHA geholt (`BARESIP_RE_SHA=65555dad…`, `BARESIP_SHA=9cfab815…`, beide gehören zu `v4.12.0`, `git init` + `git fetch --depth 1 <url> <sha>` + `checkout FETCH_HEAD`), `piper-tts` samt allen Abhängigkeiten über `requirements.txt` mit Hashes (`pip install --require-hashes`, erzeugt aus `requirements.in` mit `pip-compile --generate-hashes` unter Python 3.12, 7 Pakete, 109 Hashes). `.dockerignore` lässt die Datei durch, `build-images.yml` löst bei Änderung daran einen Build aus.
- **Karenzzeit (Punkte 2 und 3):** `renovate.json` `minimumReleaseAge: "3 days"`, `.github/dependabot.yml` `cooldown: default-days: 3` für beide Ökosysteme.
- **Basis-Images per Digest:** über die Regel `pinDigests` aus Incident 023 (Renovate trägt die Digests nach, auch für `ubuntu:24.04` im Dockerfile).

**Bewusst nicht umgesetzt:** `vulnerabilityAlerts.enabled: true` in Renovate. Die Datenbasis (GitHub-Advisories) kennt Go-Module und Actions, das deckt Dependabot ab; Docker-Images und Helm-Charts kennt sie nicht. Renovate würde nur doppelte PRs öffnen. Begründung in `docs/f-cicd-automatisierung/f0020-renovate.md`.

**Nachweis.**

| Test | Ergebnis |
|---|---|
| `docker build` von `argocd/apps/tech/alert-caller` mit den Änderungen (Ubuntu 24.04, Kompilieren von `re`/`baresip`, Installieren mit Hashes, Stimme laden) | Exit-Code 0 |
| `baresip -h` im gebauten Image | `baresip v4.12.0` |
| `import piper` im venv, Stimme `de_DE-thorsten-high` unter `/opt/piper` | ok |
| `renovate.json`, `dependabot.yml` | gültiges JSON bzw. YAML |
| Doc-Link-Check | 0 kaputte Links |

**Geänderte Dateien.**

- `argocd/apps/tech/alert-caller/Dockerfile`, `.dockerignore`, `requirements.in` (neu), `requirements.txt` (neu)
- `.github/workflows/build-images.yml` (Pfadfilter), `.github/dependabot.yml`, `renovate.json`
- Doku: `docs/6-hintergruende/60040-helm-charts-tech.md`, `docs/f-cicd-automatisierung/f0020-renovate.md`, `docs/d-sicherheit/d0080-codeql-dependabot.md`

**Rollback.** `git revert`; im Dockerfile wieder `git clone --branch v${BARESIP_VERSION}` und `pip install "piper-tts==1.8.0"`.

**Offen.**

- Die Image-Änderung baut `build-images.yml` nach dem Merge neu und öffnet den Tag-Bump-PR für `alert-caller`; der Telefon-Alarm bekommt das neue Image erst nach dessen Merge. Danach einen Testanruf auslösen.
- Die `ARG BARESIP_VERSION` ist nur noch Dokumentation der Version (kein Verbraucher mehr), `BARESIP_RE_SHA` und `BARESIP_SHA` müssen bei Versionssprüngen gleichzeitig angepasst werden.
