# Renovate — automatische Update-PRs

[Renovate](https://docs.renovatebot.com/) durchsucht das Repo nach Helm-Chart-
Versionen, Container-Image-Tags und GitHub-Actions-Versionen und öffnet
automatisch einen Pull Request, sobald eine neuere Version verfügbar ist.
Vorher musste jede neue Chart-/Image-Version manuell in `values.yaml`/
`Chart.yaml` nachgetragen werden — leicht zu übersehen, gerade bei
Sicherheitsupdates.

---

## Was Renovate hier überwacht

| Quelle | Manager | Beispiel |
|---|---|---|
| `argocd/apps/*/values.yaml` | `helm-values` | Image-Tags wie `vaultwarden/server:1.37.1` |
| `argocd/apps/*/Chart.yaml` | `helmv3` | `dependencies[].version` (Subchart-Versionen) |
| `.github/workflows/*.yml` | `github-actions` | `uses: actions/checkout@vX` |

Config liegt in [`renovate.json`](../../renovate.json) im Repo-Root.

**Bewusst ausgenommen:** `**/charts/**` (vendored `.tgz`-Subcharts, z. B.
`argocd/apps/platform/headlamp/charts/headlamp-*.tgz`) und `Chart.lock` — die werden
weiterhin manuell per `helm dependency update` aktualisiert, nicht per
Renovate-PR gegen eine generierte Lockdatei.

---

## Verhalten

- **Zeitplan:** Minor-/Major-Updates wöchentlich (montags vor 6 Uhr), Patch-
  Updates sofort — damit Sicherheitspatches nicht bis Montag liegen bleiben.
- **Gruppierung:** Alle Änderungen einer App (Chart-Version + Image-Tag)
  landen in einem gemeinsamen PR statt in mehreren Einzel-PRs.
- **Dependency Dashboard:** Renovate legt ein offenes GitHub-Issue
  „Dependency Dashboard" an, das den Status aller erkannten Updates auflistet
  (auch die, die z. B. wegen offener Major-Version zurückgehalten werden).

## Was Renovate NICHT tut

- Es merged nichts automatisch — jeder PR bleibt bis zur manuellen Prüfung
  und manuellem Merge offen (Commits/Merges macht der Betreiber selbst).
- Es rollt nichts im Cluster aus — erst nach dem Merge auf `main` greift der
  normale GitOps-Kreislauf: ArgoCD pollt das Repo und synct die geänderte
  `values.yaml` wie jede andere Änderung auch (siehe
  [docs/b-kubernetes-gitops/b0010-argocd.md](../b-kubernetes-gitops/b0010-argocd.md)).
- Ein Merge auf `main` löst zusätzlich automatisch ein neues GitHub-Release
  aus, siehe [docs/f-cicd-automatisierung/f0030-release-automation.md](f0030-release-automation.md).

---

## Einmalige Einrichtung (GitHub-seitig, nicht Teil dieses Repos)

Renovate läuft als GitHub App, nicht als Workflow-Datei — die Config in
`renovate.json` reicht nur, wenn die App installiert ist:

1. [github.com/apps/renovate](https://github.com/apps/renovate) öffnen.
2. **Install** → Repository `pkr-lab/capulus-core` auswählen (nicht
   „All repositories", falls der GitHub-Account weitere private Repos hat).
3. Renovate erkennt `renovate.json` automatisch beim nächsten Lauf und öffnet
   den initialen „Configure Renovate"-PR sowie das Dependency-Dashboard-Issue.

**Wichtige Falle bei Repos in einer Org:** Liegt das Repo unter einer GitHub-
Org (hier `pkr-lab`) statt einem persönlichen Account, muss die App auf
**Org-Ebene** installiert/autorisiert sein
(`github.com/organizations/pkr-lab/settings/installations`). Eine App-
Installation, die nur für den persönlichen Account bestand, wandert bei einem
Repo-Transfer in eine Org **nicht** automatisch mit — Renovate verliert dann
kommentarlos den Zugriff und öffnet einfach keine PRs mehr, ohne Fehlermeldung
irgendwo im Repo selbst.

---

## Troubleshooting

| Symptom | Hinweis |
|---|---|
| Kein PR trotz neuer Upstream-Version | Dependency-Dashboard-Issue prüfen — Update evtl. wegen Versions-Constraint zurückgehalten |
| PR für `charts/*.tgz` oder `Chart.lock` erscheint doch | `packageRules`-Ausschluss in `renovate.json` prüfen, Pfad ggf. nicht getroffen |
| Renovate reagiert **gar nicht** mehr (kein Dependency-Dashboard-Issue, keine PRs, obwohl `renovate.json` valide ist) | Meist ein App-Installations-Problem, kein Config-Problem — lokal geprüft: `renovate.json` ist gültiges JSON, alle `fileMatch`-Pfade (`argocd/apps/*/values.yaml`, `.../Chart.yaml`) existieren tatsächlich im Repo. Nächste Schritte: 1) [github.com/settings/installations](https://github.com/settings/installations) bzw. für Orgs `github.com/organizations/pkr-lab/settings/installations` öffnen und prüfen, ob die Renovate-App dort noch gelistet ist und Zugriff auf `capulus-core` hat. 2) Falls nicht (mehr) installiert oder Zugriff entzogen: unter „Einmalige Einrichtung" oben neu installieren. 3) Bis das geklärt ist, läuft der Fallback-Workflow unten unabhängig von der App. |

---

## Self-hosted Fallback (GitHub Actions)

Falls die GitHub App (wieder) den Zugriff verliert, öffnet
[`.github/workflows/renovate.yml`](../../.github/workflows/renovate.yml) die
gleichen PRs unabhängig davon — über
[`renovatebot/github-action`](https://github.com/renovatebot/github-action)
mit einem PAT statt der App. Er nutzt dieselbe `renovate.json`, es gibt also
keine zweite Config zu pflegen.

**Einmalige Einrichtung:**

1. Fine-grained Personal Access Token erstellen, gescoped **nur** auf
   `pkr-lab/capulus-core`, mit Repository-Permissions: `Contents`,
   `Pull requests`, `Issues`, `Workflows` je auf „Read and write".
2. Token als Repo-Secret `RENOVATE_TOKEN` hinterlegen
   (Settings → Secrets and variables → Actions → New repository secret).
3. Fertig — der Workflow läuft danach automatisch montags 05:00 UTC (vor dem
   `before 6am on monday`-Zeitplan in `renovate.json`, Europe/Berlin) und ist
   zusätzlich per „Run workflow" manuell auslösbar.

**Verhältnis zur App:** Beide Wege schreiben denselben `renovate.json`-Stand
in dieselben PRs — es entsteht kein Konflikt, wenn irgendwann beide parallel
laufen. Der Workflow ist als Fallback gedacht, nicht als Ersatz: Läuft die App
wieder normal, kann `RENOVATE_TOKEN` einfach ungesetzt bleiben oder der
Workflow deaktiviert werden.
