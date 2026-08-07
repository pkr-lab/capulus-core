# Port-Übersicht aller Apps

Diese Seite listet für jede laufende App: den internen Kubernetes-Service
(ClusterIP:Port), wie sie im LAN erreichbar ist (Traefik-Ingress) und ob/wie
sie zusätzlich extern über den Cloudflare Tunnel erreichbar ist. Stand:
Live-Abfrage aus dem Cluster (`kubectl get svc -A` / `kubectl get ingress -A`).

## Die zwei Wege rein

```
LAN:      Client → 192.168.178.200 (Traefik LoadBalancer, MetalLB) :80/443
                      → Host-Header "xyz.homeserver" → passender Service

Internet: Client → xyz.pke-lab.de → Cloudflare Edge
                      → cloudflared (outbound-only, kein offener Router-Port)
                      → passender Service direkt (an Traefik vorbei)
```

Wichtig: **cloudflared braucht keinen Port-Forward am Router.** Der Tunnel
baut die Verbindung von innen nach außen auf (siehe
[docs/22-cloudflare-tunnel.md](22-cloudflare-tunnel.md)). Welche Hostnamen
extern erreichbar sind, steht ausschließlich in
`argocd/apps/cloudflared/values.yaml` (`ingress.rules`) — nicht jede App mit
LAN-Ingress ist automatisch auch extern erreichbar.

Node-IP von `homeserver`: `192.168.178.94`. Traefik-LoadBalancer-IP (MetalLB):
`192.168.178.200`.

---

## Web-Apps (Traefik-Ingress, LAN via `*.homeserver`)

| App | Namespace | Interner Service:Port | LAN (`*.homeserver`) | Extern (`*.pke-lab.de`) |
|---|---|---|---|---|
| Immich | immich | immich-server:80 | immich.homeserver | immich.pke-lab.de |
| Nextcloud | nextcloud | nextcloud:80 | nextcloud.homeserver | nextcloud.pke-lab.de |
| Paperless-ngx | paperless-ngx | paperless-ngx:80 | paperless.homeserver | paperless.pke-lab.de |
| Vaultwarden | vaultwarden | vaultwarden:80 | vault.homeserver | vault.pke-lab.de |
| Mealie | mealie | mealie:80 | mealie.homeserver | mealie.pke-lab.de |
| Grocy | grocy | grocy:80 | grocy.homeserver | grocy.pke-lab.de |
| n8n | n8n | n8n:80 | n8n.homeserver | – (aus Cloudflare Tunnel entfernt, Security) |
| Wiki.js | wikijs | wikijs:80 | wiki.homeserver | wiki.pke-lab.de |
| Zammad | zammad | zammad-nginx:8080 | zammad.homeserver | support.pke-lab.de |
| ntfy | ntfy | ntfy:80 | ntfy.homeserver | ntfy.pke-lab.de |
| Grafana | monitoring | monitoring-grafana:80 | grafana.homeserver | grafana.pke-lab.de |
| Authentik | authentik | authentik-server:80 | authentik.homeserver | authentik.pke-lab.de |
| MediaMTX (Playback) | mediamtx | mediamtx:8888 (HLS) | stream.homeserver | stream.pke-lab.de |
| Gotify | gotify | gotify:80 | gotify.homeserver, gotify-api.homeserver | — (nur LAN/Tailnet) |
| Uptime Kuma | uptime-kuma | uptime-kuma:80 | uptime-kuma.homeserver | — |
| Semaphore | semaphore | semaphore:3000 | semaphore.homeserver, semaphore-api.homeserver | — |
| Glance | glance | glance:80 | glance.homeserver | — |
| Pi-hole (Web-UI) | pihole | pihole:80 | pihole.homeserver | — |
| Alamos-Apager | alamos-apager | alamos-apager:8080 | alamos-apager.homeserver | — |
| Xibo CMS | xibosignage | xibosignage-cms:80 | xibo.homeserver | — |
| Homeserver-Dashboard-API | carplay-api | carplay-api:80 | carplay-api.homeserver | — |
| Tinyteller | tinyteller | tinyteller-frontend:80 | tinyteller.homeserver | — |
| Argo Workflows | argo-workflows | argo-workflows-server:2746 | argo-workflows.homeserver | — |
| Headlamp | headlamp | headlamp:80 | headlamp.homeserver | — |
| MinIO Console | minio | minio-console:9001 | minio.homeserver | — |
| kubeseal-webgui | kubeseal-webgui | kubeseal-webgui:8080 | kubeseal-webgui.homeserver | — |
| example-whoami | example-whoami | example-whoami:80 | whoami.homeserver | — |

Alle `*.homeserver`-Hosts laufen über Traefik auf `192.168.178.200:80` (bzw.
`:443` mit TLS, sofern konfiguriert) — kein individueller Port pro App nötig,
Traefik routet per Host-Header. Alle `*.pke-lab.de`-Hosts laufen über den
Cloudflare Tunnel direkt auf den jeweiligen Service (an Traefik vorbei), siehe
`argocd/apps/cloudflared/values.yaml`.

---

## Sonderfälle mit eigenen Ports

| Was | Port(s) | Erreichbar über | Bemerkung |
|---|---|---|---|
| Pi-hole DNS | 53/UDP+TCP | NodePort `homeserver:30053` | Nur LAN/Tailnet, siehe [docs/09-dns-architecture.md](09-dns-architecture.md) |
| MediaMTX Publish (RTMP) | 1935 | NodePort `homeserver:31935` | Für OBS/ffmpeg-Encoder, bewusst NICHT über Cloudflare (siehe [docs/24-mediamtx.md](24-mediamtx.md)) |
| MediaMTX Publish (RTSP) | 8554 | NodePort `homeserver:31554` | s.o., nur LAN/Tailnet |
| MediaMTX WebRTC | 8889 | Nur ClusterIP intern | Kein eigener Ingress-Host, wird intern vom HLS-Player-Frontend genutzt |
| MediaMTX API | 9997 | Nur ClusterIP intern | Kein externer Zugriff |
| ArgoCD | 80/443 | NodePort `homeserver:30080` / `homeserver:30443` | Kein Ingress-Host, direkter NodePort-Zugriff |
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
| LAN-Hostname (`*.homeserver`) einer App | `argocd/apps/<app>/values.yaml` → `ingress.hosts[].host` |
| Externe Erreichbarkeit (`*.pke-lab.de`) hinzufügen/entfernen | `argocd/apps/cloudflared/values.yaml` → `ingress.rules` |
| Internen Service-Port einer App | `argocd/apps/<app>/values.yaml` → `service.port`/`targetPort` (Chart-abhängig) |
| NodePort (Pi-hole DNS, MediaMTX Publish) | `argocd/apps/<app>/values.yaml` → `service.nodePort`/`publishService.ports.*.nodePort` — danach ggf. UFW-Regel auf neuen Port anpassen |
| ArgoCD-Zugriffsport | `argocd/apps/argocd`-Bootstrap bzw. Helm-Values des ArgoCD-Charts selbst (nicht Teil der App-Wrapper-Charts) |

Nach jeder Änderung: committen + pushen, ArgoCD synct automatisch
(`automated: {prune: true, selfHeal: true}` ist für alle Apps aktiv).
