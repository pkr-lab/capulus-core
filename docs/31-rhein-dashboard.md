# Rhein-Dashboard — Pegel, Warnungen & Schifffahrt Andernach

Das Grafana-Dashboard **"Rhein Andernach — Pegel & Warnungen"** zeigt
Echtzeitdaten aus vier öffentlichen, kostenlosen Datenquellen.

Grafana URL: **http://grafana.homeserver** → Dashboard: *Rhein Andernach*

---

## Datenquellen

| Quelle | Betreiber | Lizenz | Zweck |
|---|---|---|---|
| **Pegelonline** | WSV (Wasser- und Schifffahrtsverwaltung) | öffentlich & kostenlos | Aktueller Rhein-Pegel + Verlauf |
| **DWD Open Data** | Deutscher Wetterdienst | öffentlich & kostenlos | Unwetter- und Sturmwarnungen |
| **ELWIS** | WSV | öffentlich & kostenlos | Schifffahrtsmeldungen, Sperrungen |
| **Hochwasser RLP** | LUWG RLP | öffentlich & kostenlos | 24–48h Hochwasservorhersage |

---

## Dashboard-Panels

### Pegelonline — Rhein-Pegel Andernach

**API:** `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/ANDERNACH/W/measurements.json?start=P2D`

- **Stat-Panel:** Aktueller Wasserstand in cm mit Farbschwellen
- **Zeitreihe:** 48h-Verlauf mit Hochwassermeldestufen-Markierungen
- **Gauge:** Visueller Füllstand mit Schwellenwert-Markierungen
- **Tabelle:** Nachbarstationen am Rhein (km 580–650)

Hochwassermeldestufen Andernach (Rhein):

| Stufe | Pegel | Bedeutung |
|---|---|---|
| 1 | ≥ 430 cm | Beobachtung |
| 2 | ≥ 570 cm | Kontrollmaßnahmen |
| 3 | ≥ 660 cm | Einsatz |
| 4 | ≥ 800 cm | Katastrophenschutz |

### DWD Warnungen — Kreis Mayen-Koblenz

> **⚠ API eingestellt:** Der DWD hat die JSON-API (`warnapp_gemeinden/json/`) abgeschaltet (HTTP 404).
> Die Nachfolge-URL (`warnapp/json/warnings.json`) liefert **JSONP**, kein valides JSON — nicht kompatibel
> mit dem Infinity-Plugin. Das Panel zeigt daher statische Links zum DWD-Warnportal.
>
> Alternative für Grafana: NINA-API (`https://nina.api.bund.dev`) oder Katwarn-API prüfen.

- Warncell-ID `807137000` = Landkreis Mayen-Koblenz
- Warnstufen: 1 = Gelb, 2 = Orange, 3 = Rot, 4 = Violett

### ELWIS — Schifffahrtsmeldungen

Text-Panel mit direkten Links zu:
- Schifffahrtsmeldungen Rhein (Sperrungen, Baustellen)
- Fahrwassertiefe Rhein

### Hochwasservorhersage RLP

Text-Panel mit Meldestufen-Referenz und Link zum LUWG-Portal
(Hochwasservorhersage 24–48h).

---

## Technische Umsetzung

### Grafana Infinity Plugin

Das Dashboard nutzt das **Yesoreyeram Infinity Datasource** Plugin, das direkte
HTTP-API-Abfragen aus Grafana-Panels heraus ermöglicht (kein extra Scraper
oder Exporter nötig).

Das Plugin wird automatisch beim Grafana-Start installiert (Eintrag in
`argocd/apps/platform/monitoring/values.yaml` unter `grafana.plugins`).

Die Datasource (`uid: infinity`) wird über den ConfigMap
`datasource-infinity` im Monitoring-Namespace bereitgestellt.

### Erlaubte Hosts

Die Infinity-Datasource erlaubt nur Anfragen an:
```
www.pegelonline.wsv.de
www.dwd.de
www.elwis.de
www.hochwasser-rlp.de
opendata.dwd.de
```

Weitere Hosts können in `argocd/apps/platform/monitoring/templates/datasource-infinity.yaml`
ergänzt werden.

---

## Erweiterungsmöglichkeiten

### Open-Meteo Wettervorhersage (kein API-Key)

```
https://api.open-meteo.com/v1/forecast?latitude=50.44&longitude=7.40&hourly=temperature_2m,precipitation,wind_speed_10m&forecast_days=2
```

Panel-Typ: Timeseries, Format: JSON, root_selector: `hourly`

### UV-Index (DWD)

```
https://opendata.dwd.de/climate_environment/health/alerts/uvi_latest.json
```

### Sonnenauf-/-untergang

```
https://api.sunrise-sunset.org/json?lat=50.44&lng=7.40&formatted=0
```

---

## Fehlerbehebung

### Panel zeigt "No data"

```bash
# Grafana-Pod logs prüfen:
kubectl -n monitoring logs deploy/monitoring-grafana -c grafana

# Infinity-Plugin installiert?
kubectl -n monitoring exec deploy/monitoring-grafana -c grafana -- \
  grafana-cli plugins ls | grep infinity

# Direkte API-Test:
curl -s "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/ANDERNACH/W/measurements.json?start=PT1H" | head -c 500
```

### DWD Warnungen — API eingestellt

Die DWD JSON-API (`warnapp_gemeinden/json/warnungen_gemeinde_map_de.json`) wurde abgeschaltet (HTTP 404).
Die Nachfolge-URL liefert JSONP (kein valides JSON). Das DWD-Panel ist daher auf
statische Links umgestellt. Für Live-Warnungen → [dwd.de Warnkarte](https://www.dwd.de).

### Grafana-Neustart nach Plugin-Installation

Das Infinity-Plugin wird beim ersten ArgoCD-Sync automatisch durch den
Grafana-Init-Container installiert. Falls das Panel dennoch nicht lädt:

```bash
kubectl -n monitoring rollout restart deploy/monitoring-grafana
```
