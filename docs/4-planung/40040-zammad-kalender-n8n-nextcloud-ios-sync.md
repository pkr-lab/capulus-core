# Planung: Zammad-Kalendereinladung → n8n → Nextcloud-Kalender (+ iOS-Sync)

Ziel: Kommt an `info@edv-kretzer.de` eine Kalendereinladung (E-Mail mit
`.ics`-Anhang) an und landet dadurch als Ticket in Zammad, soll n8n den
Termin automatisch in einen Nextcloud-Kalender eintragen — ohne manuellen
Zwischenschritt. Von dort soll der Termin auch auf dem iPhone erscheinen.

**Ergebnis vorweg:** Technisch sind das zwei getrennte Bausteine, kein
einzelner "in beide eintragen"-Schritt: n8n schreibt **nur** nach Nextcloud
(per CalDAV). Das iPhone bekommt den Termin **passiv**, weil es als
CalDAV-Account mit genau diesem Nextcloud-Kalender verbunden ist — iOS
synct dann automatisch, ganz ohne dass n8n oder sonst etwas aktiv auf das
Telefon schreibt (das geht serverseitig auch gar nicht; siehe unten). Die
iPhone-Anbindung ist deshalb ein **einmaliger, manueller Setup-Schritt**
auf dem Gerät, keine wiederkehrende Automatisierung.

---

## Offene Vorfrage, vor der Umsetzung zu klären

`info@edv-kretzer.de` läuft über **welche** Zammad-Instanz? Im Repo sind
laut [30070-n8n.md](../3-apps-workloads/30070-n8n.md) zwei bekannt:

| Instanz | Erreichbar unter | Bereits n8n-Credential vorhanden? |
|---|---|---|
| Interne Instanz (dieses Repo) | `zammad.homeserver` | nein, müsste neu angelegt werden |
| Externe Instanz (bereits an n8n angebunden) | `https://ticket.emue365.de` | ja — Credential „Zammad ticket.emue365" (Zammad Basic Auth API) |

Der Domainname `edv-kretzer.de` passt zu keiner der beiden 1:1 — welche
Instanz den E-Mail-Kanal für dieses Postfach führt (oder ob er neu
eingerichtet werden muss), lässt sich aus dem Repo nicht ableiten. Die
Architektur unten funktioniert für beide identisch (nur Basis-URL +
Credential im n8n-Workflow ändern sich), aber **Gruppe** und
**Trigger-Bedingung** in Zammad müssen auf die richtige Instanz gesetzt
werden, bevor Baustein 3 umgesetzt wird.

---

## Architektur (Zielbild)

```
E-Mail an info@edv-kretzer.de (Terminanfrage/-einladung, .ics-Anhang)
        │
        ▼
Zammad E-Mail-Channel → neues Ticket
        │
        ▼
Zammad-Trigger  (Bedingung: Gruppe = <Ziel-Postfach-Gruppe>,
                 Artikel-Typ = email, "Ticket neu erstellt")
        │  Aktion: Webhook → n8n
        ▼
n8n-Workflow  (Webhook-Trigger)
  ├─ Zammad-Node „Ticket: Get"        → volles Ticket inkl. articles/attachments
  ├─ Code-Node „Anhänge filtern"      → sucht Attachment mit .ics-Endung /
  │                                      Content-Type text/calendar
  │        kein Treffer → Workflow endet hier (kein Termin, normales Ticket
  │        bleibt unangetastet)
  ├─ HTTP-Request-Node „CalDAV PUT"   → schreibt die Original-.ics-Datei
  │                                      unverändert in den Nextcloud-Kalender
  ├─ Zammad-Node „Ticket: Update"     → interne Notiz "Termin übernommen",
  │                                      optional Status-Wechsel
  └─ ntfy-Node                        → Push-Bestätigung (oder Fehler-Push)

Nextcloud-Kalender (CalDAV)
        │   passiver Sync — kein weiterer Automatisierungsschritt nötig
        ▼
iPhone „Kalender"-App — einmalig als CalDAV-Account mit Nextcloud verbunden
```

---

## Warum "iOS-Kalender" kein eigener Workflow-Schritt ist

Es gibt keine Server-API, mit der n8n (oder irgendein Dienst) direkt in
die Kalender-App eines bestimmten iPhones schreiben kann — Apple erlaubt
das nur lokal auf dem Gerät selbst (EventKit, braucht eine installierte
App) oder indirekt über ein Protokoll, das iOS nativ unterstützt:
**CalDAV**. Nextcloud spricht CalDAV bereits nativ. Der einzig
realistische Weg ist daher: n8n schreibt den Termin einmal nach Nextcloud,
das iPhone ist dauerhaft als CalDAV-Client an denselben Kalender
angebunden und holt sich neue Termine automatisch — technisch identisch
zu "ich trage den Termin von Hand in der Nextcloud-Kalender-Web-UI ein und
er erscheint auf dem iPhone", nur dass n8n das Eintragen übernimmt.

Alternative (nicht empfohlen): die `.ics`-Datei per E-Mail an eine mit dem
iPhone verknüpfte Adresse weiterleiten — iOS Mail erkennt `.ics`-Anhänge
und bietet "Zum Kalender hinzufügen" an. Das bräuchte aber weiterhin einen
manuellen Tap pro Termin und wäre damit keine vollautomatische Lösung wie
gefordert — deshalb hier verworfen.

---

## Baustein 1 — Nextcloud: Kalender-App + CalDAV-Zugang

1. **Kalender-App aktivieren** (falls noch nicht geschehen): Nextcloud →
   Apps → Büro & Text → "Kalender" installieren/aktivieren. Nicht im
   Repo-Doc [300b0-nextcloud.md](../3-apps-workloads/300b0-nextcloud.md)
   als bereits aktiv dokumentiert — vor der Umsetzung prüfen.
2. **Zielkalender anlegen**, z. B. „Termine EDV Kretzer" — eigener
   Kalender statt des Standard-Kalenders, damit sich die Termine sauber
   trennen und das iPhone gezielt nur diesen einen abonnieren kann.
3. **CalDAV-URL notieren:**
   `https://nextcloud-prod.pke-lab.de/remote.php/dav/calendars/<nutzername>/<kalender-uri>/`
   (extern, für iPhone) bzw. intern für n8n direkt über den
   Cluster-Service `http://nextcloud.nextcloud.svc.cluster.local/remote.php/dav/calendars/<nutzername>/<kalender-uri>/`
   — analog zum bestehenden Muster interner Service-Calls in
   [30070-n8n.md](../3-apps-workloads/30070-n8n.md) (Ollama-Beispiel).
4. **App-Passwort für n8n erzeugen:** Nextcloud → Einstellungen →
   Sicherheit → „Neues App-Passwort erzeugen" — **nicht** das echte
   Account-Passwort im n8n-Credential hinterlegen, ein separates
   App-Passwort lässt sich unabhängig widerrufen.

---

## Baustein 2 — iPhone: Kalender abonnieren (einmalig, manuell)

1. Einstellungen → Kalender → Accounts → Account hinzufügen → Andere →
   **CalDAV-Account**.
2. Server: `nextcloud-prod.pke-lab.de` (öffentlich über Cloudflare Tunnel
   erreichbar, siehe
   [300b0-nextcloud.md](../3-apps-workloads/300b0-nextcloud.md) —
   funktioniert damit auch außerhalb von LAN/Tailscale).
3. Benutzername + eigenes App-Passwort (separat von dem für n8n erzeugten,
   sauberer für Audit/Widerruf — beide erzeugt man in Baustein 1.4 nach
   demselben Muster).
4. In den Kalender-Einstellungen des iPhones **nur** den Zielkalender aus
   Baustein 1.2 zum Sync auswählen, nicht alle Nextcloud-Kalender.

---

## Baustein 3 — Zammad: Trigger für eingehende Kalendereinladungen

- **Bedingung:** Gruppe = Ziel-Gruppe des `info@edv-kretzer.de`-Postfachs
  (abhängig von der Vorfrage oben), Artikel-Typ = `email`, Ereignis =
  Ticket neu erstellt.
- **Aktion:** Webhook → n8n-Webhook-URL des neuen Workflows.
- **Bewusst kein `.ics`-Filter in Zammad selbst** — Zammads
  Trigger-Bedingungen können Anhangsinhalte/-typen nicht prüfen, das
  übernimmt n8n im nächsten Schritt. Der Trigger feuert also für **jedes**
  neue Ticket in dieser Gruppe; n8n entscheidet, ob es sich um eine
  Kalendereinladung handelt.

---

## Baustein 4 — n8n-Workflow

Empfohlener Dateiname (passend zum bestehenden Muster importierbarer
Workflows unter `argocd/apps/workloads/n8n/workflows/`, siehe
[30070-n8n.md](../3-apps-workloads/30070-n8n.md)):
`zammad-termin-zu-nextcloud.json`

| Node | Zweck |
|---|---|
| Webhook (Trigger) | empfängt den Zammad-Trigger-Call |
| Zammad-Node „Ticket: Get" | lädt Ticket inkl. `articles`-Array (liefert die API automatisch mit, kein separater Attachment-Call nötig — bereits so beobachtet in den bestehenden externen-Zammad-Workflows) |
| Code-Node „Anhänge filtern" | sucht Attachment mit `.ics`-Endung bzw. `Content-Type: text/calendar`; kein Treffer → Workflow endet (`NoOp`/`IF`) |
| HTTP-Request-Node „CalDAV PUT" | `PUT` der **unveränderten** `.ics`-Bytes an `<CalDAV-URL>/<UID-aus-ics>.ics`, Basic Auth mit dem App-Passwort aus Baustein 1.4 |
| Zammad-Node „Ticket: Update" | interne Notiz „Termin automatisch in Nextcloud übernommen", optional Status auf „pending close"/„closed" |
| ntfy-Node | Push-Bestätigung bzw. Fehler-Push, analog zum Muster in [30070-n8n.md](../3-apps-workloads/30070-n8n.md) |

**Idempotenz:** Ein CalDAV-`PUT` auf dieselbe `<UID>.ics`-Resource
überschreibt den bestehenden Termin statt ihn zu duplizieren — die UID
kommt direkt aus der `.ics`-Datei (Feld `UID:`), muss also nicht selbst
generiert werden. Ein erneuter Trigger-Lauf für dasselbe Ticket (z. B.
nach einem n8n-Neustart) legt den Termin dadurch nicht doppelt an.

---

## Was das NICHT tut / Grenzen der ersten Iteration

- **Keine Termin-Änderungen/Absagen.** Nur `METHOD:REQUEST`
  (Neueinladung) wird verarbeitet. `METHOD:CANCEL`/aktualisierte
  Einladungen zum selben `UID` erkennen und den Nextcloud-Termin löschen/
  aktualisieren ist eine sinnvolle, aber bewusst nicht in der ersten
  Iteration enthaltene Erweiterung.
- **Keine Konflikt-/Doppelbuchungsprüfung** gegen bestehende Termine.
- **Kein automatisches Zusagen/Absagen** per E-Mail-Antwort an den
  Einladenden — der Termin landet nur im Kalender.
- **Kein Fallback, falls das Nextcloud-CalDAV nicht erreichbar ist**
  außer der ntfy-Fehlermeldung — kein Retry-Mechanismus in der ersten
  Iteration.

---

## Umsetzungsschritte (Reihenfolge)

1. Vorfrage klären: welche Zammad-Instanz/Gruppe empfängt
   `info@edv-kretzer.de` (siehe oben).
2. Nextcloud: Kalender-App aktivieren, Zielkalender anlegen, App-Passwort
   für n8n erzeugen (Baustein 1).
3. iPhone: CalDAV-Account einrichten, Zielkalender abonnieren
   (Baustein 2).
4. Zammad: Trigger + Webhook-Aktion anlegen (Baustein 3).
5. n8n: Workflow bauen (Baustein 4), mit einer echten Test-Einladung
   (z. B. aus der eigenen Kalender-App an `info@edv-kretzer.de`
   verschickt) end-to-end testen.
6. Nach erfolgreichem Testlauf: produktive Doku unter
   `docs/3-apps-workloads/` ergänzen (analog zu den bestehenden
   Workflow-Abschnitten in
   [30070-n8n.md](../3-apps-workloads/30070-n8n.md)) — dieses Dokument
   bleibt die Planungsgrundlage, nicht die Betriebsdoku.

---

## Relevante Links

- [docs/3-apps-workloads/30000-zammad.md](../3-apps-workloads/30000-zammad.md) — Zammad-Deployment, E-Mail-Kanal-Setup (Schritt 4)
- [docs/3-apps-workloads/30070-n8n.md](../3-apps-workloads/30070-n8n.md) — bestehende Zammad-/Webhook-/ntfy-Automatisierungsmuster
- [docs/3-apps-workloads/300b0-nextcloud.md](../3-apps-workloads/300b0-nextcloud.md) — Nextcloud-Deployment, interne/externe Erreichbarkeit
- [docs/1-benachrichtigungen/10010-ntfy.md](../1-benachrichtigungen/10010-ntfy.md) — ntfy-Push-Muster
