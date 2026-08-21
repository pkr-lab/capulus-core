# Uptime Kuma — Status-Seite und Service-Alerting

Uptime Kuma ist eine schlanke, selbst gehostete Status-Seite. Sie prüft
regelmäßig ob Dienste erreichbar sind und schickt Alerts bei Ausfällen —
via ntfy, Gotify, E-Mail oder anderen Kanälen.

---

## Architektur

```
uptime-kuma.homeserver  →  Traefik  →  uptime-kuma (Port 3001)
                                            └── PVC: data (2 Gi, local-path)
```

> **Warum `local-path` statt `nas`:** War testweise auf `nas`, ist aber nach
> Umstellung des NAS auf `all_squash` (siehe [docs/2-betrieb-hardware/20000-nas-storage.md](../2-betrieb-hardware/20000-nas-storage.md))
> mit Permission-Fehlern abgestürzt und wurde zurück auf `local-path`
> gestellt.

---

## Erster Start

Nach dem Deploy unter **https://uptime-kuma.homeserver** den Admin-Account
anlegen (erscheint beim ersten Besuch automatisch).

---

## Monitore anlegen

1. **Neuer Monitor** → Typ wählen:
   - **HTTP(s)** — für Web-Dienste (Grafana, ArgoCD, ...)
   - **TCP Port** — für Ports (k3s-API Port 6443)
   - **Ping** — für Hosts (homeserver, worker-0)
2. URL / Host und Intervall eintragen
3. Notification hinzufügen (ntfy oder Gotify)

### Empfohlene Monitore für den Stack

| Monitor | URL | Typ |
|---|---|---|
| Grafana | https://grafana.homeserver | HTTP |
| ArgoCD | https://`<server-ip>`:30443 | HTTPS (selbstsigniert) |
| ntfy | https://ntfy.homeserver | HTTP |
| Semaphore | https://semaphore.homeserver | HTTP |
| Paperless | https://paperless.homeserver | HTTP |
| Mealie | https://mealie.homeserver | HTTP |
| n8n | https://n8n.homeserver | HTTP |
| worker-0 (Ping) | 192.168.178.95 | Ping |

---

## Notifications einrichten

### ntfy

1. Uptime Kuma: *Einstellungen* → *Benachrichtigung* → *ntfy*
2. Server: `https://ntfy.homeserver`
3. Topic: z. B. `homelab-uptime`
4. Priorität: `urgent` für Ausfälle

### Gotify

1. In Gotify eine neue App anlegen, Token kopieren
2. Uptime Kuma: Benachrichtigung → *Gotify*
3. URL: `https://gotify.homeserver`, Token eintragen

---

## Öffentliche Status-Page

`argocd/apps/workloads/uptime-kuma/values.yaml` legt zusätzlich zum
internen Host einen externen Ingress-Host an (`status-prod.pke-lab.de` —
bewusst ohne "uptime-kuma" im Namen, damit die eingesetzte Software nicht
schon aus der URL erkennbar ist), erreichbar über die bestehende
`*.pke-lab.de`-Wildcard-Route von cloudflared — kein Änderung an
cloudflared nötig, siehe [docs/e-externe-erreichbarkeit/e0010-cloudflare-deploy.md](../e-externe-erreichbarkeit/e0010-cloudflare-deploy.md#neuen-dienst-freigeben).

Die eigentliche Status-Page ist ein manueller Einmal-Schritt in der
Kuma-UI (nicht Teil von Git/Helm):

1. **Settings → Status Pages → New Status Page**
2. Nur die Monitore hinzufügen, die öffentlich sichtbar sein sollen (keine
   internen IPs/Ports, keine Klarnamen sensibler interner Dienste)
3. Slug vergeben, z. B. `homelab` → Page liegt dann unter
   `https://status-prod.pke-lab.de/status/homelab`
4. Die "Updates"-Seite auf edv-kretzer.de fragt ausschließlich die
   Status-Page-JSON-API (`/api/status-page/<slug>` +
   `/api/status-page/heartbeat/<slug>`) per Hintergrund-Request ab und
   rendert die Daten im eigenen Design nach — es gibt dort **weder einen
   Link noch ein iframe**, das direkt auf `status-prod.pke-lab.de` zeigt.
   Nutzer sehen nur die Zusammenfassung, nicht den echten Hostnamen.

> Das Haupt-Dashboard (`/dashboard`) bleibt hinter dem normalen
> Admin-Login — nur die Status-Page-Route ist laut Kuma-Design
> unauthentifiziert öffentlich erreichbar. Der generische Hostname ist ein
> zusätzlicher Baustein, kein Ersatz für den Login-Schutz: Wer die
> Netzwerk-Requests der Website mitliest, sieht die tatsächliche URL —
> das lässt sich bei einem clientseitigen Fetch grundsätzlich nicht
> verstecken, nur der beiläufige Ein-Klick-Zugriff wird verhindert.

---

## Authelia-SSO (Pilot seit 21.08.2026)

Der interne Host (`uptime-kuma.prod.homeserver`) verlangt jetzt zuerst einen
Authelia-Login (`one_factor`, siehe
[docs/d-sicherheit/d0070-authelia-sso.md](../d-sicherheit/d0070-authelia-sso.md)).
Der externe Status-Host (`status-prod.pke-lab.de`) ist davon **nicht**
betroffen — bewusst unverändert, siehe dortiger Rollout-Plan. Für native
Anmeldung ohne Authelia (z. B. falls Authelia mal nicht erreichbar ist):
`https://uptime-kuma-native.prod.homeserver` — siehe
[docs/d-sicherheit/d0071-native-login-fallback.md](../d-sicherheit/d0071-native-login-fallback.md).

---

## Konfiguration (values.yaml)

| Key | Bedeutung | Default |
|---|---|---|
| `persistence.size` | Datenspeicher (SQLite + Config) | `2Gi` |
| `resources.limits.memory` | RAM-Limit | `512Mi` |
