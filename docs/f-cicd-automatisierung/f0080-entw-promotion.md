# ENTW → main — automatischer PR nach grüner CI

[`.github/workflows/promote-entw.yml`](../../.github/workflows/promote-entw.yml)
übergibt Änderungen, die auf dem Branch `entw` gelandet sind, als **Pull
Request an `main`** — aber erst, wenn die CI auf `entw` grün ist. `entw` ist
die Git-Quelle des ENTW-Clusters (`argocd_repo_revision: entw` in
`ansible/host_vars/entw-vm/vars.yml`); `main` ist die Quelle von TECH und PROD.
Was auf ENTW getestet wurde, kommt so ohne Handarbeit als fertiger PR nach
`main`, wo [das Ruleset](f0090-branch-schutz-main.md) die Pflicht-Checks prüft und
du den Merge bestätigst.

Das ist die erste, bewusst schlanke Stufe der Promotion-Pipeline aus
[40080, Baustein 6](../4-planung/40080-multi-cluster-entw-prod-tech.md#6-cicd-pipeline-automatisierte-promotion-entw--tech--prod)
(Phase 4). Sie überträgt **alles außer den ENTW-Apps** (Doku, Skripte, Playbooks). Die Apps unter
`argocd/apps/entw/` (existiert seit 2026-09-20 auf dem Branch `entw`, siehe
[b0050](../b-kubernetes-gitops/b0050-entw-argocd.md)) gehen ihren eigenen Weg: die
[Promotion-Kette](f00b0-promotion-chain.md) überträgt deren **Versionen** nach ENTW-Gesundheit (24 h)
über TECH nach PROD. Hier reicht die CI als Freigabe.

---

## Ablauf

```mermaid
flowchart TD
    Push["Commit auf entw<br/>(per PR)"] --> Cron["entw-trigger.yml startet sofort,<br/>Cron stündlich als Fallback<br/>promote-entw.yml auf main"]
    Cron --> Detect{"neue entw-Commits<br/>seit Tag entw-promoted?"}
    Detect -->|nein| Ende["nichts zu tun"]
    Detect -->|ja| CI["ci.yml gegen ref=entw<br/>lint, kubeconform, go, gitleaks"]
    CI -->|rot| Issue["Issue 'ENTW-CI rot',<br/>Tag bleibt, kein PR"]
    CI -->|grün| Pick["Cherry-Pick der Commits<br/>auf promote/entw-SHA (ab main)"]
    Pick -->|Konflikt| Issue2["Issue 'Konflikt',<br/>Tag bleibt, kein PR"]
    Pick -->|ok| PR["PR nach main<br/>(Draft bei Alt-Layout-Dateien)"]
    PR --> Tag["Tag entw-promoted<br/>auf entw-Stand umlegen"]
    Tag --> Merge["du: PR prüfen + mergen<br/>= Rollout auf TECH und PROD"]
```

| Job | Was |
|---|---|
| `detect` | Vergleicht `origin/entw` mit dem Tag `entw-promoted`; gibt es neue Commits, die `main` noch nicht hat? Überspringt Stände, für die schon ein offenes Issue existiert. |
| `ci` | Ruft [`ci.yml`](../../.github/workflows/ci.yml) als wiederverwendbaren Workflow mit `ref: entw` auf — exakt dieselben vier Jobs wie auf einem PR. |
| `ci-failed` | Bei rotem CI: Issue mit Link zum Lauf. Der Cron prüft diesen Stand danach nicht mehr alle 15 Minuten neu. |
| `promote` | Cherry-Pick, PR, Tag umlegen (Logik in [`scripts/promote-entw.sh`](../../scripts/promote-entw.sh)). |

## Der Tag `entw-promoted`

Der Tag ist die Marke „bis hierhin wurde `entw` an `main` übergeben“ und
wird **nur nach erfolgreich geöffnetem PR** (oder nach „nichts zu übergeben“)
auf den neuen `entw`-Stand gesetzt. Die Commits eines PR sind genau die
zwischen altem Tag und neuer `entw`-Spitze, abzüglich allem, was `main` schon
enthält. Ohne Tag (erster Lauf) gilt der Merge-Base von `main` und `entw`.
Der Tag bleibt auch stehen, wenn der PR noch offen ist — dieselben Commits
kommen nicht ein zweites Mal.

## Welche Commits übernommen werden

- **Alle neuen Commits**, außer solchen mit **`[entw-only]`** in der
  Commit-Nachricht **oder die ausschließlich `argocd/apps/entw/` ändern**: ENTW-Apps
  laufen über die [Promotion-Kette](f00b0-promotion-chain.md), ein Cherry-Pick des ENTW-Ordners nach `main`
  wäre nur Rauschen (TECH und PROD lesen ihn nie). Ein **gemischter** Commit (ENTW-Ordner
  plus anderes) wird übernommen; kollidiert er nur im ENTW-Ordner, wird dieser Anteil verworfen.
- Merge-Commits werden nicht übernommen, nur die einzelnen Commits.
- Übernommen wird per `git cherry-pick -x`; die Commit-Nachricht verweist
  dadurch auf das Original. Was `main` schon enthält (gleicher Patch), wird
  verworfen.
- **Layout:** seit `main` nach `entw` gemergt wurde, haben beide Branches dasselbe Layout
  (`tech/`, `prod/`, dazu `entw/`). Für Commits, die noch im **alten** Layout
  (`argocd/apps/platform/`, `workloads/`) entstanden sind, erkennt Git Umzüge bestehender Dateien
  (`workloads/foo/…` → `tech/foo/…`); **neu angelegte** Dateien im alten Layout kann es nicht
  zuordnen. Der PR wird dann als **Draft** geöffnet und nennt die Dateien, die von Hand nach
  `tech/`/`prod/` verschoben werden müssen.

## Fehlerfälle

| Fall | Verhalten | Was du tust |
|---|---|---|
| CI auf `entw` rot | Issue `ENTW-CI rot bei <sha>`, kein PR, Tag bleibt | Fehler auf `entw` beheben. Der neue Stand wird automatisch neu geprüft. |
| Cherry-Pick-Konflikt | Issue `ENTW -> main: Konflikt bei <sha>` mit Konfliktdateien, Lauf rot, Tag bleibt | Änderung von Hand per PR nach `main` bringen, danach Tag setzen (Befehl steht im Issue) — oder auf `entw` den Commit mit `[entw-only]` versehen. |
| Nichts Übertragbares (alles `[entw-only]` oder schon in `main`) | Kein PR, Tag wird trotzdem umgelegt | — |
| PAT fehlt | `promote` bricht mit Hinweis ab | Secret anlegen (siehe unten). |

Jede erfolgreiche Promotion schließt alle offenen `entw-promotion`-Issues.

## Voraussetzung: Personal Access Token

`promote` braucht ein PAT, weil **PRs und Pushes mit dem Standard-`GITHUB_TOKEN`
keine weiteren Workflows auslösen** — die CI auf dem PR bliebe aus, und der
Pflicht-Check würde ewig auf „pending“ stehen. Der Workflow nimmt das Repo-Secret
`PROMOTE_TOKEN`, ersatzweise `RENOVATE_TOKEN` (fine-grained PAT nur für dieses
Repo, `Contents`, `Pull requests`, `Issues`, `Workflows` = Read and write —
das ist die Rechteliste, die [`renovate.yml`](../../.github/workflows/renovate.yml)
ohnehin nutzt). Ein eigenes Secret ist sauberer, weil sich die Rechte dann
getrennt widerrufen lassen.

## Bedienung

| Ziel | Wie |
|---|---|
| Sofort prüfen statt auf den nächsten Lauf warten | GitHub → Actions → „Promote ENTW to main“ → *Run workflow* |
| Einen `entw`-Commit von der Promotion ausnehmen | `[entw-only]` in die Commit-Nachricht |
| Alles bis zu einem Stand als „erledigt“ markieren | `git tag -f entw-promoted <sha> && git push --force origin refs/tags/entw-promoted` |
| Neu beginnen | Tag löschen (`git push origin :refs/tags/entw-promoted`); dann gilt wieder der Merge-Base |

## Gegenrichtung: main -> entw

[`sync-entw.yml`](../../.github/workflows/sync-entw.yml) (Logik: `scripts/sync-entw.sh`) merged `main` nach jedem
Push (Cron stündlich als Fallback) in `entw`, damit `entw` nicht hinter `main` zurückfällt.
Hat `entw` **eigene Commits** (Nicht-Merge-Commits, die `main` nach Patch-Id nicht hat und die noch nicht
per Tag `entw-promoted` übergeben sind), passiert nichts: dort wird gerade getestet. Ein Merge-Konflikt lässt
den Lauf rot enden, ohne zu pushen.

| Ziel | Wie |
|---|---|
| Sync anhalten (z. B. längerer Test) | Repo-Variable `ENTW_SYNC_PAUSED=true` setzen, zum Fortsetzen löschen |
| Sofort synchronisieren | Actions → „Sync main into ENTW“ → *Run workflow* |

## Bewusst nicht enthalten

- **Kein Auto-Merge.** `main` speist TECH *und* PROD, der ArgoCD-Sync nach dem
  Merge ist der Rollout. Ein Mensch bestätigt (wie in 40080 für PROD vorgesehen).
- **Kein ArgoCD-Health-Gate.** „Pipeline durch“ heißt hier: CI grün auf `entw`,
  nicht „läuft seit 24 h gesund auf ENTW“. Das Gesundheits- und Smoke-Gate gilt für die
  ENTW-Apps in der [Promotion-Kette](f00b0-promotion-chain.md).
- **Kein Rollback** bei einem später rot werdenden ENTW.
- **Kein Auto-Rebase**: liegen zwei Promotion-PRs offen, die dieselben Dateien
  ändern, muss der zweite nach dem Merge des ersten aktualisiert werden.

## Auslöser: Push-Trigger plus Cron-Fallback

Ein `push`-Workflow läuft mit der Workflow-Datei **des gepushten Branches**, die Arbeit selbst
soll aber immer mit den aktuellen Workflows von `main` laufen. Deshalb gibt es zwei Auslöser:

- [`entw-trigger.yml`](../../.github/workflows/entw-trigger.yml): kleiner `push`-Workflow auf `entw`, der nur
  `promote-entw.yml` auf `main` per `workflow_dispatch` startet (ein Dispatch mit dem Standard-Token ist erlaubt).
  Die Datei muss dafür **auf `entw` liegen**, sie kommt mit dem nächsten Merge `main` → `entw`.
- Cron **stündlich** als Fallback. Der frühere 15-Minuten-Cron lief im Test nur alle 2–5 Stunden, GitHub drosselt
  Schedules.

## Die Rulesets auf `entw`

Für `entw` gelten drei aktive Rulesets (`entw-1`: kein Löschen, kein Force-Push; `entw-2`: nur per PR,
Admin-Bypass; `Protect MAIN`: PR-Pflicht ohne Bypass). Weil die Regeln aller Rulesets gelten und ein Bypass
nur die Regeln seines eigenen Rulesets aufhebt, kommt **jeder Commit auf `entw` per PR**, auch von Admins. Die
Pipeline pusht nie auf `entw`, sie liest nur. Force-Push betrifft ausschließlich den Tag
`entw-promoted` und die Branches `promote/entw-*`, die von keinem Ruleset
erfasst sind.

## Was getestet wurde

Lokal an einem Wegwerf-Repo (bare `origin` + Arbeitskopie, `gh`-Aufrufe im
Trockenlauf): Erkennen neuer Commits, Cherry-Pick über den Layout-Umzug
`workloads/` → `tech/`, Überspringen von `[entw-only]`, Umlegen des Tags,
„nichts Neues“ im zweiten Lauf, Draft-Warnung bei Neuanlage im alten Layout,
Konfliktfall (Issue, Tag unverändert, Exit 1). Später ergänzt und getestet: Commits, die nur
`argocd/apps/entw/` ändern, werden übersprungen; ein gemischter Commit wird übernommen, sein
ENTW-Anteil bei Konflikt verworfen. `actionlint` und `shellcheck` sind sauber. **Noch nicht gelaufen** ist der Workflow auf GitHub selbst (PAT,
`gh pr create`, der `workflow_call` von `ci.yml`): der erste Lauf sollte per
*Run workflow* beobachtet werden.
