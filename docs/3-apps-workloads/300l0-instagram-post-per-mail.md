# Instagram-Post per Mail — n8n-Workflow, der Mail-Anhänge auf Instagram veröffentlicht

Eine Mail mit einer JSON-Datei und Bildern im Anhang wird zu einem Instagram-Beitrag: ein Bild als Einzelpost, mehrere Bilder als Karussell. Der Workflow läuft in n8n und nutzt die offizielle Instagram Graph API. Es gibt kein Passwort-Login und kein Browser-Scraping. Die Bilder liegen dafür kurz im n8n-Pod und werden Meta über einen einzelnen öffentlichen Pfad bereitgestellt.

> **Cluster:** TECH · Ordner `argocd/apps/tech/n8n/` · Workflow `workflows/instagram-post-per-mail.json` · Bild-URL `https://instagram-bilder-prod.pke-lab.de/webhook/instagram-bild` (extern, nur dieser Pfad). `kubectl`-Befehle in diesem Doc gelten für den TECH-Cluster ([Zugriff je Cluster](../a-betriebssystem/a0010-overview.md#kubectl-zugriff-je-cluster)).

Allgemeines zu n8n steht in [30070](30070-n8n.md). Der Mail-Eingang ist wie beim [ISC-News-Workflow](300k0-isc-news-bot.md#n8n-workflow-einrichten) aufgebaut, nur mit eigenem Betreff und eigenem Ordner.

---

## Architektur

```
Mail „INSTAGRAM“ mit JSON + Bildern
        │ IMAP, Ordner „Instagram“
        ▼
┌──────────────────────────────── n8n (TECH) ─────────────────────────────────┐
│ Beitrag prüfen ─► Bilder als JPEG ─► /data/instagram-bilder/<Token>-<Nr>.jpg │
│                                                      ▲                       │
│ Bild-URL prüfen ──── GET (öffentliche Adresse) ──────┤ Zweig „Bild ausliefern“│
│        │                                             │                       │
│ Probelauf? ─► Freigabe? ─► Container ─► Status ─► Veröffentlichen ─► ntfy    │
└──────────────┬───────────────────────────────────────┼───────────────────────┘
               │ POST /media, /media_publish           │ GET Bild
               ▼                                       │
        graph.facebook.com (Meta) ─────────────────────┘
                              ruft https://instagram-bilder-prod.pke-lab.de ab
                              (Cloudflare Tunnel → Traefik → n8n, nur dieser Pfad)
```

Der Workflow hat zwei Zweige in einer Datei:

| Zweig | Trigger | Aufgabe |
|---|---|---|
| Mail → Instagram | IMAP, Ordner `Instagram` | Mail auswerten, Bilder aufbereiten, bei Meta anlegen und veröffentlichen, Ergebnis per ntfy melden |
| Bild ausliefern | Webhook `GET /webhook/instagram-bild?t=<Token>&n=<Nr>` | liefert die abgelegten JPEGs an Meta aus, sonst `404` |

Beide Zweige müssen im selben, **aktiven** Workflow stehen: Die Datei muss beim Abruf durch Meta schon im Pod liegen, und der Webhook antwortet nur bei aktivem Workflow.

### Ablauf eines Laufs

| Schritt | Node | Was passiert | Bei Fehler |
|---|---|---|---|
| 1. Mail annehmen | E-Mail empfangen, Mail lesen | Ungelesene Mail mit Betreff `INSTAGRAM` von der freigegebenen Adresse im Ordner `Instagram`. Betreff und Absender werden im Code noch einmal geprüft. Die Mail gilt danach als gelesen | andere Mails lösen nichts aus |
| 2. Beitrag prüfen | Beitrag pruefen | Caption aus dem JSON bauen, Hashtags und @-Erwähnungen zählen, Bildformat und Maße aus dem Dateikopf lesen, Zuschnitt berechnen, 128-Bit-Zufallstoken erzeugen | ntfy „fehlgeschlagen“, Schritt `Eingabe` |
| 3. Bilder aufbereiten | Bild konvertieren, Bilder ablegen | Zuschnitt, auf höchstens 1440 px verkleinern, als JPEG (Qualität 90) nach `/data/instagram-bilder/<Token>-<Nr>.jpg` schreiben | ntfy, Schritt `Bildverarbeitung` |
| 4. URL prüfen | Bild-URL pruefen, Bild-URL bewerten | Das erste Bild wird von n8n selbst über die öffentliche Adresse abgerufen. Erwartet wird HTTP 200 und `image/jpeg`. Damit ist der ganze Weg Tunnel → Traefik → n8n geprüft, bevor Meta etwas sieht | ntfy, Schritt `Bild-URL` |
| 5. Probelauf | Probelauf? | Bei `testModus = true` endet der Lauf hier mit einer ntfy-Meldung (Caption, Anzahl, erstes Bild als Vorschau). Es wird nichts bei Meta aufgerufen | — |
| 6. Freigabe | Freigabe per ntfy? | Optional (`ntfyFreigabe`): ntfy-Meldung mit Button „Freigeben“, der Lauf wartet, bis der Button gedrückt wird | ohne Klick passiert nichts |
| 7. Container | Bild-Container anlegen, Container sammeln | Pro Bild `POST /{ig-id}/media` mit `image_url`. Bei einem Bild mit Caption, bei mehreren mit `is_carousel_item` | ntfy, Schritt `Bild-Container (Bild n)`, Text der Meta-Fehlermeldung |
| 8. Karussell | Karussell-Container anlegen | Nur ab 2 Bildern: `POST /{ig-id}/media` mit `media_type=CAROUSEL`, `children` und Caption, vorher 5 s Pause | ntfy, Schritt `Karussell-Container` |
| 9. Warten | Warten auf Meta, Status abfragen | Alle 5 s `GET /{container}?fields=status_code,status`, bis `FINISHED`. Bei `ERROR`/`EXPIRED` oder nach 36 Abfragen (3 Minuten) Abbruch | ntfy, Schritt `Container-Status` |
| 10. Veröffentlichen | Veroeffentlichen | `POST /{ig-id}/media_publish` mit `creation_id` | ntfy, Schritt `Veröffentlichen`, mit Hinweis auf mögliche Dublette |
| 11. Melden, aufräumen | Permalink holen, ntfy, Bilder loeschen | Link zum Post per ntfy. Danach werden die Dateien des Laufs gelöscht, ebenso alle JPEGs, die älter als 12 Stunden sind | — |

---

## Mail-Format

Betreff genau `INSTAGRAM`, Absender die freigegebene Adresse (Standard `peter.kretzer@dlrg.org`, einstellbar im Node **Konfiguration**). Der Betreff darf **nicht** `1002011` enthalten ([Warum, siehe Einrichtung](#1-postfach-vorbereiten)).

**Anhang 1: JSON-Datei.** Der Workflow nimmt die erste Datei mit `application/json` oder Endung `.json`.

```json
{
  "title": "Sommerfest am See",
  "subtitle": "Alle sind eingeladen",
  "text": "Am Samstag ab 14 Uhr.\n\nBring gute Laune mit.",
  "hashtags": ["DLRG", "Andernach"]
}
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `title` | nein | erste Zeile der Caption |
| `subtitle` | nein | zweiter Absatz |
| `text` oder `html` | nein | Text der Caption. Bei `html` werden Tags entfernt, `<br>` und Absatzenden werden zu Zeilenumbrüchen, `&amp;` & Co. aufgelöst |
| `caption` | nein | fertige Caption. Ersetzt die Zusammensetzung aus `title`, `subtitle` und `text` |
| `hashtags` | nein | Liste oder Text (`"dlrg, #andernach"`). Doppelte entfallen, `#` wird ergänzt, Sonderzeichen werden entfernt. Die Hashtags stehen nach einer Leerzeile am Ende |

Mindestens einer der Texte (`title`, `text`, `html` oder `caption`) muss vorhanden sein, sonst bricht der Workflow ab. Die deutschen Feldnamen des ISC-Workflows (`Überschrift`, `Untertitel`, `Text`) werden ebenfalls verstanden. Weitere Felder wie `categories`, `startDate` und `mode` werden **ignoriert**: Instagram kennt weder Entwurf noch zeitversetztes Veröffentlichen über diesen Weg, der Beitrag erscheint sofort.

**Weitere Anhänge: die Bilder.** JPEG, PNG oder WebP, höchstens 10, Reihenfolge wie in der Mail. Das erste Bild bestimmt das Format des Karussells. Alles, was kein Bild ist (z. B. PDF), wird nicht übernommen und in der ntfy-Meldung genannt.

### Was mit den Bildern passiert

Meta verlangt JPEG. Der Workflow wandelt deshalb jedes Bild um und passt es an die Regeln der Graph API an ([Meta-Referenz `ig-user/media`](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media)):

| Regel von Meta | Umsetzung im Workflow |
|---|---|
| nur JPEG | Edit Image wandelt PNG und WebP um (Qualität 90) |
| Breite höchstens 1440 px | Verkleinern in eine 1440×1440-Box, nie vergrößern. Meta skaliert zu schmale Bilder (unter 320 px) selbst hoch, der Workflow lässt sie durch |
| Seitenverhältnis 4:5 bis 1,91:1 | Liegt ein Bild außerhalb, wird es **mittig zugeschnitten**. Typisches Beispiel: Hochkantfotos vom Handy (3:4) verlieren oben und unten etwas, damit sie auf 4:5 kommen |
| höchstens 8 MB | JPEG mit Qualität 90 bei höchstens 1440 px bleibt weit darunter |
| Caption höchstens 2200 Zeichen | Zu lange Texte werden mit „…“ gekürzt, die Hashtags bleiben erhalten. Die ntfy-Meldung sagt „Caption wurde gekürzt“ |
| höchstens 30 Hashtags, 20 @-Erwähnungen | Mehr bricht den Lauf ab (Schritt `Eingabe`), nichts wird gekürzt |
| Karussell höchstens 10 Elemente | Weitere Bilder werden nicht übernommen und in der Meldung genannt |

Die Maße liest der Code aus dem Dateikopf (PNG, JPEG inklusive EXIF-Drehung, WebP). Edit Image richtet gedrehte JPEGs vor dem Zuschnitt nach EXIF aus; der Zuschnitt rechnet deshalb in der angezeigten Ausrichtung. Das wurde mit n8n `2.42.3` so beobachtet. Ändert eine neue n8n-Version das, wären hochkant fotografierte JPEGs falsch zugeschnitten: dann den Zuschnitt in `Beitrag pruefen` prüfen.

Bei Karussells schneidet Instagram selbst alle Bilder auf das Format des ersten zu (Standard 1:1), unabhängig vom Zuschnitt hier.

---

## Voraussetzungen bei Meta

Der Weg über die Graph API mit Facebook-Login braucht Dinge, die außerhalb des Clusters liegen. Die Oberflächen von Meta ändern sich häufig; verbindlich ist die [Meta-Dokumentation zu Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing).

1. **Instagram-Konto als Business- oder Creator-Konto** (Konto-Einstellungen in der Instagram-App), verbunden mit einer **Facebook-Seite**. Ein privates Konto kann nicht über die API posten.
2. **Meta-App** unter [developers.facebook.com](https://developers.facebook.com) mit dem Produkt für Instagram-Inhalte. Die App darf im Modus **Entwicklung** bleiben, solange nur das eigene Konto beschickt wird, dessen Inhaber eine Rolle in der App hat (Admin, Entwickler oder Tester). Eine App-Prüfung durch Meta ist dafür nach heutigem Stand nicht nötig; sie wird erst fällig, wenn fremde Konten angebunden werden.
3. **Berechtigungen** des Tokens: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`.
4. **Token, ID und Test** (siehe unten). Das Ergebnis sind zwei Werte: das **Seiten-Zugriffstoken** und die **Instagram-Konto-ID** (`igUserId`).

### Token erzeugen

Im [Graph API Explorer](https://developers.facebook.com/tools/explorer/) die App wählen und ein Benutzer-Token mit den vier Berechtigungen erzeugen. Dann auf einem Rechner (Klartext nur per Eingabe, nie in der Shell-History oder im Repo):

```bash
read -rs APP_SECRET; read -rs KURZES_TOKEN
APP_ID=<App-ID>
curl -sG https://graph.facebook.com/v23.0/oauth/access_token \
  -d grant_type=fb_exchange_token -d client_id=$APP_ID \
  --data-urlencode client_secret=$APP_SECRET --data-urlencode fb_exchange_token=$KURZES_TOKEN
```

Die Antwort enthält ein langlebiges **Benutzer-Token** (rund 60 Tage). Daraus entsteht das Seiten-Token:

```bash
read -rs LANGES_TOKEN
curl -sG https://graph.facebook.com/v23.0/me/accounts --data-urlencode access_token=$LANGES_TOKEN
```

In der Antwort steht je Seite `id` und `access_token`. Das **Seiten-Token** der richtigen Seite wird verwendet. Ein Seiten-Token, das aus einem langlebigen Benutzer-Token entstanden ist, läuft nicht ab ([Meta: Long-Lived Access Tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived)). Das sollte vor dem Einsatz geprüft werden:

```bash
read -rs SEITEN_TOKEN
curl -sG https://graph.facebook.com/debug_token \
  --data-urlencode input_token=$SEITEN_TOKEN --data-urlencode "access_token=$APP_ID|$APP_SECRET"
```

`expires_at: 0` heißt „läuft nicht ab“, unter `scopes` müssen die vier Berechtigungen stehen. Die Instagram-Konto-ID liefert:

```bash
curl -sG https://graph.facebook.com/v23.0/<Seiten-ID> -d fields=instagram_business_account \
  --data-urlencode access_token=$SEITEN_TOKEN
```

`instagram_business_account.id` ist die `igUserId`. Als Abschlusstest, der zugleich den Header-Weg prüft, den der Workflow nutzt:

```bash
curl -s -H "Authorization: Bearer $SEITEN_TOKEN" "https://graph.facebook.com/v23.0/<igUserId>?fields=username"
```

Kommt der Benutzername zurück, stimmen Token, ID und Berechtigungen.

---

## Einrichtung

### 1. Postfach vorbereiten

Im Postfach, das der Workflow liest:

1. Ordner **`Instagram`** anlegen.
2. Regel: Betreff **enthält** `INSTAGRAM` → verschieben nach `Instagram`.

Beides vor dem Aktivieren erledigen. Ohne die Regel bleibt die Mail in der INBOX, und der [WhatsApp-Workflow](30070-n8n.md#beispiel-workflow-e-mail-von-absender--whatsapp-kanal) liest dort. Verwendet er denselben Absender, würde er die Mail in den WhatsApp-Kanal schicken. Der Betreff darf kein `1002011` enthalten: Die bestehende Regel `Betreff enthält 1002011 → ISC-News` würde die Mail sonst in den ISC-Ordner verschieben, und der Instagram-Workflow sähe sie nie.

Der Trigger liest nur den Ordner `Instagram` und markiert jede Mail nach dem Abholen als gelesen. Ein zweiter Workflow auf demselben Ordner würde sie deshalb nie sehen.

### 2. Chart ausrollen

Die Änderungen an `argocd/apps/tech/n8n/` (`values.yaml`, `templates/deployment.yaml`, `templates/ingress-instagram-bilder.yaml`) mergen. ArgoCD synchronisiert die App `n8n` im TECH-Cluster, der Pod startet neu (Strategie `Recreate`). Ein laufender Workflow wird dabei unterbrochen. Die WhatsApp-Session liegt auf dem PVC und bleibt erhalten.

Es kommen hinzu: ein `emptyDir` unter `/data/instagram-bilder` (512 Mi), dieser Ordner in `N8N_RESTRICT_FILE_ACCESS_TO` und ein zweiter Ingress `n8n-instagram-bilder` für den Host `instagram-bilder-prod.pke-lab.de`. Ein DNS-Eintrag ist nicht nötig, der Wildcard `*.pke-lab.de` zeigt auf den TECH-Tunnel ([e0000](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md#zwei-tunnel-tech-und-prod)).

Prüfen:

```bash
kubectl -n n8n get ingress
kubectl -n n8n exec deploy/n8n -- ls -ld /data/instagram-bilder
```

Von einem Rechner **außerhalb** des Heimnetzes (Handy im Mobilfunknetz genügt):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://instagram-bilder-prod.pke-lab.de/webhook/instagram-bild
curl -s -o /dev/null -w '%{http_code}\n' https://instagram-bilder-prod.pke-lab.de/rest/settings
curl -s -o /dev/null -w '%{http_code}\n' https://instagram-bilder-prod.pke-lab.de/
```

Der erste Aufruf liefert `404` von n8n (kein Token), die beiden anderen `404` von Traefik. Liefert der zweite oder dritte etwas anderes, ist mehr von n8n erreichbar als gewollt: sofort `instagram.enabled: false` setzen.

### 3. Workflow importieren und einrichten

1. In n8n: *Workflows → Import from file*, `argocd/apps/tech/n8n/workflows/instagram-post-per-mail.json` wählen. Er kommt inaktiv herein. Die Schritte stehen auch als Notiz im Workflow.
2. **IMAP-Credential** dem Node **E-Mail empfangen** zuweisen (Postfach wie beim ISC-Workflow). Fehlt der Ordner `Instagram`, meldet n8n beim Aktivieren einen Fehler. Je nach Mailserver heißt der Ordner `INBOX.Instagram`.
3. **Credential anlegen:** Typ *Header Auth*, Name `Instagram Graph API (Seiten-Token)`, Header `Authorization`, Wert `Bearer <Seiten-Token>`. Zuweisen an die fünf Meta-Nodes: **Bild-Container anlegen**, **Karussell-Container anlegen**, **Status abfragen**, **Veroeffentlichen**, **Permalink holen**.
4. Node **Konfiguration** öffnen und `igUserId` eintragen. Alles andere kann bleiben ([Tabelle unten](#konfiguration)).
5. ntfy-Topic **`instagram`** in der App abonnieren ([ntfy](../1-benachrichtigungen/10010-ntfy.md)).
6. Workflow **aktivieren**. Import allein reicht nicht.

### 4. Probelauf, Freigabe, Echtbetrieb

1. `testModus` steht beim Import auf `true`. Testmail mit einem Bild und einer JSON-Datei senden. Nach etwa einer Minute kommt „Instagram Probelauf (nichts gepostet)“ mit der fertigen Caption, der Bildanzahl und dem ersten Bild als Vorschau. Der Satz „Bild-URL von außen abrufbar“ bedeutet, dass der gesamte öffentliche Weg funktioniert.
2. `ntfyFreigabe` auf `true` und `testModus` auf `false` stellen. Der nächste Lauf legt noch nichts an, sondern fragt per ntfy „Instagram-Post freigeben?“. Erst der Klick auf **Freigeben** startet die Veröffentlichung. Das ist der empfohlene Betrieb für die ersten Beiträge.
3. Wenn alles passt, `ntfyFreigabe` auf `false` setzen, dann gehen Mails direkt auf Instagram.

---

## Konfiguration

Im Node **Konfiguration** (Code-Node, Objekt `cfg`):

| Key | Bedeutung | Default |
|---|---|---|
| `testModus` | `true`: Lauf endet nach der Bild-URL-Prüfung, nichts wird bei Meta aufgerufen | `true` |
| `ntfyFreigabe` | `true`: Veröffentlichung wartet auf den Button in ntfy | `false` |
| `ntfyUrl`, `ntfyTopic` | Ziel der Meldungen, cluster-intern | `http://ntfy.ntfy.svc.cluster.local`, `instagram` |
| `graphUrl` | Graph API inklusive Version | `https://graph.facebook.com/v23.0` |
| `igUserId` | Instagram-Konto-ID. Ist sie noch `CHANGE-ME…`, bricht ein Echtlauf ab | `CHANGE-ME-IG-USER-ID` |
| `bildBasisUrl` | öffentliche Adresse des Bild-Zweigs, so wie Meta sie abruft | `https://instagram-bilder-prod.pke-lab.de/webhook/instagram-bild` |
| `bildVerzeichnis` | Ordner der JPEGs im Pod, muss zum Mount im Chart passen | `/data/instagram-bilder` |
| `sender`, `betreff` | erlaubter Absender (Teilstring) und Betreff (exakt). Die Adresse steht zusätzlich in den *Custom Email Rules* des Nodes **E-Mail empfangen** | `peter.kretzer@dlrg.org`, `INSTAGRAM` |
| `maxBilder` | Obergrenze Bilder pro Beitrag | `10` |
| `minVerhaeltnis`, `maxVerhaeltnis` | erlaubtes Seitenverhältnis (Breite/Höhe), außerhalb wird zugeschnitten | `0.8`, `1.91` |
| `maxCaptionZeichen`, `maxHashtags`, `maxErwaehnungen` | Grenzen der Graph API | `2200`, `30`, `20` |

Im Chart (`argocd/apps/tech/n8n/values.yaml`):

| Key | Bedeutung | Default |
|---|---|---|
| `instagram.enabled` | emptyDir, Dateizugriff und öffentlichen Ingress anlegen. `false` nimmt den Pfad wieder aus dem Internet | `true` |
| `instagram.publicHost` | öffentlicher Hostname (Tier `prod`, Cluster TECH) | `instagram-bilder-prod.pke-lab.de` |
| `instagram.publicPath` | der einzige geroutete Pfad (Typ `Exact`) | `/webhook/instagram-bild` |
| `instagram.bilder.mountPath` | Ordner der Bilder im Pod | `/data/instagram-bilder` |
| `instagram.bilder.sizeLimit` | Größe des emptyDir | `512Mi` |
| `env.N8N_RESTRICT_FILE_ACCESS_TO` | Ordner, die Lese-/Schreib-Nodes betreten dürfen, enthält jetzt auch `/data/instagram-bilder` | `…;/data/instagram-bilder` |

---

## Öffentliche Bild-URL und Sicherheit

Meta lädt jedes Bild selbst herunter („We cURL media used in publishing attempts, so the media must be hosted on a publicly accessible server“, [Meta](https://developers.facebook.com/docs/instagram-platform/content-publishing)). Die Graph API nimmt keine hochgeladenen Bytes an, nur eine `image_url`. Deshalb muss ein Stück von n8n aus dem Internet erreichbar sein.

Was öffentlich ist:

- **Genau ein Pfad**: der Ingress `n8n-instagram-bilder` routet mit `pathType: Exact` nur `/webhook/instagram-bild` auf dem Host `instagram-bilder-prod.pke-lab.de` zu n8n. Jeder andere Pfad auf diesem Host (Editor, `/rest/…`, andere Webhooks) trifft auf keine Regel und bekommt `404` von Traefik. `n8n.prod.homeserver` selbst bleibt unverändert intern.
- **Nur mit Token**: Der Webhook liefert nur Dateien `<Token>-<Nr>.jpg`. Der Token ist ein 128-Bit-Zufallswert (32 Hex-Zeichen), pro Mail neu. Der Code lehnt alles ab, was nicht `^[0-9a-f]{32}$` und `^[0-9]{1,2}$` entspricht (kein Pfad aus der Anfrage), und der Lese-Node darf nur `/data/instagram-bilder` betreten.
- **Nur kurz**: Die Dateien liegen im `emptyDir` und werden am Ende jedes Laufs gelöscht, auch nach Fehlern. Zusätzlich räumt jeder Lauf Dateien auf, die älter als 12 Stunden sind. Ein Pod-Neustart leert den Ordner.
- **Inhalt**: Bilder, die ohnehin auf Instagram veröffentlicht werden. Wer die URL kennt, sieht nichts, was später nicht öffentlich wäre. Die URL taucht in den n8n-Ausführungen und, bei der Freigabe, in der ntfy-Meldung als Vorschau auf.

Das widerspricht dem sonst geltenden Grundsatz „n8n bleibt aus dem Internet“ ([c0030](../c-netzwerk-dns/c0030-port-uebersicht.md), [300i0](300i0-alamos-relay.md)) in einem Punkt: n8n beantwortet jetzt Anfragen aus dem Internet, auch wenn nur auf diesem Pfad. Die Alternative nach dem Muster von `alamos-relay` wäre ein eigener Mini-Dienst, der die Bilder hält. Dann müsste n8n sie dorthin hochladen und der Dienst bräuchte Image, Chart und Netzwerkregeln. Gewählt wurde der kleinere Eingriff; Begründung und Rückbau stehen in [60040](../6-hintergruende/60040-helm-charts-tech.md#n8n).

---

## Verhalten und Grenzen

- **Kein Duplikatschutz.** Wird dieselbe Mail zweimal gesendet, entstehen zwei Beiträge. Die Mail wird beim Abholen als gelesen markiert, ein Neustart des Laufs wiederholt sie nicht von selbst.
- **Sofort öffentlich.** Es gibt keinen Entwurf. Wer prüfen will, nutzt `ntfyFreigabe`.
- **100 Beiträge in 24 Stunden** pro Konto über die API, ein Karussell zählt als einer ([Meta](https://developers.facebook.com/docs/instagram-platform/content-publishing)).
- **Nur Feed-Beiträge**, keine Reels, Stories oder Videos. Videos wären ein anderer Container-Typ.
- **Keine Alt-Texte, Orts- oder Personen-Markierungen.** Die Felder `alt_text`, `location_id`, `user_tags` werden nicht gesendet.
- **Links in der Caption sind bei Instagram nicht anklickbar.**
- **Dauer**: Im Test mit Mock-API brauchte ein Lauf wenige Sekunden pro Bild plus die Wartezeit der Statusabfrage (mindestens 5 s). Bei der echten API kommt die Verarbeitung bei Meta dazu; die Statusabfrage gibt bis zu 3 Minuten Zeit. Echte Werte im Betrieb messen.
- **Läuft das Posten ins Leere** (z. B. Token ungültig), steht der Fehler von Meta wörtlich in der ntfy-Meldung. Die Mail ist dann gelesen und wird nicht erneut verarbeitet: nach der Korrektur eine neue Mail senden.
- **Antwort auf Mails mit demselben Betreff** (`Re: INSTAGRAM`) wird nicht verarbeitet, der Betreff muss exakt `INSTAGRAM` sein.

---

## Fehlerbehebung

| Symptom | Ursache und Lösung |
|---|---|
| Nichts passiert bei neuen Mails | Workflow aktiv? Liegt die Mail im Ordner `Instagram` (Regel!), ist sie ungelesen, stimmt Absender und Betreff exakt? Execution-Liste ansehen. Der IMAP-Trigger holt nur `UNSEEN` |
| Mail landet in INBOX oder im WhatsApp-Kanal | Postfachregel `INSTAGRAM → Instagram` fehlt oder greift nicht. Die Mail im Ordner `Instagram` prüfen |
| Mail landet im Ordner `ISC-News` | Betreff enthält `1002011`. Betreff ändern |
| ntfy: Schritt `Eingabe`, „Kein JSON-Anhang“ oder „JSON-Anhang ist nicht lesbar“ | Datei fehlt, ist keine gültige JSON oder die Wurzel ist kein Objekt (Liste) |
| ntfy: „Keine Caption“ | `title`, `text`, `html` und `caption` fehlen oder sind leer |
| ntfy: „Mehr als 30 Hashtags“ / „20 @-Erwähnungen“ | Grenzen der Graph API. Text kürzen |
| ntfy: Schritt `Bildverarbeitung` | Edit Image oder das Schreiben ist gescheitert, etwa weil das Bild beschädigt ist oder `/data/instagram-bilder` fehlt. `kubectl -n n8n exec deploy/n8n -- ls -ld /data/instagram-bilder`. Ist der Ordner nicht beschreibbar, `N8N_RESTRICT_FILE_ACCESS_TO` prüfen |
| ntfy: Schritt `Bild-URL`, `HTTP 404` | Der Bild-Zweig ist nicht erreichbar: Workflow nicht aktiv, Ingress fehlt (`kubectl -n n8n get ingress`) oder `bildBasisUrl` stimmt nicht mit `instagram.publicHost` überein |
| ntfy: Schritt `Bild-URL`, Verbindungsfehler oder Timeout | Tunnel/Traefik, DNS oder die Auflösung des Hosts im Cluster. Von außen mit `curl` gegenprüfen ([Chart ausrollen](#2-chart-ausrollen)) |
| ntfy: Schritt `Bild-Container`, Meta-Code `9004` / Subcode `2207052` („Medium nicht abrufbar“) | Meta erreicht die Bild-URL nicht oder bekommt kein JPEG. Die Prüfung im Workflow lief aus dem Cluster und war ok, also blockiert etwas von außen: Cloudflare-Bot-Regeln gegen Meta, CrowdSec, Rate-Limits. In den Cloudflare- und Traefik-Logs nach dem Abruf suchen |
| ntfy: Meta-Code `190` (OAuthException) | Token ungültig oder abgelaufen (z. B. Passwortänderung beim Facebook-Konto oder Berechtigungen entzogen). Neu erzeugen, [Token erzeugen](#token-erzeugen) |
| ntfy: Meta-Code `10` oder `200` | Berechtigung fehlt: `instagram_content_publish`, Rolle in der App, Seite nicht mit dem Konto verbunden |
| ntfy: Meta-Code `4`, `17`, `32` oder `613` | Rate-Limit der API. Später erneut senden |
| ntfy: Schritt `Container-Status`, `ERROR` | Meta hat das Bild abgelehnt (Format, Seitenverhältnis, Größe). Der Statustext steht in der Meldung |
| ntfy: Schritt `Container-Status`, nach 3 Minuten | Meta wird nicht fertig. Später prüfen, ob der Beitrag trotzdem erscheint |
| ntfy: Schritt `Veröffentlichen` | Unklar, ob der Beitrag erschienen ist. **Erst auf Instagram nachsehen**, dann erneut senden |
| Bild ist anders zugeschnitten als gedacht | Kein Fehler. Instagram schneidet Karussells zusätzlich auf das Format des ersten Bildes. Zuschnitt und Grenzen: [Was mit den Bildern passiert](#was-mit-den-bildern-passiert) |

---

## Wie der Workflow geprüft wurde

Der Workflow wurde lokal in n8n `2.42.3` (dem Stand im Cluster) importiert, aktiviert und ausgeführt, mit einem Mock der Graph API und einem Mock für ntfy:

- Einzelbild und Karussell (EXIF-gedrehtes JPEG, PNG, WebP, Panorama, Quadrat, großes JPEG), jeweils mit Zuschnitt und Abruf der Bilder über den öffentlichen Pfad
- Probelauf, Freigabe per Button (POST), falscher Absender und falscher Betreff
- alle Fehlerpfade: ohne JSON, ohne Bilder, zu viele @-Erwähnungen, Meta lehnt Container ab, Status `ERROR`, Veröffentlichen schlägt fehl, Bild-URL nicht erreichbar
- mehr als 10 Bilder und ein PDF-Anhang
- Abruf des Bild-Zweigs mit ungültigem, manipuliertem und unbekanntem Token (jeweils `404`)

**Nicht** getestet: die echte Meta Graph API, ein echter IMAP-Trigger, der öffentliche Weg über Cloudflare und Traefik sowie die Zustellung von ntfy an ein Gerät. Deshalb der Probelauf mit `testModus = true` vor dem ersten Echtlauf.

---

## Token rotieren

Das Seiten-Token liegt nur als Credential in n8n, nicht im Repo und nicht in `ops/token-register.yaml`. Es läuft nicht ab, wird aber ungültig, wenn der Inhaber des Facebook-Kontos das Passwort ändert, der App Berechtigungen entzieht oder die App gelöscht wird. Rotation:

1. [Token erzeugen](#token-erzeugen) (neues Benutzer-Token, tauschen, Seiten-Token holen, mit `debug_token` prüfen).
2. In n8n das Credential `Instagram Graph API (Seiten-Token)` bearbeiten und den Wert `Bearer <neues Token>` eintragen.
3. Probelauf mit Freigabe.

---

## Risiken

- **Offizieller Weg, aber Meta-Regeln gelten.** Vor dem Einsatz mit dem Vorstand klären, dass das Konto automatisiert beschickt werden darf und wer Inhalte freigibt.
- **Token und App-Secret** sind Zugangsdaten zum Instagram-Konto. Das App-Secret nicht ablegen, das Seiten-Token nur im n8n-Credential.
- **Öffentlicher n8n-Pfad.** Siehe [Öffentliche Bild-URL und Sicherheit](#öffentliche-bild-url-und-sicherheit). Rückbau mit `instagram.enabled: false`.
- **Versionsabhängigkeiten.** Graph-API-Version (`graphUrl`) und Verhalten von Edit Image (Ausrichtung nach EXIF) sind an die getestete Umgebung gebunden. Nach einem n8n-Update einen Probelauf mit einem gedrehten Foto machen.
