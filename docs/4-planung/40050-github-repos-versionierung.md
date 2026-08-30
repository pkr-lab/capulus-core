# Planung: Versionierung für alle GitHub-Repos

Ziel: Nicht nur `capulus-core`, sondern **alle** eigenen GitHub-Repos sollen
nachvollziehbare Versionen (Git-Tags + Changelog) bekommen — bisher ist das
laut Repo-Historie nur hier über
[semantic-release](f0030-release-automation.md) gelöst.

**Ergebnis vorweg:** Der in `capulus-core` bereits produktive Ansatz
(`.releaserc.json` + `.github/workflows/release.yml`, siehe
[f0030-release-automation.md](f0030-release-automation.md)) ist ohne
Änderung als Vorlage für jedes andere Repo wiederverwendbar — er braucht
weder `package.json` noch eine bestimmte Sprache/Runtime, nur eine
Commit-Historie in Conventional-Commits-Syntax. Der eigentliche Aufwand
liegt nicht im Tooling, sondern darin, **pro Repo zu entscheiden, ob sich
Versionierung überhaupt lohnt**, und bei bereits bestehenden Repos die
Historie so weit sauberzuziehen, dass semantic-release ab einem sinnvollen
Punkt starten kann.

---

## Schritt 0 — Repo-Inventar erstellen

Ich habe von hier aus **keinen GitHub-API-Zugriff** (kein `gh`, kein
Token im Environment) und kann die eigene Repo-Liste daher nicht
automatisch abrufen. Vor dem eigentlichen Rollout einmal manuell (oder
mit `gh repo list <user/org> --limit 200`) eine Liste aller Repos
ziehen — inkl. Sichtbarkeit (privat/öffentlich), Owner (persönlicher
Account vs. `pkr-lab`-Org) und letztem Commit-Datum, um archivierte/tote
Repos direkt auszusortieren (Kriterium C unten).

---

## Schritt 1 — Pro Repo entscheiden: lohnt sich Versionierung?

Nicht jedes Repo braucht Tags/Releases — Kriterien, in Reihenfolge der
Prüfung:

| Kriterium | Versionierung sinnvoll? |
|---|---|
| **A. Hat das Repo "Konsumenten"** — wird irgendwo auf einen bestimmten Commit/Tag referenziert (Deployment zieht `targetRevision`, ein anderes Repo pinnt eine Version, ein Ansible-Playbook zieht eine Release-Version)? | Ja — genau dafür sind Tags da (Nachvollziehbarkeit: "welcher Stand läuft gerade produktiv") |
| **B. Reines IaC-/GitOps-Repo wie `capulus-core` selbst**, wo ArgoCD ohnehin `targetRevision: main` direkt trackt (siehe [a0010-overview.md](../a-betriebssystem/a0010-overview.md)) | Ja, aber als **reine Versionshistorie/Nachvollziehbarkeit**, nicht als Deployment-Gate — deckt sich 1:1 mit der bestehenden Begründung in [f0030-release-automation.md](f0030-release-automation.md) |
| **C. Archiviert / seit > 12 Monaten kein Commit / reines Experiment** | Nein — Aufwand für rückwirkende Versionierung lohnt sich nicht, es sei denn es wird reaktiviert |
| **D. Reine Config-/Dotfiles-/Notiz-Repos ohne Release-Zyklus** | Nein — kein sinnvoller "Versionssprung"-Begriff, `git log` reicht als Historie |
| **E. Node/npm-Pakete, die auf npm veröffentlicht werden** | Ja, plus zusätzlich `@semantic-release/npm` in die Plugin-Liste aufnehmen (im Unterschied zu `capulus-core`, das bewusst **kein** npm-Paket ist, siehe f0030) |

Repos, die A oder B erfüllen, in die Rollout-Liste (Schritt 3) aufnehmen.
C und D bewusst auslassen, nicht "der Vollständigkeit halber" mitziehen.

---

## Schritt 2 — Commit-Historie: Voraussetzung Conventional Commits

semantic-release bestimmt die nächste Version ausschließlich aus
Commit-Präfixen (`fix:`, `feat:`, `BREAKING CHANGE:` — siehe Tabelle in
[f0030-release-automation.md](f0030-release-automation.md)). Zwei Fälle:

- **Repo folgt bereits Conventional Commits** (wie `capulus-core`): Setup
  kann direkt starten, semantic-release wertet die komplette Historie ab
  dem ersten Commit aus.
- **Repo hat bisher keine einheitliche Commit-Syntax:** Historie
  **nicht** rückwirkend umschreiben (Rewrite bestehender, ggf. bereits
  gepushter/geteilter Commits ist riskant und nicht nötig). Stattdessen:
  1. Aktuellen Stand manuell mit einem Start-Tag versehen, z. B. `v1.0.0`
     oder `v0.1.0` je nach Reife des Repos — das gibt semantic-release
     einen sauberen Ausgangspunkt, ab dem es weiterzählt.
  2. Ab sofort Conventional-Commits-Syntax für neue Commits verwenden.
  3. Optional (siehe Schritt 4): Commit-Message-Linting einführen, damit
     das nicht wieder einschläft.

---

## Schritt 3 — Rollout je Repo (wiederholbarer Ablauf)

Für jedes Repo aus Schritt 1 identisch zu `capulus-core`:

1. `.releaserc.json` aus diesem Repo kopieren (unverändert, außer bei
   npm-Paketen: `@semantic-release/npm` ergänzen, siehe Kriterium E).
2. `.github/workflows/release.yml` aus diesem Repo kopieren (unverändert
   — nutzt bereits `permissions: contents: write` und den mitgelieferten
   `GITHUB_TOKEN`, keine weiteren Secrets nötig).
3. Falls Historie nicht in Conventional-Commits-Syntax: Start-Tag setzen
   (Schritt 2).
4. Einmal auf `main` pushen/mergen und den ersten Workflow-Lauf unter
   **Actions → Release** beobachten — bei fehlenden Release-würdigen
   Commits seit dem letzten Tag läuft er als No-Op durch, das ist
   erwartetes Verhalten (siehe Troubleshooting in
   [f0030-release-automation.md](f0030-release-automation.md)).
5. Optional: README des jeweiligen Repos um einen Versions-Badge
   ergänzen (`img.shields.io/github/v/release/<owner>/<repo>`).

---

## Schritt 4 — Konsistenz über alle Repos absichern (optional, empfohlen)

Ohne Durchsetzung schleicht sich über Zeit wieder Commit-Message-Wildwuchs
ein (`fix stuff`, `wip`, …), wodurch semantic-release keine Releases mehr
triggert. Zwei unabhängige, kombinierbare Absicherungen:

- **Commit-Lint-Workflow** (`commitlint` mit
  `@commitlint/config-conventional`) als zusätzlicher Actions-Job, der
  PR-Titel/Commits gegen Conventional-Commits-Syntax prüft und den PR rot
  markiert, bevor gemergt wird — verhindert das Problem, statt es erst
  beim ausbleibenden Release zu bemerken.
- **Branch Protection auf `main`** (GitHub-Repo-Settings, nicht Teil des
  Repo-Codes): "Require status checks to pass" inkl. des
  Commit-Lint-Checks, falls oben umgesetzt.

Beides ist pro Repo ein einmaliger Zusatzaufwand von wenigen Minuten und
lohnt sich vor allem für Repos mit mehreren Mitwirkenden — bei
Ein-Personen-Repos (wie hier) reicht oft schon die Selbstdisziplin, die
`capulus-core`s eigene Historie bereits zeigt.

---

## Was das NICHT ist

- **Kein zentraler Versions-Dashboard/Tracking über alle Repos hinweg.**
  Jedes Repo versioniert unabhängig für sich — es gibt keine
  repo-übergreifende Versionsnummer, das würde eine ganz andere
  Architektur (Monorepo/zentrales Release-Tooling) voraussetzen, die hier
  nicht gebraucht wird.
- **Kein rückwirkendes Umschreiben bestehender Historie** (siehe
  Schritt 2) — Start-Tags statt Rewrite, um bestehende Commits/Referenzen
  nicht zu invalidieren.
- **Kein automatisches `npm publish`/Registry-Push** für Repos, die
  keine Pakete sind — analog zur bewussten Auslassung in `capulus-core`
  selbst (siehe "Was das NICHT tut" in
  [f0030-release-automation.md](f0030-release-automation.md)).

---

## Relevante Links

- [f0030-release-automation.md](f0030-release-automation.md) — die hier
  als Vorlage genutzte, bereits produktive Implementierung
- [.releaserc.json](../../.releaserc.json) — zu kopierende Konfiguration
- [.github/workflows/release.yml](../../.github/workflows/release.yml) —
  zu kopierender Workflow
- [Conventional Commits](https://www.conventionalcommits.org/)
- [semantic-release-Dokumentation](https://semantic-release.gitbook.io/)
