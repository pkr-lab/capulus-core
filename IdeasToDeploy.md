# Ideas to Deploy at a Later Point

Loki (+ Promtail) – ihr habt VictoriaMetrics/Grafana nur für Metriken, aber keine zentrale Log-Aggregation; passt direkt in den bestehenden Grafana-Stack.

## Alltag / Produktivität

Firefly III – persönliche Finanzverwaltung/Budgetierung, gut wenn ihr Ausgaben/Abos im Blick behalten wollt.

Homepage (oder Homarr) – ein Dashboard mit Links/Status für alle eure Self-Hosted-Dienste statt Lesezeichen-Chaos. (Glance wurde dafür testweise deployed und wieder entfernt — offen, ob eine der beiden Alternativen stattdessen sinnvoll ist.)

## Vereins-IT (DLRG OG Andernach)

### Einsatzbereich

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
Zusätzlich zu Pegelonline/DWD/Hochwasser/ELWIS (bereits deployed, siehe [docs/31-rhein-dashboard.md](docs/31-rhein-dashboard.md)):

Open-Meteo – kostenlose Wettervorhersage ohne API-Key, einfacher als DWD-Rohdaten zu parsen
Sunrise-Sunset API – Sonnenuntergang für "Wachdienst-Ende"-Planung
UV-Index – Einschätzung Badebetrieb/Besucheraufkommen
Pollenflug (DWD) – relevant bei Zeltlagern/Ausbildung im Freien
Aggregierte Einsatzstunden aus NocoDB (nur Summen, keine personenbezogenen Rohdaten) – "Einsatzstunden diesen Monat"
Belegungsplan-Übersicht (Booked Scheduler/CalDAV) – nur "Boot frei/belegt", nicht der volle interne Kalender
Uptime-Status eurer Vereins-Dienste (Wiki, NocoDB) via Uptime Kuma – Status ja, Infra-Details nein
Grundsatz: in die DLRG-Org nur aggregierte/öffentliche Daten, nichts, was Rückschlüsse auf eure interne Infrastruktur erlaubt.