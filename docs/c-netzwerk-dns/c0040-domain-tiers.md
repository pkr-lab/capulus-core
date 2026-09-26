# Domain-Tiers — dev / tech / prod

Jeder Hostname trägt ein zusätzliches Tier-Label
zwischen App-Name und Domain. Intern per Punkt, extern per Bindestrich —
unterschiedliches Trennzeichen, siehe [Warum Punkt intern, Bindestrich
extern](#warum-punkt-intern-bindestrich-extern) unten:

```
vorher:   grafana.homeserver          zammad.homeserver
nachher:  grafana.tech.homeserver     zammad.tech.homeserver     (intern)
          grafana-tech.pke-lab.de     support-tech.pke-lab.de    (extern)
```

Vorher lief alles flach unter `<app>.homeserver` bzw. `<app>.pke-lab.de` —
ohne erkennbar, ob dahinter Infrastruktur oder eine Familien-/Vereins-App
steckt.

Diese Seite beschreibt die URL-Konvention (Namensgebung) und wie sie mit den drei Clustern
zusammenhängt. Die ArgoCD-Trennung (Projekte, Ordner) ist ein anderes Thema, siehe
[docs/b-kubernetes-gitops/b0020-argocd-projects.md](../b-kubernetes-gitops/b0020-argocd-projects.md).

> **Tier ist nicht gleich Cluster.** Das Tier ist ein Namensbestandteil (`tech` = Infrastruktur/
> Admin, `prod` = Apps mit Nutzerkreis, `dev` = Entwicklung). Welcher *Cluster* hinter dem Namen
> steckt, entscheidet allein das DNS, siehe
> [DNS: Tier und Cluster sind zwei verschiedene Dinge](#dns-tier-und-cluster-sind-zwei-verschiedene-dinge).

---

## Die drei Tiers

| Tier | Bedeutung | Cluster | Beispiele |
|---|---|---|---|
| **tech** | Infrastruktur/Admin-Dienste, auf denen andere Apps aufbauen (Monitoring, Secrets-Tooling, SSO, DNS, CI/CD) | TECH | `grafana.tech.homeserver`, `semaphore.tech.homeserver`, `authentik.tech.homeserver` |
| **prod** | Apps mit echtem Nutzerkreis (Familie, Vereinsmitglieder) | überwiegend PROD, einige noch TECH (s. u.) | `nextcloud.prod.homeserver`, `mealie.prod.homeserver`, `immich.prod.homeserver` |
| **dev** | Entwicklung und Tests vor dem Rollout | ENTW | `whoami.dev.homeserver`, `demo.dev.homeserver` |

Hostnamen der Form `<app>.<tier>.homeserver` gelten intern (LAN/Tailnet). Die Zuordnung eines
Hostnamens zu einem Tier folgt dem Charakter der App, **nicht** dem Ordner, in dem sie liegt:

| App | Ordner | Tier | Warum |
|---|---|---|---|
| Vaultwarden | `argocd/apps/tech/vaultwarden` | **tech** | Passwort-Manager, Credential-Quelle auch für andere Dienste, kein Endnutzer-Produkt im eigentlichen Sinn |
| Zammad | `argocd/apps/tech/zammad` | **tech** | Ticket-/Support-System, das auch interne Automatisierung (z. B. `github-release-watcher`) anspricht, Betriebs-Tooling |
| n8n, alamos-apager, alamos-relay, carplay-api, mediamtx, uptime-kuma, pacman | `argocd/apps/tech/<app>` | **prod** | Apps mit Nutzerkreis, die (noch) im TECH-Cluster laufen. Ihr Name trägt `prod`, ihr Cluster ist TECH |

---

## DNS: Tier und Cluster sind zwei verschiedene Dinge

Die dnsmasq-Rolle ([`dnsmasq.conf.j2`](../../ansible/roles/dnsmasq/templates/dnsmasq.conf.j2)) löst
nach dem Prinzip „spezifischer gewinnt" auf:

| Regel | Auflösung | Cluster |
|---|---|---|
| `address=/homeserver/<homeserver-IP>` | alles unter `*.homeserver` (also alle `*.tech.homeserver` und `*.prod.homeserver`, die nicht weiter unten überschrieben werden) | **TECH** (`.94`) |
| `address=/dev.homeserver/<entw_vm_ip>` | alles unter `*.dev.homeserver` | **ENTW** (`.100`) |
| `address=/<host>/<prod_vm_ip>` je Eintrag in `dnsmasq_prod_vm_hosts` (`group_vars/all.yml`) | genau die aufgelisteten Hosts | **PROD** (`.99`) |

Ein Host unter `*.prod.homeserver` landet also **nur dann im PROD-Cluster**, wenn er einzeln in
`dnsmasq_prod_vm_hosts` steht; sonst antwortet weiterhin der TECH-Traefik. Aktuell sind das
`demo`, `tinyteller`, `whoami`, `mealie`, `mealie-native`, `paperless`, `wiki`, `nextcloud`, `xibo`
und `immich` (jeweils `.prod.homeserver`). Nach dem Ändern der Liste: `make dnsmasq`.

Konsequenzen für neue Hosts:

- **Neue App im PROD-Cluster mit internem Host:** Name in `dnsmasq_prod_vm_hosts` ergänzen, sonst
  bekommt man den TECH-Traefik und einen 404.
- **Neue App im TECH-Cluster:** kein DNS-Eintrag nötig, die Wildcard greift.
- **Neue App auf ENTW:** Host unter `*.dev.homeserver` wählen, kein DNS-Eintrag nötig.
- **TLS:** Das `*.prod.homeserver`-Zertifikat stellt der cert-manager im PROD-Cluster aus einer eigenen
  Intermediate-CA der gemeinsamen Root-CA aus, siehe
  [d0040](../d-sicherheit/d0040-internal-tls.md).
- Die CoreDNS-Auflösung **im** Cluster ist davon getrennt: die PROD-VM fragt ausschließlich den
  dnsmasq auf dem homeserver (`host_vars/homeserver/vars.yml`, Feld `dns`), damit `*.homeserver`-Namen
  auch aus PROD-Pods auflösbar sind.

---

## Wo das greift

```
LAN/Tailnet:  Client → Traefik (Host-Header "app.tech.homeserver"
                                 bzw. "app.prod.homeserver")
                     → passender Service

Internet:     Client → app-tech.pke-lab.de / app-prod.pke-lab.de
                     → Cloudflare Edge → cloudflared
                     → Traefik (EINE Wildcard-Regel *.pke-lab.de für die
                                 ganze Zone, s. u.)
                     → Host-Header "app-tech.pke-lab.de" → passender Service
```

Beide Pfade tragen dasselbe Tier-Label — z. B. ist Grafana intern
`grafana.tech.homeserver` und extern `grafana-tech.pke-lab.de`, dieselbe
App, derselbe Tier, nur andere Domain (und anderes Trennzeichen vor dem
Tier, s. u.). Betroffene Stellen pro App:

- `argocd/apps/<tech|prod>/<app>/values.yaml` →
  `ingress.hosts[].host` (**beide** Hosts, LAN und — falls die App extern
  erreichbar sein soll — extern) und ggf. `env`/OIDC-Redirect-URLs, die den
  eigenen Hostnamen referenzieren
- Jede Stelle, die den Hostnamen einer *anderen* App referenziert (siehe
  [Cross-App-Referenzen](#cross-app-referenzen) unten)

Die Tier-Labels brauchten in der DNS-Auflösung selbst keine eigene Regel: sowohl dnsmasq
(`address=/homeserver/<ip>`, siehe
[docs/c-netzwerk-dns/c0000-dns-architecture.md](c0000-dns-architecture.md)) als auch der
CoreDNS-Forward im Cluster (`argocd/apps/tech/coredns-custom/`)
matchen auf die komplette `homeserver`-Zone inklusive aller
Subdomain-Ebenen. Nur für Hosts, die in einem **anderen** Cluster laufen, gibt es die
Ausnahmen aus dem [Abschnitt darüber](#dns-tier-und-cluster-sind-zwei-verschiedene-dinge).

---

## Externe Erreichbarkeit: Wildcard-Routing über Traefik

`cloudflared` enthält **nicht** eine Ingress-Regel pro extern freigegebener App, sondern nur
**eine einzige** Wildcard-Regel für die ganze Zone (`*.pke-lab.de`). Sie zeigt auf den Traefik des
jeweiligen Clusters (`https://traefik.kube-system.svc.cluster.local:443`, `noTLSVerify`, weil das
interne Zertifikat von der privaten Homeserver-CA stammt), genau wie der interne LAN-Pfad das für
`*.homeserver` tut.

**Zwei Tunnel, ein Wildcard:** TECH und PROD haben je ein eigenes `cloudflared` mit eigenem Tunnel
(`argocd/apps/tech/cloudflared/`, `argocd/apps/prod/cloudflared/`, Tunnel `homeserver` bzw.
`homeserver-prod`). Beide Tunnel tragen dieselbe Wildcard-Regel; **welcher Tunnel einen Host
bekommt, entscheidet allein der DNS-Eintrag bei Cloudflare.** Der Wildcard `*.pke-lab.de` zeigt auf
den TECH-Tunnel, Hosts von Apps im PROD-Cluster werden einzeln mit
`cloudflared tunnel route dns homeserver-prod <host>` auf den PROD-Tunnel gelegt. Wer eine App von
TECH nach PROD umzieht, muss also auch den DNS-Eintrag ihres externen Hosts umlegen (siehe
[e0010](../e-externe-erreichbarkeit/e0010-cloudflare-deploy.md)).

**Nicht** eine Regel pro Tier (`*-tech.pke-lab.de`, `*-prod.pke-lab.de`, ...): laut
`cloudflared tunnel ingress rule --help` erkennt cloudflared `*` ausschließlich als **komplettes**
DNS-Label (`*.example.com`), kein Muster mit Stern + Literal *innerhalb* eines Labels
(`*-tech.example.com`); das fiel im Test auf `defaultService`/404 zurück. Da `grafana-tech` selbst
schon ein einziges vollständiges Label ist, deckt ein simples `*.pke-lab.de` alle Tiers gleichzeitig
ab, die Tier-Trennung ist auf cloudflared-Ebene nicht nötig und reine Namenskonvention für Menschen.

**Eine Wildcard-Regel macht keine App automatisch extern erreichbar.** Traefik matcht
Ingress-Ressourcen weiterhin exakt nach Host-Header: eine App wird nur erreichbar, wenn sie
zusätzlich zu ihrem `*.homeserver`-Host auch einen `*-pke-lab.de`-Host in ihrer eigenen
`ingress.hosts`-Liste trägt. Fehlt der, matcht Traefik keinen Router und liefert 404, dieselbe
„nur was explizit eingetragen ist"-Garantie wie über cloudflareds `defaultService`, nur eine Ebene
tiefer.

Aktuell tragen diese Apps zusätzlich einen `*-pke-lab.de`-Host:

| App | Extern | Tier | Cluster |
|---|---|---|---|
| Authentik | `authentik-tech.pke-lab.de` | tech | TECH |
| Grafana | `grafana-tech.pke-lab.de` | tech | TECH |
| ntfy | `ntfy-tech.pke-lab.de` | tech | TECH |
| Zammad | `support-tech.pke-lab.de` (abweichendes Label!) | tech | TECH |
| Vaultwarden | `vault-tech.pke-lab.de` | tech | TECH |
| MediaMTX | `stream-prod.pke-lab.de` | prod | TECH |
| Uptime Kuma (Status-Seite) | `status-prod.pke-lab.de` | prod | TECH |
| pacman | `pacman-prod.pke-lab.de` (öffentlich, ohne Auth, Schulungsobjekt) | prod | TECH |
| alamos-relay | `alamos-relay-prod.pke-lab.de` (einziger Zweck ist die externe Erreichbarkeit, siehe [docs/3-apps-workloads/300i0-alamos-relay.md](../3-apps-workloads/300i0-alamos-relay.md)) | prod | TECH |
| Wiki.js | `wiki-prod.pke-lab.de` | prod | PROD |
| Mealie | `mealie-prod.pke-lab.de` | prod | PROD |
| Nextcloud | `nextcloud-prod.pke-lab.de` | prod | PROD |
| Immich | `immich-prod.pke-lab.de` | prod | PROD |
| Xibo CMS | `xibo-prod.pke-lab.de` | prod | PROD |

Alle anderen Apps (Semaphore, Pi-hole, MinIO, Gotify, Headlamp, Paperless-ngx, n8n, ...) bleiben
ausschließlich LAN/Tailscale-erreichbar, auch wenn ihr Hostname theoretisch unter die Wildcard-Regel
fiele, weil ihnen schlicht der zweite Ingress-Host fehlt.

Eine App extern freigeben oder entfernen heißt: den `*-pke-lab.de`-Host in der `ingress.hosts`-Liste
der **App selbst** ergänzen bzw. löschen, nicht in `cloudflared/values.yaml`. Details/Ablauf:
[docs/e-externe-erreichbarkeit/e0010-cloudflare-deploy.md → Neuen Dienst freigeben](../e-externe-erreichbarkeit/e0010-cloudflare-deploy.md#neuen-dienst-freigeben).

> **Zu prüfen nach einem Rollout:** Traefiks Host-Header-Routing setzt voraus, dass `cloudflared`
> den ORIGINAL angefragten Hostnamen (z. B. `grafana-tech.pke-lab.de`) unverändert als HTTP-Host-Header
> weiterreicht. Das ist Cloudflares Default für `originRequest.httpHostHeader`, lässt sich aber per
> `curl -I https://<app>-<tier>.pke-lab.de` bestätigen; falls nicht, `httpHostHeader` pro Regel in
> `cloudflared/values.yaml` explizit setzen.

### Warum Punkt intern, Bindestrich extern

Ursprünglich war extern genau wie intern ein Punkt geplant
(`grafana.tech.pke-lab.de`) — das scheiterte live an Cloudflares
kostenlosem "Universal SSL"-Zertifikat: das deckt für eine Zone nur
`pke-lab.de` + `*.pke-lab.de` ab, also genau **eine** Label-Ebene. Ein
zweites Label vor der Domain fällt aus diesem Wildcard-Zertifikat raus —
der TLS-Handshake schlägt schon an der Cloudflare-Edge fehl, bevor die
Anfrage überhaupt beim Tunnel ankommt (empirisch bestätigt:
`curl https://grafana.tech.pke-lab.de` lieferte `SSL routines:ST_CONNECT:
sslv3 alert handshake failure`, DNS löste dabei ganz normal auf — das
Problem lag rein am fehlenden Zertifikat, nicht an DNS oder Traefik).

Mit Bindestrich (`grafana-tech.pke-lab.de`) bleibt der externe Hostname
eine einzige Label-Ebene und ist vom bestehenden kostenlosen Zertifikat
abgedeckt — keine Cloudflare-Plan-Änderung nötig. Intern bleibt der Punkt
(`grafana.tech.homeserver`), weil dort die eigene, selbst erzeugte CA
greift (siehe [docs/d-sicherheit/d0040-internal-tls.md](../d-sicherheit/d0040-internal-tls.md)), die nicht an
Cloudflares Zertifikatsgrenzen gebunden ist und beliebig viele
Label-Ebenen in ihrer SAN-Liste tragen kann.

Alternative, falls später gewünscht: Cloudflares "Total TLS"/Advanced
Certificate Manager (SSL/TLS → Edge Certificates im Dashboard prüfen)
kann echte Mehrebenen-Wildcards ausstellen — dann ließe sich extern auf
den Punkt zurückwechseln. Bewusst nicht automatisch vorausgesetzt, da
plan-/kostenabhängig.

---

## Cross-App-Referenzen

Der eigentliche Aufwand bei dieser Umstellung war nicht das Umbenennen
der eigenen Ingress-Hosts, sondern alle Stellen zu finden, die den
Hostnamen einer *anderen* App fest verdrahtet haben. Beispiele, die dabei
angepasst wurden:

| Wer referenziert | Wen | Datei |
|---|---|---|
| `github-release-watcher` | Zammad-API | `argocd/apps/tech/github-release-watcher/values.yaml` |
| n8n-Workflow (Banana-Pi-Alarm → Zammad-Ticket) | Zammad-API + Grafana-Dashboard-Link | `argocd/apps/tech/n8n/workflows/banana-pi-down-to-zammad.json` |
| `carplay-api` (Kommentar) | kubeseal-webgui | `argocd/apps/tech/carplay-api/values.yaml` |
| Grafana selbst (`grafana.ini` `domain`/`root_url`) | eigener externer Hostname | `argocd/apps/tech/monitoring/values.yaml` |
| ntfy-Watchdogs (Cluster-Power-Manager, Resource-/Thermal-Watchdog) | ntfy | `ansible/roles/{cluster_power_manager,resource_watchdog,thermal_watchdog}/defaults/main.yml` |
| Semaphore-Ansible-Rollen (`semaphore_bootstrap`, `semaphore_secrets`) | Semaphore-REST-API | `ansible/roles/semaphore_bootstrap/defaults/main.yml`, `ansible/roles/semaphore_secrets/tasks/main.yml` |
| vmagent auf den Banana-Pis | VictoriaMetrics remote-write (`vm-write`) | `ansible/group_vars/banana_pis.yml` |
| Alamos-/Banana-Pi-Kiosk-Rollen | alamos-apager | `ansible/roles/{alamos_kiosk,banana_pi_kiosk}/defaults/main.yml` |
| iOS-App "Homeserver Dashboard" | carplay-api + alle in der App verlinkten Self-Hosted-Services | `ios/HomeserverDashboard/Utilities/Constants.swift` |

**Faustregel für neue Cross-App-Referenzen:** Der Tier eines Hostnamens
richtet sich immer nach der **Ziel-App**, nicht nach der App, die
referenziert. n8n (Tier `prod`) spricht Zammad über
`zammad.tech.homeserver` an, weil Zammad `tech` ist, nicht weil der
Aufrufer es ist. Bei Aufrufen **zwischen Clustern** (z. B. ein PROD-Pod, der
eine TECH-App anspricht) immer den `*.homeserver`-Hostnamen über den
Traefik-Ingress nehmen, nicht den Cluster-internen Service-Namen: die
Cluster haben getrennte Service-Netze.

---

## ArgoCD-UI-Link

ArgoCD liest den in der Applications-Übersicht angezeigten "Open
Application"-Link direkt aus dem `host`-Feld der Ingress-Ressource, die
zur jeweiligen Application gehört — es gibt keine separate Annotation
oder Konfiguration dafür. Sobald `ingress.hosts[].host` in der
`values.yaml` einer App auf den neuen `<app>.<tier>.homeserver`-Namen
zeigt, zieht ArgoCD automatisch nach dem nächsten Sync nach. Kein
zusätzlicher Schritt in `argocd/bootstrap/` nötig — die dortige
ApplicationSet-/AppProject-Struktur (siehe
[docs/b-kubernetes-gitops/b0020-argocd-projects.md](../b-kubernetes-gitops/b0020-argocd-projects.md)) ist von dieser
URL-Konvention unabhängig.

---

## Gelöst: internes TLS-Wildcard-Zertifikat (war Hostname-Mismatch)

Der `https://`-Rollout aus [docs/d-sicherheit/d0040-internal-tls.md](../d-sicherheit/d0040-internal-tls.md)
war bereits vollzogen, bevor diese Migration hier lief — das damals
committete Zertifikat trug danach aber noch die feste SAN-Liste der
*alten*, untierten Hostnamen (`<app>.homeserver`), während die Hosts
durch diese Migration jetzt `<app>.tech.homeserver`/
`<app>.prod.homeserver` heißen. Ein Browser/`curl`, der
`https://grafana.tech.homeserver` aufrief, bekam dadurch einen
Zertifikats-Hostname-Mismatch — und weil der CA-Private-Key bewusst
außerhalb des Repos lag, ließ sich das nicht per Commit reparieren.

Das war genau der Auslöser für die Umstellung auf cert-manager (siehe
[docs/d-sicherheit/d0040-internal-tls.md](../d-sicherheit/d0040-internal-tls.md)): Die
`Certificate`-Ressource trägt jetzt die aktuelle, tier-behaftete
SAN-Liste, cert-manager signiert automatisch aus derselben CA (kein
Hostname-Mismatch mehr) und erneuert selbstständig vor Ablauf. Ein
künftiger neuer Host braucht weiterhin einen `dnsNames`-Eintrag + Commit
(siehe docs/d-sicherheit/d0040-internal-tls.md), aber keinen manuellen CA-Key-abhängigen Signier-Schritt
mehr.

---

## Eine neue App einordnen

1. **Tier wählen:** **tech** (Infrastruktur/Admin, kein Endnutzer), **prod** (echter Nutzerkreis)
   oder **dev** (Entwicklung auf ENTW). Im Zweifel: Infrastruktur-/Betriebsdienst ohne eigenen
   Endnutzer → **tech**.
2. **Cluster wählen** und den zugehörigen Ordner anlegen (`argocd/apps/tech/`, `argocd/apps/prod/`,
   `argocd/apps/entw/`), siehe
   [docs/b-kubernetes-gitops/b0020-argocd-projects.md](../b-kubernetes-gitops/b0020-argocd-projects.md#eine-neue-app-hinzufügen).
   Läuft die App im **PROD**-Cluster, den internen Host zusätzlich in `dnsmasq_prod_vm_hosts` eintragen
   ([DNS-Abschnitt](#dns-tier-und-cluster-sind-zwei-verschiedene-dinge)).
3. Ingress-Host in der `values.yaml` der neuen App direkt im Schema anlegen:
   `<app>.tech.homeserver`, `<app>.prod.homeserver` bzw. `<app>.dev.homeserver`, nicht erst flach
   anlegen und später umbenennen. Ein neuer Host braucht außerdem einen `dnsNames`-Eintrag im
   Zertifikat ([d0040](../d-sicherheit/d0040-internal-tls.md)).
4. Soll die App zusätzlich extern erreichbar sein: **in der `values.yaml` der App selbst** einen
   zweiten `ingress.hosts`-Eintrag mit demselben Tier ergänzen, **mit Bindestrich, nicht Punkt**:
   `<app>-tech.pke-lab.de` / `<app>-prod.pke-lab.de` (siehe
   [Warum Punkt intern, Bindestrich extern](#warum-punkt-intern-bindestrich-extern)).
   `cloudflared/values.yaml` bleibt dabei unangetastet, dafür muss der DNS-Eintrag beim richtigen
   Tunnel liegen, siehe [Externe Erreichbarkeit](#externe-erreichbarkeit-wildcard-routing-über-traefik).
5. Referenziert eine andere, bereits bestehende App diesen neuen Host (oder umgekehrt), z. B. ein
   Webhook-Ziel oder ein Ansible-Default, auf den korrekten Tier des jeweiligen **Ziels** achten
   (siehe [Cross-App-Referenzen](#cross-app-referenzen)).
