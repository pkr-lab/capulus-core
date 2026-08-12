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

Config liegt in [`renovate.json`](../renovate.json) im Repo-Root.

**Bewusst ausgenommen:** `**/charts/**` (vendored `.tgz`-Subcharts, z. B.
`argocd/apps/platform/authentik/charts/authentik-*.tgz`) und `Chart.lock` — die werden
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
  [docs/05-argocd.md](05-argocd.md)).
- Ein Merge auf `main` löst zusätzlich automatisch ein neues GitHub-Release
  aus, siehe [docs/48-release-automation.md](48-release-automation.md).

---

## Einmalige Einrichtung (GitHub-seitig, nicht Teil dieses Repos)

Renovate läuft als GitHub App, nicht als Workflow-Datei — die Config in
`renovate.json` reicht nur, wenn die App installiert ist:

1. [github.com/apps/renovate](https://github.com/apps/renovate) öffnen.
2. **Install** → Repository `pkr-lab/capulus-core` auswählen (nicht
   „All repositories", falls der GitHub-Account weitere private Repos hat).
3. Renovate erkennt `renovate.json` automatisch beim nächsten Lauf und öffnet
   den initialen „Configure Renovate"-PR sowie das Dependency-Dashboard-Issue.

---

## Troubleshooting

| Symptom | Hinweis |
|---|---|
| Kein PR trotz neuer Upstream-Version | Dependency-Dashboard-Issue prüfen — Update evtl. wegen Versions-Constraint zurückgehalten |
| PR für `charts/*.tgz` oder `Chart.lock` erscheint doch | `packageRules`-Ausschluss in `renovate.json` prüfen, Pfad ggf. nicht getroffen |
| Renovate reagiert gar nicht | GitHub-App-Installation prüfen (Schritt oben) — ohne installierte App liest niemand `renovate.json` |
