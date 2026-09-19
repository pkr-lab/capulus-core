# PROD-Cluster im TECH-Hub (Phase 2.6 / 3.1)

Handgeschriebene Manifeste, **nicht** vom `argocd`-Ansible-Role generiert.
Sie beruehren die bestehenden ApplicationSets (`home-server-apps-platform`,
`-workloads`) nicht.

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

## 2. Projekt + ApplicationSet anwenden

```bash
kubectl apply -f argocd/bootstrap-prod/appproject.yaml
kubectl apply -f argocd/bootstrap-prod/applicationset.yaml
```

## 3. Pruefen

```bash
kubectl -n argocd get applications | grep '^prod-'     # prod-sealed-secrets, prod-nas-storage, prod-immich-storage
sudo k3s kubectl get pods -A                            # auf prod-vm
```

Rueckbau: `kubectl delete -f argocd/bootstrap-prod/applicationset.yaml`
(entfernt die Applications samt Ressourcen in PROD, TECH bleibt unberuehrt).
