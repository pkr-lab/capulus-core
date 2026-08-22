# Öffentliches Teilen (Immich/Nextcloud) ohne Gast-Accounts

Architektur-Plan für das Problem, das zum Zurückbau von Authelia vor
Immich und Nextcloud geführt hat (siehe
[docs/d-sicherheit/d0070-authelia-sso.md](../d-sicherheit/d0070-authelia-sso.md)
→ Rollout-Log, 22.08.2026). Noch **nicht umgesetzt** — hält den
recherchierten Stand und mehrere Optionen mit Trade-offs fest, bevor der
nächste Rollout-Schritt beginnt.

---

## Kontext

Immich (Fotos/Videos) und Nextcloud (Dateien) wurden mit ForwardAuth-
Middleware vor Authelia gestellt und dann wieder komplett zurückgebaut,
weil ForwardAuth **die ganze Domain** gated — inklusive der eingebauten
"öffentlicher Link"-Funktionen beider Apps. Der Nutzer will Fotos/Videos
(und potenziell Dateien) mit externen Personen teilen können, **ohne** für
jeden Empfänger einen lldap-Account anzulegen — die Empfänger sollen den
Link einfach öffnen können, ganz ohne Authelia-Login.

Dieses Dokument arbeitet das grundsätzliche Problem auf, recherchiert
mehrere Lösungsansätze (inkl. was in der Community bereits probiert und
als nicht tragfähig verworfen wurde) und legt für beide Apps mehrere
Optionen mit Trade-offs vor.

---

## Warum ForwardAuth (Traefik-Middleware) hier grundsätzlich klemmt

ForwardAuth gated **jeden** Request an die Domain, bevor er die App
überhaupt erreicht — es kennt nur "Host + Pfad", nicht "ist das eine
öffentliche Freigabe oder nicht". Zwei naheliegende Auswege wurden
recherchiert und beide erwiesen sich als nicht sauber lösbar:

1. **Pfad-basierter Bypass** (Authelia unterstützt das offiziell:
   `policy: bypass` + `resources:` als Regex-Liste, siehe
   [Authelia-Doku](https://www.authelia.com/configuration/security/access-control/)).
   Für Immich wurde das in der Community bereits versucht und
   dokumentiert gescheitert
   ([immich-app/immich Discussion #3118](https://github.com/immich-app/immich/discussions/3118)):
   *"The /share page is not designed to only load from /share. It accesses
   /api like everything else in Immich."* Ein `/api`-Bypass wäre nötig,
   aber Immichs API unterscheidet nicht auf URL-Ebene zwischen "gehört zu
   einem öffentlichen Share" und "privates Asset" — die Berechtigungsprüfung
   passiert serverseitig anhand des Share-Tokens, nicht anhand des Pfads.
   Ein `/api`-Bypass wäre also ein **echtes Sicherheitsloch**: jeder könnte
   dann beliebige Asset-IDs erraten/durchprobieren, nicht nur die geteilten.
   Für Nextcloud ist die Lage ähnlich unklar — auch dort fand sich **kein**
   dokumentiertes, funktionierendes Beispiel für einen sauberen
   `/s/`-Bypass ([authelia/authelia Issue #2557](https://github.com/authelia/authelia/issues/2557),
   als ungelöst markiert; Mobile-Sync-Client-Login bricht nachweislich).

2. **Zweiter, komplett offener Host** (unser bisheriges `-native`-Muster,
   funktioniert für Uptime Kuma/Mealie gut). Für Immich/Nextcloud aber
   fragwürdig: der zweite Host erreicht die **komplette** App, nicht nur
   die Freigabe — sicherheitstechnisch identisch zum Zustand *vor*
   Authelia (nur noch App-eigener Login als Schutz), sobald jemand den
   zweiten Hostnamen kennt oder errät. Bringt für Immich/Nextcloud fast
   nichts gegenüber "kein Authelia davor".

**Die strukturell saubere Alternative: OIDC statt ForwardAuth.**
Authelia kann als OpenID-Connect-Identity-Provider auftreten (nicht nur
als ForwardAuth-Gateway). Der Unterschied ist fundamental: ForwardAuth
prüft *jeden* HTTP-Request am Reverse-Proxy, bevor er die App erreicht.
OIDC dagegen wirkt **nur beim Login-Vorgang selbst** — die App zeigt einen
zusätzlichen "Mit Authelia anmelden"-Button auf ihrer *eigenen* Login-Seite,
alles andere (inkl. öffentlicher Freigaben, API, Mobile-App-Zugriff) läuft
komplett unverändert über die App selbst, ganz ohne Traefik-Middleware.
Kein Bypass-Pfad nötig, weil gar nichts blockiert wird, was nicht sowieso
schon durch die App selbst geschützt ist.

---

## Allgemeines Muster — betrifft nicht nur Immich/Nextcloud

Dieselbe Entscheidungslogik gilt für **jede** App mit einer öffentlichen
oder gast-nutzbaren Teilfunktion, nicht nur für Fotos/Dateien-Teilen:

- **Zammad** (`support-tech.pke-lab.de`, externe Ticket-Einreichung ohne
  Account) — bereits bewusst ohne Authelia belassen. Rückblickend genau
  die richtige Entscheidung nach derselben Logik: ForwardAuth hätte die
  gesamte Domain gegated, inkl. der öffentlichen Ticket-Einreichung, die ja
  der eigentliche Zweck der externen Freigabe ist. Zammad hat ebenfalls
  OIDC-Unterstützung — falls der interne Agenten-Bereich
  (`zammad.tech.homeserver`) später doch zusätzliche Absicherung braucht,
  wäre OIDC (nicht ForwardAuth) auch hier der richtige Weg, aus genau
  denselben Gründen.
- **Pacman** (`pacman-prod.pke-lab.de`, öffentliches Spiel ohne Login) —
  ebenfalls bereits korrekt ausgenommen. Hier gibt es nicht mal einen
  App-eigenen Login, den man per OIDC ergänzen könnte — ForwardAuth wäre
  hier ohnehin komplett unpassend, da die gesamte App öffentlich sein soll.

**Faustregel für künftige Entscheidungen:** ForwardAuth-Middleware passt
nur für Apps, die **komplett** privat sind (kein öffentlicher/gast-nutzbarer
Pfad) — Uptime Kuma (Admin-Dashboard, öffentliche Status-Page ist ohnehin
ein separater, unveränderter Host) und Mealie passen deshalb weiterhin gut.
Sobald eine App eine öffentliche Teilfunktion *innerhalb* derselben
App/Domain hat (Immich-Shares, Nextcloud-Freigaben, Zammad-Ticketformular),
ist OIDC (falls die App es unterstützt) oder schlicht kein Authelia davor
die bessere Wahl — ForwardAuth kann diese Fälle strukturell nicht sauber
abbilden, siehe Begründung oben.

---

## Immich

| Option | Wie | Öffentliche Shares | Aufwand | Sicherheit für den Rest |
|---|---|---|---|---|
| **OIDC (empfohlen)** | Authelia als OIDC-Provider, Immich hat natives OAuth/OIDC-Login ([docs.immich.app/administration/oauth](https://docs.immich.app/administration/oauth/)) — zusätzlicher Login-Button, ersetzt Immichs eigenen Login nicht | Komplett unberührt — kein ForwardAuth mehr vor der Domain | Mittel (OIDC-Client in Authelia + Immich-Setting) | 2FA-fähig für den Owner-Login, App-eigener Login bleibt parallel bestehen |
| `immich-share-proxy` | Community-Tool ([11notes/immich-share-proxy](https://hub.docker.com/r/11notes/immich-share-proxy), GPL-3.0, aktiv gepflegt, ~56★), separater Container, bedient NUR `/share` mit eigener schlanker Oberfläche statt Immichs API, Traefik routet `/share` ohne Middleware dorthin, `/` bleibt per ForwardAuth geschützt | Funktioniert, weil der Proxy die Autorisierung selbst prüft statt Immichs Roh-API durchzureichen | Mittel — dritte Komponente, eigene Wartung/Updates, kein offizieller Immich-Bestandteil | Gut, solange der Proxy selbst fehlerfrei ist (externe Abhängigkeit) |
| Kein Authelia vor Immich | Wie Zammad — App-eigener Login (E-Mail/Passwort, optional 2FA) bleibt einziger Schutz | Unberührt | Keiner | Kein zusätzlicher Schutz über Immichs eigenen Login hinaus |
| Zwei Hosts (voller Bypass) | Wie ursprünglich bei Mealie/Uptime Kuma | Erreichbar, aber genauso die GANZE App | Gering | **Nicht empfohlen** — sicherheitstechnisch kaum besser als "kein Authelia", nur unauffälliger |
| Pfad-Bypass `/share` bzw. `/api` | — | — | — | **Nicht empfohlen** — echtes Sicherheitsloch (siehe oben), in der Community als nicht funktionierend dokumentiert |

**Empfehlung:** OIDC. Löst das Problem strukturell (kein Bypass-Pfad nötig,
kein Sicherheitsloch, keine dritte Komponente), Immich unterstützt es
nativ. `immich-share-proxy` ist die zweitbeste Option, falls OIDC aus
irgendeinem Grund nicht gewünscht ist.

---

## Nextcloud

Kein Nextcloud-Äquivalent zu `immich-share-proxy` gefunden — Nextclouds
Freigabe-Feature hängt enger mit dem Rest der App zusammen (WebDAV, OCS-API,
`files_sharing`-App), ein sicherer schlanker Proxy dafür wäre selbst
gebaut nicht trivial.

| Option | Wie | Öffentliche Freigaben | Aufwand | Sicherheit für den Rest |
|---|---|---|---|---|
| **OIDC (empfohlen)** | Authelia als OIDC-Provider, Nextcloud-App `user_oidc` (offiziell, im App-Store), zusätzlicher Login-Button ([Authelia-Doku zu Nextcloud-OIDC](https://www.authelia.com/integration/openid-connect/nextcloud/)) | Komplett unberührt — kein ForwardAuth mehr vor der Domain | Mittel (OIDC-Client in Authelia + `user_oidc`-App-Konfiguration) | 2FA-fähig für den Owner-Login, App-eigener Login bleibt parallel bestehen |
| Kein Authelia vor Nextcloud | Wie Zammad — App-eigener Login bleibt einziger Schutz | Unberührt | Keiner | Kein zusätzlicher Schutz über Nextclouds eigenen Login hinaus |
| Zwei Hosts (voller Bypass) | Wie ursprünglich versucht | Erreichbar, aber genauso die GANZE App | Gering | **Nicht empfohlen** — siehe Immich-Begründung, hier identisch |
| Pfad-Bypass `/s/`, `/public.php/*` | Regex-Bypass-Regeln für die öffentlichen Share-Pfade | Möglicherweise funktionsfähig für reines Anschauen/Runterladen einer Freigabe | Hoch — viele Pfade (`/s/`, `/public.php/webdav`, `/public.php/dav`, `/ocs/v2.php/apps/files_sharing/...`, dazugehörige statische Assets), in der Community nicht als vollständig funktionierend dokumentiert, Mobile-/Desktop-Sync-Client-Login bricht nachweislich separat ([authelia/authelia #2557](https://github.com/authelia/authelia/issues/2557)) | Fragil — hohes Risiko, eine Lücke zu übersehen (offen zu lassen, was privat bleiben sollte) oder eine Funktion zu übersehen (Freigabe, die doch nicht erreichbar ist) |

**Empfehlung:** OIDC, aus denselben Gründen wie bei Immich. Falls OIDC
nicht gewünscht ist, ist "kein Authelia vor Nextcloud" (wie bei Zammad) die
nächstsichere, robusteste Option — die Pfad-Bypass-Variante würde ich nicht
empfehlen, weil sie in der Community nachweislich nicht zuverlässig
funktioniert.

---

## Umsetzung (falls OIDC gewählt wird)

1. **Authelia-Config erweitern** um `identity_providers.oidc` — braucht
   einen HMAC-Secret + ein Schlüsselpaar (RSA/ECDSA) für Token-Signierung,
   zusätzlich zu den bereits bestehenden Secrets. Neue Secrets, per
   `kubeseal` versiegeln, gleiches Muster wie bisher.
2. **Pro App ein OIDC-Client** in Authelias Config: `client_id`,
   `client_secret` (gehasht hinterlegt), `redirect_uris` (App-spezifisch,
   z. B. Immichs `app.immich:///oauth-callback` fürs Handy plus
   `https://immich.prod.homeserver/auth/login` fürs Web), `scopes`
   (`openid email profile`).
3. **App-seitige Aktivierung:**
   - Immich: Admin-Settings → OAuth, Issuer-URL (Authelias
     `.well-known/openid-configuration`), Client-ID/Secret eintragen.
   - Nextcloud: `user_oidc`-App installieren (offizieller App-Store-Eintrag),
     dort Provider mit denselben Werten anlegen.
4. **ForwardAuth-Middleware entfernen** (bereits erledigt — beide Apps
   liegen aktuell ohne Middleware).
5. **Lokal validieren, bevor es in den Cluster geht** — gleiche Disziplin
   wie beim bisherigen Rollout (`authelia config validate` gegen die neue
   `identity_providers.oidc`-Sektion, idealerweise auch ein echter
   Docker-Login-Test gegen eine lokale Immich/Nextcloud-Instanz, falls das
   in vertretbarem Aufwand nachstellbar ist).
6. **Doku:** neue Seite `docs/d-sicherheit/d0073-oidc-immich-nextcloud.md`
   (Typ A, Setup-Schritte, Client-IDs, Troubleshooting) nach Umsetzung.

**Kein Ausbau der bestehenden ForwardAuth-Middleware nötig** — Uptime Kuma
und Mealie bleiben unverändert wie sie sind (kein öffentliches
Sharing-Feature, ForwardAuth passt dort weiterhin).

---

## Offene Fragen für die nächste Runde

- OIDC für beide Apps, oder nur für eine (z. B. erstmal nur Immich testen)?
- Soll der App-eigene Login (E-Mail/Passwort) bei Immich/Nextcloud danach
  deaktiviert werden (nur noch OIDC), oder als Fallback bestehen bleiben
  (empfohlen, analog zum "admin"-Fallback-Prinzip bei Authelia selbst)?
- `immich-share-proxy` als Ausweichoption im Hinterkopf behalten, falls
  sich OIDC in der Praxis doch als zu aufwendig erweist.
