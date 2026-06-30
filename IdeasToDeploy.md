# Ideas to deploy at later Poind

Loki (+ Promtail) – ihr habt VictoriaMetrics/Grafana nur für Metriken, aber keine zentrale Log-Aggregation; passt direkt in den bestehenden Grafana-Stack.

Vaultwarden – leichtgewichtiger Passwort-Manager (Bitwarden-kompatibel), sinnvoll als persönlicher Dienst hinter eurem bereits vorhandenen Authentik-SSO.

## Alltag / Produktivität

Paperless-ngx – digitalisiert Briefe, Rechnungen und Verträge per OCR und macht sie durchsuchbar; Scanner/Handy-Foto reinwerfen, Rest läuft automatisch.

Mealie – Rezeptverwaltung + Wochenplaner, importiert Rezepte direkt von Kochseiten per URL.

Grocy – Haushalts-ERP: Vorräte, Einkaufsliste, Ablaufdaten, Putzplan – nützlich, wenn ihr Lebensmittelverschwendung/Vorräte im Griff haben wollt.

Immich – Foto/Video-Backup vom Handy (Google-Photos-Ersatz), inkl. Gesichtserkennung und Timeline; spielt gut mit eurem MinIO/HDD-Storage zusammen.

Nextcloud – Datei-Sync, Kalender, Kontakte; deckt mehr ab als Immich/Paperless einzeln, dafür schwerer (mehr RAM, mehr Wartung).

Firefly III – persönliche Finanzverwaltung/Budgetierung, gut wenn ihr Ausgaben/Abos im Blick behalten wollt.

Homepage (oder Homarr) – ein Dashboard mit Links/Status für alle eure Self-Hosted-Dienste statt Lesezeichen-Chaos.

n8n – Low-Code-Automatisierung (Zapier-Ersatz), z. B. "neue Rechnung in Paperless → Benachrichtigung via ntfy".

Uptime Kuma – einfache Status-Seite/Alerting für "ist Dienst X gerade erreichbar", ergänzt VictoriaMetrics für den schnellen Blick.

## Vereins-IT (DLRG OG Andernach)

### Einsatzbereich

Wiki.js (oder BookStack) – SOPs, Alarm- und Ausrückeordnung, Checklisten zentral und durchsuchbar statt Word-Dateien in WhatsApp-Gruppen verteilt.

Grafana-Dashboard mit Pegelonline-API (WSV, öffentlich & kostenlos) – Rhein-Pegel Andernach live einbinden, hilft bei Wachdienst- und Einsatzplanung.

DWD Open Data API (Deutscher Wetterdienst, öffentlich & kostenlos) – Unwetter-/Sturmwarnungen für Andernach als Grafana-Panel + automatischer ntfy-Push an die Einsatzleitung bei Gewitter/Starkregen während des Wachdienstes.

Hochwasservorhersage RLP / Hochwasserzentralen.de (öffentlich & kostenlos) – ergänzt den reinen Ist-Pegel von Pegelonline um eine 24–48h-Vorhersage, relevant für vorausschauende Einsatzplanung statt nur Momentaufnahme.

ELWIS (Elektronischer Wasserstraßen-Informationsservice, öffentlich & kostenlos) – Schifffahrtsmeldungen, Sperrungen und Fahrwasser-Infos zum Rhein bei Andernach, gut als zusätzliches Grafana-Panel oder Wiki.js-verlinkte Quelle.

uMap (self-hosted, basiert auf OpenStreetMap) – eigene Einsatzkarte mit Layern für Wachstellen, Rettungspunkte, Einsatzgebiete und Bootshaus-Zufahrten; lässt sich direkt aus Wiki.js verlinken/einbetten.

Sahana Eden (open source, spezialisiert auf Katastrophen-/Einsatzorganisationen) – falls mehr als nur Doku/Karten gebraucht wird: Ressourcen-, Freiwilligen- und Lageübersicht in einem System; deutlich größer als die anderen Vorschläge, daher nur bei echtem Bedarf.


### Empfohlene Architektur
Statt Ordner-Berechtigungen (die in Grafana OSS nicht wirklich "hart" isolieren, weil Datenquellen org-weit sichtbar bleiben) lieber eine zweite Grafana-Organisation:

Neue Authentik-Gruppe z. B. dlrg-public, getrennt von authentik Admins und euren internen Gruppen.
Neue Grafana-Org "DLRG" (eigene Org-ID) mit eigenen Datasources + Dashboards — Orgs sind in Grafana vollständig isoliert (Datasources, Dashboards, Folders, Users), nicht nur "ausgeblendet".
grafana.ini → auth.generic_oauth um org_mapping erweitern, z. B. sinngemäß:

org_mapping = "dlrg-public:2:Viewer, authentik Admins:1:Admin, *:1:Viewer"
damit die dlrg-public-Gruppe ausschließlich Viewer in Org 2 wird und gar nicht erst in Org 1 (eure Homelab-Org) landet.
Wichtig: auto_assign_org/Default-Rolle so setzen, dass ein neuer DLRG-Account nicht zusätzlich automatisch der Main Org beitritt.
Das ist eine echte Zugriffstrennung, nicht nur ein UI-Filter — DLRG-Nutzer können technisch nicht an eure k3s-/Infra-Metriken kommen.

Was in diese DLRG-Org rein könnte
Zusätzlich zu Pegelonline/DWD/Hochwasser/ELWIS (schon notiert):

Open-Meteo – kostenlose Wettervorhersage ohne API-Key, einfacher als DWD-Rohdaten zu parsen
Sunrise-Sunset API – Sonnenuntergang für "Wachdienst-Ende"-Planung
UV-Index – Einschätzung Badebetrieb/Besucheraufkommen
Pollenflug (DWD) – relevant bei Zeltlagern/Ausbildung im Freien
Aggregierte Einsatzstunden aus NocoDB (nur Summen, keine personenbezogenen Rohdaten) – "Einsatzstunden diesen Monat"
Belegungsplan-Übersicht (Booked Scheduler/CalDAV) – nur "Boot frei/belegt", nicht der volle interne Kalender
Uptime-Status eurer Vereins-Dienste (Wiki, NocoDB) via Uptime Kuma – Status ja, Infra-Details nein
Grundsatz: in die DLRG-Org nur aggregierte/öffentliche Daten, nichts, was Rückschlüsse auf eure interne Infrastruktur erlaubt.