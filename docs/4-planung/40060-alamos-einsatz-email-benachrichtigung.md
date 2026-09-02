# Planung: Einsatz-Alarm → E-Mail mit den wichtigsten Einsatzdaten

**Status: umgesetzt, mit offenen Nachschärfungen.** Statt einer eigenen
Mail-Logik wurde die Zustellung — wie bei den bestehenden n8n→Zammad-
Workflows in diesem Repo — über ein Zammad-Ticket gelöst (Zammads eigene
Agenten-Benachrichtigung verschickt dann die Mail, kein eigener
E-Mail-Node nötig). Umsetzung, Setup-Anleitung und Fehlerbehebung:
[docs/3-apps-workloads/300h0-alamos-einsatz-zammad.md](../3-apps-workloads/300h0-alamos-einsatz-zammad.md),
Workflow: `argocd/apps/workloads/n8n/workflows/alamos-einsatz-to-zammad.json`.
Weil die exakten Webhook-Feldnamen (siehe unten) ohne Alamos-Login nicht zu
ermitteln waren, gibt der Workflow bewusst **alle** empfangenen Felder aus,
statt nur eine feste Auswahl. Die unten stehende Recherche und die offenen
Punkte gelten weiterhin — insbesondere die Rückmeldungen-API ist noch
**nicht** angebunden.

---

Ursprüngliches Ziel: Kommt über ALAMOS AMweb ein echter Einsatz (Alarm)
rein, sollen die wichtigsten Einsatzdaten automatisch zugestellt werden —
zusätzlich zur bestehenden Anzeige auf den Kiosk-Monitoren
([30010-alamos-apager.md](../3-apps-workloads/30010-alamos-apager.md),
[30020-vereinsheim-alarmmonitor.md](../3-apps-workloads/30020-vereinsheim-alarmmonitor.md)).

Dieses Dokument ist der **erste Schritt**: klären, welche Einsatzdaten sich
über den Alarmmonitor überhaupt abgreifen lassen, bevor Architektur/Umsetzung
festgelegt werden. Es gibt bereits eine Vorrecherche dazu in
`IdeasToDeploy.md` (Abschnitt "Einsatzbereich") — dieses Dokument fasst sie
zusammen, ergänzt sie um öffentlich zugängliche ALAMOS-Handbuch-Treffer und
zeigt auf, was davon nur mit eingeloggtem Alamos-Account zu klären ist.

**Ergebnis vorweg:** Die Kiosk-Pis selbst wissen aktuell nichts über
Einsatzinhalte — sie zeigen nur die AMweb-Seite an
([30010-alamos-apager.md, Übersicht & Architektur](../3-apps-workloads/30010-alamos-apager.md#übersicht--architektur)).
ALAMOS/AMweb bietet zwar mehrere Schnittstellen, um Alarmdaten aktiv
herauszubekommen — die exakten Feldnamen/Platzhalter sind aber nicht
öffentlich dokumentiert, sondern nur in der (eingeloggten) Webhook-Konfiguration
eures Alamos-Accounts über eine "Vorschau"/"Webhook Test"-Funktion einsehbar.
Bevor Feldauswahl und Architektur final feststehen, muss also einmal jemand
mit Alamos-Login in die Webhook-Konfiguration schauen.

---

## Inhaltsverzeichnis

1. [Was ich geprüft habe](#was-ich-geprüft-habe)
2. [Schnittstellen-Übersicht](#schnittstellen-übersicht)
3. [Welche Einsatzdaten es grundsätzlich gibt](#welche-einsatzdaten-es-grundsätzlich-gibt)
4. [Offene Punkte — nur mit Alamos-Login zu klären](#offene-punkte--nur-mit-alamos-login-zu-klären)
5. [Architektur-Überlegungen (vorläufig)](#architektur-überlegungen-vorläufig)
6. [Nächster Schritt](#nächster-schritt)

---

## Was ich geprüft habe

- Bestehenden Code/Doku im Repo durchsucht: `alamos-apager` (Helm-Chart,
  `argocd/apps/workloads/alamos-apager/`) macht aktuell nur Redirect +
  Heartbeat/Ausfall-Erkennung, fasst keine Einsatzinhalte an — siehe
  [30010-alamos-apager.md](../3-apps-workloads/30010-alamos-apager.md).
  Die `alamos_kiosk`-Ansible-Rolle (`ansible/roles/alamos_kiosk/`) startet
  nur Chromium im Kiosk-Modus gegen diese Redirect-URL, liest selbst nichts
  aus der Seite.
- Öffentlich erreichbare Seiten des Alamos-Handbuchs
  (`alamos-support.atlassian.net/wiki/...`) abgerufen. Mehrere davon sind
  nur als Übersicht/Inhaltsverzeichnis öffentlich sichtbar, die technischen
  Details (genaue Platzhalter, Beispiel-Payloads) liegen hinter dem
  Alamos-Login — deckt sich mit dem, was in `IdeasToDeploy.md` schon notiert
  war ("Details liegen hinter dem Alamos-Login").

## Schnittstellen-Übersicht

| Schnittstelle | Richtung | Auslöser | Eignung |
|---|---|---|---|
| **AMweb-Seiten-Webhook** ([Handbuch](https://alamos-support.atlassian.net/wiki/spaces/documentation/pages/2406318090/)) | Push, GET | Feuert **aus dem Browser-Tab heraus**, bei jedem neuen Alarm ("NEW") und wenn kein Alarm mehr offen ist | Grundsätzlich geeignet, aber: feuert aus dem Kiosk-Chromium selbst — lokale Ziel-URLs werden vom Browser i. d. R. blockiert (Handbuch-Warnung); Ziel muss eine "echte" HTTPS-URL sein |
| **Allgemeine Webhooks** ([Handbuch](https://alamos-support.atlassian.net/wiki/spaces/documentation/pages/2638086145/Webhooks)) | Push, GET oder POST (JSON-Body bei POST) | Nur "echte" Alarme (Tab "Alarm"), keine Info/Wetter/Status-Meldungen | Vermutlich Account-/Konto-Ebene statt Browser-Tab-Ebene — genau das ist einer der offenen Punkte unten (relevant für Duplikate, siehe Architektur-Überlegungen) |
| **Monitoring-Schnittstelle** ([Handbuch](https://alamos-support.atlassian.net/wiki/spaces/documentation/pages/1683226637/Monitoring-Schnittstelle)) | Pull, HTTP GET mit Access-Key, Text oder JSON | Auf Abruf | **Nicht geeignet** — laut Handbuch für System-/Ausfallstatus gedacht (Endpunkte wie `/rest/monitoring/status`, `/rest/monitoring/system`), nicht für Einsatzinhalte |
| **JSON-Plugin / "Datenformat Externe Schnittstelle"** ([Handbuch](https://alamos-support.atlassian.net/wiki/spaces/documentation/pages/219480068/Datenformat+Externe+Schnittstelle)) | eingehend (andere Systeme → Alamos) | — | **Nicht geeignet** — das ist die umgekehrte Richtung: damit alarmiert *man* über Alamos, nicht umgekehrt |
| **API – Abrufen von Rückmeldungen alarmierter Personen** ([Handbuch](https://alamos-support.atlassian.net/wiki/spaces/documentation/pages/3049226241/API+-+Abrufen+von+R+ckmeldungen+alarmierter+Personen)) | Pull, GET `.../rest/addressbook/external/{alarmId}/feedback`, Access-Key im Header | Auf Abruf, pro `alarmId` | **Beantwortet "wer hat sich zurückgemeldet"** — siehe eigener Abschnitt unten |

Kurz: Für die Einsatzdaten selbst kommen die beiden **Webhook-Varianten**
infrage, für die Rückmeldungen zusätzlich die Feedback-API — nicht die
Monitoring- oder JSON-Plugin-Schnittstelle.

## Rückmeldungen alarmierter Personen ("wer kommt")

Zusätzlich zu den reinen Einsatzdaten lässt sich laut Handbuch auch
abrufen, wer sich auf den Alarm zurückgemeldet hat — das zeigt der
Alarmmonitor ja ebenfalls an. Dafür gibt es eine eigene, öffentlich
dokumentierte API (Details unter obigem Link):

```
GET http(s)://[FE2]:[PORT]/rest/addressbook/external/{alarmId}/feedback
Authorization: <Organisations-Access-Key>
```

Antwort: JSON-Array, pro Person u. a. `name`, `groups` (Einheit/Gruppe),
`functions` (Rolle, z. B. "AGT"), `state` (`"YES"`/`"NO"`),
`timeOfUpdate`.

**Zwei Einschränkungen, die noch zu klären sind** (siehe auch offene Punkte
unten):

1. Der Aufruf braucht eine **`alarmId`**. Laut Handbuch stammt die aus
   einem zuvor über die API erzeugten Alarm (Parameter `externalId`) — ob
   ein ganz normaler Leitstellen-Alarm (nicht selbst über die API
   ausgelöst) ebenfalls eine nutzbare `alarmId` hat bzw. ob die im
   Webhook-Payload mitgeliefert wird, ist offen.
2. Laut Handbuch **"nur für Online-Service-Organisationen"** — ob euer
   Account darunterfällt, ist ebenfalls offen.
3. Daten sind laut Handbuch **nicht Echtzeit** — ggf. sind wiederholte
   Abfragen nötig, bis sich der Rückmeldestand vervollständigt (z. B. kurz
   nach der ersten Mail nochmal nachfragen/aktualisieren).

## Welche Einsatzdaten es grundsätzlich gibt

Die exakten Platzhalter-/JSON-Feldnamen der Webhooks sind nicht öffentlich
einsehbar. Aus der Struktur der AMweb-Alarmanzeige selbst (Handbuch-Seite
["Alarmanzeige"](https://alamos-support.atlassian.net/wiki/spaces/documentation/pages/992346261/Alarmanzeige),
gegliedert in Titelleiste / Karte / Fußleiste / rechtes Menü) sowie
allgemeiner ALAMOS-Fachkenntnis lässt sich die Kategorien-Liste ableiten, die
bei einem Einsatz typischerweise vorhanden ist:

| Kategorie | Beispiel |
|---|---|
| Einsatzstichwort | z. B. "B2 Brand Gebäude" |
| Alarmzeit | Zeitstempel des Alarmeingangs |
| Einsatzort/Adresse | Straße, Hausnummer, Ort |
| Objekt/Ortsangabe | Gebäude-/Objektname, falls hinterlegt |
| Meldebild / Alarmtext | Freitext der Leitstelle |
| Alarmierte Einheiten/Fahrzeuge | z. B. Funkrufname, Fahrzeugliste |
| Einsatznummer | interne/externe Kennung |
| Koordinaten / Kartenausschnitt | für Kartendarstellung |
| Zusatzinfos | je nach Leitstellen-Konfiguration variabel |

**Wichtig:** Das ist eine Kategorien-Liste zur Orientierung, keine Garantie,
dass jedes Feld auch tatsächlich als Webhook-Platzhalter existiert oder bei
eurer Leitstelle befüllt wird — das hängt von der Konfiguration eurer
ALAMOS-Instanz ab.

## Offene Punkte — nur mit Alamos-Login zu klären

Diese Fragen lassen sich nicht aus öffentlicher Doku oder dem Repo
beantworten, sondern nur direkt in eurem Alamos-Account:

1. **Exakte Platzhalter/Feldnamen des Webhooks.** In der
   Webhook-Konfiguration (AMweb-Seiteneinstellung *oder* "Allgemeine
   Webhooks" im Admin-Bereich) gibt es laut Handbuch eine
   Vorschau-/"Webhook Test"-Funktion, die das tatsächliche Format anzeigt.
2. **Browser-Tab- vs. Konto-Ebene.** Feuert der Webhook pro AMweb-Kiosk-Tab
   (dann bei 3 Standorten = 3 Auslösungen pro echtem Einsatz, siehe
   [30010](../3-apps-workloads/30010-alamos-apager.md) für die
   Standort-Liste) oder zentral einmal pro Konto? Bestimmt nicht nur, ob im
   Zielsystem eine Duplikat-Erkennung nötig ist (z. B. über Einsatznummer +
   Alarmzeit als Idempotenz-Schlüssel), sondern auch, **ob die Ziel-URL
   öffentlich erreichbar sein muss**: Für die AMweb-Seiteneinstellung ist
   dokumentiert, dass der Aufruf aus dem Browser-Tab (Kiosk-Chromium, im
   LAN/Tailscale) feuert — dafür reicht die interne URL
   `n8n.prod.homeserver`. Ob "Allgemeine Webhooks" stattdessen
   server-seitig direkt von Alamos' Cloud aus feuert (und damit eine
   öffentliche URL bräuchte, die n8n aktuell bewusst nicht hat — siehe
   [300h0-alamos-einsatz-zammad.md, Architektur](../3-apps-workloads/300h0-alamos-einsatz-zammad.md#architektur)),
   war öffentlich nicht zu klären. **Deshalb aktuelle Empfehlung/Umsetzung:
   AMweb-Seiteneinstellung-Webhook verwenden**, nicht "Allgemeine
   Webhooks", solange das nicht geklärt ist.
3. **GET vs. POST bei "Allgemeine Webhooks".** POST liefert laut
   Handbuch-Snippet ein JSON-Objekt, GET nur Query-Parameter — relevant für
   den Empfänger-Endpunkt.
4. **Ob es einen eingebauten Alarmton/eine eingebaute Mail-Funktion in AMweb
   selbst gibt**, die das Problem ggf. schon teilweise löst (aus
   `IdeasToDeploy.md` übernommen, dort als offene Prüfung notiert).
5. **Ob/wie sich die `alarmId` für die Rückmeldungen-API aus einem normalen
   Leitstellen-Alarm gewinnen lässt** (kommt sie im Webhook-Payload mit,
   oder gilt die Feedback-API nur für Alarme, die selbst über die
   Alamos-API ausgelöst wurden?).
6. **Ob euer Account als "Online-Service-Organisation" zählt** — laut
   Handbuch Voraussetzung für die Rückmeldungen-API.

## Architektur-Überlegungen (vorläufig)

Noch **keine** Festlegung — nur die Bausteine, die aus der bestehenden
Cluster-Architektur naheliegen, damit die Entscheidung nach Klärung der
offenen Punkte schnell fällt:

```
AMweb (Alamos Cloud)
   │  Webhook (GET/POST), nur bei echten Alarmen
   ▼
HTTPS-Ziel, erreichbar aus dem Browser-Tab-Kontext (kein localhost!)
   │  naheliegend: neuer Endpunkt an alamos-apager anhängen
   │  (läuft schon hinter Traefik mit vertrauter CA, siehe 30010)
   ▼
Einsatzdaten-Payload empfangen
   │  ggf. Duplikat-Filter (falls Tab-Ebene, siehe offene Punkte)
   │
   ├─ optional: GET .../feedback/{alarmId}  (Rückmeldungen-API)
   │            → "wer kommt" ergänzen, ggf. mit kurzer Verzögerung/
   │              zweitem Abruf nachziehen (Daten laut Handbuch nicht
   │              Echtzeit) — abhängig von offenen Punkten 5+6 oben
   ▼
E-Mail-Versand
   │  Optionen: (a) direkt per SMTP aus alamos-apager,
   │            (b) über n8n-Workflow (Muster wie
   │                banana-pi-down-to-zammad.json, aber Ziel E-Mail statt
   │                Zammad-Ticket — kein Ticket pro Einsatz gewünscht,
   │                das wäre zu viel Rauschen im Support-System),
   │            (c) über Zammad-Ticket + Agenten-Mail-Benachrichtigung
   │                (bestehendes Muster, aber erzeugt zusätzlich ein
   │                Ticket pro Einsatz — vermutlich nicht gewünscht)
   ▼
Ziel-Mailadresse
```

Tendenz: **(a) oder (b)**, da (c) unnötig ein Zammad-Ticket pro Einsatz
erzeugen würde. Endgültige Wahl hängt auch davon ab, welche Felder wichtig
sind (steuert, wie viel Logik/Formatierung nötig ist) und ob wegen Punkt 2
oben eine Duplikat-Erkennung gebraucht wird (dafür eignet sich ein
zentraler Cluster-Endpunkt ohnehin besser als 3× dieselbe Logik direkt am
Kiosk).

## Nächster Schritt

Bitte im Alamos-Account (Webhook-Konfiguration, AMweb-Seiteneinstellung
oder "Allgemeine Webhooks" im Admin-Bereich) die Vorschau/"Webhook Test"
öffnen und schauen, welche Platzhalter/Felder dort tatsächlich angeboten
werden — und mir dann sagen, welche davon für die Mail wichtig sind
(z. B. aus der Kategorien-Liste oben: Stichwort, Adresse, Fahrzeuge, ...,
plus: sollen Rückmeldungen/"wer kommt" mit in die Mail?). Für Letzteres
zusätzlich prüfen, ob im Admin-Bereich unter API-Zugängen ein
Organisations-Access-Key für die Rückmeldungen-API vorhanden ist und ob
sich dort erkennen lässt, wie die `alarmId` eines normalen
Leitstellen-Alarms lautet. Danach lässt sich die Architektur oben
festlegen und umsetzen.
