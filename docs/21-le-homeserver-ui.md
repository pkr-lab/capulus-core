# Eigenes Dashboard-UI: le.homeserver (Einsatz) & admin.homeserver (Admin)

Dieses Repo enthält eine selbst gebaute Dashboard-UI
(`apps/le-homeserver-ui/`, deployed über `argocd/apps/le-homeserver/`), die
zwei Einstiegsseiten bereitstellt:

| Host | Zielgruppe | Inhalt |
|---|---|---|
| `le.homeserver` | alle eingeloggten Mitglieder | Einsatz-Dashboard: Navigation zu Grafana, Wiki.js, Alamos Pager |
| `admin.homeserver` | nur Gruppe "authentik Admins" | Admin-Dashboard: alle Apps + Live-Health-Status aus Grafana |

Beide Hosts laufen als **ein** Deployment/Pod (`le-homeserver-ui`,
Namespace `le-homeserver`) mit zwei separaten `Ingress`-Ressourcen. Die
Zugriffstrennung passiert in Authentik (zwei Applications, eine davon mit
Gruppen-Bindung) und zusätzlich serverseitig in der App selbst
(`X-authentik-groups`-Header-Check für `/admin`).

Wiki.js und der "Alamos Pager" sind aktuell **nicht** deployed — die
entsprechenden Kacheln im Einsatz-Dashboard sind als "bald verfügbar"
markiert (`comingSoon: true` in `values.yaml`). Sobald sie verfügbar sind,
reicht es, in `argocd/apps/le-homeserver/values.yaml` unter `services.einsatz`
die `url` einzutragen und `comingSoon` zu entfernen — kein Code-Change nötig.

---

## 1. Image bauen lassen & öffentlich machen

Ein Push auf `main` mit Änderungen unter `apps/le-homeserver-ui/**` löst
`.github/workflows/build-le-homeserver-ui.yml` aus und pusht das Image nach
`ghcr.io/pkr-lab/le-homeserver-ui:latest`.

**Einmalig nach dem ersten Build:** GitHub-Packages sind standardmäßig
privat, auch wenn das Repo selbst es ist. Damit k3s das Image ohne
ImagePullSecret pullen kann, muss das Package auf "Public" gestellt werden:

1. <https://github.com/pkr-lab/capulus-core/pkgs/container/le-homeserver-ui>
   öffnen (oder GitHub-Profil → Packages).
2. **Package settings → Change visibility → Public**.

Nach jedem weiteren Build (gleicher Tag `latest`) muss der Pod einmal neu
gezogen werden, da Kubernetes ein bereits gepulltes `latest`-Image sonst
nicht automatisch neu lädt:

```bash
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n le-homeserver rollout restart deployment/le-homeserver-ui'
```

---

## 2. Authentik: zwei Applications anlegen

Wie bei den anderen Forward-Auth-Diensten (siehe `docs/10-gotify.md`) reicht
die bereits bestehende `authentik-authentik-forwardauth`-Middleware — die
Zugriffstrennung passiert über die Policy-/Gruppen-Bindung der jeweiligen
Authentik-**Application**, nicht über den Provider-Typ.

### 2.1 — Provider + Application für `le.homeserver`

1. **Applications → Providers → Erstellen**
2. Typ: **Proxy Provider** → Weiter
3. Felder:
   - **Name:** `le-homeserver`
   - **Authorization flow:** Standard lassen
   - **Forward auth (single application)**
   - **External host:** `http://le.homeserver`
4. **Fertigstellen**.
5. **Applications → Applications → Erstellen**:
   - **Name:** `Einsatz-Dashboard`, **Slug:** `le-homeserver`
   - **Provider:** `le-homeserver`
   - **Launch URL:** `http://le.homeserver`
6. Speichern. Jeder gültige Authentik-Login darf hier rein — keine
   zusätzliche Gruppen-Bindung nötig.

### 2.2 — Provider + Application für `admin.homeserver`

Wie 2.1, aber:

- **Name (Provider):** `le-homeserver-admin`, **External host:**
  `http://admin.homeserver`
- **Name (Application):** `Admin-Dashboard`, **Slug:**
  `le-homeserver-admin`, **Launch URL:** `http://admin.homeserver`
- Zusätzlich nach dem Speichern: Application öffnen → Tab
  **Policy / Group / User Bindings → Bind existing group** →
  **authentik Admins** auswählen, **Order** auf `0` lassen. Damit kommen
  nur Mitglieder dieser Gruppe überhaupt am Forward-Auth-Check vorbei.

> Falls eine andere Gruppe als "authentik Admins" gewünscht ist: Gruppe in
> Authentik anlegen, hier binden, und denselben Namen in
> `argocd/apps/le-homeserver/values.yaml` unter `authentik.adminGroup`
> eintragen (muss exakt übereinstimmen, da die App diesen Header-Wert
> serverseitig vergleicht).

---

## 3. Grafana: Service-Account für den Health-Check anlegen

Der Health-Status auf `admin.homeserver` wird über Grafanas
Datasource-Proxy abgefragt (Prometheus-kompatible `up`-Metrik gegen die
VictoriaMetrics-Datasource).

1. `http://grafana.homeserver` öffnen → **Administration → Users and
   access → Service accounts → Add service account**.
   - **Name:** `le-homeserver-ui`, **Role:** `Viewer`
2. **Add service account token** → Token kopieren (wird nur einmal
   angezeigt).
3. Datasource-UID nachschlagen: **Connections → Data sources →
   victoriametrics-metrics-datasource** öffnen, UID steht in der URL
   (`.../datasources/edit/<uid>`).

---

## 4. Secrets versiegeln & `values.yaml` befüllen

```bash
NAMESPACE=le-homeserver
SECRET_NAME=le-homeserver-grafana-sa
CERT=~/homelab-certs/sealed-secrets.pem   # siehe docs/15-sso-alle-dienste.md

echo -n "<Token aus Schritt 3.2>" \
  | kubeseal --raw --namespace "$NAMESPACE" --name "$SECRET_NAME" \
      --cert "$CERT" --from-file=/dev/stdin
```

Alternativ über die Web-UI unter `http://kubeseal-webgui.homeserver`
(Namespace `le-homeserver`, Secret-Name `le-homeserver-grafana-sa`, Key
`token`) — siehe `docs/10-gotify.md` Abschnitt 1.2 für den genauen Ablauf.

In `argocd/apps/le-homeserver/values.yaml` eintragen:

```yaml
grafana:
  datasourceUid: "<UID aus Schritt 3.3>"
  tokenSecret:
    enabled: true
    encryptedToken: "<Ausgabe von oben>"
```

---

## 5. Commit & Deploy

```bash
git add argocd/apps/le-homeserver/values.yaml
git commit -m "feat(le-homeserver): Grafana-Health-Check aktivieren"
git push
```

ArgoCD synct innerhalb von ~3 Minuten. `*.homeserver` ist als Wildcard in
dnsmasq hinterlegt (`docs/09-dns-architecture.md`) — für `le.homeserver` und
`admin.homeserver` ist **keine** zusätzliche DNS-Änderung nötig.

---

## 6. Verifizierung

1. Browser → `http://le.homeserver` → Authentik-Login → Einsatz-Dashboard
   mit Kacheln für Grafana, Wiki.js ("bald verfügbar"), Alamos Pager ("bald
   verfügbar").
2. Browser → `http://admin.homeserver` als Mitglied von "authentik Admins"
   → Admin-Dashboard, Health-Badges werden nach ein paar Sekunden grün/rot.
3. Browser → `http://admin.homeserver` als Nicht-Admin → 403-Seite
   ("Kein Zugriff").

---

## Troubleshooting

### Health-Badges bleiben dauerhaft grau ("wird geprüft…")

`GET http://admin.homeserver/api/health` direkt aufrufen (eingeloggt) und
das `error`-Feld prüfen. Häufigste Ursachen:

- `datasourceUid` falsch oder leer → `not_configured`/`404`.
- Grafana-Token abgelaufen oder Service-Account deaktiviert → `401`.
- VictoriaMetrics liefert kein `up{job="..."}` für den Job-Namen in
  `values.yaml` → Job-Namen mit den tatsächlichen VMServiceScrape/
  ServiceMonitor-Labels in `argocd/apps/monitoring` abgleichen.

### `admin.homeserver` zeigt Authentik-Login-Loop

Die `ingress-outpost`-Route fehlt oder zeigt auf den falschen Service —
prüfen, dass `authentik-server-alias` im Namespace `le-homeserver`
existiert (`kubectl -n le-homeserver get svc`).

### Pod zieht nicht das neue Image nach einem CI-Build

`latest` + `imagePullPolicy: Always` lädt erst beim nächsten Pod-Neustart
neu — siehe Befehl in Abschnitt 1.
