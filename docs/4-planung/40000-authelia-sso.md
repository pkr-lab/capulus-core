# Authelia als zentrale SSO-Instanz vor allen Apps mit Login

Architektur- und Rollout-Plan für einen zentralen Single-Sign-On-Layer via
[Authelia](https://www.authelia.com/) vor jeder App mit eigener Anmeldemaske.
Noch **nicht umgesetzt** — dieses Doc hält den recherchierten und mit dem
Nutzer abgestimmten Plan fest, bevor der erste Rollout-Batch beginnt. Sobald
Umsetzung + Verifikation abgeschlossen sind, wandert der Ist-Zustand als
eigenes Doc nach `d-sicherheit/` (analog zu den bestehenden Security-Docs),
dieses Planungsdoc bleibt als historischer Kontext bestehen.

---

## Ausgangslage

Jede App mit Anmeldemaske (Nextcloud, Immich, Wiki.js, Zammad, Mealie,
Paperless-ngx, Xibo, n8n, Uptime Kuma, Pihole, Grafana, Headlamp, Argo
Workflows, MinIO, kubeseal-webgui, Gotify, Semaphore, Vaultwarden) hat aktuell
ihren eigenen, unabhängigen Login. Es gibt **keine** zentrale Anmeldung —
jede App-Instanz verwaltet eigene Zugangsdaten, es gibt kein einheitliches
2FA und keinen zentralen Punkt, um z. B. bei Verdacht auf ein kompromittiertes
Passwort alle Zugänge auf einen Schlag zu sperren.

Ein zentraler SSO-Layer existierte bereits einmal: **Authentik**, aufgebaut
über mehrere PRs (`feat/sso-authentik` bis `feat/minio-oidc`), aber am
18.08.2026 komplett entfernt (`feat/remove-authentik`, Commit `1800642`). Die
Commit-Historie nennt keine dokumentierte Begründung ("Remove unused
Authentik...") — plausibel ist der Ressourcen-/Komplexitäts-Overhead eines
vollen Authentik+PostgreSQL-Stacks für einen Zwei-Node-Homelab-Cluster, in
dem aktuell ohnehin nur der `homeserver`-Node schedulebar ist (`worker-0`/
`worker-1` sind `NotReady`, nur bei Bedarf per WoL an). Das ist der zentrale
Designtreiber für diesen Plan: **Authelia statt Authentik**, weil Authelia
ein einzelnes, leichtgewichtiges Go-Binary ohne Pflicht-Datenbank ist (SQLite
+ file-basierte Nutzerverwaltung reichen), während die bewährten
Ingress-/Traefik-Middleware-Mechanismen von damals 1:1 wiederverwendet werden
können — sie sind nachweislich funktionsfähig in diesem Cluster (die
`Middleware`-CRD ist aktuell live registriert, `kubectl api-resources | grep
middleware`).

**Mit dem Nutzer abgestimmte Leitentscheidungen:**

- Authelia schützt **intern UND extern** (Cloudflare Tunnel) exponierte Apps.
- Der "Knopfdruck zur nativen Anmeldung" wird über einen **zweiten,
  ungeschützten Hostnamen pro App** (bewährtes Dual-Ingress-Muster, siehe
  Gotify/Semaphore) plus **einem generischen Link auf Authelias Login-Portal**
  zu einer zentralen Fallback-Übersichtsseite gelöst.
- Rollout **gestaffelt** (Pilot → Admin-Tools → Endnutzer-Apps), analog zur
  bereits bewährten Batch-Strategie beim NetworkPolicy-Rollout
  ([d0030-network-policies.md](../d-sicherheit/d0030-network-policies.md)).
- **2FA (TOTP) verpflichtend nur für Admin-/Infra-Tools**, Endnutzer-Apps
  laufen mit einfachem Passwort-Login über Authelia (`one_factor`).

---

## Zielarchitektur

```
Browser ──▶ Traefik (kube-system) ──▶ Middleware "authelia-authelia@kubernetescrd"
                                          │
                          nicht eingeloggt│eingeloggt
                                          ▼         ▼
                          Authelia-Portal      Ziel-App (Backend-Service)
                        (auth.tech.homeserver)
                                │
                    Login (Passwort [+TOTP bei Admin-Tools])
                                │
                    Link "Native Anmeldung stattdessen" ──▶ Fallback-Übersichtsseite
                                                              │
                                              <app>-native.<tier>.homeserver
                                                    (App-eigener Login, kein Authelia)
```

- **Authelia** läuft als neue Platform-App, genau eine Replica (Session-State
  ist lokal/dateibasiert — mehr als 1 Replica würde Sessions brechen; passt
  zur aktuellen Cluster-Realität mit nur einem schedulebaren Node).
- **Traefik ForwardAuth-Middleware** (`traefik.io/v1alpha1 Middleware`,
  identisches Muster wie das historische `authentik-authentik-forwardauth`)
  leitet jeden nicht authentifizierten Request an Authelias
  `/api/verify`-Endpoint um.
- **Zweiter Ingress pro geschützter App** (`<app>-native.<tier>.homeserver`,
  gleicher Backend-Service, keine Middleware-Annotation) — für native
  Mobile-/Desktop-Clients (Immich-App, Nextcloud-Sync) und als Ziel des
  Bypass-Buttons.
- **Fallback-Übersichtsseite**: eine neue, sehr kleine statische Wiki.js-Seite
  ("Dienste-Portal — native Logins"), die alle `-native`-URLs auflistet.
  Authelias Login-Portal bekommt über das offiziell unterstützte
  Custom-Theme/Custom-Assets-Feature (kein Eingriff in den Authelia-Kern)
  einen festen Link dorthin.

---

## Bausteine

### 1. Authelia als neue Platform-App

Neuer Chart-Ordner `argocd/apps/platform/authelia/` (Struktur analog zu
`argocd/apps/platform/gotify/`: `Chart.yaml`, `values.yaml`,
`templates/deployment.yaml`, `templates/service.yaml`,
`templates/ingress.yaml`, `templates/sealedsecret.yaml`).

| Aspekt | Entscheidung |
|---|---|
| Storage | SQLite (lokal, `local-path`-PVC, 1 Gi) — keine externe DB, kein Redis |
| Nutzerverwaltung | File-basierter `users_database.yml`-Provider, Argon2id-Hashes, als `SealedSecret` committed (gleiches Muster wie bei Vaultwarden) |
| 2FA | eingebautes TOTP, erzwungen nur für Admin-Tool-Regeln (siehe Baustein 4) |
| Hostnamen | `auth.tech.homeserver` (intern) und `auth-tech.pke-lab.de` (extern, über bestehenden `*.pke-lab.de`-Wildcard, kein neuer `cloudflared`-Schritt nötig) |
| TLS | `auth.tech.homeserver` als neuer Eintrag in `argocd/apps/platform/cert-manager/templates/certificate-homeserver-wildcard.yaml` → `dnsNames` |
| NetworkPolicy | `authelia` als neuer Eintrag in `argocd_platform_apps` + `argocd_network_policy_refined_namespaces` (`ansible/roles/argocd/defaults/main.yml`) — Traefik (`kube-system`) ist dort standardmäßig als Ingress-Quelle erlaubt |
| AppProject | `platform` (Identity-Layer, wie früher Authentik) |

### 2. Traefik-Middleware (ForwardAuth)

Neue `Middleware`-Ressource in `argocd/apps/platform/authelia/templates/`:

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: authelia
  namespace: authelia
spec:
  forwardAuth:
    address: "http://authelia.authelia.svc.cluster.local/api/verify?rd=https://auth.tech.homeserver/"
    trustForwardHeader: true
    authResponseHeaders:
      - Remote-User
      - Remote-Groups
      - Remote-Name
      - Remote-Email
```

Anwendung pro geschützter App über das bereits in jedem Chart vorhandene Feld
`ingress.annotations` (kein Chart-Umbau nötig, nur `values.yaml` ändern):

```yaml
ingress:
  annotations:
    traefik.ingress.kubernetes.io/router.middlewares: "authelia-authelia@kubernetescrd"
```

Identisches Annotation-Schema wie beim historischen
`authentik-authentik-forwardauth` (Referenz-Commits `0a58bdc`, `6dab1d6`) —
bewährter Mechanismus, kein neues Risiko.

### 3. Bypass-Ingress + Fallback-Seite ("Knopfdruck zur nativen Anmeldung")

Für jede zu schützende App (außer den in Baustein 5 ausgeschlossenen) ein
zweiter Ingress-Block nach dem bereits etablierten Gotify-Muster
(`argocd/apps/platform/gotify/values.yaml`, `ingressApi`):

```yaml
ingressNative:
  enabled: true
  host: <app>-native.<tier>.homeserver
```

Der zugehörige Chart-Template-Block ist pro Chart einmalig zu ergänzen
(gleiches Grundgerüst wie das bestehende `templates/ingress.yaml`, nur ohne
`router.middlewares`-Annotation) — als Vorlage dient
`argocd/apps/platform/gotify/templates/` (dort existiert der
`ingressApi`-Mechanismus bereits als Referenzimplementierung).

Neue, kleine Doc-Seite (automatisch per `wiki-docs-sync` nach Wiki.js
gespiegelt, siehe [d0071-native-login-fallback.md](../d-sicherheit/d0071-native-login-fallback.md))
mit einer Tabelle aller `-native`-URLs.

> **Korrektur nach Live-Recherche (21.08.2026):** Der ursprünglich geplante
> Footer-Link direkt auf Authelias Login-Seite (`theme: custom` +
> `asset_path`) ist **nicht umsetzbar wie angenommen** — Authelias offiziell
> dokumentierter Asset-Override-Mechanismus
> (`/reference/guides/server-asset-overrides/`) erlaubt ausschließlich
> `favicon.ico`, `logo.png` und Locale-Text-Overrides (JSON,
> Text-Strings ohne HTML). Ein echter klickbarer Link auf der Login-Seite
> selbst würde einen Fork/Rebuild des Authelia-Frontends erfordern — genau
> der "super schwere Workaround", den der Plan explizit vermeiden soll.
> **Der "Knopfdruck" funktioniert deshalb aktuell nur über die dedizierte
> `-native`-Hostnamen + die zentrale Übersichtsseite, nicht als Link
> innerhalb von Authelias eigener Login-Maske.** Falls das nicht ausreicht,
> müsste eine echte UI-Änderung her (z. B. ein eigener, Authelia
> vorgeschalteter Chooser — das würde aber pro App eine unauthentifizierte
> Zwischenseite bei JEDEM Besuch einbauen und widerspricht "Authelia ist die
> erste Wahl" aus der ursprünglichen Anfrage). Offener Punkt, siehe
> [d0070-authelia-sso.md](../d-sicherheit/d0070-authelia-sso.md).

### 4. Access-Control-Policy (Authelia `configuration.yml`)

```yaml
access_control:
  default_policy: deny
  rules:
    # Admin-/Infra-Tools — 2FA Pflicht
    - domain: ["headlamp.tech.homeserver", "argo-workflows.tech.homeserver",
               "minio.tech.homeserver", "kubeseal-webgui.tech.homeserver",
               "semaphore.tech.homeserver", "gotify.tech.homeserver"]
      policy: two_factor
    # Endnutzer-Apps — Passwort reicht
    - domain: ["wiki.prod.homeserver", "nextcloud.prod.homeserver",
               "immich.prod.homeserver", "mealie.prod.homeserver",
               "paperless.prod.homeserver", "xibo.prod.homeserver",
               "n8n.prod.homeserver", "uptime-kuma.prod.homeserver",
               "pihole.tech.homeserver", "grafana.tech.homeserver"]
      policy: one_factor
```

Domain-Listen werden pro Rollout-Batch erweitert (siehe Baustein 7) — nicht
alles auf einmal eintragen.

### 5. Ausgeschlossene Apps (bewusst kein Authelia)

| App | Grund |
|---|---|
| **Vaultwarden** | bereits dokumentierte, bestehende Entscheidung — Bitwarden-Clients sprechen die API direkt an, ein Redirect bricht Login/Sync ([300a0-vaultwarden.md](../3-apps-workloads/300a0-vaultwarden.md)). Unverändert lassen. |
| **Pacman** | öffentliches, absichtlich anmeldefreies Spiel ([300f0-pacman-visitor-tracking.md](../3-apps-workloads/300f0-pacman-visitor-tracking.md)) — ein Login-Wall widerspricht dem Zweck. Separater, von diesem Plan unabhängiger Hinweis: `trainingMode.enabled: true` steht aktuell live im committeten `values.yaml` für die öffentliche Prod-Instanz — laut eigenem Doku-Kommentar dort nur für die Dauer einer Unterrichtsstunde gedacht, lohnt sich unabhängig zu prüfen. |
| **MediaMTX** | eigene HTTP-Basic-Auth für HLS-Viewer, RTMP/RTSP-Publisher brauchen Stream-URL-Auth ohne Browser-Redirect-Fähigkeit — ForwardAuth würde Publisher-Clients brechen. Bleibt wie dokumentiert ("kein IdP nötig"). |
| **Semaphore-/Gotify-API-Ingress** | bereits bestehende `ingressApi`-Hosts für maschinelle Zugriffe (Ansible-Bootstrap, iOS-App) — bleiben unangetastet, bekommen keine Middleware (unabhängig vom neuen `-native`-Bypass für die Haupt-App). |

### 6. Cloudflare Access — Ablösung statt Doppel-Login

[e0000-cloudflare-tunnel.md](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md)
empfiehlt aktuell Cloudflare Access als Zusatzschutz für extern exponierte
Apps (Grafana, Zammad, Wiki.js). Da Authelia jetzt intern **und** extern vor
diesen Apps steht, würde eine zusätzliche Cloudflare-Access-Policy zu
doppeltem Login führen. **Entscheidung:** Für Apps, die Authelia bekommen,
Cloudflare Access **nicht** parallel aktivieren (bzw. bestehende Policies wie
die für Grafana dokumentierte deaktivieren) — Authelia übernimmt die Rolle
vollständig. Der entsprechende Abschnitt in `e0000-cloudflare-tunnel.md` wird
bei der Umsetzung aktualisiert.

### 7. Rollout-Batches (gestaffelt, mit Verifikation dazwischen)

1. **Pilot:** Authelia deployen, Middleware anlegen, gegen **eine**
   unkritische App testen (z. B. Uptime Kuma) — kompletten Flow inkl.
   Bypass-Ingress und Fallback-Link end-to-end prüfen, bevor es weitergeht.
2. **Admin-Tools** (`two_factor`): Headlamp, Argo Workflows, MinIO,
   kubeseal-webgui, Semaphore (nur Haupt-Host), Gotify (nur Haupt-Host).
3. **Endnutzer-Apps, nur intern zunächst** (`one_factor`): Wiki.js, Mealie,
   Paperless-ngx, Xibo, n8n, Pihole, Grafana, Zammad.
4. **Endnutzer-Apps mit externen/mobilen Clients** (`one_factor` + zwingend
   Bypass-Ingress, sonst brechen Mobile-Apps): Nextcloud, Immich.
5. **Extern exponierte Hosts auf Cloudflare-Ebene** nachziehen (Baustein 6) —
   erst nachdem Schritt 3/4 intern verifiziert sind.

### 8. Dokumentation bei Umsetzung

- Neue Seite `d-sicherheit/d0070-authelia-sso.md` (Architektur, Setup,
  Access-Control-Regeln, Rollout-Log — Aufbau analog zur wiederherstellbaren
  alten `docs/16-sso-alle-dienste.md`, aber für Authelia statt Authentik).
- Neue Phase 8 in
  [d0010-security-hardening-roadmap.md](../d-sicherheit/d0010-security-hardening-roadmap.md).
- [e0000-cloudflare-tunnel.md](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md)
  anpassen (Baustein 6).
- Pro geänderter App: kurzer Absatz in der jeweiligen
  `3-apps-workloads/*.md`, dass sie jetzt hinter Authelia liegt +
  `-native`-Fallback-URL nennen (bestehende Konvention, siehe
  [300a0-vaultwarden.md](../3-apps-workloads/300a0-vaultwarden.md) als
  Beispiel für den gegenteiligen Fall).

---

## Verifikation

- `curl -sI https://<app>.tier.homeserver` → erwartet `302` Richtung
  `auth.tech.homeserver`.
- `curl -sI https://<app>-native.tier.homeserver` → erwartet direktes `200`
  von der App, kein Redirect.
- Browser-Test des kompletten Login-Flows (inkl. TOTP-Enrollment) für die
  Pilot-App vor jedem weiteren Batch.
- Mobile-Client-Test (Immich-App, Nextcloud-Sync-Client) explizit gegen die
  `-native`-Hosts, bevor Batch 4 als abgeschlossen gilt.
- `kubectl -n authelia logs` und Grafana/VictoriaLogs auf Fehlversuche prüfen
  (CrowdSec-Integration wie bei Phase 1 der bestehenden Security-Roadmap
  spätestens hier mitdenken, aktuell nicht Teil dieses Plans).
