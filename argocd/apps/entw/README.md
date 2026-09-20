# argocd/apps/entw — Apps für den ENTW-Cluster

Nur die **ArgoCD-Instanz auf ENTW** (`entw-vm`, 192.168.178.100) liest diesen
Ordner, und zwar auf dem **Branch `entw`**. Das ApplicationSet `home-server-apps-entw` legt für jeden Unterordner
`argocd/apps/entw/<app>/` eine Application an (Namespace = Ordnername, Projekt
`entw`, Auto-Sync mit Prune und Self-Heal). Die ArgoCD-Instanzen von TECH und
PROD lesen `main` und dort nur `argocd/apps/tech/*` bzw. `argocd/apps/prod/*`
und sehen diesen Ordner nie.

Neue App: Ordner mit einem Helm-Chart (`Chart.yaml`, `values.yaml`, `templates/`)
oder reinen Manifesten anlegen und auf den Branch `entw` bringen, dann deployt ENTW
innerhalb von ca. 3 Minuten. Keine Liste, kein AppProject, kein Ansible-Lauf.

Details, Rollout und Fehlersuche:
[docs/b-kubernetes-gitops/b0050-entw-argocd.md](../../../docs/b-kubernetes-gitops/b0050-entw-argocd.md).
