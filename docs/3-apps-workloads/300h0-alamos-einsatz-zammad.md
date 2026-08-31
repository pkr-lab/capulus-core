# ALAMOS-Einsatzalarm → Zammad-Ticket (n8n)

Erweitert die reine Kiosk-Anzeige aus
[30010-alamos-apager.md](30010-alamos-apager.md) um eine
Push-Benachrichtigung: Kommt in ALAMOS AMweb ein echter Einsatz rein, legt
ein n8n-Workflow automatisch ein Zammad-Ticket mit den mitgelieferten
Einsatzdaten an — die Mail-Benachrichtigung übernimmt danach Zammads
eigene Agenten-Benachrichtigung, wie bei den anderen n8n→Zammad-Workflows
in diesem Repo (siehe [30070-n8n.md](30070-n8n.md)).

**Wichtige Einschränkung, bevor ihr das aufsetzt:** Welche Felder ALAMOS
AMweb im Webhook tatsächlich mitliefert (Adresse, Fahrzeuge, Meldebild,
...), war ohne einen eingeloggten Alamos-Account nicht zu ermitteln — nur
`keyword` (Einsatzstichwort) und `unit` (Einheit) sind laut öffentlichem
Handbuch als Standard-Platzhalter dokumentiert. Der Workflow ist deshalb
bewusst **datenoffen** gebaut: er gibt *alle* Felder aus, die der Webhook
mitliefert, unabhängig davon, wie sie heißen. Die vollständige Recherche
inkl. offener Fragen steht in
[docs/4-planung/40060-alamos-einsatz-email-benachrichtigung.md](../4-planung/40060-alamos-einsatz-email-benachrichtigung.md).

## Architektur

**Der einzige Auslöser dieses Workflows ist der ALAMOS-Webhook selbst —
kein Polling.** Ohne die Ziel-URL im Alamos-Account einzutragen (siehe
[Einrichtung](#einrichtung), Schritt 5) läuft der Workflow nie an und es
entsteht nie ein Ticket, egal wie viele echte Einsätze reinkommen.

**Empfehlung: AMweb-Seiteneinstellung-Webhook nutzen, nicht "Allgemeine
Webhooks"** — nur für Ersteren ist öffentlich dokumentiert, dass der Aufruf
**aus dem Browser-Tab heraus** feuert, also von der Kiosk-Chromium-Session
selbst, die ohnehin schon im LAN/Tailscale hängt und `*.homeserver`
auflöst (identisch dazu, wie der Kiosk die echte AMweb-Seite lädt). Die
interne URL `n8n.prod.homeserver` reicht dafür aus, **keine öffentliche
Erreichbarkeit nötig**. Bei "Allgemeine Webhooks" (Account-Ebene) war
öffentlich nicht zu klären, ob der Call stattdessen von Alamos'
Cloud-Servern selbst kommt (also wirklich aus dem öffentlichen Internet) —
falls ja, würde `n8n.prod.homeserver` **nicht** funktionieren: n8n wurde
bewusst aus dem Cloudflare-Tunnel entfernt (siehe
`argocd/apps/workloads/n8n/values.yaml`, Kommentar bei `env.N8N_HOST`) und
ist absichtlich nur intern erreichbar. Öffentliche Freigabe (und sei es nur
dieses eine Webhook-Pfads über einen neuen Cloudflare-Tunnel-Eintrag, siehe
[e0000-cloudflare-tunnel.md](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md))
wäre eine bewusste Sicherheitsentscheidung, die hier nicht vorweggenommen
wird — falls "Allgemeine Webhooks" gewünscht ist, das bitte vorher
absprechen.

**Zusätzliches Risiko, unabhängig von der Webhook-Variante — Private
Network Access:** Die AMweb-Seite selbst wird von einer öffentlichen
Origin (`amweb.alamos.cloud` o. ä.) geladen. Moderne Chromium-Versionen
blockieren per **Private Network Access** standardmäßig JS-Requests
(`fetch`/XHR) von einer öffentlichen Seite zu einer **privaten**
Netzwerk-Adresse — und `n8n.prod.homeserver` löst intern auf eine private
IP auf. Das deckt sich vermutlich mit der Handbuch-Warnung "Aufruf lokaler
URLs... wird i. d. R. vom Browser aus Sicherheitsgründen blockiert" (die
könnte mehr meinen als nur `localhost`). Ob die konkrete
Chromium-Version auf den Kiosk-Pis (`chromium-browser`-Paket, Raspberry Pi
OS bzw. Armbian) das tatsächlich blockt, lässt sich nur durch einen
Testlauf klären (siehe Fehlerbehebung, "Webhook kommt gar nicht in n8n
an"). Blockt der Browser den Call, hilft nur eine öffentlich erreichbare
Ziel-URL — dieselbe Sicherheitsabwägung wie oben bei "Allgemeine
Webhooks".

```
ALAMOS AMweb (Cloud-Dienst)
   │  Webhook, GET oder POST, nur bei echten Alarmen
   │  (AMweb-Seiteneinstellung ODER "Allgemeine Webhooks" im Alamos-Admin)
   │  Ziel-URL MUSS dort eingetragen sein, siehe Einrichtung Schritt 5
   ▼
http://n8n.prod.homeserver/webhook/alamos-einsatz
   │
   ├─ Webhook (GET)  ─┐
   ├─ Webhook (POST) ─┤  beide Trigger teilen sich denselben Pfad
   │                   ▼
   │        Code-Node "Einsatzdaten aufbereiten"
   │          - führt Query-Parameter (GET) und JSON-Body (POST) zusammen
   │          - baut Ticket-Titel aus keyword/unit, falls vorhanden
   │          - gibt ALLE empfangenen Felder unverändert im Ticket-Text aus
   │          - filtert Mehrfach-Auslösungen desselben Alarms innerhalb von
   │            2 Minuten (Workflow-Static-Data, siehe unten)
   ▼
Zammad-Ticket erstellen (nativer n8n-nodes-base.zammad-Node, Ticket→Create,
                          Gruppe Support::Administration)
   │
   ▼
Zammads Agenten-Benachrichtigung → Mail an info@edv-kretzer.de
```

Workflow-Datei:
`argocd/apps/workloads/n8n/workflows/alamos-einsatz-to-zammad.json`.
Nutzt bewusst den **nativen `n8n-nodes-base.zammad`-Node** (wie
`nightly-worker-update-to-zammad.json`/`yearly-secrets-rotation-reminder.json`),
nicht den rohen HTTP-Request-Node wie im älteren
`banana-pi-down-to-zammad.json` — andere Credential (Typ „Zammad Token Auth
API“ statt Header-Auth), siehe Einrichtung.

### Warum zwei Webhook-Trigger auf demselben Pfad

Ob eure Alamos-Konfiguration den Alarm per GET (Query-Parameter) oder POST
(JSON-Body) verschickt, hängt davon ab, welche der beiden
Webhook-Varianten ihr einrichtet (siehe Planungsdokument). Beide
Trigger-Nodes registrieren denselben Pfad `alamos-einsatz`, aber
unterschiedliche HTTP-Methoden — dadurch funktioniert der Workflow mit
beiden Varianten, ohne dass vorher geklärt sein muss, welche ihr nutzt.

### Duplikat-Schutz

Falls der Webhook **pro geöffnetem Kiosk-Tab** feuert (statt zentral einmal
pro Konto — auch das ist eine der offenen Fragen im Planungsdokument),
würden bei bis zu drei gleichzeitig laufenden Alarmmonitor-Standorten
([30010](30010-alamos-apager.md), [30020](30020-vereinsheim-alarmmonitor.md))
bis zu drei Tickets für denselben Einsatz entstehen. Der Code-Node merkt
sich deshalb `Stichwort|Einheit` (oder den kompletten Payload, falls
`keyword`/`unit` fehlen) für 2 Minuten in n8n-Workflow-Static-Data und
überspringt inhaltsgleiche Wiederholungen innerhalb dieses Fensters —
**wichtig:** Das ist reiner In-Memory-Zustand, ein n8n-Neustart löscht ihn
(unkritisch, da echte Mehrfach-Auslösungen desselben Alarms innerhalb von
Sekunden eintreffen, nicht nach einem Neustart).

## Einrichtung

1. **Voraussetzung:** Zammad-API-Token mit Berechtigung `ticket.agent`
   vorhanden. **Achtung:** Der native Zammad-Node braucht eine Credential
   vom Typ **„Zammad Token Auth API"** (`zammadTokenAuthApi`) — das ist
   ein anderer Credential-**Typ** als die Header-Auth-Credential "Zammad
   API Token", die `banana-pi-down-to-zammad.json` nutzt; die beiden lassen
   sich nicht wiederverwenden, auch wenn derselbe Zammad-Token dahinter
   stehen kann. Falls schon für `nightly-worker-update-to-zammad.json` oder
   `yearly-secrets-rotation-reminder.json` eine Credential dieses Typs
   angelegt wurde (z. B. "Zammad Token Auth (Rotation-Reminder)"), kann die
   wiederverwendet werden, sofern sie auf dieselbe Zammad-Instanz zeigt.
   Sonst Token neu erzeugen wie in
   [f0040-github-release-watcher.md, Schritt 1](../f-cicd-automatisierung/f0040-github-release-watcher.md#schritt-1--zammad-api-token-erzeugen)
   beschrieben, Credential in n8n neu anlegen: Typ "Zammad Token Auth API",
   Base URL `http://zammad.tech.homeserver`, Access Token aus Schritt 1.
2. **n8n:** `alamos-einsatz-to-zammad.json` importieren, im Node
   "Zammad-Ticket erstellen" die Credential aus Schritt 1 zuweisen —
   Credential-IDs werden beim Import nicht übernommen, normaler
   Post-Import-Schritt.
3. Workflow in n8n **aktivieren** (Import allein reicht nicht).
4. Webhook-URL kopieren: `http://n8n.prod.homeserver/webhook/alamos-einsatz`.
5. **Im Alamos-Account** (mit eurem bestehenden Login) — **dieser Schritt
   ist zwingend, ohne ihn feuert der Workflow nie**: Webhook-Konfiguration
   **der AMweb-Seiteneinstellung** öffnen (nicht "Allgemeine Webhooks",
   siehe Begründung oben unter Architektur — sonst evtl. öffentliche
   Erreichbarkeit nötig), obige URL als Ziel eintragen. Dabei gleich in der
   Vorschau/"Webhook Test" nachsehen, welche Platzhalter tatsächlich
   angeboten werden — das beantwortet die im Planungsdokument offene Frage
   nach den exakten Feldnamen.
6. **Zammad:** Sicherstellen, dass `info@edv-kretzer.de` (oder die
   gewünschte Zieladresse) Agent in der Gruppe `Support::Administration`
   ist und unter **Profil → Benachrichtigungen** die Mail-Benachrichtigung
   für "Neues Ticket" aktiviert hat (Zammad-Standard: aktiviert).
7. Testauslösung: entweder auf einen echten Einsatz warten, oder — falls
   Alamos eine "Webhook Test"-Funktion in der Konfiguration anbietet —
   darüber einen Testaufruf schicken.

## Anpassungen

- **Andere Zammad-Gruppe/Empfänger:** `ZAMMAD_GROUP` /
  `ZAMMAD_REQUESTER_EMAIL` am Kopf des Code-Node "Einsatzdaten
  aufbereiten" ändern. `ZAMMAD_REQUESTER_EMAIL` muss ein bereits
  existierender Zammad-User sein (siehe
  [f0040, Schritt 3](../f-cicd-automatisierung/f0040-github-release-watcher.md#schritt-3--valuesyaml-anpassen)
  für die Details zu dieser Einschränkung).
- **Dedup-Fenster ändern:** `DEDUP_WINDOW_MS` im selben Code-Node.
- **Rückmeldungen ("wer kommt") ergänzen:** Noch nicht umgesetzt — hängt an
  zwei ungeklärten Voraussetzungen (passende `alarmId` aus dem
  Webhook-Payload, "Online-Service"-Accountstatus), siehe Abschnitt
  "Rückmeldungen alarmierter Personen" im Planungsdokument.

## Fehlerbehebung

| Symptom | Check |
|---|---|
| Kein Zammad-Ticket bei echtem Einsatz | Workflow in n8n aktiv? `kubectl -n n8n logs deploy/n8n` (bzw. n8n-UI → Executions) — kommt der Webhook überhaupt an? |
| n8n-Execution zeigt Fehler "Webhook ohne jegliche Query-/Body-Daten empfangen" | Alamos-Webhook-Konfiguration prüfen — Ziel-URL korrekt, Platzhalter im Body/in der Query wirklich gesetzt? |
| Ticket wird unterdrückt, obwohl es ein neuer Einsatz war | `DEDUP_WINDOW_MS` zu großzügig, oder `keyword`/`unit` fehlen und der Fallback-Payload-Vergleich trifft zufällig — Rohdaten in der n8n-Execution ansehen |
| Ticket erstellt, aber keine Mail | Zammad-Agenten-Mitgliedschaft/Benachrichtigung prüfen (siehe oben), ausgehender E-Mail-Kanal in Zammad konfiguriert? |
| n8n-Workflow schlägt am Zammad-Node fehl | Credential vom Typ "Zammad Token Auth API" zugewiesen (nicht die Header-Auth-Credential aus `banana-pi-down-to-zammad.json`)? Base URL korrekt (`http://zammad.tech.homeserver`)? Token gültig/`ticket.agent`-Berechtigung? |
| Webhook kommt gar nicht in n8n an | `alamos-einsatz-get`/`alamos-einsatz-post` — läuft der Kiosk/AMweb-Zugriff über dieselbe `*.homeserver`-Route wie sonst? (Tailscale Split-DNS bei `vereinsheim-alarmmonitor`, siehe [30020](30020-vereinsheim-alarmmonitor.md#netzwerk-tailscale-only)) |

## Relevante Links

- [docs/4-planung/40060-alamos-einsatz-email-benachrichtigung.md](../4-planung/40060-alamos-einsatz-email-benachrichtigung.md) — Recherche zu ALAMOS-Schnittstellen, offene Fragen
- [docs/3-apps-workloads/30010-alamos-apager.md](30010-alamos-apager.md) — Basis-Architektur (Kiosk-Anzeige)
- [docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md, Zammad-Ticket via n8n](30020-vereinsheim-alarmmonitor.md#zammad-ticket-via-n8n) — analoges Vorbild-Muster (Ausfall statt Einsatz)
- [docs/3-apps-workloads/30070-n8n.md](30070-n8n.md) — n8n-Setup
- [docs/f-cicd-automatisierung/f0040-github-release-watcher.md](../f-cicd-automatisierung/f0040-github-release-watcher.md) — Zammad-API-Token/Gruppe/Requester-Regeln
