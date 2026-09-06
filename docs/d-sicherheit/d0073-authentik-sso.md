# Authentik — Zentrale SSO-/2FA-Instanz

[Authentik](https://goauthentik.io/) läuft als neue Platform-App
(`argocd/apps/platform/authentik/`) und schützt jede App mit eigener
Anmeldemaske per Traefik-ForwardAuth — Ablösung von Authelia.
Architektur-Begründung, Leitentscheidungen und der komplette Rollout-Plan
stehen in
[docs/4-planung/40070-authentik-sso-iac.md](../4-planung/40070-authentik-sso-iac.md).
Dieses Doc ist der Ist-Zustand-/Runbook-Teil. Für das Hinzufügen neuer Apps
oder Nutzer siehe das separate Cookbook:
[d0074-authentik-iac-cookbook.md](d0074-authentik-iac-cookbook.md).

---

## Architektur

```
Browser ──▶ Traefik (kube-system) ──▶ Middleware "authentik-authentik@kubernetescrd"
                                          │
                          nicht eingeloggt│eingeloggt
                                          ▼         ▼
                          Authentik-Portal      Ziel-App (Backend-Service)
                       (authentik.tech.homeserver)
```

- **Storage:** eigenes, leichtgewichtiges Postgres-Deployment (kein
  Bitnami-Subchart, siehe 40070 → Ausgangslage), `local-path`-PVC (2 Gi).
  Kein Redis — Authentik läuft mit einer Server-Replica ohne Pflicht-Redis.
- **Nutzerquelle:** [lldap](d0072-lldap.md) per LDAP Source, Bind als
  `authentik-bind` (Gruppe `lldap_strict_readonly`).
- **Zwei Hostnamen** (im Unterschied zur ursprünglichen Planung in 40070,
  die nur einen internen Host vorsah): `authentik.tech.homeserver` (intern)
  **und** `authentik-tech.pke-lab.de` (extern, Bindestrich statt Punkt,
  siehe [c0040-domain-tiers.md](../c-netzwerk-dns/c0040-domain-tiers.md)).
  Der externe Host ist **nicht optional** — Mealie ist auch extern
  geschützt (`mealie-prod.pke-lab.de`), ein von dort zum Login
  redirecteter Browser muss Authentik erreichen können. Kein
  Tier-spezifisches Cookie-Domain-Problem wie bei Authelia bekannt (vor dem
  ersten produktiven Login trotzdem einmal browserseitig verifizieren,
  siehe Verifikation unten).
- **ForwardAuth:** eine einzige gemeinsame Traefik-Middleware für alle
  Tiers (`templates/middleware.yaml`) — Authentiks eingebetteter Outpost
  berechnet die Rückkehr-URL dynamisch aus `X-Forwarded-Host`/`-Proto`,
  kein statischer `rd=`-Parameter wie bei Authelia nötig, also keine
  Redirect-Loop-Falle zwischen Tiers.
- **Blueprints:** komplette Konfiguration (LDAP Source, Policies,
  Provider/Application pro App) liegt als YAML unter
  `argocd/apps/platform/authentik/blueprints/`, gemountet als ConfigMap,
  von Authentik beim Start automatisch angewendet. Siehe
  [d0074-authentik-iac-cookbook.md](d0074-authentik-iac-cookbook.md).

---

## Setup (bereits erledigt / vom Nutzer freizugeben)

1. Chart erstellt (`argocd/apps/platform/authentik/`), Secrets generiert
   (`openssl rand`) und mit `kubeseal --raw --namespace authentik --name
   authentik-credentials` versiegelt: `secret-key`, `db-password`,
   `bootstrap-password`, `bootstrap-email`, `ldap-bind-password`.
   Bootstrap-Admin-Zugang (`akadmin` / einmalig im Chat mitgeteiltes
   Passwort) — **sofort nach dem ersten Login ändern**, analog zum
   lldap-root-Passwort.
2. Zweiter, identischer `ldap-bind-password`-Wert zusätzlich als
   `authentik-bind-password` in `lldap-secrets` versiegelt (Muster wie
   zuvor bei `authelia-bind`, siehe [d0072-lldap.md](d0072-lldap.md)) —
   **der Service-Account `authentik-bind` muss aber noch manuell in lldaps
   Web-UI angelegt werden**, siehe d0072 → Abschnitt 2.3. Ohne diesen
   Schritt schlägt die LDAP-Source-Synchronisierung fehl.
3. `authentik.tech.homeserver` in
   `argocd/apps/platform/cert-manager/templates/certificate-homeserver-wildcard.yaml`
   ergänzt (ersetzt die zwei Authelia-Hostnamen `auth.tech.homeserver`/
   `auth.prod.homeserver`). `authentik-tech.pke-lab.de` braucht **keinen**
   eigenen Eintrag dort — externe Hosts laufen über Cloudflares eigenes
   Wildcard-Zertifikat für `*.pke-lab.de`, nicht über die interne CA.
4. `authentik` als neuer Namespace in
   `ansible/roles/argocd/defaults/main.yml` (`argocd_platform_apps` +
   `argocd_network_policy_refined_namespaces` + `argocd_network_policy_extra_ingress.lldap`)
   ergänzt, `authelia` dort entfernt.
5. `authelia`-Chart komplett gelöscht
   (`argocd/apps/platform/authelia/`), Middleware-Referenzen in
   `mealie`/`uptime-kuma` auf `authentik-authentik@kubernetescrd`
   umgestellt.

**Noch offen (vom Nutzer vor dem ersten `make argocd`-Lauf zu erledigen):**

- [ ] `authentik-bind`-Account in lldaps Web-UI anlegen (d0072 → 2.3).
- [ ] `kubectl describe node homeserver` gegen das aktuelle
      Ressourcenbudget prüfen (40070 → Baustein 2).
- [ ] Aktuellste stabile Authentik-Version gegen
      `Chart.yaml`/`values.yaml` → `image.tag` prüfen (TODO-Kommentar dort).
- [ ] Blueprints (`blueprints/*.yaml`) gegen die tatsächlich deployte
      Authentik-Version validieren — Feldnamen/Modelle wurden recherchiert,
      aber nicht gegen eine echte Instanz getestet (siehe Hinweis in jeder
      Blueprint-Datei).
- [ ] Nach erfolgreichem Pilot: `authelia-bind` aus lldap löschen +
      `bind-password`-Key aus `lldap-secrets` entfernen (d0072 → 2.3).

---

## Nutzerverwaltung

Identisch zum bisherigen lldap-Workflow (siehe
[d0072-lldap.md](d0072-lldap.md)) — Authentik synchronisiert Nutzer/Gruppen
periodisch aus lldap über die LDAP Source, keine eigene Nutzerverwaltung in
Authentik nötig. Neue Person = neuer lldap-User + ggf. Gruppenzuweisung,
kein Authentik-seitiger Schritt.

---

## Access-Control (aktueller Stand)

| App | Policy | Zugriff |
|---|---|---|
| Uptime Kuma (`uptime-kuma.prod.homeserver`) | `admins`-Gruppe | Vollzugriff, nur intern, 2FA Pflicht (Gruppen-Policy) |
| Mealie (`mealie.prod.homeserver` **+** `mealie-prod.pke-lab.de`) | `user == rdn` | Nur `rdn`, intern + extern, kein 2FA-Zwang — **zwei** Provider/Application-Paare (ein `forward_single`-Provider pro `external_host`, siehe `blueprints/apps/mealie.yaml`), gleiche Policy auf beide gebunden |

**Immich, Nextcloud, Grafana, Zammad sind bewusst NICHT geschützt** —
identische Entscheidung wie zuvor bei Authelia (eigener App-Login reicht
bzw. Zammad braucht anonyme Ticket-Einreichung). Siehe
[40010-oeffentliches-teilen-ohne-authelia.md](../4-planung/40010-oeffentliches-teilen-ohne-authelia.md)
für den Immich/Nextcloud-Sonderfall (ForwardAuth-vs-OIDC-Analyse gilt
strukturell unverändert für Authentik).

Weitere Apps: neue Blueprint-Datei unter `blueprints/apps/`, siehe
[d0074-authentik-iac-cookbook.md](d0074-authentik-iac-cookbook.md).

---

## Bypass-Ingress ("native Anmeldung")

Unverändert zum bisherigen Muster — jede geschützte App behält ihren
zweiten, ungeschützten `-native`-Hostnamen:

| App | Authentik-geschützt (Standard) | Native Anmeldung (Fallback) |
|---|---|---|
| Uptime Kuma | https://uptime-kuma.prod.homeserver | https://uptime-kuma-native.prod.homeserver |
| Mealie | https://mealie.prod.homeserver / https://mealie-prod.pke-lab.de | https://mealie-native.prod.homeserver |

---

## Rollout-Log

| Datum | Was |
|---|---|
| — | Chart + Blueprints vorbereitet, Authelia-Chart entfernt, Cross-Referenzen umgestellt (siehe Setup oben). **Noch nicht deployt** — offene Punkte oben zuerst abarbeiten. |

Wird bei jedem weiteren Schritt ergänzt (analog zum bisherigen
Authelia-Rollout-Log).

---

## Troubleshooting

| Symptom | Hinweis |
|---|---|
| `502`/`503` auf `authentik.tech.homeserver` | `kubectl -n authentik get pods` / `logs deploy/authentik-server -c server` prüfen — Postgres erreichbar? `initContainers` (`wait-for-postgres`) hängen? |
| Server startet, aber Blueprints werden nicht übernommen | `kubectl -n authentik logs deploy/authentik-worker -c worker` — Blueprints werden vom Worker angewendet, nicht vom Server. ConfigMap-Mount (`/blueprints/custom`) prüfen. |
| Login funktioniert, ForwardAuth liefert trotzdem 401/Redirect-Loop | Provider nicht am eingebetteten Outpost registriert — `authentik_outposts.outpost`-Eintrag im jeweiligen App-Blueprint prüfen (siehe `blueprints/apps/*.yaml`). |
| Kein Nutzer kann sich mehr einloggen, Fehler deutet auf LDAP | `authentik-bind`-Passwort-Mismatch zwischen lldap und `authentik-credentials` — siehe [d0072-lldap.md](d0072-lldap.md) → Troubleshooting. |
| Worker-Pod wird OOMKilled | Historisch bereits einmal passiert (Commit 983e338) — `worker.resources.limits.memory` in `values.yaml` prüfen/anheben, VMRule-Alert (`templates/vmrule.yaml`) sollte vorher warnen. |
| 401 (statt Redirect) auf einem externen `*.pke-lab.de`-Host | Gleiche Ursache wie historisch bei Authelia — `cloudflared` muss auf Traefiks HTTPS-Entrypoint (443, `noTLSVerify: true`) zeigen, nicht auf Klartext-Port 80. |
