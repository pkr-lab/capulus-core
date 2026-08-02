# carplay-api — Homeserver-CarPlay-Dashboard

Kleine Go/Gin-API, die VictoriaMetrics (Systemmetriken), ntfy (Alerts) und
Uptime-Kuma (Service-Status) zu einem einzigen JSON-Payload zusammenfasst,
30s gecacht. Einziger Konsument: die iOS-App **Homeserver CarPlay Dashboard**
(3-Spalten-Ansicht im Auto, siehe `ios/README.md` im selben Repo).

## Inhaltsverzeichnis

1. [Übersicht & Architektur](#übersicht--architektur)
2. [Abweichungen vom ursprünglichen Konzept](#abweichungen-vom-ursprünglichen-konzept)
3. [Ersteinrichtung](#ersteinrichtung)
4. [Uptime-Kuma Status-Page anlegen](#uptime-kuma-status-page-anlegen)
5. [Image bauen & pushen](#image-bauen--pushen)
6. [Absicherung](#absicherung)
7. [Konfiguration (values.yaml)](#konfiguration-valuesyaml)
8. [Fehlerbehebung](#fehlerbehebung)

---

## Übersicht & Architektur

```
Homeserver CarPlay Dashboard (iOS)
        │  GET /api/dashboard  (Bearer-Token, alle 30s)
        ▼
carplay-api.homeserver ──▶ Traefik ──▶ carplay-api Pod (Namespace carplay-api)
                                          ├─ VictoriaMetrics  (CPU/RAM/Disk/Temp/Uptime/Load)
                                          ├─ ntfy             (Alerts, Topic "alerts")
                                          └─ Uptime-Kuma       (Service-Status, Status-Page)
                                          30s In-Memory-Cache, 5s Gesamt-Timeout
```

Jede der drei Abfragen läuft parallel und mit eigenem kurzen Timeout
(VictoriaMetrics 3s, ntfy/Kuma je 2s). Fällt eine Quelle aus, liefert
`/api/dashboard` trotzdem `200` mit den übrigen Spalten gefüllt und der
ausgefallenen Spalte leer/auf 0 — siehe Quellcode-Kommentare in
`argocd/apps/carplay-api/src/internal/handlers/dashboard.go`.

## Abweichungen vom ursprünglichen Konzept

Das ursprüngliche Anforderungsdokument beschrieb drei Dinge, die entweder
nicht existieren oder nicht zu diesem Cluster passen. Statt sie 1:1
umzusetzen (und damit etwas zu bauen, das gegen die echten Dienste nie
funktioniert hätte), wurde angepasst:

- **Uptime-Kuma-API**: Es gibt kein `Authorization: Bearer`-geschütztes
  `/api/status_page/monitors`. Uptime-Kumas einzige stabile Lese-API ist die
  **öffentliche Status-Page** (`/api/status-page/{slug}` +
  `/api/status-page/heartbeat/{slug}`), bewusst ohne Auth — das ist ihr
  ganzer Zweck. `carplay-api` liest genau diese. Folge: eine Status-Page mit
  Slug muss in der Kuma-UI existieren, siehe unten.
- **Paketierung**: Helm-Chart (`Chart.yaml`/`values.yaml`/`templates/`) wie
  jede andere App unter `argocd/apps/`, kein rohes Kustomize/kubectl-YAML —
  sonst hätte die App nicht automatisch über die ArgoCD-`ApplicationSet`
  (siehe [docs/05-argocd.md](05-argocd.md)) ausgerollt werden können.
- **Namespace**: `carplay-api`, nicht `homeserver-app` — die
  `ApplicationSet` leitet den Namespace aus dem Verzeichnisnamen ab.
- **mTLS**: nicht umgesetzt. Traefik terminiert in diesem Cluster kein
  Client-Zertifikat-TLS — ein "Certificate Pinning" hätte nichts geprüft,
  außer einer vorgetäuschten Sicherheit. Die reale Grenze ist Bearer-Token +
  optionale IP-Allowlist auf das Tailscale-Netz (siehe
  [Absicherung](#absicherung)).

## Ersteinrichtung

1. **`kubeseal`-Zertifikat besorgen** (einmalig, überspringen falls
   `~/homelab-certs/sealed-secrets.pem` schon existiert — siehe
   [docs/14-cert-login.md](14-cert-login.md#kubeseal-ohne-lokalen-cluster-kontext)):

   ```bash
   mkdir -p ~/homelab-certs
   ssh -i ~/.ssh/id_ed25519 ubuntu@192.168.178.94 \
     'sudo kubectl -n sealed-secrets get secret \
      -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
      -o jsonpath="{.items[0].data.tls\.crt}" | base64 -d' \
     > ~/homelab-certs/sealed-secrets.pem
   ```

   Alternative ohne CLI/SSH-Zugriff: **http://kubeseal-webgui.homeserver**
   verschlüsselt einzelne Werte über eine Weboberfläche (Namespace
   `carplay-api`, Secret-Name `carplay-api-token`, Key `token`) — liefert
   denselben Base64-Blob wie unten, ohne Schritt 1.

2. **API-Token erzeugen und versiegeln** (Pflicht — ohne dieses Secret
   bleibt der Pod in `CreateContainerConfigError` hängen, siehe
   `values.yaml`-Kommentar bei `secrets.apiToken`):

   ```bash
   TOKEN=$(openssl rand -hex 32)
   echo -n "$TOKEN" | kubeseal --raw \
     --namespace carplay-api --name carplay-api-token \
     --cert ~/homelab-certs/sealed-secrets.pem --from-file=/dev/stdin
   ```

   Das Ergebnis in `argocd/apps/carplay-api/values.yaml` unter
   `secrets.apiToken.encryptedData` eintragen. `$TOKEN` selbst geht in die
   iOS-App (Keychain, siehe `ios/README.md`) — nie ins Git.

3. Status-Page in Uptime-Kuma anlegen (siehe nächster Abschnitt) und den
   Slug in `values.yaml` unter `config.uptimeKuma.slug` eintragen.

4. Image bauen/pushen (siehe [unten](#image-bauen--pushen)) und
   `image.repository`/`image.tag` setzen.

5. Committen & pushen — ArgoCD rollt automatisch aus.

## Uptime-Kuma Status-Page anlegen

1. **http://uptime-kuma.homeserver** → *Status-Pages* → *New Status Page*.
2. Slug vergeben (Default in `values.yaml`: `homeserver`) — muss exakt mit
   `config.uptimeKuma.slug` übereinstimmen.
3. Alle Monitore hinzufügen, die im CarPlay-Dashboard erscheinen sollen
   (siehe [docs/30-uptime-kuma.md](30-uptime-kuma.md) für die vorhandene
   Monitor-Liste).
4. Speichern — die Seite muss nicht öffentlich beworben werden, sie muss
   nur existieren; `carplay-api` liest sie serverseitig.

## Image bauen & pushen

Kein GitHub Actions in diesem Repo — Image-Builds laufen über das
`kaniko-build-push`-WorkflowTemplate aus
[docs/12-argo-workflows.md](12-argo-workflows.md):

```bash
argo submit --from workflowtemplate/kaniko-build-push \
  -p repo=https://github.com/pkr-lab/capulus-core.git \
  -p revision=main \
  -p context=argocd/apps/carplay-api \
  -p dockerfile=argocd/apps/carplay-api/Dockerfile \
  -p image=ghcr.io/<dein-gh-username>/carplay-api:latest
```

Danach `image.repository`/`image.tag` in `values.yaml` setzen. Ist das
GHCR-Package privat, zusätzlich ein `imagePullSecrets`-Secret anlegen (siehe
Kommentar in `values.yaml`).

## Absicherung

Drei unabhängige Schichten, keine davon mTLS (siehe oben):

1. **Bearer-Token** (`CARPLAY_API_TOKEN`) — Pflicht in Produktion, prüft
   jeder Request an `/api/*`. Ohne gesetztes Token läuft die API ungeschützt
   und loggt das laut beim Start.
2. **IP-Allowlist** (`config.ipAllowlist`, default **deaktiviert**) —
   beschränkt `/api/*` auf CIDR-Bereiche (Default-Vorschlag: Tailscale-CGNAT
   `100.64.0.0/10` + LAN `192.168.178.0/24`). Braucht `config.trustedProxies`
   korrekt gesetzt (Traefik-Pod-CIDR), sonst sieht die App Traefiks
   Pod-IP statt der echten Client-IP und sperrt alles aus — deshalb vor dem
   Aktivieren einmal `kubectl -n carplay-api logs deploy/carplay-api` prüfen,
   ob `client_ip` in den Request-Logs die erwartete Adresse zeigt.
3. **Rate-Limiting** (100 req/min/IP, konfigurierbar) — Backstop gegen eine
   verunglückte App-Instanz, die im 30s-Intervall-Bug feststeckt.

## Konfiguration (values.yaml)

Vollständige Liste + Defaults: `argocd/apps/carplay-api/values.yaml`
(kommentiert) und `argocd/apps/carplay-api/README.md` (Env-Var-Tabelle).
Die wichtigsten:

| Key | Bedeutung |
|---|---|
| `config.victoriaMetrics.instanceFilter` | Regex-Alternation der `instance`-Labels, die aggregiert werden (Default `homeserver\|worker-0\|worker-1`, gleiches Muster wie `argocd/apps/glance`) |
| `config.ntfy.topic` | ntfy-Topic, das als Alerts angezeigt wird |
| `config.uptimeKuma.slug` | Status-Page-Slug, siehe oben |
| `secrets.apiToken.enabled` | Default `true` — siehe [Ersteinrichtung](#ersteinrichtung) |
| `ingress.host` | `carplay-api.homeserver` |

## Fehlerbehebung

| Symptom | Check |
|---|---|
| Pod hängt in `CreateContainerConfigError` | `secrets.apiToken.encryptedData` noch Platzhalter? Siehe [Ersteinrichtung](#ersteinrichtung) Schritt 1 |
| `/api/dashboard` liefert `status: []` | Status-Page-Slug falsch oder Monitore nicht auf die Page gelegt — siehe [Uptime-Kuma-Abschnitt](#uptime-kuma-status-page-anlegen) |
| `/api/dashboard` liefert `alerts: []`, obwohl ntfy Nachrichten hat | `config.ntfy.topic` prüfen; `NTFY_SINCE` (Default `12h`) evtl. zu kurz für ältere Test-Nachrichten |
| `metrics` zeigt überall `0` / `"N/A"` | `kubectl -n carplay-api logs deploy/carplay-api` — PromQL-Query-Fehler landen dort mit Klartext-Fehlermeldung von VictoriaMetrics |
| iOS-App bekommt `401` | Token in der App (Keychain) ≠ `secrets.apiToken`-Klartext beim Erzeugen des SealedSecret |
| iOS-App bekommt `403` nach Aktivieren der IP-Allowlist | `config.trustedProxies` fehlt/falsch — App sieht Traefik-Pod-IP statt Tailscale-IP, siehe [Absicherung](#absicherung) |
| `carplay-api.homeserver` löst nicht auf | Wildcard-DNS prüfen: `nslookup carplay-api.homeserver` (siehe [docs/09-dns-architecture.md](09-dns-architecture.md)) |
