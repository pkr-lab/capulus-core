# Authentik als zentraler SSO-Layer via IaC — Ablösung von Authelia

Architektur- und Rollout-Plan für die Einführung von
[Authentik](https://goauthentik.io/) als zentralen SSO/Identity-Provider vor
allen Apps mit eigener Anmeldemaske, LDAP-backed gegen das bestehende
`lldap`, komplett über Infrastructure-as-Code gesteuert. Noch **nicht
umgesetzt** — dieses Doc hält den recherchierten und mit dem Nutzer
abgestimmten Plan fest, bevor der erste Rollout-Batch beginnt. Sobald
Umsetzung + Verifikation abgeschlossen sind, wandert der Ist-Zustand als
eigenes Doc nach `d-sicherheit/d0073-authentik-sso.md`, dieses Planungsdoc
bleibt als historischer Kontext bestehen (Konvention analog zu
[40000-authelia-sso.md](40000-authelia-sso.md)).

---

## Ausgangslage

Ein zentraler SSO-Layer existiert bereits — **Authelia**, live seit dem
22.08.2026, LDAP-backed gegen `lldap`, mit TOTP-Pflicht für Admin-Tools und
gestaffeltem Rollout ([40000-authelia-sso.md](40000-authelia-sso.md),
[d0070-authelia-sso.md](../d-sicherheit/d0070-authelia-sso.md)). Authelia
selbst ist der **Ersatz** für eine erste, umfangreiche Authentik-Runde:
aufgebaut über rund 25 Commits/PRs (`feat/sso-authentik` bis
`feat/minio-oidc`, u. a. OIDC-Integrationen für Headlamp (`08b8107`), Argo
Workflows (`8f6380d`), MinIO (`325e488`), Grafana-OAuth2 (`94a922b`),
Traefik-ForwardAuth für Gotify/Semaphore (`6dab1d6`, `0a58bdc`) und sogar
mTLS-Zertifikats-Login (`044c48e`, `ccc9202`)) — und am **18.08.2026
komplett entfernt** (`feat/remove-authentik`, Commit `1800642`).

Die Commit-Historie nennt keine offizielle Begründung für die Entfernung,
aber zwei konkrete, dokumentierte Probleme sind nachvollziehbar:

- **Ressourcenverbrauch durch den Bitnami-PostgreSQL-Subchart.** Das
  historische Setup bettete die vollständige Bitnami-`postgresql`-Subchart
  ein (Commit `1800642` löscht allein dafür ~40 Dateien: StatefulSet mit
  Read-Replica-Support, Backup-CronJob, PodDisruptionBudget,
  ServiceMonitor, NetworkPolicy je Rolle usw.) — deutlich mehr
  Infrastruktur, als ein Ein-Node-Homelab-Cluster braucht, in dem ohnehin
  nur der `homeserver`-Node durchgängig schedulebar ist (`worker-0`/
  `worker-1` sind `NotReady`, nur bei Bedarf per WoL an).
- **OOMKilled-Worker.** Commit `983e338` musste das Worker-Memory-Limit
  nachträglich auf 512Mi anheben, weil der Worker-Pod mit den
  ursprünglichen Limits abstürzte — ein Muster, das im aktuellen Plan aktiv
  vermieden werden soll, nicht erst nach einem Vorfall gefixt.

**Mit dem Nutzer abgestimmte Leitentscheidung:** Trotz dieser Vorgeschichte
soll **Authentik jetzt bewusst Authelia vollständig ablösen** — nicht
parallel als Dauerzustand, sondern als geplanter Cutover. Die aus der ersten
Runde gelernten Lektionen (kein schwerer Postgres-Subchart, korrektes
Resource-Sizing, ServiceMonitor-CRD ist in diesem Cluster nicht installiert)
fließen direkt in die neue Architektur ein, statt wiederholt zu werden.
Weitere Leitentscheidungen:

- TOTP-2FA-Pflicht nur für Admin-/Infra-Tools (identische Abgrenzung wie
  aktuell bei Authelia), Endnutzer-Apps laufen mit Passwort-Login.
- Rollout **gestaffelt**, Authelia bleibt während aller Batches als
  Fallback aktiv und wird erst nach vollständiger Verifikation
  zurückgebaut — kein Big-Bang-Cutover.
- OIDC als primäres Protokoll (siehe Machbarkeits-Analyse).

---

## 1. Machbarkeits-Analyse

| Frage | Antwort | Begründung |
|---|---|---|
| Funktioniert Authentik mit dem bestehenden LDAP? | **Ja** | `lldap` bleibt die einzige Nutzerquelle. Authentik bindet als **LDAP Source** dagegen (nicht als "LDAP-Provider" — diese Rolle wäre umgekehrt: Authentik würde selbst LDAP nach außen anbieten, was hier nicht gebraucht wird, da `lldap` bereits der LDAP-Server ist). Service-Account nach demselben Muster wie `authelia-bind`: neuer User `authentik-bind` in der eingebauten Gruppe `lldap_strict_readonly` (Least Privilege), Passwort als SealedSecret dupliziert in den `authentik`-Namespace (siehe [d0072-lldap.md](../d-sicherheit/d0072-lldap.md) für das exakte Vorgehen). |
| Kann man Authentik komplett via IaC steuern? | **Überwiegend ja** | Authentik **Blueprints** (natives YAML-Feature) bilden Flows, Stages, Policies, Providers, Applications, Groups und Brand-Einstellungen deklarativ ab, versioniert in Git, beim Start automatisch angewendet. Rest-UI-Bedarf: einmaliger Bootstrap-Login und gelegentliche manuelle Diagnose — exakt wie bei Authelia/lldap auch, kein Sonderfall. |
| Welche IaC-Tools sind sinnvoll? | **Helm + ArgoCD + SealedSecrets + Blueprints** | Kein Terraform. Das Repo nutzt durchgängig Helm-Wrapper-Charts + ArgoCD (App-of-Apps) + SealedSecrets, ohne Terraform-State-Backend irgendwo. Ein Terraform-Provider nur für Authentik-Objektverwaltung würde ein komplett neues Tool samt Remote-State-Frage einführen, für das Blueprints bereits die native, git-basierte Alternative sind. |
| Welche Authentik-Version? | **Selbstgehostet, aktuelle stabile Version** | Kein Managed-Service — passt nicht zur Self-Hosted-Philosophie des restlichen Repos (lldap, Authelia, Vaultwarden etc. laufen alle selbstgehostet im eigenen Cluster). |

**Explizite Abkehr vom historischen Setup:** Kein Bitnami-PostgreSQL-Subchart
mehr. Stattdessen ein handgerolltes, leichtgewichtiges Postgres-Deployment
nach dem im Repo bereits etablierten Muster für App-eigene Datenbanken
(`argocd/apps/workloads/{wikijs,nextcloud,immich}/templates/postgres-
{deployment,service,pvc}.yaml`) — ein Pod, eine PVC, keine
Replikations-/Backup-Automatik der Subchart, dafür ein eigener, einfacher
`pg_dump`-CronJob (siehe Baustein 6).

---

## 2. Zielarchitektur

```
lldap (bestehend) ──▶ Authentik LDAP Source
                          │
                    Server + Worker + Postgres (leichtgewichtig, eigenes Deployment)
                          │
        ┌─────────────────┴─────────────────┐
        │                                     │
  App mit nativem OIDC                  App ohne natives OIDC
  (Headlamp, Grafana,                   (Gotify, Semaphore, …)
   MinIO, Argo Workflows)                     │
        │                              Proxy Provider + Embedded Outpost
  OAuth2Provider (Blueprint)                   │
        │                          Traefik Middleware "authentik-forwardauth"
        ▼                                      ▼
   Redirect zu Authentik-Login (Passwort [+ TOTP bei Admin-Tools])
                          │
                  Ziel-App nach erfolgreichem Login
```

- **Direkter OIDC-Provider** für Apps mit nativer OIDC-Unterstützung —
  historisch bereits funktionierende Configs als Referenz (Headlamp
  `08b8107`, Argo Workflows `8f6380d`, MinIO `325e488`, Grafana `94a922b`).
  Kein Outpost nötig, die App validiert das Token selbst.
- **Proxy Provider + Embedded Outpost + Traefik-ForwardAuth-Middleware** für
  Apps ohne native OIDC-Unterstützung — identisches Muster wie historisch
  `authentik-authentik-forwardauth` (Commits `0a58bdc`, `6dab1d6`), das
  Authelia im aktuellen Setup 1:1 weiterverwendet
  (`authelia-{prod,tech,external}`-Middleware je Tier). Dieselbe
  Middleware-CRD ist im Cluster live registriert, kein neues Risiko.
- **OIDC statt SAML:** Alle betroffenen Apps (Headlamp, Grafana, MinIO, Argo
  Workflows, Nextcloud, Immich, Wiki.js, Zammad, Mealie, Paperless-ngx,
  Xibo, n8n, Uptime Kuma, Pihole) unterstützen OIDC nativ oder über
  ForwardAuth — SAML wird nirgends benötigt. SAML bleibt als
  Authentik-Fähigkeit für einen etwaigen künftigen Enterprise-/Legacy-Fall
  im Hinterkopf, ist aber kein Bestandteil dieses Plans.
- **SSO-Logout:** Front-/Back-Channel-Logout-Unterstützung ist pro App
  unterschiedlich und muss real getestet werden (Authentik unterstützt
  RP-initiated Logout, aber ob eine App den `end_session_endpoint`
  tatsächlich aufruft, hängt vom App-seitigen OIDC-Client ab). **Offener
  Verifikationspunkt** — nicht als gelöst annehmen, siehe Baustein 7 /
  Verifikation.
- **Session-Cookie-Domain:** Authelia musste wegen der Single-Label-
  Fake-TLD `homeserver` (kein Punkt, Cookie-Domain-Validierung schlägt
  sonst fehl) auf getrennte Cookie-Scopes pro Tier ausweichen
  (`tech.homeserver`/`prod.homeserver`, siehe `40000`, Baustein 1). Ob
  Authentik dieselbe Einschränkung hat, muss vor dem Pilot-Batch geprüft
  werden (Baustein 7).

---

## 3. Bausteine

### 1. Authentik als neue Platform-App

Neuer Chart-Ordner `argocd/apps/platform/authentik/` (Struktur analog zu
`argocd/apps/platform/authelia/`: `Chart.yaml`, `values.yaml`,
`templates/{deployment,service,ingress,sealedsecret,vmservicescrape}.yaml`
plus eigene `templates/postgres-{deployment,service,pvc}.yaml`).

| Aspekt | Entscheidung |
|---|---|
| Storage (App) | Leichtgewichtiges, handgerolltes Postgres-Deployment (`local-path`-PVC), **kein** Bitnami-Subchart — Muster wie `wikijs`/`nextcloud`/`immich` |
| Nutzerverwaltung | LDAP Source gegen `lldap`, kein eigener File-Provider |
| 2FA | eingebautes TOTP + Backup-Codes, erzwungen über Blueprint-Policy auf der Admin-Gruppe (siehe Baustein 5) |
| Secrets | `secret_key`, `db_password`, `bootstrap_password`, `bootstrap_email` als SealedSecret — identisches Schema wie historisch (`authentik-credentials`) |
| Hostnamen | `authentik.tech.homeserver` (intern) — externe Exposition erst mit Batch 5 (Cloudflare) |
| NetworkPolicy | `authentik` als neuer Eintrag in `argocd_platform_apps` + `argocd_network_policy_refined_namespaces` (`ansible/roles/argocd/defaults/main.yml`) |
| AppProject | `platform` (Identity-Layer, wie zuvor Authelia/Authentik) |
| Replicas / HPA | `replicaCount: 1`, Autoscaling deaktiviert — identische Begründung wie historisch und wie bei Authelia: Ein-Node-Cluster, mehr Replicas bringen keine Ausfallsicherheit, nur zusätzlichen RAM-Verbrauch |

### 2. Ressourcen-Sizing

Historisch validierte Werte (letzter Stand vor der Entfernung, inklusive
des 2026 gefixten Worker-OOM) als Startpunkt übernehmen:

| Komponente | Request | Limit |
|---|---|---|
| Server | 100m CPU / 512Mi RAM | 768Mi RAM |
| Worker | 50m CPU / 384Mi RAM | 768Mi RAM |
| Postgres (neu, leichtgewicht) | ~50m CPU / 128Mi RAM | 256Mi RAM |

**Vor dem ersten Rollout-Batch zwingend:** `kubectl describe node
homeserver` gegen das Gesamtbudget prüfen — Authelia, lldap und deren
Postgres laufen zu diesem Zeitpunkt noch parallel auf demselben Node. Erst
nach bestätigtem Headroom starten, um den historischen OOM-Fehler nicht zu
wiederholen.

### 3. Monitoring

- Handgeschriebene `VMServiceScrape` statt `serviceMonitor.enabled: true`
  im Authentik-Chart — die `ServiceMonitor`-CRD (`monitoring.coreos.com/v1`)
  ist in diesem Cluster nicht installiert, nur VictoriaMetrics-CRDs
  (identische Lehre wie historisch bereits in der alten `values.yaml`
  dokumentiert, hier von Anfang an richtig statt nachträglich gefixt).
- Grafana-Dashboard unter `argocd/apps/platform/monitoring/templates/`.
- **Neu gegenüber der ersten Runde:** `VMRule`-Alert, der auf Worker-
  Memory-Nutzung nahe dem Limit anschlägt, *bevor* ein OOMKill passiert —
  aktive Vorbeugung statt reaktivem Fix wie bei `983e338`.

### 4. IaC-Beispiel A — Helm-Wrapper `values.yaml` (Skelett)

```yaml
# argocd/apps/platform/authentik/values.yaml
credentials:
  enabled: true
  secretName: authentik-credentials
  # kubeseal --raw --namespace authentik --name authentik-credentials ...
  encryptedSecretKey: "AgC..."
  encryptedDbPassword: "AgC..."
  encryptedBootstrapPassword: "AgC..."
  encryptedBootstrapEmail: "AgC..."

authentik:
  authentik:
    error_reporting:
      enabled: false
    avatars: "none"
    log_level: info
    postgresql:
      host: "authentik-postgres"   # eigenes leichtgewichtiges Deployment, kein Subchart
      name: authentik
      user: authentik

  global:
    env:
      - name: AUTHENTIK_SECRET_KEY
        valueFrom:
          secretKeyRef: { name: authentik-credentials, key: secret_key }
      - name: AUTHENTIK_POSTGRESQL__PASSWORD
        valueFrom:
          secretKeyRef: { name: authentik-credentials, key: db_password }
      - name: AUTHENTIK_BOOTSTRAP_PASSWORD
        valueFrom:
          secretKeyRef: { name: authentik-credentials, key: bootstrap_password }
      - name: AUTHENTIK_BOOTSTRAP_EMAIL
        valueFrom:
          secretKeyRef: { name: authentik-credentials, key: bootstrap_email }

  server:
    replicas: 1
    autoscaling:
      enabled: false
    resources:
      requests: { cpu: 100m, memory: 512Mi }
      limits: { memory: 768Mi }
    ingress:
      enabled: true
      ingressClassName: traefik
      hosts: ["authentik.tech.homeserver"]
    metrics:
      enabled: true
      serviceMonitor:
        enabled: false   # eigene VMServiceScrape statt ServiceMonitor-CRD

  worker:
    replicas: 1
    autoscaling:
      enabled: false
    resources:
      requests: { cpu: 50m, memory: 384Mi }
      limits: { memory: 768Mi }

  postgresql:
    enabled: false   # bewusst deaktiviert — eigenes leichtgewichtiges Deployment statt Bitnami-Subchart

  blueprints:
    configMap: authentik-blueprints   # siehe Variante B
```

Das eigene Postgres-Deployment (`templates/postgres-{deployment,service,
pvc}.yaml`) folgt 1:1 dem Muster aus `argocd/apps/workloads/wikijs/
templates/postgres-deployment.yaml`.

### 5. IaC-Beispiel B — Blueprint: TOTP-Pflicht + OIDC-Provider

```yaml
# argocd/apps/platform/authentik/blueprints/admin-2fa-and-grafana.yaml
version: 1
metadata:
  name: admin-2fa-and-grafana
entries:
  # TOTP verpflichtend für die Admin-Gruppe
  - model: authentik_stages_authenticator_totp.authenticatortotpstage
    id: totp-stage
    identifiers:
      name: default-authenticator-totp-setup
    attrs:
      digits: 6

  - model: authentik_policies_expression.expressionpolicy
    id: require-2fa-admins-policy
    identifiers:
      name: require-2fa-for-admins
    attrs:
      expression: |
        return ak_is_group_member(request.user, name="admins")

  - model: authentik_flows.flowstagebinding
    identifiers:
      target: !KeyOf default-authentication-flow
      stage: !KeyOf totp-stage
      order: 30
    attrs:
      policy_engine_mode: any
    # policy-binding referenziert require-2fa-admins-policy analog zur
    # bestehenden Authelia access_control-Logik (nur Admin-Gruppe erzwingt 2FA)

  # OIDC-Provider + Application für Grafana
  - model: authentik_providers_oauth2.oauth2provider
    id: grafana-provider
    identifiers:
      name: grafana
    attrs:
      client_type: confidential
      redirect_uris: "https://grafana.tech.homeserver/login/generic_oauth"
      signing_key: !Find [authentik_crypto.certificatekeypair, [name, "authentik Self-signed Certificate"]]

  - model: authentik_core.application
    identifiers:
      slug: grafana
    attrs:
      name: Grafana
      provider: !KeyOf grafana-provider
```

Analoge Blueprint-Dateien entstehen pro Rollout-Batch (Baustein 6) — nicht
alles auf einmal, sondern batchweise erweitert wie bisher bei Authelias
`access_control`-Regeln.

### 6. Backup & Rollback

| Aspekt | Entscheidung |
|---|---|
| Config-Backup | Blueprints sind bereits über Git versioniert — vollständige Config-Wiederherstellung aus dem Repo |
| Daten-Backup | Eigener `pg_dump`-CronJob fürs Authentik-Postgres — Nutzer-Sessions, Self-Service-Daten und Laufzeitstate liegen in der DB, nicht in den Blueprints |
| Rollback-Strategie | Authelia-Manifeste bleiben während der gesamten Rollout-Phase **unangetastet im Repo** und laufen parallel weiter — kein Rückbau vor vollständiger Verifikation aller Batches (siehe Baustein 7, letzter Schritt) |

---

## 4. Schritt-für-Schritt-Rollout

Authelia bleibt bis zum letzten Schritt aktiv als Fallback — kein
Big-Bang-Cutover.

1. **Vorbereitung:** Blueprints-Grundgerüst anlegen, leichtgewichtiges
   Postgres deployen, Secrets versiegeln, LDAP Source gegen `lldap`
   verifizieren (`ldapsearch`, analog [d0072-lldap.md](../d-sicherheit/d0072-lldap.md)),
   Session-Cookie-Domain-Verhalten gegen die Single-Label-Fake-TLD
   `homeserver` prüfen.
2. **Pilot:** Authentik gegen **eine** unkritische App **zusätzlich** zu
   Authelia betreiben (kein Cutover) — kompletten Flow inkl. Login, Logout
   und TOTP-Enrollment end-to-end prüfen, bevor es weitergeht.
3. **Admin-Tools** (TOTP-Pflicht via Blueprint-Policy): Headlamp, Argo
   Workflows, MinIO, kubeseal-webgui, Semaphore, Gotify — dieselbe
   App-Liste wie beim historischen Authelia-Rollout.
4. **Endnutzer-Apps, nur intern zunächst:** Wiki.js, Mealie, Paperless-ngx,
   Xibo, n8n, Pihole, Grafana, Zammad.
5. **Endnutzer-Apps mit externen/mobilen Clients:** Nextcloud, Immich —
   Native-Client-Test zwingend vor Abschluss (der OIDC-Redirect-Flow bei
   mobilen Apps war historisch bereits ein dokumentierter Stolperstein,
   Commit `d9a3965`).
6. **Cloudflare-Ebene nachziehen** — Ablösungslogik identisch zu Authelia
   (`40000`, Baustein 6): kein doppeltes Login für extern exponierte Apps.
7. **Authelia-Rückbau** — erst nachdem alle Batches über einen
   Beobachtungszeitraum stabil liefen. Reihenfolge spiegelbildlich zu
   Commit `1800642`: Middleware-Annotationen aus den App-`values.yaml`
   entfernen, Authelia-Chart + SealedSecrets löschen, Einträge aus
   `argocd_platform_apps` entfernen, `lldap`-Bind-Account `authelia-bind`
   löschen (`authentik-bind` übernimmt die Rolle dauerhaft).

---

## 5. Checkliste fehlender Komponenten

- [ ] **Dokumentation:** Neue Seite `d-sicherheit/d0073-authentik-sso.md`
      (Architektur, Setup, Rollout-Log — Aufbau analog
      [d0070-authelia-sso.md](../d-sicherheit/d0070-authelia-sso.md)); neue
      Phase in
      [d0010-security-hardening-roadmap.md](../d-sicherheit/d0010-security-hardening-roadmap.md);
      pro geänderter App ein kurzer Absatz in der jeweiligen
      `3-apps-workloads/*.md` (Konvention siehe
      [300a0-vaultwarden.md](../3-apps-workloads/300a0-vaultwarden.md)).
- [ ] **Rollback-Strategie:** siehe Baustein 6 — Authelia bleibt bis zur
      vollständigen Verifikation als Fallback im Repo.
- [ ] **Backup der Konfiguration:** Blueprints in Git (Config) + `pg_dump`-
      CronJob (Laufzeitdaten) — beides zusammen ergibt vollständige DR.
- [ ] **Secrets-Management:** SealedSecrets-Schema wie historisch
      (`secret_key`, `db_password`, `bootstrap_password`,
      `bootstrap_email`), keine neuen Tools nötig.
- [ ] **Monitoring/Logging:** VMServiceScrape (kein ServiceMonitor-CRD),
      Grafana-Dashboard, VMRule-Alert auf Worker-Memory nahe Limit,
      VictoriaLogs für Log-Aggregation (automatisch per Collector,
      kein App-spezifisches Setup nötig).
- [ ] **Ressourcen-Budget-Check** vor dem ersten Rollout-Batch
      (`kubectl describe node homeserver`).
- [ ] **Session-Cookie-Domain-Check** vor dem Pilot-Batch (Single-Label-
      Fake-TLD-Problematik wie bei Authelia).
- [ ] **SSO-Logout-Verifikation** pro App (Front-/Back-Channel-Logout ist
      kein Selbstläufer, siehe Zielarchitektur).
- [ ] **ArgoCD-Registry:** `authentik` in `argocd_platform_apps` +
      `argocd_network_policy_refined_namespaces`
      (`ansible/roles/argocd/defaults/main.yml`) eintragen.

---

## Verifikation

- `curl -sI https://<app>.tier.homeserver` → erwartet `302` Richtung
  `authentik.tech.homeserver`.
- Browser-Test des kompletten Login-Flows (inkl. TOTP-Enrollment) für die
  Pilot-App vor jedem weiteren Batch.
- Mobile-Client-Test (Immich-App, Nextcloud-Sync-Client) explizit vor
  Abschluss von Batch 5.
- Logout-Test pro App: nach Klick auf "Logout" in Authentik prüfen, ob die
  App-Session tatsächlich beendet wird (nicht nur Authentiks eigene).
- `kubectl -n authentik logs` und Grafana/VictoriaLogs auf Fehlversuche
  **und** auf Speicherverbrauch nahe dem Worker-Limit prüfen (aktive
  OOM-Vorbeugung, nicht erst nach einem Absturz).
- Vor dem finalen Authelia-Rückbau: alle Batches mindestens eine
  Beobachtungsperiode stabil ohne Incident.
