# Port-Übersicht aller Apps

Diese Seite listet für jede laufende App: den internen Kubernetes-Service
(ClusterIP:Port), wie sie im LAN erreichbar ist (Traefik-Ingress) und ob/wie
sie zusätzlich extern über den Cloudflare Tunnel erreichbar ist. Stand:
Live-Abfrage aus dem Cluster (`kubectl get svc -A` / `kubectl get ingress -A`).

## Die zwei Wege rein

```
LAN:      Client → 192.168.178.200 (Traefik LoadBalancer, MetalLB) :80/443
                      → Host-Header "xyz.tier.homeserver" → passender Service

Internet: Client → xyz.tier.pke-lab.de → Cloudflare Edge
                      → cloudflared (outbound-only, kein offener Router-Port)
                      → passender Service direkt (an Traefik vorbei)
```

`tier` ist `tech` (Infrastruktur/Admin) oder `prod` (echter Nutzerkreis) —
Details und die vollständige Zuordnung: [docs/55-domain-tiers.md](55-domain-tiers.md).

Wichtig: **cloudflared braucht keinen Port-Forward am Router.** Der Tunnel
baut die Verbindung von innen nach außen auf (siehe
[docs/22-cloudflare-tunnel.md](22-cloudflare-tunnel.md)). Welche Hostnamen
extern erreichbar sind, steht ausschließlich in
`argocd/apps/platform/cloudflared/values.yaml` (`ingress.rules`) — nicht jede App mit
LAN-Ingress ist automatisch auch extern erreichbar.

Node-IP von `homeserver`: `192.168.178.94`. Traefik-LoadBalancer-IP (MetalLB):
`192.168.178.200`.

---

## Web-Apps (Traefik-Ingress, LAN via `*.tier.homeserver`)

| App | Tier | Namespace | Interner Service:Port | LAN (`*.tier.homeserver`) | Extern (`*.tier.pke-lab.de`) |
|---|---|---|---|---|---|
| Immich | prod | immich | immich-server:80 | immich.prod.homeserver | immich.prod.pke-lab.de |
| Nextcloud | prod | nextcloud | nextcloud:80 | nextcloud.prod.homeserver | nextcloud.prod.pke-lab.de |
| Paperless-ngx | prod | paperless-ngx | paperless-ngx:80 | paperless.prod.homeserver | paperless.pke-lab.de |
| Vaultwarden | tech (Ausnahme) | vaultwarden | vaultwarden:80 | vault.tech.homeserver | vault.tech.pke-lab.de |
| Mealie | prod | mealie | mealie:80 | mealie.prod.homeserver | mealie.prod.pke-lab.de |
| n8n | prod | n8n | n8n:80 | n8n.prod.homeserver | – (aus Cloudflare Tunnel entfernt, Security) |
| Wiki.js | prod | wikijs | wikijs:80 | wiki.prod.homeserver | wiki.prod.pke-lab.de |
| Zammad | tech (Ausnahme) | zammad | zammad-nginx:8080 | zammad.tech.homeserver | support.tech.pke-lab.de |
| ntfy | tech | ntfy | ntfy:80 | ntfy.tech.homeserver | ntfy.tech.pke-lab.de |
| Grafana | tech | monitoring | monitoring-grafana:80 | grafana.tech.homeserver | grafana.tech.pke-lab.de |
| Authentik | tech | authentik | authentik-server:80 | authentik.tech.homeserver | authentik.tech.pke-lab.de |
| MediaMTX (Playback) | prod | mediamtx | mediamtx:8888 (HLS) | stream.prod.homeserver | stream.prod.pke-lab.de |
| Gotify | tech | gotify | gotify:80 | gotify.tech.homeserver, gotify-api.tech.homeserver | — (nur LAN/Tailnet) |
| Uptime Kuma | prod | uptime-kuma | uptime-kuma:80 | uptime-kuma.prod.homeserver | — |
| Semaphore | tech | semaphore | semaphore:3000 | semaphore.tech.homeserver, semaphore-api.tech.homeserver | — |
| Pi-hole (Web-UI) | tech | pihole | pihole:80 | pihole.tech.homeserver | — |
| Alamos-Apager | prod | alamos-apager | alamos-apager:8080 | alamos-apager.prod.homeserver | — |
| Xibo CMS | prod | xibosignage | xibosignage-cms:80 | xibo.prod.homeserver | — |
| Homeserver-Dashboard-API | prod | carplay-api | carplay-api:80 | carplay-api.prod.homeserver | — |
| Tinyteller | prod | tinyteller | tinyteller-frontend:80 | tinyteller.prod.homeserver | — |
| Argo Workflows | tech | argo-workflows | argo-workflows-server:2746 | argo-workflows.tech.homeserver | — |
| Headlamp | tech | headlamp | headlamp:80 | headlamp.tech.homeserver | — |
| MinIO Console | tech | minio | minio-console:9001 | minio.tech.homeserver | — |
| kubeseal-webgui | tech | kubeseal-webgui | kubeseal-webgui:8080 | kubeseal-webgui.tech.homeserver | — |
| example-whoami | prod | example-whoami | example-whoami:80 | whoami.prod.homeserver | — |

> Paperless-ngx ist der einzige Eintrag, bei dem LAN- und Extern-Spalte
> noch auseinanderlaufen — der Cloudflare-Tunnel-Eintrag in
> `argocd/apps/platform/cloudflared/values.yaml` trägt für `paperless`
> noch kein Tier-Label (siehe [docs/55-domain-tiers.md](55-domain-tiers.md)).

Alle `*.homeserver`-Hosts laufen über Traefik auf `192.168.178.200:80` (bzw.
`:443` mit TLS, sofern konfiguriert) — kein individueller Port pro App nötig,
Traefik routet per Host-Header. Alle `*.pke-lab.de`-Hosts laufen über den
Cloudflare Tunnel direkt auf den jeweiligen Service (an Traefik vorbei), siehe
`argocd/apps/platform/cloudflared/values.yaml`.

---

## Sonderfälle mit eigenen Ports

| Was | Port(s) | Erreichbar über | Bemerkung |
|---|---|---|---|
| Pi-hole DNS | 53/UDP+TCP | NodePort `homeserver:30053` | Nur LAN/Tailnet, siehe [docs/09-dns-architecture.md](09-dns-architecture.md) |
| MediaMTX Publish (RTMP) | 1935 | NodePort `homeserver:31935` | Für OBS/ffmpeg-Encoder, bewusst NICHT über Cloudflare (siehe [docs/24-mediamtx.md](24-mediamtx.md)) |
| MediaMTX Publish (RTSP) | 8554 | NodePort `homeserver:31554` | s.o., nur LAN/Tailnet |
| MediaMTX WebRTC | 8889 | Nur ClusterIP intern | Kein eigener Ingress-Host, wird intern vom HLS-Player-Frontend genutzt |
| MediaMTX API | 9997 | Nur ClusterIP intern | Kein externer Zugriff |
| ArgoCD | 443 | NodePort `homeserver:30443` (HTTPS) | Kein Ingress-Host, direkter NodePort-Zugriff. HTTP-NodePort (30080) bewusst nicht in UFW freigegeben |
| Tailscale (SSH/Admin) | — | Tailnet-IP des Nodes | Siehe [docs/06-tailscale.md](06-tailscale.md) |

NodePorts sind laut bestehenden UFW-Regeln bereits auf LAN/Tailnet beschränkt
(siehe README.md#networking--security) — keine zusätzliche Firewall-Änderung
nötig, wenn ein neuer NodePort in diesem Bereich dazukommt.

---

## Interne Dienste ohne Ingress (nicht von außen erreichbar)

Diese laufen rein als ClusterIP und werden nur von anderen Pods im Cluster
angesprochen (Datenbanken, Caches, interne Bridges, Batch-Jobs):

| App/Komponente | Namespace | Port |
|---|---|---|
| gotify-bridge | gotify-bridge | 8080 |
| ntfy-bridge | ntfy-bridge | 8080 |
| Immich Postgres | immich | 5432 |
| Immich Redis | immich | 6379 |
| Immich Machine Learning | immich | 3003 |
| Nextcloud Postgres | nextcloud | 5432 |
| Nextcloud Redis | nextcloud | 6379 |
| Zammad Postgres | zammad | 5432 |
| Zammad Redis | zammad | 6379 |
| Zammad Memcached | zammad | 11211 |
| Zammad Websocket | zammad | 6042 |
| Wiki.js Postgres | wikijs | 5432 |
| Authentik Postgres | authentik | 5432 |
| MinIO S3-API | minio | 9000 |
| Sealed Secrets Controller | sealed-secrets | 8080 |
| VictoriaMetrics (vmsingle/vmagent/vmalert/vmalertmanager) | monitoring | 8428/8429/8080/9093 |
| Xibo CMS MySQL | xibosignage | 3306 |
| Xibo CMS XMR (Message-Relay) | xibosignage | 9505 |
| Xibo CMS Memcached | xibosignage | 11211 |
| Xibo CMS QuickChart | xibosignage | 3400 |

**Reine Batch-Jobs ohne Service/Port**: `github-release-watcher` (CronJob,
alle 2h) und `wiki-docs-sync` (CronJob, alle 15min) — laufen komplett
outbound, haben keinen offenen Port.

`cloudflared` selbst hat ebenfalls keinen offenen Port — reiner
Tunnel-Client, baut die Verbindung ausschließlich nach außen auf.

---

## Wo ändere ich was, falls umgeroutet werden muss?

| Ich will ändern... | Datei |
|---|---|
| LAN-Hostname (`*.tier.homeserver`) einer App | `argocd/apps/<platform\|workloads>/<app>/values.yaml` → `ingress.hosts[].host` |
| Externe Erreichbarkeit (`*.tier.pke-lab.de`) hinzufügen/entfernen | `argocd/apps/platform/cloudflared/values.yaml` → `ingress.rules` |
| Internen Service-Port einer App | `argocd/apps/<platform\|workloads>/<app>/values.yaml` → `service.port`/`targetPort` (Chart-abhängig) |
| NodePort (Pi-hole DNS, MediaMTX Publish) | `argocd/apps/<platform\|workloads>/<app>/values.yaml` → `service.nodePort`/`publishService.ports.*.nodePort` — danach ggf. UFW-Regel auf neuen Port anpassen |
| ArgoCD-Zugriffsport | ArgoCD-Bootstrap (`ansible/roles/argocd/`) bzw. Helm-Values des ArgoCD-Charts selbst (nicht Teil der App-Wrapper-Charts) |

Nach jeder Änderung: committen + pushen, ArgoCD synct automatisch
(`automated: {prune: true, selfHeal: true}` ist für alle Apps aktiv).
