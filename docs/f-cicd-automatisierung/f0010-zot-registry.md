# Zot (self-hosted OCI-Registry)

[Zot](https://zotregistry.dev) (CNCF Sandbox) ist die selbst gehostete
Alternative zu `ghcr.io` für eigene Images — Zweck: Images müssen nicht
mehr extern auf GitHub liegen. Die Deployment-Konfiguration liegt unter
`argocd/apps/platform/zot/`.

Bewusst gegen [Harbor](https://goharbor.io) entschieden: Harbor bräuchte
zusätzlich eigenes Postgres, Redis und Trivy als separate Komponenten —
passt nicht zum Fußabdruck dieses Clusters. Zot ist ein einzelnes,
statisch gelinktes Go-Binary, spricht die Standard-OCI-Distribution-API
(kaniko/docker/skopeo brauchen keine Sonderbehandlung außer Ziel-Host +
Credentials) und bringt eingebautes GC/Retention sowie repo-level
Access-Control mit, ohne eine eigene DB zu brauchen.

---

## Übersicht

| Komponente  | Technologie                              | Namespace |
|-------------|-------------------------------------------|-----------|
| Zot         | Go-Binary (`ghcr.io/project-zot/zot:v2.1.18`) | `zot`     |
| Persistenz  | StorageClass `nas` (UGREEN NAS, NFS), 30Gi | —         |
| Ingress     | Traefik, **nur LAN/Tailscale** (`zot.tech.homeserver`) | `zot` |
| Secrets     | SealedSecrets (`zot-htpasswd`)             | `zot`     |

Kein externer Host (`*-tech.pke-lab.de`) — anders als z. B. Grafana oder
Nextcloud braucht eine Registry keine Erreichbarkeit aus dem offenen
Internet; kaniko (in-cluster) erreicht Zot ohnehin direkt über den
ClusterIP-Service, nicht über den Ingress.

---

## Auth

Ein einziger Nutzer `kaniko` (htpasswd, bcrypt-gehasht) mit vollen Rechten
(`read`, `create`, `update`, `delete`) auf **alle** Repositories
(`adminPolicy` in `values.yaml`, `configFiles.config.json`). Keine
anonyme Policy — **jeder** Request (Push, Pull, UI, `/v2/_catalog`, …)
braucht Auth, mit einer bewussten Ausnahme: `/livez`, `/readyz`,
`/startupz` sind in Zot selbst nicht hinter der Auth-Middleware
registriert (siehe `pkg/api/routes.go`), deshalb kein `authHeader`-Wert
für die Kubernetes-Probes nötig.

**Wichtig — anders als bei `ghcr.io`-Packages:** Es gibt keine
"öffentliche Sichtbarkeit" zum Freischalten. Jeder Client, der von Zot
pullen will (auch Kubernetes selbst, um einen Pod mit einem
Zot-Image zu starten!), braucht Credentials — siehe
[Images aus Zot pullen](#images-aus-zot-pullen-imagepullsecrets) unten.

### Credentials rotieren

```bash
NEW_PASS="<neues starkes Passwort>"
NEW_HASH=$(python3 -c "
import bcrypt
print(bcrypt.hashpw('$NEW_PASS'.encode(), bcrypt.gensalt(rounds=10)).decode())
")
echo -n "kaniko:${NEW_HASH}" | kubeseal --raw \
  --namespace zot --name zot-htpasswd \
  --controller-namespace sealed-secrets \
  --controller-name sealed-secrets-controller \
  --from-file=/dev/stdin
# → Ausgabe als htpasswdSecret.encryptedHtpasswd in values.yaml eintragen
```

Danach überall, wo das alte Passwort hinterlegt ist, aktualisieren: das
`ghcr-push`-Docker-Config-Secret (`argo-workflows`-Namespace, siehe unten)
und jedes `imagePullSecret`, das Apps zum Pullen aus Zot nutzen.

---

## Images nach Zot bauen/pushen (kaniko)

Analog zu `pacman`/`n8n` (siehe deren READMEs bzw.
[docs/3-apps-workloads/30070-n8n.md](../3-apps-workloads/30070-n8n.md)) über das `kaniko-build-push`
Argo-WorkflowTemplate — nur der `image`-Parameter zeigt auf Zot statt
`ghcr.io`:

```bash
export ARGO_SERVER=argo-workflows.tech.homeserver:80
export ARGO_HTTP1=true
export ARGO_SECURE=false
export ARGO_TOKEN="Bearer $(kubectl -n argo-workflows create token argo-workflow)"

argo submit -n argo-workflows --from workflowtemplate/kaniko-build-push \
  -p repo=https://github.com/pkr-lab/capulus-core.git \
  -p revision=main \
  -p context=argocd/apps/workloads/<app> \
  -p dockerfile=Dockerfile \
  -p image=zot.zot.svc.cluster.local:5000/<app>:<tag>
```

**Credentials:** `kaniko-build-push` mountet ein einziges
Docker-Config-Secret namens `ghcr-push` (Namespace `argo-workflows`,
**außerhalb von Git/SealedSecrets** manuell angelegt, siehe
`argocd/apps/platform/argo-workflows/values.yaml`) für alle Registries.
Ein Eintrag für Zot wurde dort ergänzt (`zot.zot.svc.cluster.local:5000`),
ohne den bestehenden `ghcr.io`-Eintrag zu verändern:

```bash
NEW_AUTH=$(echo -n "kaniko:<passwort>" | base64 -w0)
kubectl get secret -n argo-workflows ghcr-push \
  -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d | \
  jq --arg auth "$NEW_AUTH" \
    '.auths["zot.zot.svc.cluster.local:5000"] = {"auth": $auth}' \
  > /tmp/dockerconfig-merged.json

kubectl create secret generic ghcr-push -n argo-workflows \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/tmp/dockerconfig-merged.json \
  --dry-run=client -o yaml | kubectl apply -f -

rm /tmp/dockerconfig-merged.json
```

Bei einem Passwort-Wechsel muss dieser Eintrag entsprechend neu gesetzt
werden (derselbe Befehl mit neuem `NEW_AUTH`).

---

## Images aus Zot pullen (`imagePullSecrets`)

Da Zot **keine** anonyme Policy hat, braucht jeder Pod, der ein
Zot-Image referenziert, ein `imagePullSecrets`-Eintrag — sonst
`ImagePullBackOff` mit "unauthorized". Secret pro Namespace anlegen
(Docker-Config-Format, analog zu `ghcr-push` oben) und versiegeln:

```bash
kubectl create secret docker-registry zot-pull \
  --docker-server=zot.zot.svc.cluster.local:5000 \
  --docker-username=kaniko --docker-password='<passwort>' \
  --namespace <app-namespace> --dry-run=client -o yaml \
  | kubeseal --format yaml \
    --controller-namespace sealed-secrets \
    --controller-name sealed-secrets-controller \
  > zot-pull-sealedsecret.yaml
```

Die gerenderte `SealedSecret` ins Chart des jeweiligen Apps übernehmen
(Vorbild: `argocd/apps/workloads/carplay-api/` verwendet bereits ein
`imagePullSecrets`-Muster) und im Deployment referenzieren:

```yaml
spec:
  template:
    spec:
      imagePullSecrets:
        - name: zot-pull
```

**Noch nicht Teil dieses ersten Rollouts** — muss pro App ergänzt werden,
sobald deren Image tatsächlich nach Zot migriert wird (siehe
[Migrations-Status](#migrations-status) unten).

---

## Web-UI

`http://zot.tech.homeserver` (LAN/Tailscale) — eingebaute Zot-UI
(`extensions.ui.enable: true` + `extensions.search.enable: true` in
`values.yaml` → `configFiles."config.json"`), **kein** separates ZUI nötig.
Ohne diese beiden Extensions liefert Zot auf `/` nur `404` (reine
Registry-API ohne UI) — das war beim ersten Rollout der Fall.

Browser fragt beim Aufruf Basic-Auth ab (Zot hat kein eigenes
Session-Cookie-Login für die UI) — Login mit dem `kaniko`-Nutzer.

---

## Bekannte Einschränkung: ArgoCD zeigt `StatefulSet` dauerhaft als OutOfSync

Kosmetisch, kein Funktionsproblem — Ursache und Ignore-Regel dokumentiert
in `ansible/roles/argocd/templates/bootstrap-applicationset.yaml.j2`
(Suche nach `zot StatefulSet`). Betrifft nur die Anzeige in der
ArgoCD-UI, `argocd app diff` zeigt keinen echten Unterschied und jeder
Sync läuft erfolgreich durch.

---

## Migrations-Status

- ✅ Zot selbst deployt, Auth/UI verifiziert, kaniko kann pushen
  (Credentials im gemeinsamen `ghcr-push`-Secret ergänzt).
- ⏳ Eigene Images (`pacman`, `carplay-api`, `n8n-custom`) noch auf
  `ghcr.io` — Migration nach Zot ist der nächste Schritt.
- ⏳ Extern verteilte Images (nextcloud, postgres, redis, immich,
  paperless-ngx, …) sollen als Mirror nach Zot gezogen werden, geprüft
  und die jeweiligen `values.yaml` (`image.repository`) danach
  umgestellt werden.

---

## Relevante Links

- [Zot-Dokumentation](https://zotregistry.dev)
- [Zot Helm-Chart](https://zotregistry.dev/helm-charts/) (Chart-Repo, in
  `Chart.yaml` als `dependencies` eingebunden, wie bei `minio`)
- [project-zot/zot auf GitHub](https://github.com/project-zot/zot)
- [Argo Workflows / kaniko-build-push](f0000-argo-workflows.md)
