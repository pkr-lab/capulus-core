# Authelia — Zentrale SSO-/2FA-Instanz

[Authelia](https://www.authelia.com/) läuft als neue Platform-App
(`argocd/apps/platform/authelia/`) und schützt schrittweise jede App mit
eigener Anmeldemaske per Traefik-ForwardAuth. Nachfolger des früher
entfernten Authentik-Setups — Architektur-Begründung, Leitentscheidungen und
der komplette Rollout-Plan stehen in
[docs/4-planung/40000-authelia-sso.md](../4-planung/40000-authelia-sso.md).
Dieses Doc ist der Ist-Zustand-/Runbook-Teil, wächst mit jedem weiteren
Rollout-Batch.

---

## Architektur

```
Browser ──▶ Traefik (kube-system) ──▶ Middleware "authelia-authelia-<tier>@kubernetescrd"
                                          │
                          nicht eingeloggt│eingeloggt
                                          ▼         ▼
                          Authelia-Portal      Ziel-App (Backend-Service)
                  (auth.tech.homeserver /
                   auth.prod.homeserver)
```

- **Storage:** SQLite (`local-path`-PVC, 1 Gi) für Session-/Regulation-State
  — kein Postgres/Redis, genau eine Replica (Session-State ist lokal).
- **Nutzerquelle:** seit dem LDAP-Cutover (22.08.2026)
  [lldap](d0072-lldap.md) statt file-basierter `users_database.yml` — echte
  benannte Identitäten mit Gruppen statt einem einzelnen Pilot-Admin.
- **Zwei interne Hostnamen** (`auth.tech.homeserver`, `auth.prod.homeserver`)
  statt einem: "homeserver" ist ein Single-Label-Fake-TLD ohne Punkt,
  Authelias Session-Cookie-Domain-Validierung verlangt aber mindestens einen
  Punkt (`authelia config validate` lehnt `domain: homeserver` explizit ab).
  Jede Domain-Tier-Ebene bekommt deshalb ihren eigenen Cookie-Scope + eigenen
  Portal-Hostnamen. `auth-tech.pke-lab.de` (extern) braucht das nicht — echte
  Domain mit Punkt, ein Hostname deckt beide Tiers ab.
- **Notifier:** `filesystem` (kein SMTP-Relay im Repo vorhanden) — Passwort-
  Reset-Links landen in `/config/notification.txt` im Pod, kein echter
  Mailversand. Bei Bedarf später auf `smtp:` umstellen.

---

## Setup (bereits erledigt)

1. Secrets generiert (`authelia crypto rand` / `authelia crypto hash
   generate argon2`, Docker-Image `authelia/authelia:4.39.20`) und mit
   `kubeseal --raw --namespace authelia --name authelia-secrets` versiegelt:
   `jwt-secret`, `session-secret`, `storage-encryption-key`. Der ursprünglich
   4. Key (`users_database.yml`, file-basiert, 1 Pilot-Admin) ist mit dem
   LDAP-Cutover (Batch 2) entfallen — ersetzt durch `ldap-bind-password`,
   siehe [lldap-Setup](d0072-lldap.md).
2. Chart lokal gegen `authelia config validate` getestet, bevor es in den
   Cluster ging (Docker, `authelia/authelia:latest`) — dabei die
   Cookie-Domain-Einschränkung oben entdeckt und korrigiert.
3. `auth.tech.homeserver` + `auth.prod.homeserver` in
   `argocd/apps/platform/cert-manager/templates/certificate-homeserver-wildcard.yaml`
   ergänzt.
4. `authelia` als neuer Namespace in
   `ansible/roles/argocd/defaults/main.yml` (`argocd_platform_apps` +
   `argocd_network_policy_refined_namespaces`, Batch-4-Block) ergänzt.
5. Traefik-`Middleware` als Teil des Charts (`templates/middleware.yaml`) —
   **eine pro Domain-Tier** (`authelia-prod`, `authelia-tech`,
   `authelia-external`), referenziert als
   `authelia-authelia-<tier>@kubernetescrd`. Nicht eine gemeinsame
   Middleware für alle Apps: Traefiks ForwardAuth-Adresse trägt einen
   statischen `rd=`-Fallback als Login-Portal-Basis-URL — mit nur einer
   Middleware würden alle Apps unabhängig vom Tier zur selben Portal-Domain
   geschickt, deren Session-Cookie aber nur für dieses eine Tier gültig ist
   → Endlos-Redirect-Schleife (live beim Pilot aufgetreten, siehe
   Rollout-Log unten). Jede App referenziert die zu ihrem eigenen Tier
   passende Middleware in ihrer eigenen `ingress.annotations`.

### Nutzerverwaltung

Seit dem LDAP-Cutover (22.08.2026) kommen alle Identitäten aus
[lldap](d0072-lldap.md) — Setup, Passwort-Vergabe und Gruppenzuordnung
laufen dort über die Web-UI, nicht mehr über eine SealedSecret-Datei in
diesem Repo. `argocd/apps/platform/authelia/values.yaml` →
`config.authentication_backend.ldap` verweist auf lldap, das Bind-Passwort
kommt per Env-Var aus `authelia-secrets` (Key `ldap-bind-password`,
identischer Wert wie `bind-password` in `lldap-secrets`).

---

## Access-Control (aktueller Stand)

| Subject | Domain | Policy | Zugriff |
|---|---|---|---|
| `user:admin` | `*.tech.homeserver`, `*.prod.homeserver` | `one_factor` | Fallback/Break-Glass, alles, nur intern, bewusst kein 2FA |
| `group:admins` (`pke`) | `*.tech.homeserver`, `*.prod.homeserver` | `two_factor` | Vollzugriff, nur intern |
| `group:dlrg-einsatz` | `grafana.tech.homeserver`, `grafana-tech.pke-lab.de` | `one_factor` | Grafana, intern + extern |
| `user:ake` | `immich.prod.homeserver`, `immich-prod.pke-lab.de` | `one_factor` | Immich, intern + extern |
| `user:rdn` | `mealie.prod.homeserver`, `mealie-prod.pke-lab.de` | `one_factor` | Mealie, intern + extern |

`uptime-kuma.prod.homeserver` hat **keine eigene Regel mehr** — niemand aus
der aktuellen Identitätsliste war explizit zugewiesen, Zugriff läuft jetzt
implizit über die `group:admins`-Catch-all-Regel (erste Zeile, greift
zuerst). Das ist eine bewusste Verschärfung gegenüber dem Pilot (der noch
`one_factor` für JEDEN authentifizierten Nutzer erlaubte).

Weitere Regeln kommen bei Bedarf dazu, siehe
[40000-authelia-sso.md](../4-planung/40000-authelia-sso.md) → Baustein 7.
Änderung: `argocd/apps/platform/authelia/values.yaml` →
`config.access_control.rules` (ConfigMap, kein Secret — kein `kubeseal`
nötig für neue Regeln, aber `authelia config validate` lokal testen, siehe
Troubleshooting unten — `subject:`-Syntax und Domain-Wildcards sind
fehleranfällig).

---

## Bypass-Ingress ("native Anmeldung")

Jede geschützte App bekommt einen zweiten Ingress ohne
ForwardAuth-Middleware (`<app>-native.<tier>.homeserver`). Aktuelle Liste:
[d0071-native-login-fallback.md](d0071-native-login-fallback.md).

**Wichtig, siehe dortige Begründung:** Ein klickbarer Link direkt auf
Authelias Login-Seite ist **nicht** umgesetzt — Authelias offizieller
Asset-Override deckt nur Favicon/Logo/Text ab, kein HTML/Links, ohne das
Frontend zu forken. Der Fallback ist aktuell nur über die dedizierten
`-native`-URLs bzw. die Übersichtsseite selbst erreichbar, nicht als
sichtbarer Button im Login-Flow.

---

## Rollout-Log

| Datum | Batch | Was |
|---|---|---|
| 21.08.2026 | 1 (Pilot) | Authelia deployt, Uptime Kuma (nur interner Host) geschützt + `-native`-Bypass eingerichtet. Config lokal validiert vor Rollout. Drei Live-Fixes nötig: (1) Container-Args `--config=X` → `--config X` (Image-Entrypoint erkennt nur die getrennte Form), (2) `enableServiceLinks: false` gesetzt (Kubernetes injiziert sonst `AUTHELIA_*`-Service-Discovery-Env-Vars, die mit Authelias eigenem Config-Env-Prefix kollidieren), (3) Middleware von einer gemeinsamen auf drei Tier-spezifische aufgeteilt (Redirect-Loop, siehe Architektur-Abschnitt oben). |
| 22.08.2026 | 2 (LDAP-Cutover) | [lldap](d0072-lldap.md) deployt, `authentication_backend` von `file` auf `ldap` umgestellt, `access_control` auf `subject:`-basierte Regeln erweitert (5 Identitäten: `admin`, `pke`, `dlrg-einsatz`-Gruppe, `ake`, `rdn`). Grafana, Immich, Mealie neu per ForwardAuth geschützt, Immich + Mealie mit `-native`-Bypass (Immich zwingend, Mobile-App). Vollständig lokal per Docker-Netzwerk gegen echtes lldap ende-zu-ende getestet (LDAP-Bind, Gruppen-Auflösung, `subject:`/Domain-Wildcard-Matching) — alle drei zuvor unklaren Mechanismen vor dem Cluster-Rollout bestätigt. Zwei Live-Fixes nach dem Rollout: (1) `lldap`/`authelia` fehlten zunächst im `platform`-AppProject (`make render-bootstrap && make argocd` nötig, gleiches Muster wie beim Pilot), (2) externe `*.pke-lab.de`-Hosts lieferten 401 statt Redirect — `cloudflared` auf Traefiks HTTPS-Entrypoint (443, `noTLSVerify`) statt Klartext-Port 80 umgestellt, siehe Troubleshooting. |

Weiterer Ausbau (Batch 3+, weitere Apps/Identitäten) siehe
[40000-authelia-sso.md](../4-planung/40000-authelia-sso.md) → Baustein 7 —
jeweils erst nach Verifikation des vorherigen Batches (Login-Flow im
Browser, TOTP wo relevant, `curl -sI` auf beide Hosts pro App).

---

## Troubleshooting

| Symptom | Hinweis |
|---|---|
| `502`/`503` auf `auth.*.homeserver` | `kubectl -n authelia get pods` / `logs` prüfen — Storage-PVC oder Secret-Mount? |
| Login funktioniert, aber Redirect zurück zur App schlägt fehl | Cookie-Domain-Mismatch — Ziel-Host muss unter dem Tier liegen, für das ein `session.cookies`-Eintrag existiert (aktuell `prod.homeserver`, `tech.homeserver`, `pke-lab.de`). |
| Seite lädt endlos / Browser "reloaded" ständig, App öffnet nie | Falsche Middleware referenziert — App muss `authelia-authelia-<eigenes-Tier>@kubernetescrd` nutzen, nicht `-tech` für eine `prod.homeserver`-App (oder umgekehrt). `kubectl -n authelia logs deploy/authelia` zeigt bei diesem Fehler ständig denselben `/api/verify`-Redirect zur falschen Portal-Domain. |
| Config-Änderungen an `values.yaml` → `config:` werden nicht übernommen | `strategy.type: Recreate` im Deployment — ArgoCD muss den Pod neu erstellen, kein reines ConfigMap-Reload zur Laufzeit. |
| `config validate` lokal testen | `docker run --rm -v $PWD:/config -e AUTHELIA_SESSION_SECRET=... -e AUTHELIA_STORAGE_ENCRYPTION_KEY=... -e AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET=... -e AUTHELIA_AUTHENTICATION_BACKEND_LDAP_PASSWORD=... authelia/authelia:4.39.20 authelia config validate --config /config/configuration.yml` |
| Kein Nutzer kann sich mehr einloggen, Logs zeigen LDAP-Fehler | lldap nicht erreichbar oder Bind-Passwort falsch — siehe [d0072-lldap.md](d0072-lldap.md) → Troubleshooting. |
| Nutzer korrekt eingeloggt, aber 401 auf einer bestimmten App | Fehlende oder falsche `subject:`-Regel — `default_policy: deny` blockt alles ohne exakt passende Regel, Gruppenzugehörigkeit in lldap prüfen. |
| 401 (statt Redirect zu Authelia) auf einem **externen** `*.pke-lab.de`-Host | `kubectl -n authelia logs` zeigt `has an insecure scheme 'http'` — `cloudflared` leitete historisch auf Traefiks Klartext-Port 80 weiter (TLS terminiert an der Cloudflare-Edge, intern bisher unverschlüsselt). Fix (22.08.2026): `argocd/apps/platform/cloudflared/values.yaml` → `tunnel.ingress.rules[].service` auf `https://traefik.kube-system.svc.cluster.local:443` mit `originRequest.noTLSVerify: true` umgestellt — betrifft den gesamten Tunnel, nicht nur Authelia-geschützte Apps. |
