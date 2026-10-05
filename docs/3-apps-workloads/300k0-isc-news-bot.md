# ISC-News-Bot — News im DLRG ISC per API anlegen (RPA)

Eigenständiger Dienst, der News inkl. Bildern im DLRG-ISC (`https://dlrg.net`, App „News“) anlegt. Er steuert einen headless Chromium über Playwright. n8n ist nur Auftraggeber: n8n ruft den Dienst per HTTP auf, im n8n-Pod läuft kein Browser. Die Kategorien liefert n8n mit.

> **Cluster:** TECH · Ordner `argocd/apps/tech/isc-news-bot/` · kein Ingress, nur cluster-intern unter `http://isc-news-bot.isc-news-bot.svc.cluster.local`. `kubectl`-Befehle in diesem Doc gelten für den TECH-Cluster ([Zugriff je Cluster](../a-betriebssystem/a0010-overview.md#kubectl-zugriff-je-cluster)).

---

## Architektur

```
n8n (Namespace n8n)                              Namespace isc-news-bot
 ├─ Formular / Webhook                           ┌──────────────────────────────┐
 └─ Workflow „ISC-News veröffentlichen“          │ isc-news-bot                 │
      │  POST /news  (Bearer-Token)  ──────────▶ │ Node.js + Playwright         │
      │  NetworkPolicy: Ingress nur aus n8n      │ headless Chromium (uid 1000) │
      ▼                                          └──────────────┬───────────────┘
   ntfy-Meldung (Erfolg / Fehler / Freigabe)                    │ HTTPS 443 (Egress)
                                                                ▼
                                                        dlrg.net (ISC, App „News“)
```

Der Dienst hat keinen eigenen Zugang von außen. Die NetworkPolicy erlaubt Eingang nur aus dem Namespace `n8n`, Ausgang nur zu DNS und TCP 443 außerhalb der privaten Netze.

### Ablauf eines Laufs

Jeder Lauf startet mit einem frischen Browser-Kontext, meldet sich an, legt an und meldet sich wieder ab. Pro Pod läuft immer nur ein Lauf (Mutex).

| Schritt | Was passiert | Bei Fehler |
|---|---|---|
| 1. Login | `https://dlrg.net/` öffnen, Benutzer und Passwort eintragen, „Angemeldet bleiben“ aus, Anmelden | `LOGIN_FAILED` (Formular bleibt sichtbar) oder `LOGIN_UNEXPECTED` (andere Seite, Screenshot) |
| 2. Gliederung | Aktive Gliederung aus der Navigation lesen. Ist sie nicht die Ziel-EDV, `#edvnummer` auf `<EDV>#gld` setzen und `form#changeGliederung` absenden. Danach erneut prüfen. | `WRONG_GLIEDERUNG`, nichts wird gespeichert |
| 3. Duplikat | `GET /apps/news?page=finder&db=<EDV>&str=<Titel>`, exakter Titelvergleich (getrimmt, ohne Groß-/Kleinschreibung) | Treffer → `duplicate: true`, nichts angelegt (außer `force: true`) |
| 4. Formular | `…?page=uebersicht&create` öffnen, Kategorien auf die Optionen abbilden, Felder füllen, Text per CKEditor setzen und zurücklesen, Parsley-Prüfung | `VALIDATION_FAILED` (mit Parsley-Texten), `FORM_CHANGED` (Selektor fehlt) |
| 5. Speichern (Entwurf) | `button#save` klicken. Erfolg nur, wenn „Erfolgreich gespeichert!“ erscheint, `input[name="ID"]` > 0 ist und kein `.alert-danger` da ist | `SAVE_UNCONFIRMED`, Screenshot, `newsId` falls vergeben |
| 6. Medien | Tab „Medien“, Optionen `disallowResizeImage` / `firstAssetOnlyTeaser` setzen (dann erneut speichern), Upload-Ribbon öffnen, Schlagworte vor dem Upload setzen, Datei per Dropzone hochladen, auf `page=mediaService` warten, eine Zeile mehr in der Medienliste prüfen, danach `uploadSettleMs` warten | `UPLOAD_FAILED` mit Meldungen aus der Antwort, `newsId` bleibt als Entwurf |
| 7. Veröffentlichen | Nur bei `mode: "publish"`: Tab „Start“, `button#release` klicken, Erfolg prüfen, Status nicht mehr „gesperrt“. Social-Text aus `#social-text` mitnehmen | `PUBLISH_FAILED`, News bleibt gesperrt |
| 8. Abmelden | `#LogoutButton`, Browser schließen (auch bei Fehlern) | — |

```
Login ──▶ Gliederung ──▶ Duplikat? ──▶ Formular ──▶ Speichern (Entwurf) ──▶ Medien ──▶ Veröffentlichen ──▶ Abmelden
  │           │              │ ja                                                       (nur mode=publish)
  ▼           ▼              ▼
 LOGIN_*   WRONG_*      duplicate:true, nichts angelegt
```

Das Gesamt-Timeout berechnet sich aus der Bildanzahl: `120 s + Bilder × (uploadSettleMs + 60 s)`. Bei Überschreitung bricht der Dienst mit `TIMEOUT` ab. Der Browser wird in jedem Fall beendet.

---

## API-Referenz

Alle Endpunkte außer `/healthz` und `/readyz` verlangen `Authorization: Bearer <API_TOKEN>`.

| Methode und Pfad | Zweck |
|---|---|
| `POST /news` | News anlegen (Body siehe unten), Antwort mit `ok`, `newsId`, `editUrl`, `status` |
| `GET /categories` | Kategorie-Optionen der aktiven Gliederung, live aus dem ISC |
| `GET /healthz` | Lebenszeichen, ohne Browser, ohne Token |
| `GET /readyz` | Browser vorhanden? Ohne Token |

### Request `POST /news`

```json
{
  "title": "Sommerfest am See",
  "subtitle": "Alle sind eingeladen",
  "html": "<p>Am Samstag ab 14 Uhr.</p>",
  "type": "text",
  "categories": ["DLRG Andernach", "22607"],
  "startDate": "2026-10-10T09:00",
  "mode": "publish",
  "images": [
    { "fileName": "eins.jpg", "mimeType": "image/jpeg", "dataBase64": "<Base64>", "keywords": ["Sommer"] }
  ],
  "dryRun": false
}
```

| Feld | Pflicht | Regeln |
|---|---|---|
| `title` | ja | Text, max. 255 Zeichen |
| `subtitle` | nein | Teaser, max. 2000 Zeichen |
| `html` | bei `type: "text"` | HTML, max. 200 000 Zeichen |
| `type` | nein, Default `text` | `text` (0), `link` (1), `typo3` (2) |
| `link` | bei `type: "link"` | http(s)-URL |
| `typo3Id` | bei `type: "typo3"` | positive ganze Zahl |
| `categories` | nein | Liste aus IDs **oder** Namen (case-insensitive), max. 20. Unbekannt → `400`, nichts wird angelegt |
| `startDate` | nein, Default „jetzt“ | `YYYY-MM-DDTHH:mm` (Europe/Berlin) oder ISO mit Zeitzone (wird nach Berlin umgerechnet) |
| `archiveDate`, `endDate` | nein | wie `startDate`, dürfen nicht vor dem Start liegen. `endDate` ist „Verbergen ab“ |
| `author`, `authorEmail` | nein | Defaults aus der Konfiguration. E-Mail ohne Umlaute und ß |
| `mode` | nein, Default `draft` | `draft` (gesperrt) oder `publish` |
| `images` | nein | max. 20 Bilder, Reihenfolge = Reihenfolge im Request, erstes Bild ist Teaser. Erlaubt: `image/jpeg`, `image/png`, `image/webp`. Der Dateiinhalt muss zum MIME-Typ passen. Max. 15 MB je Bild |
| `images[].keywords` | nein | Schlagworte je Bild, max. 10. Default: `DEFAULT_IMAGE_KEYWORDS` (`News`) |
| `disallowResizeImage`, `firstAssetOnlyTeaser` | nein | Default `false` |
| `force` | nein | `true`: Duplikatprüfung überspringen |
| `dryRun` | nein | `true`: alles bis vor das erste Speichern ausführen, Screenshot liefern, **nichts** speichern oder hochladen |

Body-Limit 50 MB, `Content-Type: application/json`.

### Antwort

```json
{
  "ok": true,
  "mode": "publish",
  "dryRun": false,
  "newsId": 4711,
  "editUrl": "https://dlrg.net/apps/news?page=uebersicht&action=edit&ID=4711",
  "status": "veroeffentlicht",
  "uploaded": [{ "fileName": "eins.jpg", "ok": true, "messages": ["…"] }],
  "socialText": "Neu auf der Website: …",
  "durationMs": 184000
}
```

Fehler: `ok: false`, `errorCode`, `step`, `error`, optional `details`, `newsId` (sobald gespeichert) und `screenshotBase64`.

| `errorCode` | HTTP | Bedeutung | Was tun |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | Eingabe ungültig oder ISC-Formular meldet Fehler (`details` enthält die Texte) | Eingabe korrigieren |
| `LOGIN_FAILED` | 502 | Anmeldung abgelehnt | Secret `ISC_USERNAME`/`ISC_PASSWORD` prüfen, Account im ISC prüfen |
| `LOGIN_UNEXPECTED` | 502 | Weder Startseite noch Login-Formular, oder ISC nicht erreichbar | Screenshot ansehen (Wartung? neuer Dialog? 2FA?) |
| `WRONG_GLIEDERUNG` | 502 | Gliederungswechsel nicht gelungen. Nichts wurde gespeichert | Zugang auf die Gliederung prüfen |
| `FORM_CHANGED` | 502 | Ein erwartetes Element fehlt. Oft ein ISC-Update | `step` ablesen, [Selektoren anpassen](#selektoren-anpassen-bei-isc-änderungen) |
| `SAVE_UNCONFIRMED` | 502 | Speichern nicht bestätigt | `newsId` prüfen, ob im ISC ein Entwurf liegt, bevor neu gestartet wird |
| `UPLOAD_FAILED` | 502 | Bild abgelehnt oder nicht übernommen. News bleibt Entwurf | `details` lesen, Bild oder Schlagworte prüfen |
| `PUBLISH_FAILED` | 502 | Veröffentlichen nicht bestätigt. News bleibt gesperrt | Im ISC prüfen, ob sie veröffentlicht ist |
| `TIMEOUT` | 504 | Gesamt-Timeout überschritten, Browser beendet | Bildanzahl und `uploadSettleMs` prüfen |
| `BUSY` | 429 | Ein anderer Lauf ist aktiv (`Retry-After: 60`) | Später erneut senden |
| `INTERNAL` | 500 | Unerwarteter Fehler | Logs ansehen |

Nach dem ersten Speichern liefert jede Fehlerantwort die `newsId` mit. So bleibt nichts verwaist: Die News liegt im ISC als Entwurf und lässt sich dort prüfen oder bearbeiten.

### `GET /categories`

Liest die Optionen von `select#CATEGORIES__` live aus. Ergebnis: `{ "ok": true, "categories": [{ "value": "4", "name": "DLRG Andernach" }, …] }`.

---

## Feld-Mapping

| API-Feld | ISC-Feld | Hinweis |
|---|---|---|
| `title` | `#TITLE` | |
| `subtitle` | `textarea#SUBTITLE` | |
| `html` | `textarea#TEXT` (CKEditor) | CKEditor 4 (`CKEDITOR.instances.TEXT`) oder 5 (`.ck-editor__editable` → `ckeditorInstance`) erkannt. Ergebnis wird per `getData` zurückgelesen und verglichen |
| `type` | `select#TYP` | `0` Text, `1` Link, `2` TYPO3. Danach wird der Typ-Block (`#nt0`/`#nt1`/`#nt2`) sichtbar abgewartet |
| `link` | `#LINK` | nur bei Typ Link |
| `typo3Id` | `#TYPO3ID` | nur bei Typ TYPO3 |
| `categories` | `select#CATEGORIES__` | bootstrap-selectpicker: `selectpicker('val', …)` plus `change`. Ergebnis wird gegen die Auswahl geprüft |
| `startDate` | `#STARTDATE` | `datetime-local`, Default jetzt (Europe/Berlin) |
| `archiveDate` | `#ARCHIVEDATE` | leer, wenn nicht angegeben |
| `endDate` | `#ENDDATE` | „Verbergen ab“ |
| `author` | `#AUTHOR` | Default `DLRG Andernach e.V./cdi` |
| `authorEmail` | `#AUTHOR_EMAIL` | Default `kommunikation@andernach.dlrg.de` |
| `mode` | `button#save` / `button#release` | Entwurf speichern oder zusätzlich veröffentlichen |
| `images[]` | Tab Medien, Dropzone `#mainUpload` | Upload über `input.dz-hidden-input` (Fallback: Dateiauswahl über `#mainUpload`), Antwort von `page=mediaService` |
| `images[].keywords` | `#mainUploadUploadKeywordTk` | Schlagwort-Tokens vor dem Upload, Ergebnis wird geprüft |
| `disallowResizeImage` | `input#disallowResizeImage` | |
| `firstAssetOnlyTeaser` | `input#firstAssetOnlyTeaser` | |

Alle Selektoren und URLs stehen zentral in [`src/isc/selectors.ts`](../../argocd/apps/tech/isc-news-bot/src/isc/selectors.ts).

---

## Kategorien

Die Liste ist eine Momentaufnahme der OG Andernach. Verbindlich ist `GET /categories`.

| ID | Name |
|---|---|
| 13 | DSM 2017 |
| 4 | DLRG Andernach |
| 5 | Einsatzgruppe |
| 6 | Schwimmtraining |
| 3 | Lehrgänge/Kurse |
| 7 | DLRG Jugend |
| 14 | Wasserrettungsdienst |
| 15 | Wachstation frei |
| 16 | Wachstation belegt |
| 21876 | Material |
| 22926 | Warteliste |
| 22607 | EDV |

Namen werden case-insensitive abgeglichen. Eine unbekannte Kategorie führt zu `VALIDATION_FAILED` mit dem Namen in `details`, es wird nichts angelegt.

---

## Konfiguration

Die Werte kommen aus der ConfigMap `isc-news-bot-config` (`values.yaml` → `config`). Zugangsdaten und Token liegen im SealedSecret.

| Variable | Default | Bedeutung |
|---|---|---|
| `ISC_BASE_URL` | `https://dlrg.net` | nur `https://` (außer für lokale Tests) |
| `GLIEDERUNG_EDV` | `1002011` | Ziel-Gliederung (Ortsgruppe Andernach e.V.) |
| `DEFAULT_AUTHOR`, `DEFAULT_AUTHOR_EMAIL` | `DLRG Andernach e.V./cdi`, `kommunikation@andernach.dlrg.de` | Vorbelegung |
| `DEFAULT_MODE` | `draft` | `draft` oder `publish` |
| `UPLOAD_SETTLE_MS` | `60000` | Wartezeit nach jedem Bild-Upload |
| `DEFAULT_IMAGE_KEYWORDS` | `News` | Komma-getrennt |
| `MAX_IMAGE_BYTES` | `15728640` | 15 MB je Bild |
| `MAX_BODY_BYTES` | `52428800` | 50 MB je Request |
| `STEP_TIMEOUT_MS` | `30000` | Timeout je Schritt |
| `LOCK_WAIT_MS` | `60000` | Wartezeit auf einen freien Lauf, danach `BUSY` |
| `PORT` | `8080` | HTTP-Port im Pod |

---

## Secrets anlegen und versiegeln

Im Secret `isc-news-bot-secrets` stehen drei Schlüssel: `ISC_USERNAME`, `ISC_PASSWORD` und `API_TOKEN`. Die Werte in `values.yaml` sind bis dahin Platzhalter (`REPLACE_ME_WITH_KUBESEAL_OUTPUT`). Ohne echte Werte startet der Pod nicht.

1. **ISC-Account anlegen.** Eigener Benutzer mit News-Rechten nur für die OG Andernach. Nicht der Hauptaccount, damit der Bot bei einem Problem nichts anderes berührt.
2. **Werte versiegeln.** Klartext nur per Eingabe, nie in der Shell-History und nie im Repo:
   ```bash
   read -rs ISC_USERNAME_VALUE && printf '%s' "$ISC_USERNAME_VALUE" | kubeseal --raw \
     --namespace isc-news-bot --name isc-news-bot-secrets \
     --controller-namespace sealed-secrets --controller-name sealed-secrets-controller \
     --from-file=/dev/stdin
   ```
   Dasselbe mit `ISC_PASSWORD` und einem frisch erzeugten Token (`openssl rand -hex 32`) für `API_TOKEN`. Jeder Befehl gibt einen Base64-Text aus.
3. **Ausgaben eintragen.** In `argocd/apps/tech/isc-news-bot/values.yaml` unter `secrets.encryptedData` die drei Werte ersetzen, committen und pushen.
4. **Token für n8n.** Denselben `API_TOKEN` als Header-Auth-Credential in n8n hinterlegen ([Workflow einrichten](#n8n-workflow-einrichten)).
5. **Register pflegen.** Die beiden Einträge `isc-news-bot-isc-login` und `isc-news-bot-api-token` in [`ops/token-register.yaml`](../../ops/token-register.yaml) führen Rotationsdatum und Verantwortliche. `scripts/check-token-register.py` prüft das im CI.

Rotation: Schritte 2 bis 4 wiederholen. Für `API_TOKEN` zuerst die neue Credential in n8n anlegen, dann rollen, damit nichts ausfällt.

---

## Deployment und Promotion

- **Deploy:** ArgoCD erkennt `argocd/apps/tech/isc-news-bot/` über den ApplicationSet `home-server-apps-tech` automatisch (Namespace `isc-news-bot`, AppProject `tech`). Die Registrierung steht in `ansible/roles/argocd/defaults/main.yml` (`argocd_workloads_apps`, `argocd_network_policy_refined_namespaces`). `projects.yaml` wird mit `make render-bootstrap` erzeugt.
- **Netzwerk-Stufe:** `make argocd` setzt das `security-tier`-Label und die Tier-Policy nach dem ersten Sync. Erst danach greift die Stufe vollständig.
- **Image:** `build-images.yml` baut bei Änderungen an Dockerfile, `src/`, `test/`, `scripts/` oder den Paketdateien nach `ghcr.io/pkr-lab/isc-news-bot`. Anschließend öffnet der Workflow einen `image.tag`-PR, der den Rollout auslöst. Neue GHCR-Pakete sind zunächst privat, bei `ImagePullBackOff` die Sichtbarkeit prüfen.
- **Promotion:** keine. Der Dienst gibt es nur in TECH, nicht in ENTW oder PROD. Ein Testlauf in ENTW würde mit echten Zugangsdaten gegen das echte ISC laufen. Testläufe laufen in TECH mit `dryRun`.
- **Hinweis zum Merge:** `main` ist die Quelle von ArgoCD. Ein Merge ohne versiegelte Secrets lässt den Pod in `CreateContainerConfigError` stehen, bis die Werte da sind.

Prüfen nach dem Sync:
```bash
kubectl -n isc-news-bot get pods,networkpolicy
kubectl -n isc-news-bot logs deploy/isc-news-bot --tail=50
kubectl -n isc-news-bot port-forward svc/isc-news-bot 8080:8080 &
curl -s http://127.0.0.1:8080/readyz
```

---

## n8n-Workflow einrichten

Der fertige Workflow liegt unter [`argocd/apps/tech/n8n/workflows/isc-news-veroeffentlichen.json`](../../argocd/apps/tech/n8n/workflows/isc-news-veroeffentlichen.json). Die Schritte nach dem Import stehen auch als Notiz im Workflow.

1. In n8n: *Workflows → Import from file*, die JSON wählen.
2. Credential **Header Auth** anlegen: Name `ISC-News-Bot API-Token`, Header `Authorization`, Wert `Bearer <API_TOKEN>`. Dem Node **ISC-News-Bot anlegen** zuweisen.
3. Node **Konfiguration** öffnen:
   - `testModus`: `true` für Probeläufe (`dryRun`, nichts wird gespeichert), danach `false`
   - `ntfyFreigabe`: `true`, wenn jede News vorher per ntfy freigegeben werden soll
   - `ntfyTopic`: Standard `isc-news`, in der ntfy-App abonnieren
4. Workflow **aktivieren**. Die Formular-URL steht am Node **Formular**, die Webhook-URL am Node **Webhook** (`/webhook/isc-news`, POST, JSON mit denselben Feldern wie oben).

Ablauf: Eingaben prüfen, Text in HTML umwandeln (Absätze, Zeilenumbrüche, Links), Bilder als Base64 anhängen, optional Freigabe per ntfy (Button führt zum n8n-Wait-Node, ohne Klick passiert nichts), `POST /news` mit einem Timeout aus Bildern × 2 min + 2 min, Erfolg oder Fehler per ntfy. Bei einem Fehler mit Screenshot kommt das Bild als Anhang.

Der Workflow importiert ohne Fehler in n8n `2.42.3` (Version im Cluster), die Node-Versionen existieren dort. Noch nicht getestet ist ein Lauf mit echtem Formular, ntfy und ISC: deshalb den ersten Lauf immer mit `testModus = true` machen. Die Formularfelder heißen **Überschrift**, **Untertitel**, **Text**, **Kategorie(n)**, **Veröffentlichung ab (leer = sofort, JJJJ-MM-TTTHH:mm)**, **Bilder**, **Modus** (Entwurf / Veröffentlichen).

---

## Selektoren anpassen bei ISC-Änderungen

Wenn das ISC die Oberfläche ändert, meldet der Dienst `FORM_CHANGED` oder `LOGIN_UNEXPECTED` und liefert einen Screenshot.

1. `step` und Screenshot in der Antwort oder im n8n-Fehler-Ping prüfen.
2. Den betroffenen Selektor in `src/isc/selectors.ts` anpassen. Die Logik liegt in `src/isc/*.ts`.
3. Mock-Fixture `test/fixtures/mock-isc.ts` an die neue Struktur angleichen und `npm test` lokal laufen lassen.
4. Vor dem Merge einen Probelauf mit `dryRun` gegen das echte ISC machen (siehe unten).

### Lokal testen

```bash
cd argocd/apps/tech/isc-news-bot
npm ci
npx playwright install chromium
npm test            # Typecheck, Unit-Tests, Mock-Tests (kein Zugriff auf das echte ISC)
```

Der echte Test gegen das ISC ist ein Dry-Run mit eigenen Zugangsdaten. Der Dienst speichert dabei nichts:

```bash
ISC_USERNAME='…' ISC_PASSWORD='…' API_TOKEN='lokal' SMOKE_TITLE='Testlauf bitte ignorieren' npm run smoke
```

Der Dry-Run legt keinen Eintrag an. Das Formular wird aber trotzdem gegen die Live-Seite geprüft.

Image lokal bauen: `docker build -t isc-news-bot:local .` in `argocd/apps/tech/isc-news-bot/`. Der Build-Stage kompiliert nur. Die Tests laufen mit `npm test` (lokal oder im Stage `build` per `docker run --rm --user 1000:1000 --read-only --tmpfs /tmp isc-news-bot:build npm test`, wenn das Image mit `--target build` gebaut wurde).

---

## Troubleshooting

| Symptom | Ursache und Lösung |
|---|---|
| Pod in `CreateContainerConfigError` | SealedSecret `isc-news-bot-secrets` fehlt oder ist nicht entschlüsselbar. Namespace und Name im `kubeseal`-Befehl prüfen |
| `ImagePullBackOff` | GHCR-Paket privat oder Secret `ghcr-pull` fehlt im Namespace |
| Jeder Lauf `LOGIN_FAILED` | Passwort geändert oder Account gesperrt. Im ISC prüfen, Secret neu versiegeln |
| `LOGIN_UNEXPECTED` nach Zugangswechsel | ISC zeigt einen Zwischenschritt (z. B. Dialog oder 2FA). Screenshot prüfen, Ablauf anpassen |
| `WRONG_GLIEDERUNG` | Account hat keinen Zugriff auf die Ziel-EDV oder `GLIEDERUNG_EDV` ist falsch |
| `FORM_CHANGED` nach ISC-Update | Selektor geändert, siehe [Selektoren anpassen](#selektoren-anpassen-bei-isc-änderungen) |
| `SAVE_UNCONFIRMED` | ISC zeigt keine Bestätigung. `newsId` im ISC prüfen, bevor erneut gestartet wird, sonst entstehen Dubletten |
| `UPLOAD_FAILED` mit „Schlagworte“ | Tokens wurden nicht übernommen. Schlagwort-Eingabe im ISC-Formular prüfen |
| `TIMEOUT` bei vielen Bildern | Gesamt-Timeout (`120 s + Bilder × (uploadSettleMs + 60 s)`) reicht nicht. n8n-Timeout entsprechend setzen |
| `BUSY` | Ein Lauf läuft noch. Bei Dauerbetrieb nicht parallel senden |
| n8n-Workflow bleibt beim Freigabe-Schritt hängen | Ohne Klick auf „Freigeben“ wartet der Wait-Node bewusst. Freigabe-Button oder Ausführung in n8n prüfen |

---

## Risiken

- **Nutzungsbedingungen DLRG.** Die Automatisierung bewegt sich in einem Web-Interface ohne offizielle API. Vor dem Betrieb mit dem Vorstand bzw. der Bundesebene klären, ob das zulässig ist.
- **Eigener Account.** Nur News-Rechte für die OG Andernach, kein Hauptaccount, kein Admin-Zugriff.
- **Fragilität.** Die Oberfläche kann sich ohne Vorwarnung ändern. Dann liefert der Dienst `FORM_CHANGED`, schreibt aber nichts Falsches.
- **2FA und Captcha.** Derzeit gibt es keines. Käme eines dazu, würde der Login mit `LOGIN_UNEXPECTED` abbrechen. Dann wäre ein anderer Zugangsweg nötig.
- **Keine Freigabe im Dienst.** Der Dienst veröffentlicht, wenn `mode: "publish"` gesetzt ist. Die Freigabe per ntfy liegt im n8n-Workflow (`ntfyFreigabe`).
- **Geheimnisse.** Der Dienst loggt weder Passwort, Cookies, CSRF-Werte noch Bilddaten. Der Feldname `lastChangeAznzeige` wird nicht geloggt, weil er Benutzernamen enthält.
- **Netzwerk.** Egress nur DNS und TCP 443 außerhalb der privaten Netze. Der Dienst ist nicht öffentlich erreichbar.
