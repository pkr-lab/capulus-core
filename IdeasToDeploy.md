# Ideas to Deploy at a Later Point

Loki (+ Promtail) – ihr habt VictoriaMetrics/Grafana nur für Metriken, aber keine zentrale Log-Aggregation; passt direkt in den bestehenden Grafana-Stack.

## Alltag / Produktivität

Firefly III – persönliche Finanzverwaltung/Budgetierung, gut wenn ihr Ausgaben/Abos im Blick behalten wollt.

Homepage (oder Homarr) – ein Dashboard mit Links/Status für alle eure Self-Hosted-Dienste statt Lesezeichen-Chaos. (Glance wurde dafür testweise deployed und wieder entfernt — offen, ob eine der beiden Alternativen stattdessen sinnvoll ist.)

## Vereins-IT (DLRG OG Andernach)

### Einsatzbereich

Recherche: Alarm-Erkennung + Audio-Ausgabe am Banana Pi
Ich habe mir den bestehenden Aufbau angeschaut (banana_pi_kiosk-Rolle, docs/3-apps-workloads/30010-alamos-apager.md, docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md) und dazu im ALAMOS-Handbuch recherchiert. Kurz zur Einordnung: Der Pi zeigt aktuell nur die AMweb-Seite im Chromium-Kiosk an — er selbst "weiß" nicht, ob gerade ein Alarm läuft, das steckt komplett in der AMweb-Seite (Cloud-Dienst von Alamos GmbH).

1. Kann der Pi den Alarmstatus über eine URL auslesen?
Ja — ALAMOS/AMweb bietet dafür mehrere serverseitige Schnittstellen (dokumentiert im Alamos-Handbuch, das hinter einem Login liegt, den ihr über den bestehenden Alamos-Account ja schon habt):

Schnittstelle	Richtung	Eignung für euren Fall
Webhooks (AMweb-Seiteneinstellung)	Push, GET, feuert bei neuem Alarm ("NEW") und wieder wenn "kein Alarm mehr offen"	Wichtige Einschränkung laut Handbuch: der Aufruf passiert aus dem Browser-Tab heraus, und "Aufruf lokaler URLs (z. B. Skripte auf demselben PC) werden i. d. R. durch den Browser aus Sicherheitsgründen blockiert" — betrifft euch direkt, weil genau dieser Browser-Tab der Kiosk auf dem Pi ist
Allgemeine Webhooks	Push, GET/POST, nur echte Alarme (Tab "Alarm"), nicht Info/Wetter/Status	Flexibler, aber gleiche Blockierungs-Problematik zu klären
Monitoring-Schnittstelle	Pull, HTTP GET mit Access-Key, Antwort als Text oder JSON	Klingt am ehesten nach "von außen aktiv abfragen" — genaue Endpunkt-Syntax war für mich nicht ohne Login einsehbar
JSON-Plugin / Zugriff via HTTP POST/GET	eher die umgekehrte Richtung (FE2 schickt Alarm als JSON raus)	für Auslesen weniger relevant
Die genauen Endpunkt-URLs/Parameter konnte ich nicht öffentlich abrufen — die Confluence-Seiten geben nur Kurzbeschreibungen preis, Details liegen hinter dem Alamos-Login. Das müsstet ihr mit eurem Alamos-Account einmal nachschlagen (Links unten).

Praktischer Haken: Weil der Webhook client-seitig aus dem Kiosk-Chromium heraus feuert, würde ein Aufruf von http://localhost:... vermutlich als Mixed-Content/lokaler Zugriff blockiert (genau das warnt das Handbuch). Passt zur bestehenden Architektur würde eine HTTPS-Ziel-URL bei eurem alamos-apager (das läuft schon mit vertrauter CA hinter Traefik) sauberer funktionieren als ein lokaler Endpunkt auf dem Pi selbst — der Webhook trägt den Alarmstatus dann in den Cluster, und der ohnehin schon alle 30s laufende Supervisor-Loop auf dem Pi (banana-pi-kiosk-supervisor.sh.j2) könnte parallel zum bestehenden /heartbeat-Call einen neuen /alarm-status?station=X abfragen.

2. Kann der Pi dann eine Audiodatei über den Aux-Ausgang abspielen?
Ja, technisch unproblematisch:

Der Banana Pi M2 Ultra hat unter Armbian (Debian 13 "Trixie") ALSA-Unterstützung für die Klinkenbuchse — laut Armbian-Forum ist der Sound teils erst per Device-Tree-Overlay/DTSI zu aktivieren, das solltet ihr mit aplay -l bzw. speaker-test -c2 einmal am Gerät prüfen, bevor ihr darauf baut.
Abspielen selbst ist trivial: aplay alarm.wav (nativ, kein Zusatzpaket, gut für einen systemd-Oneshot) oder mpg123/mpv --no-video falls es eine MP3 sein soll.
ALSA-Standardausgabe muss explizit auf die Klinke statt HDMI gelegt werden (/etc/asound.conf bzw. amixer), da das Board vermutlich mehrere Audio-Sinks hat.
Interessanter Fund im bestehenden Skript: banana-pi-kiosk-supervisor.sh.j2:44 startet Chromium bereits mit --autoplay-policy=no-user-gesture-required. Das heißt, Audio-Autoplay im Browser ist schon freigeschaltet. Es lohnt sich zu prüfen, ob AMweb selbst schon einen eingebauten Alarmton abspielen kann (viele Alarmtableaus haben das) — dann bräuchtet ihr evtl. gar keinen eigenen Webhook/Skript, sondern müsstet nur sicherstellen, dass ALSA/Chromium-Audio auf den Aux-Ausgang statt HDMI geroutet ist.

Empfehlung
Zuerst in den AMweb-Seiteneinstellungen nachsehen, ob es eine eingebaute Alarmton-Option gibt — falls ja, ist Schritt 2 (ALSA → Aux routen) schon die ganze Lösung.
Falls ihr einen eigenen/anderen Sound je Station wollt: Webhook-Ziel auf eine HTTPS-Route bei alamos-apager legen (nicht auf localhost am Pi, wegen der Browser-Blockade), von dort den Alarmstatus an den Pi weiterreichen (z. B. über den bestehenden Supervisor-Poll-Loop), der dann lokal aplay aufruft.
Exakte Webhook-/Monitoring-Endpunkt-Syntax braucht einmal einen Blick ins Alamos-Handbuch mit eurem Login.