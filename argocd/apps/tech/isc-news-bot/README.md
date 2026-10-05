# isc-news-bot

HTTP-API, die News inkl. Bildern im DLRG ISC (`https://dlrg.net`, App „News“) anlegt. Steuert headless Chromium mit Playwright. n8n ruft den Dienst auf, im n8n-Pod läuft kein Browser.

Vollständige Doku (Ablauf, API, Secrets, Deployment, n8n-Workflow, Troubleshooting, Risiken): [docs/3-apps-workloads/300k0-isc-news-bot.md](../../../../docs/3-apps-workloads/300k0-isc-news-bot.md).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `src/` | Dienst: HTTP-API (`server.ts`), Lauf-Orchestrierung (`runner.ts`), ISC-Schritte (`isc/`), Validierung |
| `src/isc/selectors.ts` | Alle Selektoren und URLs des ISC an einer Stelle |
| `test/unit/` | Unit-Tests: Validierung, Kategorien, Datum, Timeout, Mutex, Auth, Logger |
| `test/e2e/` | Playwright-Tests gegen den lokalen Mock-ISC (`test/fixtures/mock-isc.ts`), kein Zugriff auf das echte ISC |
| `scripts/smoke.ts` | Dry-Run gegen das echte ISC mit lokalen Zugangsdaten (`npm run smoke`) |
| `templates/` | Helm-Chart: Deployment, Service, ConfigMap, SealedSecret, NetworkPolicies |
| `Dockerfile` | Zweistufig auf `mcr.microsoft.com/playwright:v1.63.0-noble`, läuft als uid 1000 |

## Entwicklung

```bash
npm ci
npx playwright install chromium
npm test
```

`npm test` führt Typecheck, Unit-Tests und Mock-Tests aus. Der Dienst lädt keine Konfiguration aus Dateien, alles kommt aus Umgebungsvariablen (Liste in der Doku).
