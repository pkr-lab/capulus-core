# MetalLB — LoadBalancer-Adresse für Traefik (nicht in GitOps)

MetalLB vergibt die LAN-Adresse `192.168.178.200` an den Traefik-Service (`LoadBalancer`), über die alle `*.homeserver`-Hosts im Heimnetz erreichbar sind. Die Installation liegt **nicht** im Repo, sondern wurde von Hand per Helm eingespielt. Dieses Doc hält den Ist-Zustand fest, damit er nach einem Neuaufbau reproduzierbar ist.

> **Cluster:** TECH · Namespace `metallb-system` · kein Ordner unter `argocd/apps/`. `kubectl`-Befehle in diesem Doc gelten für den TECH-Cluster ([Zugriff je Cluster](../a-betriebssystem/a0010-overview.md#kubectl-zugriff-je-cluster)).

---

## Ist-Zustand (2026-10-18)

| Merkmal | Wert |
|---|---|
| Installation | Helm-Release `metallb`, Chart `metallb-0.16.1` (App `v0.16.1`) aus `https://metallb.github.io/metallb`, Revision 1 vom 2026-06-03, **ohne** eigene Values (`USER-SUPPLIED VALUES: null`) |
| Komponenten | `metallb-controller` (Deployment), `metallb-speaker` (DaemonSet, 3 Nodes), `metallb-frr-k8s` (DaemonSet, 3 Nodes, `hostNetwork`), `metallb-frr-k8s-statuscleaner` (Deployment) |
| Modus | **Layer 2** (`L2Advertisement homelab-l2`), BGP wird nicht genutzt |
| Adresspool | `IPAddressPool homelab-pool`: `192.168.178.200-192.168.178.210`, `autoAssign: true` |
| Genutzte Adressen | eine: `192.168.178.200` für `kube-system/traefik` |

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: homelab-pool
  namespace: metallb-system
spec:
  addresses:
    - 192.168.178.200-192.168.178.210
  autoAssign: true
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: homelab-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - homelab-pool
```

---

## Neuaufbau

```bash
helm repo add metallb https://metallb.github.io/metallb
helm install metallb metallb/metallb --version 0.16.1 --namespace metallb-system --create-namespace
kubectl apply -f - <<'YAML'
(IPAddressPool und L2Advertisement von oben)
YAML
```

Prüfen: `kubectl -n metallb-system get pods`, `kubectl -n kube-system get svc traefik` (EXTERNAL-IP `192.168.178.200`), `curl -sk https://192.168.178.200/ -o /dev/null -w '%{http_code}\n'` (Traefik antwortet ohne passenden Host mit `404`, das genügt als Lebenszeichen)`.

---

## Auffälligkeiten

- **FRR wird nicht gebraucht.** Das Chart installiert `frr-k8s` standardmäßig mit, im Layer-2-Modus ohne BGP bleibt es ungenutzt. Es bringt aber `hostNetwork`, Container mit `SYS_ADMIN`, `NET_ADMIN`, `NET_RAW` und den offenen Port `2623` (FRR-`mgmtd`, „Vty password is not set“) auf jedem Node mit. Die FRR-Pods haben hohe Neustartzahlen (bis über 1000 in 135 Tagen). Abschalten: `helm upgrade metallb metallb/metallb --version 0.16.1 -n metallb-system --set frrk8s.enabled=false`. Das startet die Speaker neu; währenddessen kann die Adresse `.200` kurz nicht beantwortet werden (ARP-Wechsel), das heißt kurzer Ausfall aller Dienste über Traefik. Deshalb nur in einem ruhigen Zeitfenster.
- **Webhook:** `metallb-webhook-service` und `frr-k8s-webhook-service` gehören zu den Admission-Webhooks des Charts. Fällt der Controller aus, lassen sich `IPAddressPool`-Objekte nicht ändern.
- **Aufnahme in GitOps** (offen): Ein Wrapper-Chart unter `argocd/apps/tech/metallb/` mit dem Subchart `metallb` 0.16.1 und den beiden Objekten oben, dazu der Namespace in `argocd_platform_apps` und `make render-bootstrap` (braucht das Vault-Passwort). Beim ersten Sync übernimmt ArgoCD die vorhandenen Ressourcen; der Helm-Release-Eintrag bleibt als Altlast (`helm uninstall` wäre ein Eingriff, `kubectl -n metallb-system delete secret -l owner=helm,name=metallb` entfernt nur die Release-Verwaltung).
