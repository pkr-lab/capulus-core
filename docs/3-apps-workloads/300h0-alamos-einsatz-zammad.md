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

```
ALAMOS AMweb (Cloud-Dienst)
   │  Webhook, GET oder POST, nur bei echten Alarmen
   │  (AMweb-Seiteneinstellung ODER "Allgemeine Webhooks" im Alamos-Admin)
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
Zammad-Ticket erstellen (POST /api/v1/tickets, Gruppe Support::Administration)
   │
   ▼
Zammads Agenten-Benachrichtigung → Mail an info@edv-kretzer.de
```

Workflow-Datei:
`argocd/apps/workloads/n8n/workflows/alamos-einsatz-to-zammad.json`.

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
   vorhanden (falls schon für `banana-pi-down-to-zammad.json`
   eingerichtet, siehe
   [30020-vereinsheim-alarmmonitor.md, Zammad-Ticket via n8n](30020-vereinsheim-alarmmonitor.md#zammad-ticket-via-n8n),
   kann dieselbe Credential wiederverwendet werden). Sonst neu erzeugen wie
   in [f0040-github-release-watcher.md, Schritt 1](../f-cicd-automatisierung/f0040-github-release-watcher.md#schritt-1--zammad-api-token-erzeugen)
   beschrieben.
2. **n8n:** `alamos-einsatz-to-zammad.json` importieren, im Node
   "Zammad-Ticket erstellen" die Header-Auth-Credential "Zammad API Token"
   zuweisen (Header-Name `Authorization`, Value
   `Token token=<ZAMMAD_TOKEN>`) — Credential-IDs werden beim Import nicht
   übernommen, normaler Post-Import-Schritt.
3. Workflow in n8n **aktivieren** (Import allein reicht nicht).
4. Webhook-URL kopieren: `http://n8n.prod.homeserver/webhook/alamos-einsatz`.
5. **Im Alamos-Account** (mit eurem bestehenden Login): Webhook-Konfiguration
   öffnen (AMweb-Seiteneinstellung oder "Allgemeine Webhooks" im
   Admin-Bereich), obige URL als Ziel eintragen. Dabei gleich in der
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
| n8n-Workflow schlägt am Zammad-Node fehl | Header-Auth-Credential zugewiesen? Token gültig/`ticket.agent`-Berechtigung? |
| Webhook kommt gar nicht in n8n an | `alamos-einsatz-get`/`alamos-einsatz-post` — läuft der Kiosk/AMweb-Zugriff über dieselbe `*.homeserver`-Route wie sonst? (Tailscale Split-DNS bei `vereinsheim-alarmmonitor`, siehe [30020](30020-vereinsheim-alarmmonitor.md#netzwerk-tailscale-only)) |

## Relevante Links

- [docs/4-planung/40060-alamos-einsatz-email-benachrichtigung.md](../4-planung/40060-alamos-einsatz-email-benachrichtigung.md) — Recherche zu ALAMOS-Schnittstellen, offene Fragen
- [docs/3-apps-workloads/30010-alamos-apager.md](30010-alamos-apager.md) — Basis-Architektur (Kiosk-Anzeige)
- [docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md, Zammad-Ticket via n8n](30020-vereinsheim-alarmmonitor.md#zammad-ticket-via-n8n) — analoges Vorbild-Muster (Ausfall statt Einsatz)
- [docs/3-apps-workloads/30070-n8n.md](30070-n8n.md) — n8n-Setup
- [docs/f-cicd-automatisierung/f0040-github-release-watcher.md](../f-cicd-automatisierung/f0040-github-release-watcher.md) — Zammad-API-Token/Gruppe/Requester-Regeln
