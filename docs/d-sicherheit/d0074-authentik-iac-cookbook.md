# Authentik IaC-Cookbook — neue Apps und Nutzer anlegen

Praktische Anleitung, um Authentik **ausschließlich über Git** zu steuern —
kein Klicken in der Authentik-Web-UI für Provider/Apps/Policies. Die einzige
bewusste Ausnahme: **Nutzer werden weiterhin in lldap angelegt** (nicht in
Authentik selbst), siehe Abschnitt 2. Grundlagen/Architektur:
[d0073-authentik-sso.md](d0073-authentik-sso.md). Warum Blueprints statt
Terraform: [40070-authentik-sso-iac.md](../4-planung/40070-authentik-sso-iac.md)
→ Machbarkeits-Analyse.

**Wichtiger Vorbehalt:** Die Blueprint-Beispiele hier (Feldnamen, Modelle)
sind gegen die öffentliche Authentik-Dokumentation recherchiert, aber
**nicht gegen eine echte laufende Instanz getestet** — vor dem ersten
produktiven Einsatz einmal gegen die tatsächlich deployte Version prüfen
(`kubectl -n authentik logs deploy/authentik-worker -c worker` zeigt beim
Blueprint-Apply Fehler mit Modellname, falls etwas nicht passt) und bei
Bedarf gegen [docs.goauthentik.io](https://docs.goauthentik.io/docs/customize/blueprints/)
korrigieren.

---

## 1. Wie Blueprints funktionieren (kurz)

- Jede Datei unter `argocd/apps/platform/authentik/blueprints/*.yaml` (und
  Unterordnern wie `blueprints/apps/`) wird per Helm in eine ConfigMap
  gepackt und in Server + Worker unter `/blueprints/custom` gemountet.
- Der **Worker**-Prozess wendet beim Start (und danach regelmäßig) jede
  Datei dort automatisch an — kein manueller Trigger, kein `kubectl exec`
  nötig.
- **Wichtig:** Eine Blueprint-Datei aus dem Repo zu löschen, entfernt die
  bereits angewendeten Objekte in Authentik **nicht** automatisch — das ist
  reines "Apply", kein "Sync". Zum Entfernen einer App siehe Abschnitt 4.
- `identifiers:` in jedem Eintrag ist der Schlüssel, über den Authentik
  entscheidet, ob ein Objekt neu angelegt oder ein bestehendes aktualisiert
  wird (z. B. `slug` bei Applications, `name` bei Providern) — beim
  Umbenennen eines `identifiers`-Werts entsteht ein **neues** Objekt, das
  alte bleibt verwaist stehen.

---

## 2. Neuen Nutzer anlegen

Passiert **nicht** in Authentik, sondern wie bisher in lldaps Web-UI —
Authentik synchronisiert Nutzer/Gruppen automatisch von dort:

1. <https://lldap.tech.homeserver> öffnen, mit `lldap-root` einloggen.
2. **User Management → Create a user** — User-ID, E-Mail, Display Name
   eintragen, danach **Reset password** setzen.
3. Für Gruppen-basierte Policies (siehe Abschnitt 3.3): Nutzer öffnen →
   **Groups** → passende Gruppe zuweisen (z. B. `admins` für 2FA-Pflicht).
4. Fertig — **kein Authentik-seitiger Schritt nötig.** Die LDAP Source
   synchronisiert den neuen Nutzer automatisch beim nächsten Sync-Intervall
   (Standard: alle paar Minuten; ein sofortiger Sync ist über die
   Authentik-UI unter **Directory → Federation & Social login → lldap →
   Sync now** möglich, falls es schneller gehen soll — das ist ein
   Lese-/Trigger-Klick, kein Config-Zustand, deshalb okay als UI-Aktion).

Ausführliches Setup (Gruppen, Basis-Identitäten): siehe
[d0072-lldap.md](d0072-lldap.md).

> **App mit internem UND externem Host:** Ein
> `authentik_providers_proxy.proxyprovider` im Modus `forward_single` ist an
> genau **einen** `external_host` gebunden. Soll dieselbe App unter zwei
> Hostnamen geschützt sein (z. B. `app.tech.homeserver` **und**
> `app-tech.pke-lab.de`), braucht es **zwei** Provider + zwei Applications
> (unterschiedliche `slug`s), beide mit derselben Policy und beide am
> Embedded Outpost registriert — siehe `blueprints/apps/mealie.yaml` als
> Referenzbeispiel. Ein extern erreichbarer Host muss außerdem selbst in
> `argocd/apps/platform/authentik/values.yaml` → `server.ingress.hosts`
> stehen (Authentiks eigenes Portal muss von dort aus erreichbar sein,
> sonst läuft der Redirect ins Leere) — Naming-Konvention:
> [c0040-domain-tiers.md](../c-netzwerk-dns/c0040-domain-tiers.md).

---

## 3. Neue App hinzufügen

Beispiel: eine neue App `beispiel-app` unter `beispiel.tech.homeserver`
hinter Authentik stellen, Zugriff nur für die `admins`-Gruppe (2FA-Pflicht
kommt automatisch über die bestehende Policy in
`01-admin-2fa-policy.yaml`, siehe [d0073](d0073-authentik-sso.md)).

### 3.1 Blueprint-Datei anlegen

Neue Datei `argocd/apps/platform/authentik/blueprints/apps/beispiel-app.yaml`,
als Vorlage dient `blueprints/apps/uptime-kuma.yaml`:

```yaml
version: 1
metadata:
  name: app-beispiel-app
entries:
  - model: authentik_providers_proxy.proxyprovider
    id: beispiel-app-provider
    identifiers:
      name: beispiel-app
    attrs:
      mode: forward_single
      external_host: https://beispiel.tech.homeserver
      authorization_flow: !Find [authentik_flows.flow, [slug, default-provider-authorization-implicit-consent]]
      invalidation_flow: !Find [authentik_flows.flow, [slug, default-provider-invalidation-flow]]

  - model: authentik_core.application
    id: beispiel-app-app
    identifiers:
      slug: beispiel-app
    attrs:
      name: Beispiel App
      provider: !KeyOf beispiel-app-provider
      policy_engine_mode: any

  # Zugriffs-Policy — Beispiel: nur "admins"-Gruppe. Für "jeder eingeloggte
  # Nutzer" einfach den ganzen policybinding-Block weglassen (Application
  # ohne Policy-Bindung = jeder authentifizierte Nutzer darf rein).
  - model: authentik_policies_expression.expressionpolicy
    id: beispiel-app-admins-only-policy
    identifiers:
      name: beispiel-app-admins-only
    attrs:
      expression: |
        return ak_is_group_member(request.user, name="admins")

  - model: authentik_policies.policybinding
    identifiers:
      target: !KeyOf beispiel-app-app
      policy: !KeyOf beispiel-app-admins-only-policy
      order: 0

  # Ohne diesen Block greift die ForwardAuth-Middleware NICHT für diese App.
  - model: authentik_outposts.outpost
    identifiers:
      name: authentik Embedded Outpost
    attrs:
      providers:
        - !KeyOf beispiel-app-provider
    state: present
```

**Policy-Varianten** (den `expression`-Block entsprechend anpassen):

| Ziel | `expression` |
|---|---|
| Nur eine bestimmte Gruppe | `return ak_is_group_member(request.user, name="admins")` |
| Nur ein bestimmter Nutzer | `return request.user.username == "rdn"` |
| Mehrere Nutzer | `return request.user.username in ["rdn", "ake"]` |
| Jeder eingeloggte Nutzer | Policy-Block + `policybinding` komplett weglassen |

### 3.2 App-eigenen Ingress auf die Middleware zeigen lassen

In `argocd/apps/workloads/<app>/values.yaml` (oder `platform/<app>` bei
Plattform-Apps), Analog zu `mealie`/`uptime-kuma`:

```yaml
ingress:
  annotations:
    traefik.ingress.kubernetes.io/router.middlewares: "authentik-authentik@kubernetescrd"
```

Eine einzige Middleware für alle Apps/Tiers — kein Tier-spezifisches Suffix
nötig (siehe [d0073](d0073-authentik-sso.md) → Architektur).

### 3.3 Hostname zum Wildcard-Zertifikat hinzufügen (falls neu)

Falls `beispiel.tech.homeserver` noch nicht im internen Wildcard-Zertifikat
steht: in
`argocd/apps/platform/cert-manager/templates/certificate-homeserver-wildcard.yaml`
→ `dnsNames` ergänzen.

### 3.4 Committen und synchronisieren

```bash
git add argocd/apps/platform/authentik/blueprints/apps/beispiel-app.yaml \
        argocd/apps/workloads/beispiel-app/values.yaml
git commit -m "feat(authentik): beispiel-app hinter SSO stellen"
git push
```

ArgoCD synchronisiert automatisch (App-of-Apps). Bei Bedarf manuell
anstoßen: `argocd app sync authentik` (bzw. `make argocd` für einen vollen
Ansible-Lauf, falls sich auch `argocd_platform_apps`/`argocd_workloads_apps`
geändert hat — bei einer bereits bestehenden App wie in diesem Beispiel
nicht nötig).

### 3.5 Verifizieren

```bash
# Erwartet: 302 Richtung authentik.tech.homeserver
curl -sI https://beispiel.tech.homeserver

# Blueprint-Apply-Fehler prüfen (Modellname/Feld falsch geschrieben?)
kubectl -n authentik logs deploy/authentik-worker -c worker | grep -i blueprint
```

Danach im Browser: Login-Flow komplett durchklicken (inkl. TOTP-Enrollment,
falls die App unter eine 2FA-Policy fällt), und mit einem **nicht**
berechtigten Nutzer testen, dass der Zugriff tatsächlich verweigert wird.

---

## 4. App wieder entfernen

Datei aus `blueprints/apps/` löschen entfernt die App **nicht** aus
Authentik (siehe Abschnitt 1). Sauber rückbauen:

1. In der zu löschenden Blueprint-Datei bei **jedem** Eintrag
   `state: absent` ergänzen (Application, Provider, Policy, PolicyBinding —
   nicht nur beim Outpost-Eintrag) und einmal committen/syncen lassen —
   Authentik entfernt die Objekte dann beim nächsten Blueprint-Apply.
2. Erst danach die Datei tatsächlich aus dem Repo löschen.
3. Middleware-Annotation aus der App-eigenen `values.yaml` entfernen
   (Schritt 3.2 rückgängig).

---

## 5. Referenz: die wichtigsten Blueprint-Modelle

| Model | Zweck |
|---|---|
| `authentik_sources_ldap.ldapsource` | LDAP Source (bereits vorhanden, `00-ldap-source.yaml` — i. d. R. nicht pro App nötig) |
| `authentik_providers_proxy.proxyprovider` | ForwardAuth-Provider für eine App (`mode: forward_single`) |
| `authentik_core.application` | Verknüpft einen Provider mit einem sichtbaren "App"-Eintrag (Slug, Name) |
| `authentik_policies_expression.expressionpolicy` | Python-Ausdruck, der `True`/`False` zurückgibt — steuert, wer darf |
| `authentik_policies.policybinding` | Verknüpft eine Policy mit einem Ziel (App, Flow-Stage, ...) |
| `authentik_stages_authenticator_totp.authenticatortotpstage` | TOTP-Setup-Stage (bereits vorhanden, `01-admin-2fa-policy.yaml`) |
| `authentik_flows.flowstagebinding` | Hängt eine Stage in einen bestehenden Flow (z. B. den Authentication-Flow) |
| `authentik_outposts.outpost` | Registriert einen Provider am (eingebetteten) Outpost — ohne das greift ForwardAuth nicht |

Vollständige Modell-/Feld-Referenz:
[docs.goauthentik.io/docs/customize/blueprints/v1/models](https://docs.goauthentik.io/docs/customize/blueprints/v1/models/)
— dort auch alle unterstützten YAML-Tags (`!Find`, `!KeyOf`, `!Env`, ...).

---

## 6. Troubleshooting

| Symptom | Ursache |
|---|---|
| Blueprint wird nicht angewendet, keine Fehlermeldung sichtbar | Worker-Pod neu gestartet? Blueprints werden beim Start + periodisch geprüft — `kubectl -n authentik rollout restart deployment authentik-worker` erzwingt einen sofortigen Versuch. |
| `kubectl logs` zeigt "Invalid blueprint" / Feld unbekannt | Feldname/Modell stimmt nicht mit der deployten Authentik-Version überein — gegen [docs.goauthentik.io](https://docs.goauthentik.io/docs/customize/blueprints/v1/models/) für die exakte Version prüfen (`Chart.yaml` → `appVersion`). |
| App erscheint, ForwardAuth liefert aber immer 403/401 | Provider fehlt im `authentik_outposts.outpost`-Eintrag (Abschnitt 3.1, letzter Block) — ohne Registrierung am Embedded Outpost greift `/outpost.goauthentik.io/auth/traefik` nicht für diese App. |
| Falscher Nutzer kommt trotzdem rein | `policy_engine_mode: any` + mehrere Policy-Bindings verhalten sich wie ODER — bei mehreren Regeln ggf. auf `all` (UND) umstellen oder Policies zusammenfassen. |
| Neuer lldap-Nutzer taucht in Authentik nicht auf | LDAP-Source-Sync-Intervall abwarten oder manuell anstoßen (Abschnitt 2, Schritt 4). |
