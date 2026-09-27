# PROD-Cluster im TECH-Hub

Der PROD-Cluster (`prod-vm`, 192.168.178.99) hat **keine eigene ArgoCD-Instanz**: der ArgoCD-Hub auf
TECH (`homeserver`) verwaltet ihn als registrierten Cluster `prod`. Die Dateien in diesem Ordner sind
handgeschrieben, **nicht** vom `argocd`-Ansible-Role generiert (anders als `argocd/bootstrap/`), und
beruehren das ApplicationSet `home-server-apps-tech` nicht. Ueberblick ueber Projekte und
ApplicationSets: [docs/b-kubernetes-gitops/b0020-argocd-projects.md](../../docs/b-kubernetes-gitops/b0020-argocd-projects.md).

Inhalt: `appproject.yaml` (Projekt `prod`), `applicationset.yaml` (zwei ApplicationSets) und
`migrations/` (manuelle Hilfsmanifeste fuer den Umzug von Apps samt Daten von TECH nach PROD,
siehe [migrations/README.md](migrations/README.md)).

## 1. Cluster "prod" im Hub registrieren

Auf **prod-vm** (ServiceAccount + Token, entspricht `argocd cluster add`):

```bash
sudo k3s kubectl apply -f - <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata: {name: argocd-manager, namespace: kube-system}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {name: argocd-manager}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin}
subjects: [{kind: ServiceAccount, name: argocd-manager, namespace: kube-system}]
---
apiVersion: v1
kind: Secret
metadata:
  name: argocd-manager-token
  namespace: kube-system
  annotations: {kubernetes.io/service-account.name: argocd-manager}
type: kubernetes.io/service-account-token
YAML
sudo k3s kubectl -n kube-system get secret argocd-manager-token -o jsonpath='{.data.token}' | base64 -d; echo
sudo k3s kubectl -n kube-system get secret argocd-manager-token -o jsonpath='{.data.ca\.crt}'   # base64 belassen
```

Auf **homeserver** (TECH) das Secret anlegen. Token und CA nur lokal
einsetzen, **nicht** ins Repo committen:

```bash
kubectl apply -f - <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: cluster-prod
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
    cluster-tier: prod
type: Opaque
stringData:
  name: prod
  server: https://192.168.178.99:6443
  config: |
    {"bearerToken": "<TOKEN>", "tlsClientConfig": {"insecure": false, "caData": "<CA_BASE64>"}}
YAML
```

## Zwei ApplicationSets

`applicationset.yaml` enthaelt zwei Sets, weil `helm.releaseName` ArgoCD in den
Helm-Modus zwingt und bei Ordnern ohne `Chart.yaml` scheitert:

- `home-server-apps-prod`: reine Manifest-Ordner, **explizit gelistet**. Ein neuer
  Manifest-Ordner unter `argocd/apps/prod/` braucht dort einen `path`-Eintrag.
- `home-server-apps-prod-charts`: jeder Ordner mit `Chart.yaml`, automatisch;
  Helm-Release-Name = Ordnername (wie in TECH).

Ordner mit `Chart.yaml` nicht im ersten Set listen (doppelte Applications).

## 2. Projekt + ApplicationSet anwenden

```bash
kubectl apply -f argocd/bootstrap-prod/appproject.yaml
kubectl apply -f argocd/bootstrap-prod/applicationset.yaml
```

## 3. Pruefen

```bash
kubectl -n argocd get applications | grep '^prod-'     # auf homeserver (TECH-Hub): prod-sealed-secrets, prod-nextcloud, ...
sudo k3s kubectl get pods -A                            # auf prod-vm
```

## Neue PROD-App hinzufuegen

1. Ordner `argocd/apps/prod/<app>/` anlegen (Ordnername = Namespace = Helm-Release-Name).
2. Namespace in `appproject.yaml` ergaenzen und die Datei im Hub anwenden
   (`kubectl apply -f argocd/bootstrap-prod/appproject.yaml`). Ohne diesen Schritt meldet die
   Application `InvalidSpecError`/`Unknown`; danach `argocd.argoproj.io/refresh=hard` auf die Application setzen.
3. Nur bei einem **reinen Manifest-Ordner** (ohne `Chart.yaml`): `path` in `applicationset.yaml`
   (Set `home-server-apps-prod`) ergaenzen und anwenden. Ordner mit `Chart.yaml` werden vom Set
   `home-server-apps-prod-charts` automatisch gefunden.
4. Fuer einen internen Host unter `*.prod.homeserver`: Name in `dnsmasq_prod_vm_hosts`
   (`ansible/group_vars/all.yml`) eintragen und `make dnsmasq` ausfuehren, sonst antwortet der
   TECH-Traefik. Ein oeffentlicher Host braucht zusaetzlich einen DNS-Eintrag auf den PROD-Tunnel:
   `cloudflared tunnel route dns homeserver-prod <host>`, siehe
   [docs/e-externe-erreichbarkeit/e0010-cloudflare-deploy.md](../../docs/e-externe-erreichbarkeit/e0010-cloudflare-deploy.md).
5. SealedSecrets muessen mit dem Zertifikat des **PROD**-sealed-secrets-Controllers versiegelt werden
   (`scripts/reseal-for-prod.sh`, Kopf des Skripts), die TECH-Versiegelung ist in PROD nicht entschluesselbar.

Rueckbau: `kubectl delete -f argocd/bootstrap-prod/applicationset.yaml`
(entfernt die Applications samt Ressourcen in PROD, TECH bleibt unberuehrt).
