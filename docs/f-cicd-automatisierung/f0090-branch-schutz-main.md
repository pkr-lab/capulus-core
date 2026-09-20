# Branch-Schutz für `main` — PR-Pflicht + CI als Gate

`main` ist die Quelle von TECH und PROD: ein Commit dort wird von ArgoCD sofort
ausgerollt. Bis September 2026 gingen Änderungen direkt per Push auf `main`, die
[CI](f0070-ci-lint.md) lief erst danach und konnte einen Fehler nur noch melden
(so blieb z. B. ein kaputter Renovate-Bump an pacmans `go.mod` bis zum
Image-Build unbemerkt). Das Ruleset **„main: PR + CI“** macht daraus ein echtes
Gate: Änderungen kommen nur noch per Pull Request, und der PR lässt sich erst
mergen, wenn die CI-Jobs grün sind.

---

## Was das Ruleset erzwingt

| Regel | Wirkung |
|---|---|
| Pull Request | Kein Direkt-Push auf `main`. Kein Pflicht-Review (`0` Freigaben), du arbeitest allein — die Sicherheit kommt aus den Checks. |
| Pflicht-Checks | `make lint (yamllint, ansible-lint, helm lint)`, `helm template \| kubeconform`, `go build, vet, test, tidy`, `docs links`, `gitleaks` — die fünf Jobs aus [`ci.yml`](../../.github/workflows/ci.yml) |
| Kein Force-Push, kein Löschen | `main` ist nicht überschreibbar |
| „Up to date“ nicht verlangt | `strict_required_status_checks_policy: false` — sonst müsste jeder PR nach jedem anderen Merge neu gebaut werden |

**Notausgang:** Repo-Admins dürfen einen PR trotz roter oder fehlender Checks
mergen (`bypass_mode: pull_request`), aber weiterhin **nicht direkt pushen**.
Das verhindert einen Deadlock, wenn die CI selbst kaputt ist (der Fix für die CI
müsste sonst durch die kaputte CI).

Die Image-Builds aus [`build-images.yml`](f0060-build-images.md) sind bewusst
**keine** Pflicht-Checks: der Pfadfilter lässt den Workflow bei PRs ohne
Image-Änderung gar nicht laufen, ein Pflicht-Check bliebe dann ewig auf „pending“.

## Aktivieren

Das Ruleset wird per Skript angelegt (reproduzierbar, im Repo versioniert):

```bash
scripts/setup-main-ruleset.sh --dry-run   # zeigt das JSON
scripts/setup-main-ruleset.sh             # anlegen bzw. aktualisieren (gh als Admin)
```

**Reihenfolge ist wichtig:** erst die neue `ci.yml` (mit allen fünf Jobs) auf
`main` bringen, dann das Skript ausführen. Andernfalls verlangt das Ruleset
Checks, die es nirgends gibt, und der erste PR bleibt auf „pending“. Nach dem
Aktivieren ist auch der eigene Push auf `main` gesperrt.

## Arbeitsablauf danach

1. Branch anlegen, committen, pushen (`git push -u origin <branch>`).
2. PR gegen `main` öffnen (`gh pr create` oder im Browser) — die CI startet.
3. Grün → mergen. Rot → fixen und nachpushen (der Lauf wird ersetzt).

Wer sonst noch PRs aufmacht:

| Quelle | Bemerkung |
|---|---|
| Renovate (App und [Fallback-Workflow](f0020-renovate.md)) | PRs sind jetzt gegated. Ein kaputter Bump (Major-Sprung mit geändertem Import-Pfad, halb aktualisierte `go.mod`) bleibt rot statt auf `main` zu landen. |
| [ENTW-Promotion](f0080-entw-promotion.md) | öffnet PRs mit einem PAT (sonst liefe die CI auf dem PR nicht an) und mergt nie selbst |
| Kleine GitOps-Schritte (Migration: App stoppen, kopieren, starten) | ebenfalls per PR. Ein Lauf dauert ca. 2 Minuten (der `make lint`-Job ist der längste). Nur im Notfall per Admin-Bypass mergen. |

Nicht betroffen sind `release.yml` (setzt nur Tags und Releases, pusht keine
Commits) und `mirror-gitlab.yml` (liest `main`).

## Vorhandene Rulesets im Repo

| Ruleset | Stand | Bemerkung |
|---|---|---|
| `entw-1` | aktiv | `entw`: kein Löschen, kein Force-Push |
| `entw-2` | aktiv | `entw`: nur per PR, Admin-Bypass immer; Pflicht-Checks leer (auf `entw`-PRs läuft mangels passendem Trigger keine CI, die Freigabe übernimmt [die Promotion](f0080-entw-promotion.md)) |
| `Protect MAIN` | aktiv (seit 2026-09-20) | Löschen/Force-Push/PR (0 Freigaben) plus `code_quality`, trifft `main` **und** `entw`. Die Regeln addieren sich mit „main: PR + CI“. Auf `entw` gilt damit auch hier PR-Pflicht ohne Bypass (der Admin-Bypass von `entw-2` hebt die Regeln eines anderen Rulesets nicht auf). |

## Stolperfallen

- **Pfadgefilterte Workflows als Pflicht-Check** bleiben auf „pending“, wenn der
  Filter nicht greift. Nur Jobs ohne Pfadfilter (die vier aus `ci.yml`) sind Pflicht.
- **`GITHUB_TOKEN`-PRs lösen keine CI aus.** Automatisch erzeugte PRs brauchen ein
  PAT (siehe Promotion), sonst sind sie nicht mergbar.
- **Check-Namen** im Ruleset müssen den `name:` der Jobs in `ci.yml` entsprechen.
  Wird ein Job umbenannt oder kommt einer dazu (zuletzt `docs links`), in
  `scripts/setup-main-ruleset.sh` nachziehen und das Skript erneut ausführen: es
  aktualisiert das vorhandene Ruleset.
- **Lock-out:** Ist das Ruleset aktiv und die CI kaputt, hilft nur der
  Admin-Bypass am PR (oder das Ruleset unter *Settings → Rules* auf `disabled`
  setzen).
