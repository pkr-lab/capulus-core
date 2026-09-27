# Ideas to Deploy at a Later Point

Ideensammlung für spätere Apps und Vorhaben. Nichts davon ist umgesetzt oder verbindlich geplant; was
konkret wird, bekommt ein Doc unter [docs/4-planung/](docs/4-planung/) (Konvention:
[docs/TEMPLATE.md](docs/TEMPLATE.md)) und einen Ordner unter `argocd/apps/entw/` zum Ausprobieren
([docs/b-kubernetes-gitops/b0050-entw-argocd.md](docs/b-kubernetes-gitops/b0050-entw-argocd.md)).

---

## Alltag / Produktivität

- **Firefly III** — persönliche Finanzverwaltung/Budgetierung, gut, um Ausgaben/Abos im Blick zu behalten.
- **Homepage** (oder **Homarr**) — ein Dashboard mit Links/Status für alle Self-Hosted-Dienste statt
  Lesezeichen-Chaos. Glance wurde dafür testweise deployed und wieder entfernt; offen ist, ob eine der beiden
  Alternativen stattdessen sinnvoll ist.

---

## Vereins-IT (DLRG OG Andernach)

### Einsatzbereich: Alarm-Erkennung + Audio-Ausgabe am Banana Pi

Recherche auf Basis des bestehenden Aufbaus (Rolle `banana_pi_kiosk`,
[docs/3-apps-workloads/30010-alamos-apager.md](docs/3-apps-workloads/30010-alamos-apager.md),
[docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md](docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md))
und des ALAMOS-Handbuchs. Ausgangslage: Der Pi zeigt aktuell nur die AMweb-Seite im Chromium-Kiosk an. Er
selbst „weiß" nicht, ob gerade ein Alarm läuft, das steckt komplett in der AMweb-Seite (Cloud-Dienst der
Alamos GmbH).

#### 1. Kann der Pi den Alarmstatus über eine URL auslesen?

Ja — ALAMOS/AMweb bietet dafür mehrere serverseitige Schnittstellen. Sie sind im Alamos-Handbuch
dokumentiert, das hinter einem Login liegt (der bestehende Alamos-Account genügt).

| Schnittstelle | Richtung | Eignung für den Vereinsheim-Fall |
|---|---|---|
| Webhooks (AMweb-Seiteneinstellung) | Push, GET, feuert bei neuem Alarm („NEW") und wieder, wenn „kein Alarm mehr offen" ist | Wichtige Einschränkung laut Handbuch: der Aufruf passiert aus dem Browser-Tab heraus, und „Aufruf lokaler URLs (z. B. Skripte auf demselben PC) werden i. d. R. durch den Browser aus Sicherheitsgründen blockiert". Das betrifft den Kiosk direkt, weil genau dieser Browser-Tab auf dem Pi läuft |
| Allgemeine Webhooks | Push, GET/POST, nur echte Alarme (Tab „Alarm"), nicht Info/Wetter/Status | Flexibler, aber dieselbe Blockierungs-Problematik zu klären |
| Monitoring-Schnittstelle | Pull, HTTP GET mit Access-Key, Antwort als Text oder JSON | Klingt am ehesten nach „von außen aktiv abfragen"; die genaue Endpunkt-Syntax ist ohne Login nicht einsehbar |
| JSON-Plugin / Zugriff via HTTP POST/GET | eher die umgekehrte Richtung (FE2 schickt Alarm als JSON raus) | für das Auslesen weniger relevant |

Die genauen Endpunkt-URLs und Parameter sind öffentlich nicht abrufbar (die Confluence-Seiten geben nur
Kurzbeschreibungen preis), sie müssen einmal mit dem Alamos-Account nachgeschlagen werden.

**Praktischer Haken:** Weil der Webhook client-seitig aus dem Kiosk-Chromium heraus feuert, würde ein Aufruf
von `http://localhost:…` vermutlich als Mixed-Content/lokaler Zugriff blockiert (genau das warnt das
Handbuch). Passend zur bestehenden Architektur wäre eine **HTTPS-Ziel-URL bei `alamos-apager`** (läuft
schon hinter Traefik mit vertrauter CA, `alamos-apager.prod.homeserver`) sauberer als ein lokaler Endpunkt
auf dem Pi. Der Webhook trägt den Alarmstatus dann in den Cluster, und der ohnehin alle 30 s laufende
Supervisor-Loop auf dem Pi (`banana-pi-kiosk-supervisor.sh.j2`) könnte parallel zum bestehenden
`/heartbeat`-Call einen neuen `/alarm-status?station=X` abfragen.

#### 2. Kann der Pi dann eine Audiodatei über den Aux-Ausgang abspielen?

Ja, technisch unproblematisch:

- Der Banana Pi M2 Ultra hat unter Armbian (Debian 13 „Trixie") ALSA-Unterstützung für die Klinkenbuchse.
  Laut Armbian-Forum ist der Sound teils erst per Device-Tree-Overlay/DTSI zu aktivieren. Das vorher am
  Gerät mit `aplay -l` bzw. `speaker-test -c2` prüfen.
- Abspielen selbst ist trivial: `aplay alarm.wav` (nativ, kein Zusatzpaket, gut für einen systemd-Oneshot)
  oder `mpg123`/`mpv --no-video`, falls es eine MP3 sein soll.
- Die ALSA-Standardausgabe muss explizit auf die Klinke statt HDMI gelegt werden (`/etc/asound.conf` bzw.
  `amixer`), da das Board vermutlich mehrere Audio-Sinks hat.
- Fund im bestehenden Skript: `banana-pi-kiosk-supervisor.sh.j2` startet Chromium bereits mit
  `--autoplay-policy=no-user-gesture-required`. Audio-Autoplay im Browser ist also schon freigeschaltet. Es
  lohnt sich zu prüfen, ob AMweb selbst einen eingebauten Alarmton abspielen kann (viele Alarmtableaus haben
  das). Dann braucht es evtl. gar keinen eigenen Webhook/Skript, sondern nur die Sicherheit, dass
  ALSA/Chromium-Audio auf den Aux-Ausgang statt HDMI geroutet ist.

#### Empfehlung

1. Zuerst in den AMweb-Seiteneinstellungen nachsehen, ob es eine eingebaute Alarmton-Option gibt. Falls ja, ist
   Schritt 2 (ALSA → Aux routen) schon die ganze Lösung.
2. Für einen eigenen/anderen Sound je Station: Webhook-Ziel auf eine HTTPS-Route bei `alamos-apager` legen
   (nicht auf `localhost` am Pi, wegen der Browser-Blockade), von dort den Alarmstatus an den Pi
   weiterreichen (z. B. über den bestehenden Supervisor-Poll-Loop), der dann lokal `aplay` aufruft.
3. Die exakte Webhook-/Monitoring-Endpunkt-Syntax braucht einmal einen Blick ins Alamos-Handbuch mit dem
   Login.
