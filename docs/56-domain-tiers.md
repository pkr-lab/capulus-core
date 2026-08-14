# Domain-Tiers — dev / tech / prod

Seit diesem Schnitt trägt jeder Hostname (intern `*.homeserver` **und**
extern `*.pke-lab.de`) ein zusätzliches Label zwischen App-Name und
Domain: `<app>.<tier>.homeserver` bzw. `<app>.<tier>.pke-lab.de`. Vorher
lief alles flach unter `<app>.homeserver` — ohne erkennbar, ob dahinter
Infrastruktur oder eine Familien-/Vereins-App steckt.

```
vorher:   grafana.homeserver          zammad.homeserver
nachher:  grafana.tech.homeserver     zammad.tech.homeserver
```

Diese Seite beschreibt **nur** die URL-Konvention (Namensgebung). Die
komplett getrennte AppProject/Namespace-Trennung (`platform` vs.
`workloads`, RBAC-Grenzen für ArgoCD-Applications) ist ein anderes Thema,
siehe [docs/49-argocd-projects.md](49-argocd-projects.md) — beide Schnitte
verwenden zufällig eine ähnliche Zweiteilung, sind aber unabhängig
voneinander (das eine wirkt auf ArgoCD-Ebene, das andere ist reines
DNS-Naming).

---

## Die drei Tiers

| Tier | Bedeutung | Beispiele |
|---|---|---|
| **tech** | Infrastruktur/Admin-Dienste — alles unter `argocd/apps/platform/`, auf dem andere Apps aufbauen (Auth, DNS, Monitoring, Secrets-Tooling, ...) | `authentik.tech.homeserver`, `grafana.tech.homeserver`, `semaphore.tech.homeserver` |
| **prod** | Apps mit echtem Nutzerkreis (Familie, Vereinsmitglieder) — alles unter `argocd/apps/workloads/`, mit zwei Ausnahmen (s. u.) | `nextcloud.prod.homeserver`, `mealie.prod.homeserver`, `immich.prod.homeserver` |
| **dev** | Reserviert für künftige Test-/Staging-Deployments. Aktuell läuft keine App unter diesem Tier — die Konvention steht, sobald der erste Bedarf da ist (z. B. eine App vor dem Produktiv-Rollout separat testen) | — (noch keine) |

Die Zuordnung folgt **nicht 1:1** dem `platform`/`workloads`-Ordner — zwei
Apps liegen zwar unter `argocd/apps/workloads/`, sind aber Infrastruktur
und laufen deshalb bewusst unter **tech**:

| App | Ordner | Tier | Warum die Ausnahme |
|---|---|---|---|
| Vaultwarden | `apps/workloads/vaultwarden` | **tech** | Passwort-Manager — wird von Person *und* anderen Diensten als Credential-Quelle genutzt, kein Endnutzer-Produkt im eigentlichen Sinn |
| Zammad | `apps/workloads/zammad` | **tech** | Ticket-/Support-System, das auch interne Automatisierung (z. B. `github-release-watcher`) anspricht — Betriebs-Tooling, nicht Familien-/Vereins-Content |

Alle übrigen Apps folgen der einfachen Regel: `platform/` → **tech**,
`workloads/` → **prod**.

---

## Wo das greift

```
LAN/Tailnet:  Client → Traefik (Host-Header "app.tech.homeserver"
                                 bzw. "app.prod.homeserver")
                     → passender Service

Internet:     Client → app.tech.pke-lab.de / app.prod.pke-lab.de
                     → Cloudflare Edge → cloudflared
                     → Traefik (Wildcard-Regel *.tech.pke-lab.de bzw.
                                 *.prod.pke-lab.de)
                     → Host-Header "app.tech.pke-lab.de" → passender Service
```

Beide Pfade tragen dasselbe Tier-Label — z. B. ist Grafana intern
`grafana.tech.homeserver` und extern `grafana.tech.pke-lab.de`, dieselbe
App, derselbe Tier, nur andere Domain. Betroffene Stellen pro App:

- `argocd/apps/<platform|workloads>/<app>/values.yaml` →
  `ingress.hosts[].host` (**beide** Hosts, LAN und — falls die App extern
  erreichbar sein soll — extern) und ggf. `env`/OIDC-Redirect-URLs, die den
  eigenen Hostnamen referenzieren
- Jede Stelle, die den Hostnamen einer *anderen* App referenziert (siehe
  [Cross-App-Referenzen](#cross-app-referenzen) unten)

DNS-Auflösung selbst brauchte **keine** Änderung: sowohl dnsmasq
(`address=/homeserver/<ip>`, siehe
[docs/09-dns-architecture.md](09-dns-architecture.md)) als auch der
CoreDNS-Forward im Cluster (`argocd/apps/platform/coredns-custom/`)
matchen auf die komplette `homeserver`-Zone inklusive aller
Subdomain-Ebenen — `app.tech.homeserver` wird also automatisch mit
aufgelöst, ganz ohne Anpassung an dnsmasq/CoreDNS.

---

## Externe Erreichbarkeit: Wildcard-Routing über Traefik

`argocd/apps/platform/cloudflared/values.yaml` enthält **nicht** mehr eine
Ingress-Regel pro extern freigegebener App, sondern nur noch zwei bis drei
Wildcard-Regeln (eine pro Tier: `*.tech.pke-lab.de`, `*.prod.pke-lab.de`,
optional `*.dev.pke-lab.de`) — alle drei zeigen auf
`http://traefik.kube-system.svc.cluster.local:80`, also auf Traefik selbst,
genau wie der interne LAN-Pfad das für `*.homeserver` bereits tut.

**Eine Wildcard-Regel macht dadurch keine App automatisch extern
erreichbar.** Traefik matcht Ingress-Ressourcen weiterhin exakt nach
Host-Header — eine App wird nur dann erreichbar, wenn sie zusätzlich zu
ihrem `*.homeserver`-Host auch einen `*.pke-lab.de`-Host in ihrer eigenen
`ingress.hosts`-Liste trägt. Fehlt der, matcht Traefik keinen Router und
liefert 404 — dieselbe "nur was explizit eingetragen ist"-Garantie wie
vorher über cloudflareds `defaultService`, nur eine Ebene tiefer verlagert.

Aktuell tragen genau diese Apps zusätzlich einen `*.pke-lab.de`-Host (Stand
dieser Migration):

| App | Extern | Tier |
|---|---|---|
| Wiki.js | `wiki.prod.pke-lab.de` | prod |
| ntfy | `ntfy.tech.pke-lab.de` | tech |
| Zammad | `support.tech.pke-lab.de` (abweichendes Label!) | tech |
| Grafana | `grafana.tech.pke-lab.de` | tech |
| MediaMTX | `stream.prod.pke-lab.de` | prod |
| Mealie | `mealie.prod.pke-lab.de` | prod |
| Vaultwarden | `vault.tech.pke-lab.de` | tech |
| Nextcloud | `nextcloud.prod.pke-lab.de` | prod |
| Immich | `immich.prod.pke-lab.de` | prod |

Alle anderen Apps (Authentik, Semaphore, Pi-hole, MinIO, Gotify, Headlamp,
Paperless-ngx, n8n, ...) bleiben ausschließlich LAN/Tailscale-erreichbar —
auch wenn ihr Hostname theoretisch unter eine der Wildcard-Regeln fallen
würde, weil ihnen schlicht der zweite Ingress-Host fehlt.

Eine App extern freigeben/entfernen heißt also: den `*.pke-lab.de`-Host in
der `ingress.hosts`-Liste der **App selbst** ergänzen/löschen — nicht mehr
in `cloudflared/values.yaml`. Details/Ablauf:
[docs/23-cloudflare-deploy.md → Neuen Dienst freigeben](23-cloudflare-deploy.md#neuen-dienst-freigeben).

> **Noch gegen den echten Cluster zu verifizieren:** Traefiks
> Host-Header-Routing setzt voraus, dass `cloudflared` den ORIGINAL
> angefragten Hostnamen (z. B. `grafana.tech.pke-lab.de`) unverändert als
> HTTP-Host-Header an Traefik weiterreicht, statt den Hostnamen aus
> `service:` (`traefik.kube-system.svc.cluster.local`) einzusetzen. Das ist
> Cloudflares dokumentiertes Default-Verhalten für
> `originRequest.httpHostHeader`, sollte nach dem Rollout aber per
> `curl -I https://<app>.<tier>.pke-lab.de` bestätigt werden — falls nicht,
> `httpHostHeader` pro Regel in `cloudflared/values.yaml` explizit setzen.

---

## Cross-App-Referenzen

Der eigentliche Aufwand bei dieser Umstellung war nicht das Umbenennen
der eigenen Ingress-Hosts, sondern alle Stellen zu finden, die den
Hostnamen einer *anderen* App fest verdrahtet haben. Beispiele, die dabei
angepasst wurden:

| Wer referenziert | Wen | Datei |
|---|---|---|
| `github-release-watcher` | Zammad-API | `argocd/apps/workloads/github-release-watcher/values.yaml` |
| n8n-Workflow (Banana-Pi-Alarm → Zammad-Ticket) | Zammad-API + Grafana-Dashboard-Link | `argocd/apps/workloads/n8n/workflows/banana-pi-down-to-zammad.json` |
| `carplay-api` (Kommentar) | kubeseal-webgui | `argocd/apps/workloads/carplay-api/values.yaml` |
| Grafana selbst (`grafana.ini` `domain`/`root_url`) | eigener externer Hostname | `argocd/apps/platform/monitoring/values.yaml` |
| ntfy-Watchdogs (Cluster-Power-Manager, Resource-/Thermal-Watchdog) | ntfy | `ansible/roles/{cluster_power_manager,resource_watchdog,thermal_watchdog}/defaults/main.yml` |
| Semaphore-Ansible-Rollen (`semaphore_bootstrap`, `semaphore_secrets`) | Semaphore-REST-API | `ansible/roles/semaphore_bootstrap/defaults/main.yml`, `ansible/roles/semaphore_secrets/tasks/main.yml` |
| vmagent auf den Banana-Pis | VictoriaMetrics remote-write (`vm-write`) | `ansible/group_vars/banana_pis.yml` |
| Alamos-/Banana-Pi-Kiosk-Rollen | alamos-apager | `ansible/roles/{alamos_kiosk,banana_pi_kiosk}/defaults/main.yml` |
| iOS-App "Homeserver Dashboard" | carplay-api + alle in der App verlinkten Self-Hosted-Services | `ios/HomeserverDashboard/Utilities/Constants.swift` |

**Faustregel für neue Cross-App-Referenzen:** Der Tier eines Hostnamens
richtet sich immer nach der **Ziel-App**, nicht nach der App, die
referenziert. `github-release-watcher` ist selbst `prod`, spricht aber
`zammad.tech.homeserver` an — weil Zammad `tech` ist, nicht weil der
Aufrufer es ist.

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
[docs/49-argocd-projects.md](49-argocd-projects.md)) ist von dieser
URL-Konvention unabhängig.

---

## Offener Punkt: internes TLS-Wildcard-Zertifikat

Der `https://`-Rollout aus [docs/54-internal-tls.md](54-internal-tls.md) ist
bereits vollzogen (README/Docs zeigen `https://` für alle Dienste außer
Authentik) — aber das zugrundeliegende Zertifikat
(`argocd/apps/platform/traefik-config/sealedsecret-wildcard-tls.yaml`) trägt
noch die feste SAN-Liste der *alten*, untierten Hostnamen
(`<app>.homeserver`). Durch diese Migration heißen die Hosts jetzt
`<app>.tech.homeserver`/`<app>.prod.homeserver` — ein Browser/`curl`, der
`https://grafana.tech.homeserver` aufruft, bekommt deshalb aktuell einen
Zertifikats-Hostname-Mismatch, bis das Zertifikat mit der neuen,
tier-behafteten SAN-Liste neu erzeugt und resealed wird. Verfahren dafür
steht in
[docs/54-internal-tls.md → "Zertifikat erneuern"](54-internal-tls.md#zertifikat-erneuern).
Das kann nicht automatisiert per Commit erledigt werden, weil der
CA-Private-Key bewusst außerhalb des Repos liegt — bis dahin: `http://`
als Fallback, oder Browser-Zertifikatswarnung bewusst akzeptieren.

---

## Eine neue App einordnen

1. Gehört die App zu **tech** (Infrastruktur/Admin, kein Endnutzer) oder
   **prod** (echter Nutzerkreis)? Faustregel identisch zu
   [docs/49-argocd-projects.md](49-argocd-projects.md#eine-neue-app-hinzufügen)
   — im Zweifel: Infrastruktur-/Betriebsdienst ohne eigenen Endnutzer →
   **tech**.
2. Ingress-Host in der `values.yaml` der neuen App direkt im neuen Schema
   anlegen: `<app>.tech.homeserver` bzw. `<app>.prod.homeserver` — nicht
   erst flach anlegen und später umbenennen.
3. Soll die App zusätzlich extern erreichbar sein: **in der `values.yaml`
   der App selbst** einen zweiten `ingress.hosts`-Eintrag mit demselben
   Tier ergänzen (`<app>.tech.pke-lab.de` / `<app>.prod.pke-lab.de`) —
   `cloudflared/values.yaml` bleibt dabei unangetastet, siehe
   [Externe Erreichbarkeit](#externe-erreichbarkeit-wildcard-routing-über-traefik)
   oben.
4. Referenziert eine andere, bereits bestehende App diesen neuen Host
   (oder umgekehrt) — z. B. ein OIDC-Redirect zu Authentik, ein
   Webhook-Ziel, ein Ansible-Default — auf den korrekten Tier des
   jeweiligen **Ziels** achten (siehe
   [Cross-App-Referenzen](#cross-app-referenzen) oben).
