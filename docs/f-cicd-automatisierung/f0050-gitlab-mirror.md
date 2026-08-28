# GitLab-Mirror — Redundanz-Kopie für den Fall, dass GitHub ausfällt

Alle sechs Stunden sowie bei jedem Push auf `main` und bei jedem neuen Tag
spiegelt [`.github/workflows/mirror-gitlab.yml`](../../.github/workflows/mirror-gitlab.yml)
dieses Repo vollständig (alle Branches + alle Tags, inkl. der
`v${version}`-Tags aus [f0030-release-automation.md](f0030-release-automation.md))
zu einem GitLab-Projekt. Zweck ist reine Redundanz: Fällt GitHub aus oder
wird der Account/das Repo dort unbrauchbar, existiert eine aktuelle
Vollkopie inklusive Versionshistorie auf GitLab.

---

## Funktionsweise

```
push auf main / Tag  ─┐
alle 6h (Cron)        ├──▶ .github/workflows/mirror-gitlab.yml
workflow_dispatch    ─┘            │
                                    ▼
                     git clone --mirror github.com/<repo>
                                    │
                                    ▼
                     git push --mirror <GitLab-Remote>
```

`git push --mirror` überträgt **alle** Refs (Branches, Tags, `refs/heads/*`,
`refs/tags/*`) 1:1 und überschreibt dabei den Stand auf GitLab, damit er
exakt dem von GitHub entspricht — inklusive gelöschter Branches/Tags.

**GitLab ist damit ein reines Backup-Ziel, keine zweite Quelle:** Niemand
soll direkt auf das gespiegelte GitLab-Projekt pushen oder dort Branches
anlegen — der nächste Workflow-Lauf überschreibt/löscht das kommentarlos
wieder, weil er den GitHub-Stand als alleinige Wahrheit behandelt.

---

## Einmalige Einrichtung

Es sind nur drei Repo-Secrets zu hinterlegen (Settings → Secrets and
variables → Actions → New repository secret), der Workflow selbst ist
bereits fertig:

| Secret | Wert | Beispiel |
|---|---|---|
| `GITLAB_MIRROR_REMOTE` | Host + Projektpfad des GitLab-Ziels, **ohne** `https://` und ohne Zugangsdaten | `gitlab.com/pkr-lab/capulus-core.git` oder `git.example.internal/pkr-lab/capulus-core.git` bei selbstgehostetem GitLab |
| `GITLAB_MIRROR_USER` | Username, der zum Token unten passt | bei GitLab-Personal-Access-Token meist `oauth2`; bei Project-Access-Token der selbstvergebene Token-Name |
| `GITLAB_MIRROR_TOKEN` | GitLab-Access-Token mit Scope `write_repository` | Project Access Token, Rolle **Maintainer**, nur für dieses eine Projekt |

**GitLab-seitig vorher:**

1. Leeres Projekt auf GitLab anlegen (Name/Pfad frei wählbar, landet in
   `GITLAB_MIRROR_REMOTE`) — **nicht** initialisieren (kein README, keine
   `.gitignore` von GitLab erzeugen lassen, sonst schlägt der allererste
   Mirror-Push wegen divergierender Historie fehl).
2. Project Access Token erstellen: Projekt → Settings → Access Tokens →
   Scope `write_repository`, Rolle `Maintainer`. Token-Name und Token-Wert
   ergeben `GITLAB_MIRROR_USER`/`GITLAB_MIRROR_TOKEN`.
3. Die drei Secrets oben im GitHub-Repo hinterlegen.

Ab da läuft alles automatisch — kein weiterer Eingriff nötig, auch nicht bei
neuen Branches/Tags.

---

## Was das NICHT tut

- **Kein GitOps-Ziel.** ArgoCD trackt weiterhin ausschließlich das
  GitHub-Repo (siehe [docs/a-betriebssystem/a0010-overview.md](../a-betriebssystem/a0010-overview.md)) — GitLab ist
  nie im Sync-Pfad, sondern nur Kaltstart-Backup im Notfall.
- **Kein bidirektionaler Sync.** Es wird nur GitHub → GitLab gepusht, nie
  umgekehrt gelesen. Änderungen direkt auf GitLab werden beim nächsten Lauf
  überschrieben.
- **Keine Issues/PRs/Wiki.** `git push --mirror` überträgt ausschließlich
  Git-Refs (Commits, Branches, Tags) — keine GitHub-Metadaten wie Issues,
  Pull Requests, Releases-Texte oder das Dependency-Dashboard-Issue.

---

## Troubleshooting

| Symptom | Hinweis |
|---|---|
| Erster Lauf schlägt mit „refusing to update checked out branch" oder non-fast-forward fehl | GitLab-Projekt wurde nicht leer angelegt (README/`.gitignore` beim Erstellen aktiviert) — Projekt leeren oder neu anlegen |
| 403/401 beim Push zu GitLab | `GITLAB_MIRROR_TOKEN` abgelaufen oder Scope fehlt (`write_repository` nötig), bzw. `GITLAB_MIRROR_USER` passt nicht zum Token-Typ |
| Tags fehlen auf GitLab | Workflow-Lauf in **Actions → Mirror to GitLab** prüfen — `git push --mirror` überträgt Tags automatisch, ein Fehlschlag bricht aber den ganzen Push ab (auch Branches bleiben dann veraltet) |
| Mirror wirkt „eingefroren" | `concurrency: group: mirror-gitlab` verhindert parallele Läufe bewusst — ein hängender Lauf blockiert den nächsten bis zum Timeout; ggf. laufenden Workflow manuell abbrechen |
