# Port-Übersicht aller Apps

Diese Seite listet für jede laufende App: den internen Kubernetes-Service
(ClusterIP:Port), wie sie im LAN erreichbar ist (Traefik-Ingress) und ob/wie
sie zusätzlich extern über den Cloudflare Tunnel erreichbar ist. Die Werte
stammen aus den `values.yaml`-Dateien unter `argocd/apps/`; bei Abweichungen
zählt der Live-Stand (`kubectl get svc -A` / `kubectl get ingress -A`, je
Cluster, siehe [a0010](../a-betriebssystem/a0010-overview.md#kubectl-zugriff-je-cluster)).

## Die zwei Wege rein

```
LAN:      Client → dnsmasq (192.168.178.94) → IP des Clusters, in dem die App läuft
                      TECH 192.168.178.94 · PROD 192.168.178.99 · ENTW 192.168.178.100
                      → Traefik des Clusters :80/443 (k3s-ServiceLB, Host-Ports)
                      → Host-Header "xyz.tier.homeserver" → passender Service

Internet: Client → xyz-tier.pke-lab.de → Cloudflare Edge
                      → cloudflared des Clusters (outbound-only, kein offener Router-Port)
                      → Traefik (Wildcard-Regel *.pke-lab.de)
                      → Host-Header "xyz-tier.pke-lab.de" → passender Service
```

`tier` ist `tech` (Infrastruktur/Admin), `prod` (echter Nutzerkreis) oder `dev` (ENTW). Das Tier
sagt nichts über den Cluster: welche IP ein Name bekommt, entscheidet das DNS
(`*.homeserver` → TECH, `*.dev.homeserver` → ENTW, Einzelhosts aus `dnsmasq_prod_vm_hosts` → PROD).
Details und die vollständige Zuordnung: [docs/c-netzwerk-dns/c0040-domain-tiers.md](c0040-domain-tiers.md).
Intern per Punkt (`xyz.tier.homeserver`), extern per Bindestrich
(`xyz-tier.pke-lab.de`) — Grund: Cloudflares kostenloses Zertifikat deckt
nur eine Label-Ebene ab, siehe
[docs/c-netzwerk-dns/c0040-domain-tiers.md → Warum Punkt intern, Bindestrich extern](c0040-domain-tiers.md#warum-punkt-intern-bindestrich-extern).

Wichtig: **cloudflared braucht keinen Port-Forward am Router.** Der Tunnel
baut die Verbindung von innen nach außen auf (siehe
[docs/e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md)). TECH und PROD haben je
ein eigenes `cloudflared` mit eigenem Tunnel; jedes kennt nur **eine** Wildcard-Regel (`*.pke-lab.de`)
und leitet alles an den Traefik seines Clusters weiter. Welche Hostnamen tatsächlich extern
erreichbar sind, entscheidet ausschließlich, welche Apps zusätzlich zu
ihrem `*.homeserver`-Host auch einen `*-pke-lab.de`-Host in der eigenen
`ingress.hosts`-Liste tragen (siehe [docs/c-netzwerk-dns/c0040-domain-tiers.md](c0040-domain-tiers.md)).
Nicht jede App mit LAN-Ingress ist automatisch auch extern erreichbar.

---

## Web-Apps (Traefik-Ingress, LAN via `*.tier.homeserver`)

| App | Tier | Cluster | Namespace | Interner Service:Port | LAN (`*.tier.homeserver`) | Extern (`*-tier.pke-lab.de`) |
|---|---|---|---|---|---|---|
| Immich | prod | PROD | immich | immich-server:80 | immich.prod.homeserver | immich-prod.pke-lab.de |
| Nextcloud | prod | PROD | nextcloud | nextcloud:80 | nextcloud.prod.homeserver | nextcloud-prod.pke-lab.de |
| Paperless-ngx | prod | PROD | paperless-ngx | paperless-ngx:80 | paperless.prod.homeserver | — (nur LAN/Tailnet) |
| Mealie | prod | PROD | mealie | mealie:80 | mealie.prod.homeserver, mealie-native.prod.homeserver | mealie-prod.pke-lab.de |
| Wiki.js | prod | PROD | wikijs | wikijs:80 | wiki.prod.homeserver | wiki-prod.pke-lab.de |
| Xibo CMS | prod | PROD | xibosignage | xibosignage-cms:80 | xibo.prod.homeserver | xibo-prod.pke-lab.de |
| Tinyteller | prod | PROD | tinyteller | tinyteller-frontend:80 | tinyteller.prod.homeserver | — |
| example-whoami | prod | PROD | example-whoami | example-whoami:80 | whoami.prod.homeserver | — |
| Vaultwarden | tech (Ausnahme) | TECH | vaultwarden | vaultwarden:80 | vault.tech.homeserver | vault-tech.pke-lab.de |
| Zammad | tech (Ausnahme) | TECH | zammad | zammad-nginx:8080 | zammad.tech.homeserver | support-tech.pke-lab.de |
| n8n | prod | TECH | n8n | n8n:80 | n8n.prod.homeserver | – (aus Cloudflare Tunnel entfernt, Security) |
| MediaMTX (Playback) | prod | TECH | mediamtx | mediamtx:8888 (HLS) | stream.prod.homeserver | stream-prod.pke-lab.de |
| Uptime Kuma | prod | TECH | uptime-kuma | uptime-kuma:80 | uptime-kuma.prod.homeserver, uptime-kuma-native.prod.homeserver | status-prod.pke-lab.de |
| Alamos-Apager | prod | TECH | alamos-apager | alamos-apager:8080 | alamos-apager.prod.homeserver | — |
| Alamos-Relay | prod | TECH | alamos-relay | alamos-relay:8080 | alamos-relay.prod.homeserver | alamos-relay-prod.pke-lab.de |
| Homeserver-Dashboard-API | prod | TECH | carplay-api | carplay-api:80 | carplay-api.prod.homeserver | — |
| pacman | prod | TECH | pacman | pacman:80 | pacman.prod.homeserver | pacman-prod.pke-lab.de |
| Authentik | tech | TECH | authentik | authentik:80 | authentik.tech.homeserver | authentik-tech.pke-lab.de |
| lldap (Web-UI) | tech | TECH | lldap | lldap:17170 (LDAP: 3890) | lldap.tech.homeserver | — |
| ntfy | tech | TECH | ntfy | ntfy:80 | ntfy.tech.homeserver | ntfy-tech.pke-lab.de |
| Grafana | tech | TECH | monitoring | monitoring-grafana:80 | grafana.tech.homeserver | grafana-tech.pke-lab.de |
| Gotify | tech | TECH | gotify | gotify:80 | gotify.tech.homeserver, gotify-api.tech.homeserver | — (nur LAN/Tailnet) |
| Semaphore | tech | TECH | semaphore | semaphore:3000 | semaphore.tech.homeserver, semaphore-api.tech.homeserver | — |
| Pi-hole (Web-UI) | tech | TECH | pihole | pihole:80 | pihole.tech.homeserver | — |
| Argo Workflows | tech | TECH | argo-workflows | argo-workflows-server:2746 | argo-workflows.tech.homeserver | — |
| Headlamp | tech | TECH | headlamp | headlamp:80 | headlamp.tech.homeserver | — |
| ArgoCD (Web-UI) | tech | TECH | argocd | argocd-server:80 | argocd.tech.homeserver | — |
| MinIO Console | tech | TECH | minio | minio-console:9001 | minio.tech.homeserver | — |
| kubeseal-webgui | tech | TECH | kubeseal-webgui | kubeseal-webgui:8080 | kubeseal-webgui.tech.homeserver | — |
| VictoriaMetrics/-Logs (Schreib-Endpunkte) | tech | TECH | monitoring / logging | siehe Charts | vm-write.tech.homeserver, logs-write.tech.homeserver | — |
| demo-app / example-whoami (ENTW) | dev | ENTW | demo-app / example-whoami | — | demo.dev.homeserver / whoami.dev.homeserver | — |

Die Spalte *Cluster* zeigt, wo die App läuft. Externe Hosts tragen tatsächlich nur die Apps mit einem
Eintrag in der letzten Spalte — alle anderen (auch alle mit „—") sind ausschließlich über LAN/Tailscale
erreichbar, egal was die Wildcard-Regel von `cloudflared` theoretisch matchen würde (siehe
[docs/c-netzwerk-dns/c0040-domain-tiers.md](c0040-domain-tiers.md)).

Alle `*.homeserver`- **und** alle `*.pke-lab.de`-Hosts laufen über den Traefik des jeweiligen Clusters
(auf `:80`/`:443` der Cluster-IP) — kein individueller Port pro App nötig,
Traefik routet in beiden Fällen per Host-Header. `cloudflared` selbst
terminiert keinen Traffic an einem App-Service direkt, sondern reicht
alles an Traefik weiter (`argocd/apps/tech/cloudflared/values.yaml` bzw.
`argocd/apps/prod/cloudflared/values.yaml` → `ingress.rules`, eine Wildcard-Regel statt einer Regel pro App).

---

## Sonderfälle mit eigenen Ports

| Was | Port(s) | Erreichbar über | Bemerkung |
|---|---|---|---|
| Pi-hole DNS | 53/UDP+TCP | NodePort `homeserver:30053` | Nur LAN/Tailnet, siehe [docs/c-netzwerk-dns/c0000-dns-architecture.md](c0000-dns-architecture.md) |
| MediaMTX Publish (RTMP) | 1935 | NodePort `homeserver:31935` | Für OBS/ffmpeg-Encoder, bewusst NICHT über Cloudflare (siehe [docs/3-apps-workloads/30040-mediamtx.md](../3-apps-workloads/30040-mediamtx.md)) |
| MediaMTX Publish (RTSP) | 8554 | NodePort `homeserver:31554` | s.o., nur LAN/Tailnet |
| MediaMTX WebRTC | 8889 | Nur ClusterIP intern | Kein eigener Ingress-Host, wird intern vom HLS-Player-Frontend genutzt |
| MediaMTX API | 9997 | Nur ClusterIP intern | Kein externer Zugriff |
| ArgoCD-Hub (CLI/CI) | 30080 (HTTP) | NodePort `homeserver:30080` | **Klartext** (`server.insecure`), UFW nur für LAN, Tailnet und WireGuard-Notzugang. `https://…:30443` funktioniert nicht (Klartext-Port), keine UFW-Freigabe mehr. Die Web-UI läuft per HTTPS über Traefik: `argocd.tech.homeserver` |
| ArgoCD ENTW | 80 | NodePort `entw-vm:30080` (HTTP, `server.insecure`) | Eigene Instanz, Zugriff aus dem LAN, siehe [b0050](../b-kubernetes-gitops/b0050-entw-argocd.md#argocd-oberfläche) |
| Tailscale (SSH/Admin) | — | Tailnet-IP des Nodes | Siehe [docs/c-netzwerk-dns/c0010-tailscale.md](c0010-tailscale.md) |
| WireGuard Backup-VPN | UDP, `wireguard_backup_port` (Default 51888) | Router-Portforward → Homeserver-LAN-IP | Notfall-Fallback falls Tailscale ausfällt, genau 1 Peer, kein LAN-Routing. Siehe [docs/c-netzwerk-dns/c0011-wireguard-backup.md](c0011-wireguard-backup.md) |

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

**Reine Batch-Jobs ohne Service/Port**: `github-release-watcher` (CronJob, TECH,
alle 2h) und `wiki-docs-sync` (CronJob, PROD, alle 15min) — laufen komplett
outbound, haben keinen offenen Port.

`cloudflared` selbst hat ebenfalls keinen offenen Port — reiner
Tunnel-Client, baut die Verbindung ausschließlich nach außen auf.

---

## Wo ändere ich was, falls umgeroutet werden muss?

| Ich will ändern... | Datei |
|---|---|
| LAN-Hostname (`*.tier.homeserver`) einer App | `argocd/apps/<tech\|prod>/<app>/values.yaml` → `ingress.hosts[].host` |
| Externe Erreichbarkeit (`*-tier.pke-lab.de`) für eine App hinzufügen/entfernen | `argocd/apps/<tech\|prod>/<app>/values.yaml` → zusätzlichen (bzw. entfernten) Eintrag in `ingress.hosts` — **nicht** mehr in `cloudflared/values.yaml`, die Wildcard-Regeln dort decken bereits jedes Tier ab |
| Neuen Tunnel-Host eines PROD-Dienstes freigeben | DNS-Eintrag auf den PROD-Tunnel: `cloudflared tunnel route dns homeserver-prod <host>` (siehe [e0010](../e-externe-erreichbarkeit/e0010-cloudflare-deploy.md)) |
| Internen Service-Port einer App | `argocd/apps/<tech\|prod>/<app>/values.yaml` → `service.port`/`targetPort` (Chart-abhängig) |
| NodePort (Pi-hole DNS, MediaMTX Publish) | `argocd/apps/<tech\|prod>/<app>/values.yaml` → `service.nodePort`/`publishService.ports.*.nodePort` — danach ggf. UFW-Regel auf neuen Port anpassen |
| ArgoCD-Zugriffsport | ArgoCD-Bootstrap (`ansible/roles/argocd/`) bzw. Helm-Values des ArgoCD-Charts selbst (nicht Teil der App-Wrapper-Charts) |

Nach jeder Änderung: committen + pushen, ArgoCD synct automatisch
(`automated: {prune: true, selfHeal: true}` ist für alle Apps aktiv).
