# 044 Argo Workflows: zwei ClusterRoleBindings zeigen auf nicht vorhandene ClusterRoles

- Severity: Low
- Bereich: Repo
- Betroffen: ClusterRoleBindings `argo-workflows-server-cluster-template`, `argo-workflows-workflow-controller-cluster-template` (TECH-Cluster), `argocd/apps/tech/argo-workflows`
- Status: Behoben am 2026-10-18 im Code (gestaged; ArgoCD entfernt die zwei Bindings beim nächsten Sync per Prune)

## Beschreibung

Im TECH-Cluster binden zwei ClusterRoleBindings die ServiceAccounts `argo-workflows-server` und `argo-workflows-workflow-controller` an gleichnamige ClusterRoles, die es nicht gibt. Rechteabfragen für diese ServiceAccounts melden den Fehler `clusterrole … not found`. Folgen: Die Controller verlieren Rechte, die sie für ClusterWorkflowTemplates brauchen (funktional). Zusätzlich gilt ein Latenzrisiko: Wer künftig eine ClusterRole mit genau diesem Namen anlegt (auch versehentlich durch ein Chart-Update), vergibt damit sofort deren Rechte an diese ServiceAccounts.

## Nachweis

```
$ kubectl get clusterrolebinding -o json | (Binding.roleRef nicht in ClusterRoles)
verwaist: argo-workflows-server-cluster-template -> argo-workflows-server-cluster-template
verwaist: argo-workflows-workflow-controller-cluster-template -> argo-workflows-workflow-controller-cluster-template

$ kubectl auth can-i get secrets -A --as=system:serviceaccount:argo-workflows:argo-workflows-server
no - RBAC: clusterrole.rbac.authorization.k8s.io "argo-workflows-server-cluster-template" not found
```

## Risiko / Angriffsszenario

Gering: kein aktueller Rechtegewinn, aber ein unbemerkter Funktionsfehler und ein Namenskollisions-Risiko bei künftigen Änderungen.

## Empfohlene Behebung

Entweder die fehlenden ClusterRoles aus dem Chart wieder anlegen (`controller.clusterWorkflowTemplates.enabled` bzw. `server.clusterWorkflowTemplates.enabled` prüfen) oder die beiden ClusterRoleBindings entfernen, wenn ClusterWorkflowTemplates nicht genutzt werden.

## Rollback

ClusterRoleBindings aus dem ArgoCD-Stand wiederherstellen.

## Verifikation

```
kubectl get clusterrolebinding argo-workflows-server-cluster-template argo-workflows-workflow-controller-cluster-template
```
`NotFound` (Variante „entfernen“) oder `kubectl auth can-i --as=… list clusterworkflowtemplates` liefert `yes` (Variante „anlegen“).

## Risiko der Behebung

Niedrig.

## Behebung (2026-10-18)

**Ursache.** Das Chart `argo-workflows` 2.0.13 erzeugt mit `singleNamespace: true` die ClusterRoleBindings `…-cluster-template` weiterhin (Bedingung nur `clusterWorkflowTemplates.enabled`, Standard `true`), die zugehörigen ClusterRoles aber nicht (Bedingung `enabled` **und** `not singleNamespace`).

**Fix (Variante „entfernen“).** `argocd/apps/tech/argo-workflows/values.yaml`: `argo-workflows.server.clusterWorkflowTemplates.enabled: false` und `argo-workflows.controller.clusterWorkflowTemplates.enabled: false`. Im Cluster existiert keine `ClusterWorkflowTemplate` (`kubectl get clusterworkflowtemplates` → „No resources found“), die Funktion wird nicht genutzt.

**Nachweis** (vor dem Merge).

| Test | Ergebnis |
|---|---|
| `helm template` (Abhängigkeiten per `helm dependency build`) vorher | beide `…-cluster-template`-ClusterRoleBindings ohne passende ClusterRole |
| `helm template` nachher | kein `cluster-template` mehr im Rendering |
| ArgoCD-Sync-Policy `argo-workflows` | `automated: prune: true, selfHeal: true`, die zwei Bindings (Label `app.kubernetes.io/instance=argo-workflows`) werden also entfernt |

**Geänderte Dateien.**

- `argocd/apps/tech/argo-workflows/values.yaml`
- Doku: `docs/6-hintergruende/60040-helm-charts-tech.md`

**Rollback.** `git revert`; ArgoCD legt die Bindings wieder an (ohne ClusterRoles, wie vorher).

**Offen.** Nach dem Sync prüfen: `kubectl get clusterrolebinding | grep cluster-template` → leer; Argo-Workflows-UI und ein Testlauf laufen weiter.
