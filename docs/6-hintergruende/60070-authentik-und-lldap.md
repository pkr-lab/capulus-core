# Authentik und lldap — Hintergründe

Begründungen zu `argocd/apps/tech/authentik/` (Blueprints, Chart, Secrets) und `argocd/apps/tech/lldap/`. Betrieb und Runbook:
[d0073](../d-sicherheit/d0073-authentik-sso.md), [d0074](../d-sicherheit/d0074-authentik-iac-cookbook.md), [d0072](../d-sicherheit/d0072-lldap.md).
Die Blueprints sind ein recherchierter Startpunkt, keine garantiert 1:1 lauffähige Endzustände für jede Authentik-Version: Feldnamen und Modelle vor
größeren Versionssprüngen gegen die Doku der Zielversion prüfen (`docs.goauthentik.io`, LDAP-Source, TOTP-Stage, Policies).
Übersicht dieser Kategorie: [60000](60000-uebersicht.md).

---

## Blueprints: Fallstricke aus dem Live-Betrieb

Die Blueprints liegen unter `argocd/apps/tech/authentik/blueprints/`. Der Chart baut sie aus `templates/blueprints/*.yaml` (Helm `.Files.Glob`) als ConfigMap
und mountet sie in Server und Worker unter `/blueprints/custom`. Authentik wendet sie beim Start automatisch an. Eine neue App bedeutet eine neue Datei unter
`blueprints/apps/`.

### 00: LDAP-Quelle

- Authentik ist hier **Client** von lldap, nicht der LDAP-Server. Der Service-Account **`authentik-bind`** muss vorab **manuell** in der lldap-Web-UI angelegt und der
  Gruppe `lldap_strict_readonly` hinzugefügt werden (gleiches Muster wie früher `authelia-bind`). Sein Passwort ist der Klartext, der beim Versiegeln von
  `credentials.encryptedLdapBindPassword` in den Authentik-Values verwendet wurde.
- **`user_`/`group_property_mappings` sind Pflicht**, sobald `sync_users`/`sync_groups` aktiv sind. Sonst schlägt die Blueprint-Validierung mit „… property mappings cannot be empty“
  fehl und die LDAP-Source wird **nie** angelegt: kein Sync, keine Nutzer, und jeder Login scheitert mit „Invalid password“, weil der Nutzer schlicht nicht existiert. Das Mapping
  `default-name` passt **nicht** (erwartet ein AD-typisches `name`-Attribut, das lldap nicht liefert), stattdessen `openldap-cn` (Name aus `cn`).
- **Login mit LDAP-Nutzern (Korrektur nach dem Live-Rollout):** Nutzer landeten per Sync in Authentik, aber jeder Login scheiterte mit „Invalid credentials“, unabhängig vom korrekten
  lldap-Passwort. Ursache: Die Standard-Passwort-Stage im `default-authentication-flow` prüft per Default **nur** gegen Authentiks eigene lokale Nutzer-DB (`InbuiltBackend`), und die ist für
  LDAP-Nutzer leer, weil `sync_users_password` bewusst `false` ist (lldap gibt keine Passwort-Hashes heraus). Ohne den `LDAPBackend` zusätzlich in der Stage würde **jeder**
  LDAP-Login scheitern. `InbuiltBackend` bleibt zusätzlich bestehen, sonst verliert der lokale Bootstrap-Admin `akadmin` (kein LDAP-Nutzer) seinen Login.

### 01: TOTP-Pflicht für `admins`

TOTP wird nur für die Gruppe `admins` (aus lldap synchronisiert) erzwungen: gleiche Abgrenzung wie früher bei Authelia, nur Admin-/Infra-Tools erzwingen 2FA, Endnutzer-Apps laufen mit
Passwort-Login. Der Weg dorthin hatte zwei Fehlversuche:

1. **Setup-Stage direkt im Login-Flow:** Die rohe `authenticatortotpstage` (Setup/Enrollment, legt **immer** ein neues Geräte-Objekt an) war ohne Prüfung gebunden, ob der Nutzer schon ein TOTP-Gerät
   hat. Admins mussten TOTP bei **jedem** Login neu einrichten (neuer QR-Code statt Code-Abfrage).
2. **Eigene Validierungs-Stage auf Order 30:** Authentiks **eingebaute** Stage `default-authentication-mfa-validation` (aus dem System-Blueprint „Default - Authentication flow“) hängt
   schon immer an genau derselben Order 30 im selben Flow, ohne Policy-Bindung, und läuft damit für **jeden** Login. Mit zwei TOTP-Stages hintereinander wurde der gerade akzeptierte Code ein
   zweites Mal eingefordert, was Authentiks Replay-Schutz (derselbe Zeitschritt nur einmal gültig) zu Recht mit „Invalid Token“ ablehnt. Auffinden der System-Blueprints:
   `ak shell -c "from authentik.blueprints.models import BlueprintInstance; BlueprintInstance.objects.filter(name__startswith='Default')"`.

**Fix:** keine zweite Stage, sondern die **eingebaute Stage direkt konfigurieren**. Das ist dasselbe Muster wie die Erweiterung der ebenfalls eingebauten `default-authentication-password`-Stage in 00: nur `attrs`
bzw. zusätzliche Policy-Bindungen ergänzen. Das System-Blueprint deklariert für dieses Objekt keine `attrs` und überschreibt unsere Ergänzungen deshalb bei seiner periodischen Neuanwendung nicht.

- **Keine `state: absent`-Einträge für `flowstagebinding`** (oder darauf zeigende `policybinding`-Objekte): Die Artefakte aus den Versuchen 1 und 2 (rohe Setup-Stage, doppelte Stage
  `admin-totp-validation`) wurden **manuell** per `ak shell`/ORM entfernt. Der Blueprint-Importer trifft in Authentik 2025.8.3 beim Löschen von `authentik_flows.flowstagebinding` (Multi-Table-Inheritance
  von `PolicyBindingModel`) einen eigenen Bug (`FlowStageBinding.policybindingmodel_ptr.RelatedObjectDoesNotExist` im Collector), unabhängig davon, ob das Ziel über `!Find` aufgelöst wurde.
- **`!Find` mit mehreren Bedingungen:** Die Policy-Bindung hängt an der **bestehenden** Flow-Stage-Bindung der eingebauten Stage (angelegt vom System-Blueprint, nicht von uns, deshalb `!Find` statt
  `!KeyOf`). `!Find` erwartet für mehrere Bedingungen **separate `[key, value]`-Paare, keine abgeflachte Liste**. Sonst wird nur die erste Bedingung ausgewertet und der Rest stillschweigend
  ignoriert. Das traf hier live zu: `[target, X, stage, Y, order, Z]` filterte nur nach `target`, wodurch `.first()` auf die falsche Bindung (Order 10, die Identification-Stage) statt Order 30 zurückfiel.

### 90: Outpost-Registrierung nur an einer Stelle

Alle Provider werden in **einer** Datei am eingebetteten Outpost registriert. Ursprünglich hatte jede App ihren eigenen `authentik_outposts.outpost`-Eintrag mit `attrs.providers: […]`. Authentik **ersetzt**
diese Liste beim Apply komplett, statt sie zu mergen: Die zuletzt angewendete Blueprint-Datei gewinnt und wischt die Registrierung aller anderen Apps kommentarlos weg.

- Die Apply-Reihenfolge der Dateien unter `/blueprints/custom` ist **nicht zuverlässig alphabetisch** (das Log zeigte z. B. `app-mealie` vor `01-admin-2fa-policy` vor `uptime-kuma` vor `00-ldap-source`), vermutlich
  ConfigMap-Key-Iteration ohne garantierte Sortierung.
- Folge damals: Die Mealie-Provider existierten, waren aber nicht mehr am Outpost registriert. Der ForwardAuth-Check (`/outpost.goauthentik.io/auth/traefik`) lieferte 404, und Traefik reichte
  Authentiks 404 1:1 an den Browser durch, statt zu Mealie durchzureichen oder zum Login umzuleiten.
- Deshalb referenziert diese Datei Provider per **`!Find`** (Live-DB-Lookup zum Apply-Zeitpunkt) statt per `!KeyOf` (Referenz auf ein Objekt aus derselben Apply-Reihenfolge). `!Find` ist unabhängig von der
  Dateireihenfolge, solange der Provider aus einem früheren Durchlauf existiert (bei periodischem Re-Apply nach spätestens einem weiteren Zyklus).
- **Eine neue App** ergänzt hier eine weitere `!Find`-Zeile und legt **keinen** eigenen Outpost-Eintrag in ihrer App-Datei an (d0074, Abschnitt 3). Die App-Blueprints (`mealie.yaml`, `uptime-kuma.yaml`)
  verweisen darauf.

### Apps und Aufräumen

- **99-cleanup:** Räumt Policy-Objekte weg, die beim Umstieg von festverdrahteten Usernamen auf gruppenbasierte Policies verwaisten. Blueprints löschen beim Umbenennen eines `identifiers`-Werts nichts
  automatisch (d0074, Abschnitt 1). `state: absent` ist idempotent, der Eintrag kann nach dem Aufräumen gefahrlos stehen bleiben.
- **Mealie:** Zugriff für `admins` **oder** die App-Gruppe `mealie-user` (in lldap anlegen). Beim Umstieg auf Gruppen musste der bisher per Username fest verdrahtete Nutzer der neuen Gruppe zugewiesen
  werden, sonst verlor er den Zugriff. Kein TOTP-Zwang für `mealie-user`, nur `admins` brauchen TOTP.
- **Zwei Provider/Application-Paare, nicht eines:** Mealie ist intern (`mealie.prod.homeserver`) und extern (`mealie-prod.pke-lab.de`) geschützt, aber ein `authentik_providers_proxy.proxyprovider` im
  Modus `forward_single` ist an genau **einen** `external_host` gebunden. Ein zweiter Hostname braucht einen zweiten Provider und eine eigene Application (eine Application referenziert aktuell genau
  einen Provider). Beide teilen sich dieselbe Policy (d0074, Abschnitt 3, „App mit internem und externem Host“).
- **Uptime Kuma:** Zugriff für `admins` **oder** `uptime-kuma-user`. Bis jemand aufgenommen wird, bleibt der Zugriff faktisch admins-only (identisch zum letzten Authelia-Zustand). Die Gruppe existiert als
  Erweiterungspunkt, weitere Personen brauchen keinen Blueprint-Edit mehr. TOTP erzwingt die Policy aus 01, nicht die App-Datei. Die Datei dient als Vorlage für weitere Apps.

---

## Chart und Betrieb

| Stelle | Begründung |
|---|---|
| **Eine** gemeinsame ForwardAuth-Middleware für alle Tiers | Authelia brauchte drei Middlewares (eine pro Tier) wegen einer statischen `rd=`-Basis-URL. Authentiks eingebetteter Outpost berechnet die Rückkehr-URL dynamisch aus `X-Forwarded-Host`/`-Proto` des ursprünglichen Requests (`trustForwardHeader: true`), es ist kein Tier-spezifischer Parameter nötig und keine Redirect-Loop-Falle. |
| Externer Host ist **nötig, nicht optional** | Mealie ist auch extern geschützt, und ein Browser, der von dort zum Login umgeleitet wird, muss Authentik auch von außen erreichen. Bindestrich statt Punkt (Cloudflares kostenloses Universal-SSL deckt nur eine Label-Ebene ab), Tier `tech`, weil Authentik unter `argocd/apps/tech/` liegt. |
| Kein HPA | Ein-Knoten-Cluster (worker-0/worker-1 „NotReady“): Mehr Replicas bringen keine Ausfallsicherheit, nur zusätzlichen RAM-Verbrauch. Gleiche Begründung wie bei Authelia und lldap. |
| Worker-Speicher | Der Worker war bereits einmal mit 384Mi/768Mi OOMKilled (Commit `983e338` hob den Wert an). Hier von Anfang an mit dem gefixten Wert **und** einem VMRule-Alert (`vmservicescrape.yaml`) statt reaktivem Nachziehen. |
| `Delete=false` an der Postgres-PVC | Ein Abräumen der Application (Ordner-Umzug, ApplicationSet-Änderung) darf das `local-path`-Volume nicht löschen: `reclaimPolicy: Delete` würde die Daten von der Platte entfernen (Vorfall 2026-09-19). Aus demselben Grund tragen alle `local-path`-PVCs `argocd.argoproj.io/sync-options: Delete=false`. |
| Pod fest auf `homeserver` | `local-path` bindet den Pod an den Node, auf dem die PVC zuerst provisioniert wird (wie bei Uptime Kuma und lldap). |
| `pg_dump`-CronJob auf die NAS | Muster wie beim Vaultwarden-Backup ([60040](60040-helm-charts-tech.md#vaultwarden)). |
| Handgeschriebene `VMServiceScrape` statt `ServiceMonitor` | Die CRD `monitoring.coreos.com/v1` ist in diesem Cluster nicht installiert, nur die VictoriaMetrics-CRDs (Lehre aus der ersten Authentik-Runde, dort erst nachträglich korrigiert, [40070](../4-planung/40070-authentik-sso-iac.md)). |

### Version und Datenbank

Die App-Version wurde am **15.09.2026 auf `2025.8.3` zurückgesetzt**: Ein Renovate-Major-Bump hatte `postgresql.image.tag` versehentlich auf `18-bookworm` gesetzt (nicht kompatibel mit der bestehenden v17-Datenbank) **und**
den App-Tag separat auf `2026.8.2`. Authentik verweigert bei App-Versionen den direkten Sprung („Major version skips are not allowed“). Die echte Release-Kette lt. GitHub ist
`2025.8 → 2025.10 → 2025.12 → 2026.2 → 2026.5 → 2026.8`, **jeder Schritt einzeln** mit DB-Migration. Postgres wurde bereits per Dump/Restore auf `18-bookworm` migriert
([d0073](../d-sicherheit/d0073-authentik-sso.md)). Der App-Tag bleibt bewusst auf `2025.8.3`, bis die App-Version schrittweise nachgezogen wird. Bei der Remote-Outpost-Variante in PROD muss die
Outpost-Version dazu passen ([60030](60030-argocd-und-bootstrap.md#sso-outpost-in-prod-migrationssso-outpost)).

### Secrets in `authentik-credentials`

Das SealedSecret ist mit dem Public Key dieses Clusters versiegelt (`openssl rand` plus `kubeseal --raw --namespace authentik --name authentik-credentials …`, Muster wie bei lldap). Es enthält:

| Schlüssel | Bedeutung |
|---|---|
| `secret-key` | Authentiks interner Signier-/Verschlüsselungsschlüssel |
| `db-password` | Passwort des Users `authentik` im eigenen Postgres |
| `bootstrap-password` | Initiales Passwort des Erstadmins `akadmin`, **sofort nach dem ersten Login ändern** (analog `lldap-root`) |
| `bootstrap-email` | Platzhalter für `akadmin`, wird nie versendet (kein SMTP-Relay im Repo) |
| `ldap-bind-password` | Passwort des Service-Accounts `authentik-bind` in lldap (Gruppe `lldap_strict_readonly`), muss manuell in der lldap-Web-UI gesetzt werden ([d0072](../d-sicherheit/d0072-lldap.md)) |

**Korrektur nach dem Live-Rollout:** Die Werte wurden zuerst mit `kubeseal --raw <<< "$WERT"` versiegelt. Das Here-String hängt einen Zeilenumbruch an, jeder Wert hatte deshalb ein zusätzliches `\n`.
Postgres’ Entrypoint trimmte es beim `initdb` weg, Authentiks Config-Loader nicht. Ergebnis: „password authentication failed for user authentik“ im echten `scram-sha-256`-Pfad, obwohl ein
`PGPASSWORD`-Test über `127.0.0.1` (dort gilt `trust`, kein echter Passwort-Check) fälschlich erfolgreich wirkte. Neu versiegelt mit `printf '%s' "$WERT" | kubeseal --raw …`
([60030](60030-argocd-und-bootstrap.md#sealedsecrets-fallstricke-beim-versiegeln)).

---

## lldap

| Stelle | Begründung |
|---|---|
| SQLite lokal, ein Replica | Wie bei Authentik: keine geteilte Session/DB, mehr als ein Replica ist mit einer `local-path`-PVC (RWO) ohnehin nicht sinnvoll. Pod fest auf `homeserver`. |
| Kein `runAsNonRoot`/`runAsUser` | Der Image-Entrypoint startet bewusst als root, `chown`t `/app` und `/data` auf UID/GID (Env, Default 1000) und wechselt danach per `gosu`. Mit erzwungenem Nicht-root-Start scheitert der `chown`. Die UID/GID sind trotzdem explizit gesetzt (Konsistenz mit Uptime Kuma `PUID`/`PGID`). |
| Superuser heißt **nicht** `admin` (sondern `lldap-root`) | Der App-seitige Nutzer `admin` (Authentik-Fallback-Login) soll keinen Namenskonflikt mit lldaps eingebautem Superuser haben. Getrennte Accounts für getrennte Zwecke (lldap-Verwaltung gegen App-Zugriff). |
| Kein SMTP | Wie bei Authentik gibt es im Repo kein SMTP-Relay. Passwort-Reset läuft ausschließlich manuell über die Web-UI, `lldap-root` kann jedes Nutzerpasswort direkt zurücksetzen, ganz ohne E-Mail. |
| Nur intern | Admin-Tool-Charakter wie Headlamp, Semaphore und MinIO („Nicht freigeben“ in [e0000](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md)), kein externer Host. |

Secrets in `lldap-secrets` (erzeugt am 22.08.2026 per `openssl rand` plus `kubeseal --raw --namespace lldap --name lldap-secrets`, [d0072](../d-sicherheit/d0072-lldap.md)):

| Schlüssel | Bedeutung |
|---|---|
| `jwt-secret` | Signiert lldaps eigene Web-UI-Sessions |
| `key-seed` | Leitet den Schlüssel zum Passwort-Storage ab. **Einmalig, niemals rotieren**, das macht alle gesetzten Passwörter ungültig |
| `root-password` | Login für `LLDAP_LDAP_USER_DN` (`lldap-root`) |
| `bind-password` | Passwort des Service-Accounts `authelia-bind`. Nur noch relevant, bis der Account im Zuge der Authentik-Ablösung manuell aus lldap gelöscht wird (letzter Rollout-Schritt in [40070](../4-planung/40070-authentik-sso-iac.md)), danach diesen Key und den Account entfernen |
| `authentik-bind-password` | Passwort des Service-Accounts `authentik-bind` (manuell in der Web-UI angelegt), muss mit diesem Secret übereinstimmen, sonst schlägt Authentiks LDAP-Source-Sync fehl |

Die Werte wurden ebenfalls zuerst per `<<<`-Here-String versiegelt (derselbe Zeilenumbruch-Fehler wie bei Authentik) und danach mit `printf '%s'` neu versiegelt, gleicher Klartext wie zuvor.
