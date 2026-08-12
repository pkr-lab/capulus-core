# carplay-api — Homeserver-Dashboard-API

Kleine Go/Gin-API, die VictoriaMetrics (Systemmetriken pro Host), ntfy
(Alerts) und Uptime-Kuma (Service-Status) zu einem einzigen JSON-Payload
zusammenfasst, 30s gecacht, plus Bildschirmhelligkeit und
Wake-on-LAN/Shutdown für die Flotte. Einziger Konsument: die iOS-App
**Homeserver Dashboard** — eine reine iPhone-App, keine CarPlay-Komponente
(siehe `ios/README.md` im selben Repo für die App selbst; dieses Dokument
ist nur der Backend-Teil, der Verzeichnisname `carplay-api` blieb aus
diesem früheren CarPlay-Zuschnitt erhalten).

## Inhaltsverzeichnis

1. [Übersicht & Architektur](#übersicht--architektur)
2. [power-agent](#power-agent)
3. [Abweichungen vom ursprünglichen Konzept](#abweichungen-vom-ursprünglichen-konzept)
4. [Ersteinrichtung](#ersteinrichtung)
5. [Uptime-Kuma Status-Page anlegen](#uptime-kuma-status-page-anlegen)
6. [Image bauen & pushen](#image-bauen--pushen)
7. [Absicherung](#absicherung)
8. [Konfiguration (values.yaml)](#konfiguration-valuesyaml)
9. [Fehlerbehebung](#fehlerbehebung)

---

## Übersicht & Architektur

```
Homeserver Dashboard (iOS)
        │  GET  /api/dashboard              (Bearer-Token, alle 30s)
        │  GET  /api/brightness
        │  PUT  /api/brightness
        │  POST /api/power/wake
        │  POST /api/power/shutdown
        ▼
carplay-api.homeserver ──▶ Traefik ──▶ carplay-api Pod (Namespace carplay-api)
                                          ├─ VictoriaMetrics  (CPU/RAM/Disk/Temp/Uptime, PRO Host)
                                          ├─ ntfy             (Alerts, Topic "alerts")
                                          ├─ Uptime-Kuma       (Service-Status, Status-Page)
                                          └─ power-agent       (Bearer-Token, siehe unten)
                                          30s In-Memory-Cache (nur /api/dashboard), 5s Gesamt-Timeout
```

Die Alerts-, Metrik- und Status-Abfragen laufen parallel und mit eigenem
kurzen Timeout (VictoriaMetrics 3s, ntfy/Kuma je 2s). Fällt eine Quelle
aus, liefert `/api/dashboard` trotzdem `200` mit den übrigen Spalten
gefüllt und der ausgefallenen Spalte leer/auf 0 — siehe
Quellcode-Kommentare in
`argocd/apps/workloads/carplay-api/src/internal/handlers/dashboard.go`. Metriken
kommen pro Host (`hosts[]` im Payload, siehe `config.hosts` in
`values.yaml`), nicht mehr als ein einziger Flotten-Durchschnitt — ein
Host, der gerade aus ist, taucht mit `online: false` auf, alle
Zahlenfelder auf 0.

## power-agent

Brightness- und Power-Endpunkte werden NICHT vom carplay-api-Pod selbst
ausgeführt — der Pod läuft absichtlich unprivilegiert
(`podSecurityContext`/`securityContext` in `values.yaml`, `readOnlyRootFilesystem`,
kein Host-Zugriff). Stattdessen proxied carplay-api jede
Helligkeits-/Wake-/Shutdown-Anfrage an **power-agent**
(`ansible/roles/power_agent`), einen kleinen privilegierten HTTP-Daemon,
der direkt auf dem nackten Homeserver-Host läuft (systemd-Service, NICHT
im Cluster) und:

- die Bildschirmhelligkeit über `/sys/class/backlight/intel_backlight/`
  liest/schreibt (HP ProBook 450 G9, siehe `docs/01-overview.md`),
- `wakeonlan` für worker-0/worker-1 auslöst,
- worker-0/worker-1 über denselben SSH-Key wie `cluster_power_manager`
  herunterfährt (forced command, nur `sudo poweroff` möglich — siehe
  [docs/37-cluster-power-manager.md](37-cluster-power-manager.md)), und
- den Homeserver selbst herunterfährt (`sudo poweroff`, lokal, da der
  Agent als root läuft).

Manuelle Wake-/Shutdown-Aktionen aus der App schreiben/löschen dieselben
`STATE_DIR/<name>.woke_at`-Dateien wie der automatische
Last-Watchdog (`cluster-power-manager.service`) — ein Tap in der App und
die automatische Skalierung widersprechen sich dadurch nicht.

Der Homeserver selbst hat **keinen** Wake-Pfad (kein WoL-Empfänger, da
Dauerläufer) — `POST /api/power/wake` mit `target: "homeserver"` liefert
`400`.

Setup: `power_agent` läuft in `site.yml` direkt nach
`cluster_power_manager` (`make power-agent` für einen gezielten
Re-Deploy). Beim ersten Rollout erzeugt die Rolle ein Bearer-Token unter
`/etc/power-agent/token` auf dem Homeserver — dieser Wert muss danach
manuell in `argocd/apps/workloads/carplay-api/values.yaml` unter
`secrets.powerAgentToken` versiegelt werden (kubeseal), siehe Kommentar
dort. Ohne passendes Secret bekommt die App dauerhaft `502` auf
Helligkeit/Wake/Shutdown, der Rest des Dashboards bleibt aber nutzbar.

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

   Das Ergebnis in `argocd/apps/workloads/carplay-api/values.yaml` unter
   `secrets.apiToken.encryptedData` eintragen. `$TOKEN` selbst geht in die
   iOS-App (Keychain, siehe `ios/README.md`) — nie ins Git.

3. **power-agent ausrollen und Token versiegeln** (Pflicht für
   Helligkeit/Wake/Shutdown, der Rest der App funktioniert auch ohne —
   siehe [power-agent](#power-agent)):

   ```bash
   make power-agent   # oder: einmal make install / ansible-playbook site.yml
   ssh -i ~/.ssh/id_ed25519 ubuntu@192.168.178.94 'sudo cat /etc/power-agent/token'
   ```

   Den ausgegebenen Wert genauso versiegeln wie den API-Token oben, nur
   mit anderem Namespace-Secret-Namen:

   ```bash
   echo -n "<power-agent-token>" | kubeseal --raw \
     --namespace carplay-api --name carplay-api-power-agent-token \
     --cert ~/homelab-certs/sealed-secrets.pem --from-file=/dev/stdin
   ```

   Ergebnis in `values.yaml` unter `secrets.powerAgentToken.encryptedData`,
   dazu `secrets.powerAgentToken.enabled: true`.

4. **Shutdown-Bestätigungscode versiegeln** (Pflicht für den
   Homeserver-Shutdown aus der App — ohne dieses Secret bleibt
   `target: "homeserver"` mit `503` blockiert, worker-0/worker-1 sind
   davon nicht betroffen). Denselben Wert wie das aktuelle
   ArgoCD-Admin-Passwort verwenden (siehe
   [docs/05-argocd.md](05-argocd.md)) und bei jeder Passwort-Rotation hier
   mit erneuern:

   ```bash
   echo -n "<argocd-admin-passwort>" | kubeseal --raw \
     --namespace carplay-api --name carplay-api-shutdown-code \
     --cert ~/homelab-certs/sealed-secrets.pem --from-file=/dev/stdin
   ```

   Ergebnis in `values.yaml` unter
   `secrets.shutdownConfirmationCode.encryptedData`, dazu
   `secrets.shutdownConfirmationCode.enabled: true`.

5. Status-Page in Uptime-Kuma anlegen (siehe nächster Abschnitt) und den
   Slug in `values.yaml` unter `config.uptimeKuma.slug` eintragen.

6. `config.hosts` prüfen/anpassen — ein Eintrag pro Host-Karte auf der
   App-Startseite, `instance` muss exakt das VictoriaMetrics-Label des
   jeweiligen node-exporter-Targets treffen (Default deckt
   Homeserver/worker-0/worker-1/NAS ab, siehe Kommentar in `values.yaml`).

7. Image bauen/pushen (siehe [unten](#image-bauen--pushen)) und
   `image.repository`/`image.tag` setzen.

8. Committen & pushen — ArgoCD rollt automatisch aus.

## Uptime-Kuma Status-Page anlegen

1. **http://uptime-kuma.homeserver** → *Status-Pages* → *New Status Page*.
2. Slug vergeben (Default in `values.yaml`: `homeserver`) — muss exakt mit
   `config.uptimeKuma.slug` übereinstimmen.
3. Alle Monitore hinzufügen, die im Dashboard erscheinen sollen (siehe
   [docs/30-uptime-kuma.md](30-uptime-kuma.md) für die vorhandene
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
  -p context=argocd/apps/workloads/carplay-api \
  -p dockerfile=argocd/apps/workloads/carplay-api/Dockerfile \
  -p image=ghcr.io/<dein-gh-username>/carplay-api:latest
```

Danach `image.repository`/`image.tag` in `values.yaml` setzen. Ist das
GHCR-Package privat, zusätzlich ein `imagePullSecrets`-Secret anlegen (siehe
Kommentar in `values.yaml`).

## Absicherung

Vier unabhängige Schichten, keine davon mTLS (siehe oben):

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
4. **Bestätigungscode** (`SHUTDOWN_CONFIRMATION_CODE`) — zusätzlich zum
   Bearer-Token für genau eine Aktion: `POST /api/power/shutdown` mit
   `target: "homeserver"`. worker-0/worker-1 brauchen ihn nicht (nur eine
   simple Bestätigung in der App), da ein versehentliches
   Herunterfahren dort folgenlos per Wake-on-LAN rückgängig zu machen ist —
   beim Homeserver nicht.

## Konfiguration (values.yaml)

Vollständige Liste + Defaults: `argocd/apps/workloads/carplay-api/values.yaml`
(kommentiert) und `argocd/apps/workloads/carplay-api/README.md` (Env-Var-Tabelle).
Die wichtigsten:

| Key | Bedeutung |
|---|---|
| `config.hosts` | Liste `{id, name, instance}` — ein Eintrag pro Host-Karte auf der App-Startseite, `instance` muss exakt das VictoriaMetrics-`instance`-Label treffen (Default deckt Homeserver/worker-0/worker-1/NAS ab) |
| `config.ntfy.topic` | ntfy-Topic, das als Alerts angezeigt wird |
| `config.uptimeKuma.slug` | Status-Page-Slug, siehe oben |
| `config.powerAgent.url` | Basis-URL von power-agent auf dem Homeserver-Host, siehe [power-agent](#power-agent) |
| `secrets.apiToken.enabled` | Default `true` — siehe [Ersteinrichtung](#ersteinrichtung) |
| `secrets.powerAgentToken.enabled` | Muss `true` sein, sonst 502 auf Helligkeit/Wake/Shutdown — siehe [power-agent](#power-agent) |
| `secrets.shutdownConfirmationCode.enabled` | Muss `true` sein, sonst 503 auf Homeserver-Shutdown — siehe [Ersteinrichtung](#ersteinrichtung) Schritt 4 |
| `ingress.host` | `carplay-api.homeserver` |

## Fehlerbehebung

| Symptom | Check |
|---|---|
| Pod hängt in `CreateContainerConfigError` | `secrets.apiToken.encryptedData` noch Platzhalter? Siehe [Ersteinrichtung](#ersteinrichtung) Schritt 2 |
| `/api/dashboard` liefert `status: []` | Status-Page-Slug falsch oder Monitore nicht auf die Page gelegt — siehe [Uptime-Kuma-Abschnitt](#uptime-kuma-status-page-anlegen) |
| `/api/dashboard` liefert `alerts: []`, obwohl ntfy Nachrichten hat | `config.ntfy.topic` prüfen; `NTFY_SINCE` (Default `12h`) evtl. zu kurz für ältere Test-Nachrichten |
| `hosts[]` zeigt einen bekanntermaßen laufenden Host als `online: false` | `instance` in `config.hosts` gegen die echten VictoriaMetrics-Labels prüfen: `curl vmsingle-....svc.cluster.local:8428/api/v1/targets` |
| `hosts` zeigt überall `0` / `online: false` | `kubectl -n carplay-api logs deploy/carplay-api` — PromQL-Query-Fehler landen dort mit Klartext-Fehlermeldung von VictoriaMetrics |
| App bekommt `401` auf `/api/dashboard` | Token in der App (Keychain) ≠ `secrets.apiToken`-Klartext beim Erzeugen des SealedSecret |
| App bekommt `401` beim Homeserver-Shutdown | Eingegebener Code ≠ `secrets.shutdownConfirmationCode`-Klartext — meist nach einer ArgoCD-Passwort-Rotation, die hier noch nicht nachgezogen wurde |
| App bekommt `502` auf Helligkeit/Wake/Shutdown | `secrets.powerAgentToken` stimmt nicht mit `/etc/power-agent/token` auf dem Homeserver überein, oder power-agent läuft nicht (`systemctl status power-agent` auf dem Homeserver) — siehe [power-agent](#power-agent) |
| App bekommt `403` nach Aktivieren der IP-Allowlist | `config.trustedProxies` fehlt/falsch — App sieht Traefik-Pod-IP statt Tailscale-IP, siehe [Absicherung](#absicherung) |
| `carplay-api.homeserver` löst nicht auf | Wildcard-DNS prüfen: `nslookup carplay-api.homeserver` (siehe [docs/09-dns-architecture.md](09-dns-architecture.md)) |
