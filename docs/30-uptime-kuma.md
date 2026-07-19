# Uptime Kuma — Status-Seite und Service-Alerting

Uptime Kuma ist eine schlanke, selbst gehostete Status-Seite. Sie prüft
regelmäßig ob Dienste erreichbar sind und schickt Alerts bei Ausfällen —
via ntfy, Gotify, E-Mail oder anderen Kanälen.

---

## Architektur

```
uptime-kuma.homeserver  →  Traefik  →  uptime-kuma (Port 3001)
                                            └── PVC: data (2 Gi, hdd, worker-0)
```

---

## Erster Start

Nach dem Deploy unter **http://uptime-kuma.homeserver** den Admin-Account
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
| Grafana | http://grafana.homeserver | HTTP |
| ArgoCD | http://`<server-ip>`:30080 | HTTP |
| Authentik | http://authentik.homeserver | HTTP |
| ntfy | http://ntfy.homeserver | HTTP |
| Semaphore | http://semaphore.homeserver | HTTP |
| Paperless | http://paperless.homeserver | HTTP |
| Mealie | http://mealie.homeserver | HTTP |
| n8n | http://n8n.homeserver | HTTP |
| Grocy | http://grocy.homeserver | HTTP |
| worker-0 (Ping) | 192.168.178.95 | Ping |

---

## Notifications einrichten

### ntfy

1. Uptime Kuma: *Einstellungen* → *Benachrichtigung* → *ntfy*
2. Server: `http://ntfy.homeserver`
3. Topic: z. B. `homelab-uptime`
4. Priorität: `urgent` für Ausfälle

### Gotify

1. In Gotify eine neue App anlegen, Token kopieren
2. Uptime Kuma: Benachrichtigung → *Gotify*
3. URL: `http://gotify.homeserver`, Token eintragen

---

## Konfiguration (values.yaml)

| Key | Bedeutung | Default |
|---|---|---|
| `persistence.size` | Datenspeicher (SQLite + Config) | `2Gi` |
| `resources.limits.memory` | RAM-Limit | `512Mi` |
