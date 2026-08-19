# Port-Übersicht aller Apps

Diese Seite listet für jede laufende App: den internen Kubernetes-Service
(ClusterIP:Port), wie sie im LAN erreichbar ist (Traefik-Ingress) und ob/wie
sie zusätzlich extern über den Cloudflare Tunnel erreichbar ist. Stand:
Live-Abfrage aus dem Cluster (`kubectl get svc -A` / `kubectl get ingress -A`).

## Die zwei Wege rein

```
LAN:      Client → 192.168.178.200 (Traefik LoadBalancer, MetalLB) :80/443
                      → Host-Header "xyz.tier.homeserver" → passender Service

Internet: Client → xyz-tier.pke-lab.de → Cloudflare Edge
                      → cloudflared (outbound-only, kein offener Router-Port)
                      → Traefik (Wildcard-Regel *-tier.pke-lab.de)
                      → Host-Header "xyz-tier.pke-lab.de" → passender Service
```

`tier` ist `tech` (Infrastruktur/Admin) oder `prod` (echter Nutzerkreis) —
Details und die vollständige Zuordnung: [docs/c-netzwerk-dns/c0040-domain-tiers.md](c0040-domain-tiers.md).
Intern per Punkt (`xyz.tier.homeserver`), extern per Bindestrich
(`xyz-tier.pke-lab.de`) — Grund: Cloudflares kostenloses Zertifikat deckt
nur eine Label-Ebene ab, siehe
[docs/c-netzwerk-dns/c0040-domain-tiers.md → Warum Punkt intern, Bindestrich extern](c0040-domain-tiers.md#warum-punkt-intern-bindestrich-extern).

Wichtig: **cloudflared braucht keinen Port-Forward am Router.** Der Tunnel
baut die Verbindung von innen nach außen auf (siehe
[docs/e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md)). `cloudflared`
selbst kennt nur zwei bis drei Wildcard-Regeln (eine pro Tier) und leitet
alles an Traefik weiter — welche Hostnamen davon tatsächlich extern
erreichbar sind, entscheidet ausschließlich, welche Apps zusätzlich zu
ihrem `*.homeserver`-Host auch einen `*-pke-lab.de`-Host in der eigenen
`ingress.hosts`-Liste tragen (siehe [docs/c-netzwerk-dns/c0040-domain-tiers.md](c0040-domain-tiers.md)).
Nicht jede App mit LAN-Ingress ist automatisch auch extern erreichbar.

Node-IP von `homeserver`: `192.168.178.94`. Traefik-LoadBalancer-IP (MetalLB):
`192.168.178.200`.

---

## Web-Apps (Traefik-Ingress, LAN via `*.tier.homeserver`)

| App | Tier | Namespace | Interner Service:Port | LAN (`*.tier.homeserver`) | Extern (`*-tier.pke-lab.de`) |
|---|---|---|---|---|---|
| Immich | prod | immich | immich-server:80 | immich.prod.homeserver | immich-prod.pke-lab.de |
| Nextcloud | prod | nextcloud | nextcloud:80 | nextcloud.prod.homeserver | nextcloud-prod.pke-lab.de |
| Paperless-ngx | prod | paperless-ngx | paperless-ngx:80 | paperless.prod.homeserver | — (nur LAN/Tailnet) |
| Vaultwarden | tech (Ausnahme) | vaultwarden | vaultwarden:80 | vault.tech.homeserver | vault-tech.pke-lab.de |
| Mealie | prod | mealie | mealie:80 | mealie.prod.homeserver | mealie-prod.pke-lab.de |
| n8n | prod | n8n | n8n:80 | n8n.prod.homeserver | – (aus Cloudflare Tunnel entfernt, Security) |
| Wiki.js | prod | wikijs | wikijs:80 | wiki.prod.homeserver | wiki-prod.pke-lab.de |
| Zammad | tech (Ausnahme) | zammad | zammad-nginx:8080 | zammad.tech.homeserver | support-tech.pke-lab.de |
| ntfy | tech | ntfy | ntfy:80 | ntfy.tech.homeserver | ntfy-tech.pke-lab.de |
| Grafana | tech | monitoring | monitoring-grafana:80 | grafana.tech.homeserver | grafana-tech.pke-lab.de |
| MediaMTX (Playback) | prod | mediamtx | mediamtx:8888 (HLS) | stream.prod.homeserver | stream-prod.pke-lab.de |
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

Nur die 9 Apps mit einem Eintrag in der Extern-Spalte tragen tatsächlich
einen zusätzlichen `*-pke-lab.de`-Host in ihrer eigenen `ingress.hosts`-Liste
— alle anderen (auch alle mit „—“) sind ausschließlich über LAN/Tailscale
erreichbar, egal was `cloudflared`s Wildcard-Regeln theoretisch matchen
würden (siehe [docs/c-netzwerk-dns/c0040-domain-tiers.md](c0040-domain-tiers.md)).

Alle `*.homeserver`- **und** alle `*.pke-lab.de`-Hosts laufen über Traefik
auf `192.168.178.200:80`/`:443` — kein individueller Port pro App nötig,
Traefik routet in beiden Fällen per Host-Header. `cloudflared` selbst
terminiert keinen Traffic mehr an einem App-Service direkt, sondern reicht
alles unverändert an Traefik weiter (`argocd/apps/platform/cloudflared/values.yaml`
→ `ingress.rules`, zwei bis drei Wildcard-Regeln statt einer Regel pro App).

---

## Sonderfälle mit eigenen Ports

| Was | Port(s) | Erreichbar über | Bemerkung |
|---|---|---|---|
| Pi-hole DNS | 53/UDP+TCP | NodePort `homeserver:30053` | Nur LAN/Tailnet, siehe [docs/c-netzwerk-dns/c0000-dns-architecture.md](c0000-dns-architecture.md) |
| MediaMTX Publish (RTMP) | 1935 | NodePort `homeserver:31935` | Für OBS/ffmpeg-Encoder, bewusst NICHT über Cloudflare (siehe [docs/3-apps-workloads/30040-mediamtx.md](../3-apps-workloads/30040-mediamtx.md)) |
| MediaMTX Publish (RTSP) | 8554 | NodePort `homeserver:31554` | s.o., nur LAN/Tailnet |
| MediaMTX WebRTC | 8889 | Nur ClusterIP intern | Kein eigener Ingress-Host, wird intern vom HLS-Player-Frontend genutzt |
| MediaMTX API | 9997 | Nur ClusterIP intern | Kein externer Zugriff |
| ArgoCD | 443 | NodePort `homeserver:30443` (HTTPS) | Kein Ingress-Host, direkter NodePort-Zugriff. HTTP-NodePort (30080) bewusst nicht in UFW freigegeben |
| Tailscale (SSH/Admin) | — | Tailnet-IP des Nodes | Siehe [docs/c-netzwerk-dns/c0010-tailscale.md](c0010-tailscale.md) |

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
| Externe Erreichbarkeit (`*-tier.pke-lab.de`) für eine App hinzufügen/entfernen | `argocd/apps/<platform\|workloads>/<app>/values.yaml` → zusätzlichen (bzw. entfernten) Eintrag in `ingress.hosts` — **nicht** mehr in `cloudflared/values.yaml`, die Wildcard-Regeln dort decken bereits jedes Tier ab |
| Neues Tier extern erreichbar machen (aktuell nur `tech`/`prod`/`dev`) | `argocd/apps/platform/cloudflared/values.yaml` → `ingress.rules` um eine weitere `*-<tier>.pke-lab.de`-Regel ergänzen |
| Internen Service-Port einer App | `argocd/apps/<platform\|workloads>/<app>/values.yaml` → `service.port`/`targetPort` (Chart-abhängig) |
| NodePort (Pi-hole DNS, MediaMTX Publish) | `argocd/apps/<platform\|workloads>/<app>/values.yaml` → `service.nodePort`/`publishService.ports.*.nodePort` — danach ggf. UFW-Regel auf neuen Port anpassen |
| ArgoCD-Zugriffsport | ArgoCD-Bootstrap (`ansible/roles/argocd/`) bzw. Helm-Values des ArgoCD-Charts selbst (nicht Teil der App-Wrapper-Charts) |

Nach jeder Änderung: committen + pushen, ArgoCD synct automatisch
(`automated: {prune: true, selfHeal: true}` ist für alle Apps aktiv).
