# ISC-Urkunden melden — neue Schwimmabzeichen donnerstags per Mail

Donnerstags zwischen 17:30 und 20:00 Uhr prüft n8n alle 10 Minuten, ob in der Urkunden-App des DLRG-ISC (`https://dlrg.net/apps/urkunden`) neue Urkunden angelegt wurden. Gemeldet werden nur **Seepferdchen, Schwimmabzeichen Bronze, Silber, Gold und Juniorretter**, alle anderen Urkunden werden ignoriert. Jede neue Urkunde kommt per Mail mit Name, Geburtsdatum, Abzeichen, Prüfer mit Prüfernummer und Registriernummer.

Das Auslesen übernimmt der bestehende [ISC-News-Bot](300k0-isc-news-bot.md) über den Endpunkt `GET /urkunden`. n8n steuert den Zeitplan, merkt sich die bereits gesehenen Urkunden und verschickt die Mail.

> **Cluster:** TECH · Bot: `argocd/apps/tech/isc-news-bot/` · Workflow: [`argocd/apps/tech/n8n/workflows/isc-urkunden-melden.json`](../../argocd/apps/tech/n8n/workflows/isc-urkunden-melden.json)

---

## Überblick

```
n8n (Do 17:25–20:00, alle 10 min)
  │  GET /urkunden?jahr=2026            Bearer API_TOKEN
  ▼
isc-news-bot ──► Chromium ──► dlrg.net: Login, Gliederung 1002011,
  │                             /apps/urkunden?page=uebersicht,
  │                             dlrg_DoPost("ladeUrkundenListe")
  │  JSON: nur PO 111, 121, 122, 123, 141
  ▼
n8n: Abgleich mit dem Stand vom selben Abend
  ├─ erster Lauf des Abends ─► Stand merken, keine Mail
  ├─ nichts Neues          ─► Ende
  ├─ neue Urkunden         ─► eine Mail mit allen neuen Urkunden
  └─ Fehler vom Bot        ─► ntfy-Topic isc-urkunden
```

## Zeitplan und „neu“

| Uhrzeit (Europe/Berlin, nur donnerstags) | Was passiert |
|---|---|
| 17:25 | Erster Lauf des Abends: alle vorhandenen Urkunden werden als Stand gespeichert, **keine Mail** |
| 17:30, 17:40 … 19:50, 20:00 | Abruf, Vergleich mit dem Stand, Mail nur für Urkunden, die seitdem dazugekommen sind |
| sonst | Der Workflow startet nicht. Selbst wenn er ausgelöst wird, bricht der Node **Konfiguration** außerhalb des Fensters sofort ab |

Urkunden, die vor 17:25 schon im ISC standen (zum Beispiel um 17:00 Uhr), werden also nie gemeldet. Fällt der Lauf um 17:25 aus, wird der erste erfolgreiche Lauf des Abends zum Stand und meldet ebenfalls nichts. Am nächsten Donnerstag beginnt ein neuer Stand, weil das Datum gespeichert ist.

Der Stand liegt in den Static Data des Workflows (`urkundenStand: { datum, ids }`). n8n speichert diese Daten nur bei Läufen eines **aktiven** Workflows, nicht bei manuellen Testläufen.

## Welche Urkunden

Gefiltert wird im Bot nach der Nummer der Prüfungsordnung (`poNr`):

| PO-Nr. | Abzeichen | Ausbildungs-ID im ISC |
|---|---|---|
| 111 | Frühschwimmer (Seepferdchen) | 153 |
| 121 | Deutsches Schwimmabzeichen Bronze (Freischwimmer) | 11 |
| 122 | Deutsches Schwimmabzeichen Silber | 12 |
| 123 | Deutsches Schwimmabzeichen Gold | 13 |
| 141 | Juniorretter | 17 |

„Bronze, Silber, Gold“ bedeutet hier das **Deutsche Schwimmabzeichen**. Die Rettungsschwimmabzeichen (151, 152, 153) sind nicht dabei. Wer andere Abzeichen will, hängt `&ausbildungen=111,121,151` an die URL im Node **Urkunden abrufen**.

Außerdem gilt: nur aktive Urkunden, keine Verlängerungen oder Wiederholungen, nur das laufende Ausstellungsjahr (`jahr`).

## Inhalt der Mail

Eine Mail pro Lauf, darin jede neue Urkunde als Block:

```
Name: Erika Beispiel
Geburtsdatum: 03.04.2019
Abzeichen: Frühschwimmer (Seepferdchen)
Prüfer: Prüferin Muster (10/181/99/01)
Registriernummer: 1002011/111/041/26
```

Betreff bei einer Urkunde: `Neue Urkunde: <Abzeichen> – <Name>`, bei mehreren: `<Anzahl> neue Urkunden im ISC`. Im Testmodus steht `[TEST]` davor. Die Mail geht als Text und HTML raus.

---

## Bot-Endpunkt `GET /urkunden`

Verlangt wie alle Endpunkte `Authorization: Bearer <API_TOKEN>`.

| Parameter | Standard | Bedeutung |
|---|---|---|
| `jahr` | laufendes Jahr | Ausstellungsjahr, vierstellig |
| `ausbildungen` | `111,121,122,123,141` | PO-Nummern, durch Komma getrennt |

Antwort bei Erfolg (`200`):

```json
{
  "ok": true,
  "jahr": "2026",
  "poNummern": ["111", "121", "122", "123", "141"],
  "gelesen": 42,
  "urkunden": [
    {
      "uid": "5001",
      "vorname": "Erika",
      "nachname": "Beispiel",
      "name": "Erika Beispiel",
      "geburtsdatum": "2019-04-03",
      "abzeichen": "Frühschwimmer (Seepferdchen)",
      "poNr": "111",
      "prueferName": "Prüferin Muster",
      "prueferNummer": "10/181/99/01",
      "registriernummer": "1002011/111/041/26",
      "ausgestelltAm": "2026-10-08",
      "pruefungAm": "2026-10-08"
    }
  ],
  "durationMs": 9500
}
```

`gelesen` ist die Zahl aller Einträge, die das ISC geliefert hat, `urkunden` sind nur die passenden. Fehler kommen im selben Format wie bei `GET /categories` (`ok: false`, `errorCode`, `step`, `error`). Ungültige Parameter ergeben `400` mit `VALIDATION_FAILED`.

### So liest der Bot die Liste

Die Übersichtsseite der Urkunden-App lädt ihre Tabelle nicht im HTML, sondern per JavaScript: `ladeUrkunden()` ruft `dlrg_DoPost('/apps/urkunden?page=service', 'ladeUrkundenListe', { jahr, ausbildungId, inaktiveAnzeigen, mitVerlaengerungen }, callback)`. Der Bot ([`src/isc/urkunden.ts`](../../argocd/apps/tech/isc-news-bot/src/isc/urkunden.ts)):

1. meldet sich an und wechselt in die Gliederung `GLIEDERUNG_EDV` (wie beim News-Anlegen),
2. öffnet `/apps/urkunden?page=uebersicht` und wartet, bis `dlrg_DoPost` existiert,
3. ruft im Browser dieselbe Funktion mit `ausbildungId: ""`, `inaktiveAnzeigen: false`, `mitVerlaengerungen: false` auf. So gelten Sitzung, CSRF und Anfrageformat genau wie in der Oberfläche,
4. normalisiert die Einträge und filtert sie ([`src/urkunden.ts`](../../argocd/apps/tech/isc-news-bot/src/urkunden.ts)),
5. meldet sich ab.

Gibt es `dlrg_DoPost` nicht (keine Rechte für die Urkunden-App, Seite umgebaut) oder antwortet die Aktion nicht mit einer Liste, endet der Lauf mit `FORM_CHANGED` im Schritt `urkunden`.

Felder aus der ISC-Antwort: `qualiUid`/`uid` → `uid`, `person.vorname`/`person.nachname` (sonst `person.gesamtname`) → `name`, `person.gebDate` → `geburtsdatum`, `ausbildungName` → `abzeichen`, `poNr` (sonst `ausbildungId` oder Klammer im Namen) → `poNr`, `prueferName`, `prueferNummer`, `regNr` → `registriernummer`. Datumswerte dürfen als Text oder als `{ "date": "…" }` kommen.

Ein Lauf braucht wie beim Kategorien-Lesen einen eigenen Chromium (ca. 10–30 s) und nimmt die Sperre des Bots. Kommt währenddessen ein News-Auftrag, wartet er bis zu `LOCK_WAIT_MS`.

---

## Einrichtung

### Voraussetzungen

- Der ISC-Benutzer aus `ISC_USERNAME` hat in der Gliederung `1002011` Leserechte für die Urkunden-App. Ohne Rechte fehlt `dlrg_DoPost` auf der Seite und der Bot meldet `FORM_CHANGED`.
- Neues Image des Bots ist ausgerollt (`build-images.yml` baut nach dem Merge, der `image.tag`-PR rollt aus, siehe [300k0, Deployment](300k0-isc-news-bot.md#deployment-und-promotion)). Prüfen:

```bash
kubectl -n isc-news-bot port-forward svc/isc-news-bot 8080:8080 &
curl -s -H "Authorization: Bearer $API_TOKEN" "http://127.0.0.1:8080/urkunden?jahr=2026" | jq '.ok, .gelesen, (.urkunden | length)'
```

Netzwerk: nichts Neues. Der Bot darf schon nach außen auf 443, n8n darf den Bot schon aufrufen (`allow-ingress-n8n`), n8n selbst hat keine Egress-Einschränkung und erreicht den SMTP-Server.

### Workflow in n8n

1. *Workflows → Import from file*, `isc-urkunden-melden.json` wählen.
2. Node **Urkunden abrufen**: die vorhandene Credential **ISC-News-Bot API-Token** (Header Auth) zuweisen, dieselbe wie im News-Workflow.
3. Credential **SMTP** anlegen (Host, Port, Benutzer, Passwort des Absenderpostfachs) und dem Node **Mail senden** zuweisen. Sie liegt in n8n, nicht im Repo.
4. Node **Konfiguration** öffnen:
   - `mailAn`: Empfänger, mehrere durch Komma getrennt. Ohne `@` bricht der Workflow mit einer Fehlermeldung ab
   - `mailVon`: Absenderadresse, muss zum SMTP-Konto passen
   - `ntfyTopic`: Standard `isc-urkunden`, in der ntfy-App abonnieren, um Fehler zu sehen
   - `testModus`: siehe unten
   - `wochentag`, `startAb`, `endeBis`: Zeitfenster (4 = Donnerstag). Wer das Fenster ändert, muss auch die drei Cron-Regeln im Trigger anpassen
5. Probelauf: `testModus = true`, dann **Manuell testen** ausführen. Der Testmodus ignoriert das Zeitfenster und den gespeicherten Stand und schickt alle passenden Urkunden des Jahres als `[TEST]`-Mail. Gibt es noch keine, kommt keine Mail.
6. `testModus = false` setzen, speichern, Workflow **aktivieren**.

### Trigger

Drei Cron-Regeln (Workflow-Zeitzone `Europe/Berlin`, Sommer- und Winterzeit werden von n8n berücksichtigt):

```
0 25,30,40,50 17 * * 4
0 0,10,20,30,40,50 18-19 * * 4
0 0 20 * * 4
```

---

## Datenschutz

Die Mail enthält Namen und Geburtsdaten, meist von Kindern. Deshalb:

- `mailAn` nur auf interne Adressen der Ortsgruppe setzen, keine Verteiler nach außen.
- Der Bot loggt keine Namen, nur Jahr und Anzahl (`Urkunden gelesen`, `gelesen`, `passend`).
- n8n speichert die Antwort des Bots in der Ausführungshistorie. Wer das vermeiden will, stellt in den Workflow-Einstellungen *Save successful production executions* aus.
- Im Static Data des Workflows stehen nur die UIDs, keine Namen.

## Grenzen

- Die Antwortfelder der ISC-Aktion `ladeUrkundenListe` sind aus dem Seitenquelltext abgeleitet (Spalten der Tabelle und Formatter). Echte Antworten konnten bisher nicht gegen den Parser getestet werden. Deshalb den ersten Lauf im Testmodus machen und die Mail prüfen. Fehlt ein Feld, steht in der Mail `-`.
- Eine Urkunde, die am Donnerstagabend mit einem Ausstellungsdatum im Vorjahr angelegt wird, sieht der Bot nicht, weil er nur das laufende Jahr abfragt.
- Schlägt der Mailversand fehl, nachdem der Stand schon aktualisiert wurde, wird die Urkunde nicht noch einmal gemeldet. Die fehlgeschlagene Ausführung steht dann in n8n.
- Der Bot steuert eine Weboberfläche. Ändert der DLRG die Urkunden-App, muss `src/isc/urkunden.ts` angepasst werden.

## Lokal testen

```bash
cd argocd/apps/tech/isc-news-bot
npm ci
npm test
```

Unit-Tests in `test/unit/urkunden.test.ts` prüfen Filter, Normalisierung und Query-Prüfung mit anonymisierten Beispieldaten (`test/fixtures/urkunden.ts`). Die E2E-Tests in `test/e2e/urkunden.test.ts` laufen gegen das Mock-ISC, das eine Urkunden-App mit `dlrg_DoPost` nachbildet, und prüfen Login, Gliederungswechsel, die gesendete Anfrage, den Fehlerfall ohne `dlrg_DoPost` und den HTTP-Endpunkt.

## Troubleshooting

| Symptom | Ursache und Lösung |
|---|---|
| ntfy: `Fehler FORM_CHANGED im Schritt urkunden` | Benutzer ohne Rechte für die Urkunden-App oder Seite geändert. Mit dem Bot-Konto im Browser `/apps/urkunden` öffnen |
| ntfy: `Fehler LOGIN_FAILED` | Zugangsdaten im Secret prüfen, siehe [300k0](300k0-isc-news-bot.md#troubleshooting) |
| ntfy: `Fehler BUSY` | Ein News-Auftrag lief länger als `LOCK_WAIT_MS`. Der nächste Lauf 10 min später holt es nach |
| Workflow bricht mit „mailAn und mailVon im Node Konfiguration eintragen“ ab | Platzhalter in **Konfiguration** ersetzen |
| Keine Mail, obwohl eine Urkunde angelegt wurde | War es ein anderes Abzeichen, eine Verlängerung oder vor 17:25? Execution-Liste ansehen: steht im Node **Neue ermitteln** kein Ausgang, war nichts neu |
| Jeder Lauf meldet nichts, auch nach neuen Urkunden | Workflow wirklich aktiv? Static Data werden nur bei aktiven Workflows gespeichert |
| Mail mit `-` in einzelnen Feldern | Das ISC liefert das Feld unter anderem Namen. Antwort im Node **Urkunden abrufen** ansehen und `normalisiereUrkunde` in `src/urkunden.ts` anpassen |
