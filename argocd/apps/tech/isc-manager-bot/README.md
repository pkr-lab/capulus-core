# isc-manager-bot

HTTP-API, die eine Person aus SEWOBE (`mv.dlrg.net`) in das DLRG ISC (`dlrg.net`, App „Personen“) überträgt. Steuert headless Chromium mit Playwright. n8n ruft den Dienst cluster-intern auf.

Vollständige Doku (Ablauf, Mapping, Fehlercodes, Deployment, n8n, Risiken): [300x0-isc-manager-bot.md](https://github.com/pkr-lab/docs/blob/main/capulus/capulus-core/3-apps-workloads/300x0-isc-manager-bot.md).

## API

`POST /sync` mit `Authorization: Bearer <API_TOKEN>` und JSON-Body:

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `vorname`, `nachname` | ja | Suche in SEWOBE, exakter Namensvergleich |
| `mitgliedsnummer` | nein | 13 Ziffern, löst gleichnamige Personen in SEWOBE auf |
| `dryRun` | nein | `true`: alles außer Speichern, geplante Änderungen stehen in `diff` |

Antwort:

| Feld | Inhalt |
|---|---|
| `ok` | `true` bei `created`, `updated`, `unchanged`, `skipped` |
| `result` | `created`, `updated`, `unchanged`, `skipped` (nicht aktiv, z. B. ausgetreten) oder `error` |
| `changedFields` | Namen der geänderten Felder, keine Werte |
| `diff` | nur bei `dryRun`: Feld, alter und neuer Wert |
| `errorCode`, `step`, `error` | bei `error`: Code, Schritt und Grund |
| `warnings` | zum Beispiel `GESCHLECHT_NICHT_GESETZT` |

HTTP-Status: 200 bei `ok`, 400 ungültige Anfrage, 422 fachlicher Fehler (nichts gespeichert), 429 Dienst belegt, 502 und 504 technische Fehler.

`GET /healthz` und `GET /readyz` brauchen kein Token.

## Umgebungsvariablen

| Variable | Quelle | Bedeutung |
|---|---|---|
| `API_TOKEN` | Secret | Bearer-Token der API |
| `ISC_USERNAME`, `ISC_PASSWORD` | Secret | ISC-Zugang |
| `SEWOBE_USERNAME`, `SEWOBE_PASSWORD` | Secret | SEWOBE-Zugang |
| `SEWOBE_TOTP_SECRET` | Secret | Base32-Secret des zweiten Faktors, der Bot erzeugt die Codes selbst |
| `ISC_BASE_URL`, `SEWOBE_BASE_URL` | ConfigMap | Standard `https://dlrg.net` und `https://mv.dlrg.net` |
| `GLIEDERUNG_EDV` | ConfigMap | Standard `1002011` |
| `MITGLIEDSCHAFT_GLIEDERUNG` | ConfigMap | Standard `Ortsgruppe Andernach e.V.` |
| `MITGLIEDSCHAFT_SUCHBEGRIFF` | ConfigMap | Name der Gliederung ohne Bezeichnung, wird mit angehängtem Leerzeichen ins ISC-Feld getippt, Standard `Andernach` |
| `STEP_TIMEOUT_MS`, `SEARCH_TIMEOUT_MS`, `SEARCH_SETTLE_MS` (Wartezeit nach der SEWOBE-Sucheingabe, Standard 20000), `SAVE_TIMEOUT_MS`, `SYNC_TIMEOUT_MS`, `LOCK_WAIT_MS`, `MAX_BODY_BYTES` | ConfigMap | Zeitgrenzen und Body-Größe |

Secrets nur als SealedSecret: `scripts/seal-isc-manager-bot.sh` im Repo-Wurzelverzeichnis versiegelt alle sechs Werte und trägt sie in `values.yaml` ein.

## n8n

Workflow `argocd/apps/tech/n8n/workflows/isc-manager-bot-sync.json`: IMAP-Trigger (Ordner `NewUebertrag`) und Test-Formular (Vorname, Nachname, DLRG-Manager-ID, Testlauf). Beide rufen `POST /sync` auf. Das Mailformat ist noch nicht festgelegt, der Mail-Pfad liest vorläufig JSON mit `vorname`, `nachname` und optional `mitgliedsnummer`.

## Entwicklung

```bash
npm ci
npx playwright install chromium
npm test
```

`npm test` führt Typecheck, Unit-Tests und Mock-Tests (Mock-SEWOBE und Mock-ISC) aus, kein Zugriff auf die echten Systeme. `npm run smoke` macht einen Dry-Run gegen die echten Systeme mit `ISC_*`, `SEWOBE_*`, `SMOKE_VORNAME` und `SMOKE_NACHNAME` aus der Umgebung.
