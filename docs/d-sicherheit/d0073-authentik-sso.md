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
  **Korrektur nach Live-Rollout:** ursprünglich war "kein Pflicht-Redis"
  angenommen — falsch, die deployte Version verlangt beim Start zwingend
  erreichbares Redis (Cache/Task-Broker), sonst bleibt der Server-Pod
  dauerhaft bei `Redis Connection failed, retrying...` hängen und wird nie
  ready. Eigenes, ebenfalls leichtgewichtiges Redis-Deployment ergänzt
  (kein PVC, reiner Cache/Broker, Muster wie
  `argocd/apps/workloads/immich/templates/redis-*.yaml`).
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
| Uptime Kuma (`uptime-kuma.prod.homeserver`) | `admins` ODER Gruppe `uptime-kuma-user` | Nur intern, 2FA für `admins`-Mitglieder |
| Mealie (`mealie.prod.homeserver` **+** `mealie-prod.pke-lab.de`) | `admins` ODER Gruppe `mealie-user` | Intern + extern, kein 2FA-Zwang für `mealie-user` — **zwei** Provider/Application-Paare (ein `forward_single`-Provider pro `external_host`, siehe `blueprints/apps/mealie.yaml`), gleiche Policy auf beide gebunden |

**Korrektur (nach Live-Rollout):** ursprünglich fest verdrahtet (`user ==
rdn` für Mealie, nur `admins` für Uptime Kuma) — auf gruppenbasierte
Policies umgestellt (`<app>-user`-Gruppen), damit neue Personen ohne
Blueprint-Edit hinzugefügt werden können (siehe
[d0074-authentik-iac-cookbook.md](d0074-authentik-iac-cookbook.md),
Abschnitt 3). **Manueller Schritt beim Umstieg:** Gruppen `mealie-user`
und `uptime-kuma-user` in lldap anlegen, `rdn` in `mealie-user` aufnehmen
(sonst verliert `rdn` den Zugriff auf Mealie) — siehe
[d0072-lldap.md](d0072-lldap.md). Die alten Policy-Objekte `mealie-rdn-only`/`uptime-kuma-admins-only`
wären sonst als verwaiste, nicht mehr gebundene Objekte in Authentik
stehen geblieben (Blueprints löschen beim Umbenennen nichts automatisch,
siehe Cookbook Abschnitt 1) — per
`blueprints/99-cleanup-renamed-policies.yaml` (`state: absent`) über IaC
statt manuell in der UI entfernt.

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
| 06.09.2026 | Chart + Blueprints vorbereitet, Authelia-Chart entfernt, Cross-Referenzen umgestellt (siehe Setup oben). |
| 06.09.2026 | Erster Live-Rollout. Drei Fixes während der Inbetriebnahme nötig: (1) Alle 5 Secret-Werte in `authentik-credentials` waren mit `kubeseal --raw <<< "$VALUE"` versiegelt — das Bash-Here-String hängt einen Trailing-Newline an, Postgres' Entrypoint trimmt den beim `initdb`-Setzen des Rollen-Passworts weg, Authentiks eigener Config-Loader nicht → `password authentication failed for user authentik` auf dem echten (scram-sha-256-)Auth-Pfad; ein `PGPASSWORD`-Test über `127.0.0.1` täuschte fälschlich Erfolg vor, weil dort `pg_hba.conf` bedingungslos `trust` erlaubt. Neu versiegelt mit `printf '%s' | kubeseal --raw`. (2) Beim erneuten Einfügen war `encryptedBootstrapPassword` zusätzlich auf 717 statt eines gültigen Vielfachen-von-4 base64-Zeichen verstümmelt (vermutlich beim manuellen Einfügen) — SealedSecret-Controller verweigerte daraufhin JEDE Aktualisierung der ganzen Secret-Gruppe (`illegal base64 data at input byte 716`), auch nachdem ArgoCD den korrigierten Rest bereits synced hatte. Neu versiegelt und diesmal per Skript statt manuell eingefügt, alle 5 Werte zusätzlich strikt als Base64 validiert. (3) Fälschliche Annahme "kein Pflicht-Redis" — die deployte Version verlangt beim Start zwingend erreichbares Redis, sonst bleibt der Server-Pod dauerhaft bei `Redis Connection failed, retrying...` hängen. Eigenes Redis-Deployment ergänzt (siehe Architektur oben). Zusätzliche Lehre: die ArgoCD-Application trackt `main`, nicht Feature-Branches — Fixes auf einem unmerged Branch zeigen live schlicht keine Wirkung, unabhängig davon wie oft `kubectl rollout restart` läuft. |
| 06.09.2026 | Zwei weitere Fixes nach dem ersten erfolgreichen Start: (4) `pke`-Login schlug mit "Invalid credentials" fehl, unabhängig vom (korrekten) lldap-Passwort — die Standard-Passwort-Stage (`default-authentication-password`) prüfte per Default nur gegen Authentiks lokale Nutzer-DB (`InbuiltBackend`), die für LDAP-Nutzer leer ist (`sync_users_password: false`, bewusst). `authentik.sources.ldap.auth.LDAPBackend` zur Stage ergänzt (siehe `00-ldap-source.yaml`), `InbuiltBackend` bleibt zusätzlich für den lokalen `akadmin`-Login bestehen. (5) Mealie zeigte Authentiks eigene 404-Seite statt Login/App-Inhalt — jede App-Blueprint-Datei hatte ihr eigenes `authentik_outposts.outpost`-Entry mit `providers: [...]`, Authentik ersetzt diese Liste beim Apply komplett statt sie zu mergen, die zuletzt angewendete Datei (Reihenfolge live nicht alphabetisch, vermutlich unsortierte ConfigMap-Key-Iteration) wischte die Registrierung der anderen Apps weg — per `ak shell` direkt verifiziert (`Outpost.objects.get(...).providers.all()` zeigte nur `uptime-kuma`, obwohl beide Mealie-Provider korrekt existierten). Auf eine zentrale Datei (`90-outpost-providers.yaml`, `!Find`-basiert statt `!KeyOf`, damit ordnungsunabhängig) konsolidiert, die einzelnen App-Dateien registrieren sich nicht mehr selbst. |

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
