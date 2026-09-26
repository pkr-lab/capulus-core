# pacman (Schulungsobjekt) — Hintergründe

Begründungen zu `argocd/apps/tech/pacman/` (Go-Server, Frontend-Skripte, Chart). pacman ist ein Pacman-Canvas-Fork, der in der IT-Security-Schulung zeigt, **was ein Webserver über
einen Besucher herausfinden kann**, mit einem Grafana-Dashboard als „Auflösung“. Zweck, Ablauf und Offenlegung stehen in
[300f0](../3-apps-workloads/300f0-pacman-visitor-tracking.md) und im [README des Charts](../../argocd/apps/tech/pacman/README.md). Hier stehen die Implementierungsentscheidungen.
Übersicht dieser Kategorie: [60000](60000-uebersicht.md).

> **Rahmen:** Die Erhebung von Besucherdaten ist ausschließlich für den abgegrenzten Schulungskontext mit informierten, einverstandenen Teilnehmenden gedacht, die vorher mündlich aufgeklärt
> werden. Das Trainingsmodus-Flag ist deshalb standardmäßig **aus**.

---

## Server (Go)

### Auslieferung und Vendoring

Der Server liefert die vendorten Pacman-Canvas-Assets aus und schreibt je Request eine strukturierte JSON-Zeile (Client-IP, User-Agent und, falls eine MMDB-Geo-Datenbank gemountet ist, den
aufgelösten Standort). Änderungen am vendorten Spiel werden **nicht** in dessen Dateien vorgenommen, sondern im Server, damit ein erneutes Vendoring vom Upstream ein sauberer Diff bleibt statt
eines Merge-Konflikts:

- `serveStatic` schreibt `/` auf `index.htm` um. Der vendorte Quellcode liefert `index.htm`, nicht `index.html`, und Gos `http.FileServer` erkennt einen impliziten Verzeichnis-Index nur unter dem Namen
  `.html`. Ohne die Umschreibung fiele `/` auf das Verzeichnislisting des FileServers statt auf das Spiel.
- `serveIndexWithFingerprint` injiziert das `<script>`-Tag für `fingerprint.js` und das Flag `window.PACMAN_TRAINING_MODE` in `index.htm`, statt das vendorte HTML zu editieren.
- Der Trainingsmodus (`TRAINING_MODE`, `trainingMode.enabled`) wird **serverseitig** gerendert und nicht clientseitig entschieden. So wirkt er für jeden Besucher konsistent und ist kein clientseitiger Schalter,
  den ein neugieriger Besucher per Devtools umlegen könnte.
- `handleLeaderboard` ersetzt das ursprüngliche `data/db-handler.php` des Spiels (PHP, wurde in diesem reinen Go-Setup nie ausgeliefert).

### Bestenliste

- **Nur im Speicher.** Es ist keine PVC gemountet (`readOnlyRootFilesystem: true`), und der Server kann mit 1–3 Replicas hinter einem einfachen ClusterIP-Service ohne Session-Affinity laufen. Die Einträge sind daher
  **pro Pod**: Eine Einreichung kann auf einem anderen Pod landen als ein späteres Listing, ein Scale-Down oder Neustart verwirft alles. Für dieses Schulungs-/Demo-Spiel akzeptabel und im README dokumentiert,
  statt es mit geteiltem Speicher zu lösen.
- Die Seitengröße (10) spiegelt das `LIMIT 10` des alten `db-handler.php`. `maxLeaderboardEntries` begrenzt den Speicherverbrauch, da nur die Top-Scores je ausgeliefert werden.
- **`maxPointsPerLevel`** spiegelt `validateScoreWithLevel()` in `pacman-canvas.js` (104 Pillen + 4 Powerpillen + 4 Geister je Fright-Zyklus, mal 4 Geister) und wird **manuell synchron gehalten**. Beide Seiten sind
  dieselbe Anti-Cheat-Grenze, unabhängig angewendet: der Client für die UX, der Server, weil man dem Client nicht trauen kann.
- **`nicknamePattern`** akzeptiert nur die von `nickname.js` erzeugten Tags `<NAME>-<HEX4>` und weist alles andere ab, damit die öffentliche Bestenliste nicht zum Ablegen beliebiger Strings taugt. Der eingegebene
  Klarname erreicht diesen Endpunkt nie, nur das abgeleitete Tag.

### Zugriffslog

- Je Request eine Zeile `http_access`, getrennt davon je Seitenaufruf eine Zeile `client_fingerprint` (POST von `fingerprint.js`). In Grafana lassen sich beide über `remote_ip` (und grob über die Zeit)
  korrelieren.
- **`clientIP`** liefert die echte Besucher-IP (v4 oder v6). Cloudflare setzt `CF-Connecting-IP` am Edge als einzelnen, verbindlichen Wert, bevor der Request den Cluster erreicht, anders als
  `X-Forwarded-For`, das eine mehrstufige Kette tragen kann. Fallback ist der erste `X-Forwarded-For`-Eintrag, dann die rohe TCP-Gegenstelle. Das von Cloudflare am Edge ermittelte Land dient als **unabhängige
  Gegenprobe** zum lokalen DB-IP-GeoIP-Lookup.
- Alle Header-Felder sind **passive** Request-Header-Erfassung, ohne dass der Besucher etwas tun muss: Browser/OS per Client Hints, Content-Negotiation, Fetch-Kontext und die Opt-out-Signale selbst
  (DNT/GPC). Dass ein Header „don’t track me“ im Log landet, ist selbst Teil der Aussage der Demo.
- **`parseUserAgent`** ist bewusst einfaches, **geordnetes** Substring-Matching, keine UA-Parser-Bibliothek, für die Standardbrowser reicht das im Klassenraum. Die Reihenfolge ist entscheidend:
  - Fast jeder UA behauptet, mehrere Browser zu sein (Edge und Opera enthalten aus Kompatibilität `Chrome/` und `Safari/`), deren eigene Marker müssen zuerst geprüft werden.
  - iPhone-/iPad-UAs enthalten `like Mac OS X`, iOS muss vor dem einfachen `Mac OS X` geprüft werden, sonst würde jedes iPhone als macOS gemeldet.
  - Android-UAs enthalten ebenfalls `Linux`, Android muss zuerst geprüft werden.
- Browser und OS werden serverseitig aus dem `user_agent` geparst, damit Grafana sie als eigene Tabellenspalten zeigen kann, statt dass jeder den einen rohen User-Agent lesen muss.

### GeoIP

Quelle ist **DB-IP City Lite** (db-ip.com, CC BY 4.0): kostenlos, kein Account und kein Lizenzschlüssel, monatlicher Direct-Download (siehe README). Standardmäßig **an**, weil das der Zweck der App ist. Schlägt der
Download trotzdem fehl, läuft der Server weiter und loggt nur die rohe IP.

### Trainingsmodus

`trainingMode.enabled` koppelt das Namensfeld im Nickname-Overlay an dieselbe versteckte Autofill-Ernte (E-Mail, Telefon, Adresse, PLZ), die `fingerprint.js` für die eigene Ecke nutzt. Standard ist **aus**.

- **Achtung:** Der Host ist über `ingress.hosts` **öffentlich ohne Auth und ohne IP-Allowlist** erreichbar (`pacman-prod.pke-lab.de`). `enabled: true` wirkt serverseitig für **jeden** Request auf `/`,
  nicht nur für eine informierte, freiwillig teilnehmende Gruppe, sondern für jeden, der die URL in diesem Zeitraum aufruft (Suchmaschinen-Crawler, alte Links, zufällige Besucher eingeschlossen).
- Deshalb **nur für die Dauer der jeweiligen Unterrichtsstunde aktivieren** und danach wieder auf `false` setzen (neues Chart-Release, siehe README). Der Serverstart loggt bei `enabled: true`
  zusätzlich eine Warnzeile („training mode ENABLED“) als Erinnerung.

---

## Frontend

### `fingerprint.js`

Clientseitige Erfassung für die Schulungsdemo. Sie ist **nicht** Teil des vendorten pacman-canvas-Spiels, sondern von uns ergänzt und serverseitig eingebunden. Sie liest ausschließlich Browser-APIs, auf die
eine Seite ohne jede Berechtigungsabfrage zugreifen kann. **Geolocation, Kamera und Mikrofon werden bewusst nicht verwendet**: Sie zeigen einen sichtbaren Browser-Dialog, was den Punkt „niemand bemerkt es“
der Demo zunichtemachen würde.

- **Hash:** FNV-1a mit 32 Bit ist schnell, synchron und braucht keinen WebCrypto-Roundtrip. Er ist nicht kryptografisch, muss nur unterscheidbare Eingaben unterscheiden, und mehr braucht ein Fingerprint nicht.
- **`harvestAutofill`** ist die eine bewusst invasivere Technik: ein **echtes, sichtbares** Feld („Name für die Bestenliste“, ein plausibles Spiel-UX-Element) im **selben `<form>`** wie unsichtbare
  E-Mail-/Telefon-/Adressfelder. Ein vollständig unsichtbares Köder-Formular funktioniert gegen modernes Chrome nicht: Das Befüllen eines Felds aus einem gespeicherten Profil erfordert einen echten Klick des
  Nutzers auf den Autofill-Vorschlag, den JavaScript nicht auslösen kann. Chrome füllt aber **alle passenden Felder eines Formulars gemeinsam**, sobald der Nutzer einen Vorschlag annimmt, die versteckten Felder
  fahren also mit. Das entspricht der Funktionsweise echter täuschender Formulare (ein glaubwürdig aussehendes Einzelfeld verbirgt ein größeres Formular) und wird danach offengelegt.
- Die versteckten Felder liegen **außerhalb des sichtbaren Bereichs** (off-screen, Größe 0 und `opacity:0`), **nicht** mit `display:none`/`visibility:hidden`: Manche Browser schließen solche Felder vom Autofill
  komplett aus. Der Besucher bekommt eine echte Chance, den Dialog zu bemerken, mit dem Namensfeld zu interagieren (das ist es, was Chromes Autofill-Dropdown auslöst) und abzusenden oder zu ignorieren,
  bevor die Werte in jedem Fall eingesammelt und entfernt werden.
- **Zwei getrennte Wege:** Das Widget in der Ecke erntet **unbedingt**, unabhängig vom Trainingsmodus-Flag. Das Namensfeld der Bestenliste (siehe unten) nutzt denselben Trick nur bei
  `window.PACMAN_TRAINING_MODE === true`.

### `nickname.js` (Bestenlisten-Identität)

- Beim ersten Besuch fragt ein Overlay (`#nickname-overlay`) nach einem Anzeigenamen, mit einem **echten, einzelnen** `<input name="name" autocomplete="name">` mit echter Browser-Autofill-Unterstützung.
- **Der eingegebene Name verlässt den Browser nie.** Er erzeugt und speichert nur ein pseudonymes Tag `<NAME>-<HEX>`, das Einzige, was `pacman-canvas.js` an die öffentliche `/api/leaderboard` schickt. Das Tag ist
  mit Zeit und Zufall gesalzen, damit derselbe Name zweimal (verschiedene Personen oder dieselbe Person nach einem Reset) auf der gemeinsamen öffentlichen Bestenliste nicht kollidiert. Der Hash ist derselbe
  FNV-1a wie in `fingerprint.js`.
- Im Trainingsmodus verdrahtet dasselbe sichtbare Namensfeld die versteckte Autofill-Ernte. Was dort eingesammelt wird, geht an `/api/fingerprint` (**nur Server-Log**, getrennte Pipeline, dieselbe Log-Zeile
  `client_fingerprint` wie die Ernte der Ecke, korrelierbar in Grafana) und taucht **nie** im Nickname oder auf der Bestenliste auf. `ajax_add()` in `pacman-canvas.js` schickt nur das Nickname-Tag an
  `/api/leaderboard`, diese Daten berühren diesen Endpunkt nie.
- Das Tag und das Konfigurationsobjekt werden für `pacman-canvas.js` (Game-Over-Einreichung) und den Link „Namen ändern“ im Info-Panel bereitgestellt.
