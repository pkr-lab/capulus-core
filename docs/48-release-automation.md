# Release-Automatisierung — GitHub Release bei jedem Merge auf `main`

Jeder Push auf `main` (also jeder gemergte Pull Request) löst automatisch
einen [semantic-release](https://semantic-release.gitbook.io/)-Lauf aus, der
— falls die Commits seit dem letzten Tag das rechtfertigen — eine neue
Versionsnummer vergibt, einen Git-Tag setzt und ein GitHub-Release mit
automatisch generiertem Changelog veröffentlicht.

---

## Warum das funktioniert, ohne extra Konfiguration pro Commit

Die Commit-Historie dieses Repos folgt bereits durchgängig
[Conventional Commits](https://www.conventionalcommits.org/)
(`feat: ...`, `fix: ...`, siehe `git log`). semantic-release liest genau
dieses Präfix, um die nächste Version zu bestimmen:

| Commit-Präfix | Versions-Bump |
|---|---|
| `fix: ...` | Patch (`1.2.3` → `1.2.4`) |
| `feat: ...` | Minor (`1.2.3` → `1.3.0`) |
| `feat: ...` mit `BREAKING CHANGE:` im Body | Major (`1.2.3` → `2.0.0`) |
| alles andere (`docs:`, `chore:`, `refactor:` ohne `fix`/`feat`, …) | kein Release |

---

## Architektur

```
git push origin main (per Merge)
        │
        ▼
.github/workflows/release.yml   (GitHub Actions, Trigger: push → main)
        │
        ▼
npx semantic-release            (.releaserc.json)
        │
        ├── @semantic-release/commit-analyzer      → nächste Version bestimmen
        ├── @semantic-release/release-notes-generator → Changelog-Text erzeugen
        └── @semantic-release/github                → Git-Tag + GitHub-Release erstellen
```

Konfiguration: [`.releaserc.json`](../.releaserc.json),
Workflow: [`.github/workflows/release.yml`](../.github/workflows/release.yml).

---

## Was das NICHT tut

- **Kein Einfluss auf ArgoCD/Deployment.** ArgoCD trackt weiterhin
  `targetRevision: main` direkt (siehe
  [docs/01-overview.md](01-overview.md)) — Releases sind reine
  Versionshistorie/Nachvollziehbarkeit, kein Deployment-Gate.
- **Kein `npm publish`.** Die `@semantic-release/npm`-Plugin ist bewusst
  nicht in der Plugin-Liste — dieses Repo ist kein npm-Paket, es gibt kein
  `package.json`.
- **Kein CHANGELOG.md-Commit.** `@semantic-release/changelog` +
  `@semantic-release/git` sind bewusst nicht eingebunden, damit die
  Pipeline selbst keine zusätzlichen Commits auf `main` erzeugt — das
  generierte Changelog landet ausschließlich im GitHub-Release-Text.

---

## Troubleshooting

| Symptom | Hinweis |
|---|---|
| Kein Release trotz `feat:`-Commit | Prüfen, ob der Commit-Präfix exakt Conventional-Commits-Syntax folgt (`feat: ...`, nicht `Feat:` oder `feature:`) |
| Workflow schlägt mit 403/permission-Fehler fehl | `permissions: contents: write` im Workflow prüfen — ohne das kann `@semantic-release/github` keinen Tag/Release erstellen |
| Mehrere Commits, aber nur ein Release | Erwartetes Verhalten — semantic-release fasst alle Commits seit dem letzten Tag in einem Release zusammen, auch bei mehreren gemergten PRs zwischen zwei Pushes |
| Workflow-Lauf ansehen | GitHub-Repo → **Actions** → **Release** |
