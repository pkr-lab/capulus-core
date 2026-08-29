# Build Workload Images — automatisierte Custom-Image-Builds

[`.github/workflows/build-images.yml`](../../.github/workflows/build-images.yml)
baut und pusht die drei selbst gebauten Workload-Images —
[`pacman`](../../argocd/apps/workloads/pacman/), [`carplay-api`](../../argocd/apps/workloads/carplay-api/)
und [`n8n`](../../argocd/apps/workloads/n8n/) (dessen `image/Dockerfile`) —
automatisch nach GHCR, sobald der jeweilige Build-Kontext auf `main`
geändert wird. Vorher musste dafür manuell das `kaniko-build-push`
Argo-WorkflowTemplate gegen den Cluster angestoßen werden (siehe
[f0000-argo-workflows.md](f0000-argo-workflows.md#32-image-build-kaniko-build-push)),
das bei jeder Code-Änderung leicht vergessen wurde.

---

## Was der Workflow tut

| Trigger | Bedingung |
|---|---|
| `push` auf `main` | Pfad-Filter pro App (`Dockerfile`, Source-Verzeichnis, `.dockerignore`) — siehe `on.push.paths` im Workflow |
| `workflow_dispatch` | Manuell über GitHub → Actions → "Build Workload Images" → "Run workflow", App wählbar (`all` oder einzeln) — für einen Rebuild ohne Datei-Änderung, z. B. um ein neues Base-Image einzufangen |

Ein Matrix-Job pro App:

1. **Gate-Schritt** prüft per `git diff` gegen `github.event.before`, ob
   sich *dieser* App-Pfad im Push tatsächlich geändert hat — der
   `on.push.paths`-Filter oben entscheidet nur, ob der Workflow überhaupt
   läuft, nicht welche der drei Matrix-Apps betroffen ist. Ohne dieses
   Gate würde z. B. eine reine `pacman`-Änderung auch `carplay-api` und
   `n8n` unnötig neu bauen.
2. **Tag** = `sha-<kurzer-commit-sha>` (z. B. `sha-a1b2c3d`) — bewusst pro
   Commit eindeutig statt eines wiederverwendeten Tags wie dem alten
   `v1`/`v2`-Schema.
3. **Build + Push** via `docker/build-push-action` nach
   `ghcr.io/pkr-lab/<app>` (bzw. `n8n-custom` für n8n), Auth über den
   Standard-`GITHUB_TOKEN` (Job-Permission `packages: write`) — kein PAT,
   kein Sealed-Secret nötig, anders als beim Kaniko-Weg.
4. **Job-Summary** listet den gepushten `repository:tag`-String.

## Was der Workflow NICHT tut

- **Kein Auto-Commit.** `image.tag` in der jeweiligen `values.yaml` wird
  nicht automatisch geändert — den im Job-Summary gemeldeten Tag von Hand
  eintragen und selbst committen/pushen. Bewusste Entscheidung: Commits
  bleiben unter eigener Kontrolle statt eines Bots.
- **Kein Deploy.** Wie beim alten Weg auch: erst der manuelle Commit auf
  `image.tag` (+ Push nach `main`) lässt ArgoCD den neuen Stand ausrollen,
  siehe [b0010-argocd.md](../b-kubernetes-gitops/b0010-argocd.md).
- **Kein Rebuild bei reinen `values.yaml`-Änderungen** — die Pfad-Filter
  greifen nur auf `Dockerfile`/Source-Verzeichnisse, nicht auf
  `values.yaml` selbst (sonst würde der manuelle Tag-Commit aus dem
  vorigen Punkt einen neuen, unnötigen Build auslösen).

---

## Ablauf nach einer Code-Änderung

1. Dockerfile/Source unter `argocd/apps/workloads/<app>/` ändern, committen,
   nach `main` pushen.
2. GitHub → Actions → "Build Workload Images" abwarten (baut nur die App(s),
   deren Pfad sich geändert hat), Job-Summary öffnen → gepushten Tag
   kopieren.
3. `image.tag` in `argocd/apps/workloads/<app>/values.yaml` auf diesen Tag
   setzen, committen, pushen.
4. ArgoCD synct wie gewohnt (siehe [b0010-argocd.md](../b-kubernetes-gitops/b0010-argocd.md)).

## GHCR-Package-Sichtbarkeit

Frisch gepushte GHCR-Packages sind standardmäßig **privat** — ohne
`imagePullSecrets` scheitert der Pod dann mit `ImagePullBackOff`. Gleiche
Falle/Lösung wie beim alten Kaniko-Weg, siehe
[pacman/README.md](../../argocd/apps/workloads/pacman/README.md#image-bauen).

## Verhältnis zu `kaniko-build-push`

Das Argo-WorkflowTemplate bleibt installiert und nutzbar — als manueller
Fallback für Ad-hoc-Builds von Images außerhalb dieser drei Apps, oder
falls GHCR-Push per `GITHUB_TOKEN` aus GitHub Actions heraus mal nicht
funktioniert (z. B. Org-Policy blockiert Package-Writes). Für `pacman`,
`carplay-api` und `n8n` ist er nicht mehr der vorgesehene Weg.
