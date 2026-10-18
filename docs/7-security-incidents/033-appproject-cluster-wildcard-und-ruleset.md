# 033 ArgoCD-AppProjects erlauben alle Cluster-Ressourcen, der `main`-Ruleset verlangt keine Reviews

- Severity: Low
- Bereich: Repo
- Betroffen: `argocd/bootstrap-prod/appproject.yaml:44-46` (`clusterResourceWhitelist: */*`), `argocd/bootstrap/projects.yaml`, `scripts/setup-main-ruleset.sh:16,24`
- Status: Behoben am 2026-10-18 (PROD-Whitelist angewendet; Pflicht-Review entfällt, ein einziger Betreiber, Restrisiko akzeptiert)

## Beschreibung

Das PROD-AppProject erlaubt `group: "*"` / `kind: "*"` für Cluster-Ressourcen und enthält `kube-system` als Ziel-Namespace. Damit kann jede App im Projekt ClusterRoles, ClusterRoleBindings, CRDs und Webhooks anlegen, also cluster-admin erreichen. Die einzige Schranke ist das Repository: Der Ruleset verlangt 0 Reviews (`required_approving_review_count: 0`, Bypass-Modus `pull_request` für die Admin-Rolle), nur grüne CI. Wer den `main`-Branch ändern kann (kompromittierter PAT: `PROMOTE_TOKEN`/`RENOVATE_TOKEN`, kompromittierte Action), kontrolliert den Cluster. Das ist die Design-Konsequenz von GitOps mit einem Betreiber und beschreibt den Blast Radius der Tokens in Incident 021.

## Nachweis

```
$ sed -n 44,46p argocd/bootstrap-prod/appproject.yaml
  clusterResourceWhitelist:
    - group: "*"
      kind: "*"
$ sed -n '16p;24p' scripts/setup-main-ruleset.sh
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
        "required_approving_review_count": 0,
```

## Risiko / Angriffsszenario

Ein einzelner kompromittierter Zugang zum Repo genügt für eine Cluster-Übernahme. Es existiert keine Vier-Augen-Hürde.

## Empfohlene Behebung

1. `clusterResourceWhitelist` auf die benötigten Gruppen/Kinds einschränken (Namespace, StorageClass, PersistentVolume, CRDs der verwendeten Operatoren, ClusterIssuer).
2. Für Änderungen an `argocd/bootstrap*`, `ansible/`, `.github/workflows/` ein `CODEOWNERS`-Review plus zweite Person oder zumindest erzwungenen Review durch den Betreiber im Ruleset aktivieren.
3. Tokens mit minimalen Rechten und Ablaufdatum (Incident 021).

## Rollback

Whitelist wieder auf `*/*` setzen, Ruleset-Änderung revertieren.

## Verifikation

```
argocd proj get prod -o json | jq '.spec.clusterResourceWhitelist'
gh api repos/pkr-lab/capulus-core/rulesets --jq '.[] | select(.name=="main: PR + CI") | .rules'
```
Whitelist ohne `*`, Ruleset zeigt gewünschte Review-Anzahl.

## Risiko der Behebung

Niedrig: Die Whitelist-Einschränkung muss die tatsächlich benötigten Cluster-Ressourcen abdecken, sonst scheitern Syncs.

## Behebung (2026-10-18)

**Fix.**

- **Punkt 1, PROD:** `argocd/bootstrap-prod/appproject.yaml` erlaubt statt `*/*` nur noch `Namespace`, `CustomResourceDefinition`, `ClusterRole`, `ClusterRoleBinding`, `StorageClass`, `ClusterIssuer` sowie `Mutating-` und `ValidatingWebhookConfiguration`. Die Liste stammt aus den `status.resources` aller 14 `prod-*`-Applications im Hub (cluster-scoped Einträge ohne Namespace).
- **Punkt 2, Pfade:** neu `.github/CODEOWNERS` (Eigentümer `@pkr-lab`) für `.github/`, `ansible/`, `argocd/bootstrap/`, `argocd/bootstrap-prod/`, `ops/`, `scripts/`. Ohne die Ruleset-Regel „Review von Code-Ownern verlangen“ fordert GitHub nur automatisch ein Review an.

**Nachweis.**

| Test | Ergebnis |
|---|---|
| `kubectl diff -f argocd/bootstrap-prod/appproject.yaml` (nur lesend) | ersetzt `*/*` durch die acht Typen; zeigt außerdem, dass das Projekt im Hub Namespaces enthält, die nicht in der Datei stehen (`authentik`, `mealie`, `github-release-watcher`, `tinyteller`, …) |
| Abgleich der Typen mit den live vorhandenen cluster-scoped Ressourcen der PROD-Apps | jede vorhandene Gruppe/Art ist in der Whitelist |

**Geänderte Dateien.**

- `argocd/bootstrap-prod/appproject.yaml`, `.github/CODEOWNERS` (neu)
- Doku: `docs/b-kubernetes-gitops/b0020-argocd-projects.md`, `docs/6-hintergruende/60030-argocd-und-bootstrap.md`

**Rollback.** `clusterResourceWhitelist` wieder auf `group: "*"` / `kind: "*"` setzen und neu anwenden; `.github/CODEOWNERS` löschen.

**Offen.**

- **Ruleset `main: PR + CI`:** `required_approving_review_count` steht auf 0 mit Bypass `pull_request` für die Admin-Rolle. Mit einem Betreiber würde ein Pflicht-Review jeden Merge nur über den Bypass erlauben; wer Vier-Augen will, braucht eine zweite Person. Das ändere ich nicht ohne dich.

## Entscheidung des Betreibers (2026-10-18)

Die Whitelist im Projekt `prod` wurde im Hub angewendet. Eine zweite Person für ein Pflicht-Review gibt es nicht; `required_approving_review_count` bleibt 0 mit Bypass für die Admin-Rolle. Das Restrisiko (ein kompromittierter Zugang zum Repo genügt für eine Cluster-Übernahme, siehe Beschreibung) ist **akzeptiert** und wird nur durch CI, `CODEOWNERS` (informativ), Push Protection und die Token-Fristen abgemildert. Die Projekte `tech` und `entw` bleiben offen (generiert, Wirkung gering, solange das Repo die einzige Schranke ist).
