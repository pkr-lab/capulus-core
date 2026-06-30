# Eigenes Admin-Dashboard-UI: admin.homeserver

Dieses Repo enthält eine selbst gebaute Dashboard-UI
(`apps/le-homeserver-ui/`, deployed über `argocd/apps/le-homeserver/`), die
unter `admin.homeserver` (nur Gruppe "authentik Admins") eine einzige
Einstiegsseite bereitstellt: Kurzlinks zu allen deployten Apps, Live-Health-
Status pro App sowie eine Auslastungs-Übersicht (CPU/RAM/Disk/Temperatur je
Node) — beides live aus Grafana.

Die Zugriffstrennung passiert in Authentik (eigene Application mit
Gruppen-Bindung) und zusätzlich serverseitig in der App selbst
(`X-authentik-groups`-Header-Check).

Wiki.js und der "Alamos Pager" sind aktuell **nicht** deployed — die
entsprechenden Kacheln sind als "bald verfügbar" markiert
(`comingSoon: true` in `values.yaml`). Sobald sie verfügbar sind, reicht es,
in `argocd/apps/le-homeserver/values.yaml` unter `services.apps` die `url`
einzutragen und `comingSoon` zu entfernen — kein Code-Change nötig.

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

## 2. Authentik: Application für `admin.homeserver` anlegen

Wie bei den anderen Forward-Auth-Diensten (siehe `docs/10-gotify.md`) reicht
die bereits bestehende `authentik-authentik-forwardauth`-Middleware — die
Zugriffstrennung passiert über die Policy-/Gruppen-Bindung der
Authentik-**Application**, nicht über den Provider-Typ.

1. **Applications → Providers → Erstellen**
2. Typ: **Proxy Provider** → Weiter
3. Felder:
   - **Name:** `le-homeserver-admin`
   - **Authorization flow:** Standard lassen
   - **Forward auth (single application)**
   - **External host:** `http://admin.homeserver`
4. **Fertigstellen**.
5. **Applications → Applications → Erstellen**:
   - **Name:** `Admin-Dashboard`, **Slug:** `le-homeserver-admin`
   - **Provider:** `le-homeserver-admin`
   - **Launch URL:** `http://admin.homeserver`
6. Speichern. Anschließend Application öffnen → Tab
   **Policy / Group / User Bindings → Bind existing group** →
   **authentik Admins** auswählen, **Order** auf `0` lassen. Damit kommen
   nur Mitglieder dieser Gruppe überhaupt am Forward-Auth-Check vorbei.

> Falls eine andere Gruppe als "authentik Admins" gewünscht ist: Gruppe in
> Authentik anlegen, hier binden, und denselben Namen in
> `argocd/apps/le-homeserver/values.yaml` unter `authentik.adminGroup`
> eintragen (muss exakt übereinstimmen, da die App diesen Header-Wert
> serverseitig vergleicht).

> **Migration von einem alten Setup mit `le.homeserver`:** den Provider
> `le-homeserver` und die Application `Einsatz-Dashboard` in Authentik
> löschen — beide werden nicht mehr benötigt, da es nur noch
> `admin.homeserver` gibt.

---

## 3. Grafana: Service-Account für Health-Check & Auslastung anlegen

Health-Status und die Auslastungs-Kacheln (CPU/RAM/Disk/Temperatur) auf
`admin.homeserver` werden über Grafanas Datasource-Proxy abgefragt
(Prometheus-kompatible `up`- und `node_exporter`-Metriken gegen die
VictoriaMetrics-Datasource) — derselbe Service-Account/Token wird für
beides genutzt.

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
dnsmasq hinterlegt (`docs/09-dns-architecture.md`) — für `admin.homeserver`
ist **keine** zusätzliche DNS-Änderung nötig.

---

## 6. Verifizierung

1. Browser → `http://admin.homeserver` als Mitglied von "authentik Admins"
   → Authentik-Login → Admin-Dashboard mit Auslastungs-Kacheln
   (CPU/RAM/Disk/Temperatur je Node) oben und App-Kacheln darunter;
   Health-Badges werden nach ein paar Sekunden grün/rot.
2. Browser → `http://admin.homeserver` als Nicht-Admin → 403-Seite
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

### Auslastungs-Kacheln bleiben leer ("Keine Live-Werte verfügbar")

`GET http://admin.homeserver/api/stats` direkt aufrufen (eingeloggt) und
das `error`-Feld prüfen — dieselben Ursachen wie bei den Health-Badges
(Token/`datasourceUid`). Zusätzlich:

- Es muss `node_exporter` (DaemonSet in `argocd/apps/monitoring`) auf dem
  jeweiligen Node laufen, sonst fehlen `node_cpu_seconds_total` /
  `node_memory_*` / `node_filesystem_*` / `node_hwmon_temp_celsius`.
- Eine Node-Kachel zeigt das rohe `instance`-Label statt eines Namens →
  IP in `grafana.nodeLabels` in `values.yaml` ergänzen.

### `admin.homeserver` zeigt Authentik-Login-Loop

Die `ingress-outpost`-Route fehlt oder zeigt auf den falschen Service —
prüfen, dass `authentik-server-alias` im Namespace `le-homeserver`
existiert (`kubectl -n le-homeserver get svc`).

### Pod zieht nicht das neue Image nach einem CI-Build

`latest` + `imagePullPolicy: Always` lädt erst beim nächsten Pod-Neustart
neu — siehe Befehl in Abschnitt 1.
