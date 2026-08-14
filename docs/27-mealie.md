# Mealie — Rezeptverwaltung und Wochenplaner

Mealie ist eine selbst gehostete Rezeptverwaltung. Rezepte lassen sich direkt
per URL von Kochwebseiten importieren (Chefkoch, AllRecipes, BBC Food usw.).
Integriert ist ein Wochenplaner und eine automatische Einkaufsliste.

---

## Architektur

```
mealie.homeserver  →  Traefik  →  mealie (Port 9000)
                                      └── PVC: data (5 Gi, nas)
```

- **Datenbank:** SQLite (in `/app/data`, kein externer DB-Server nötig)
- **Anmeldung:** Standard-Admin `changeme@example.com` / `MyPassword` beim ersten Start

---

## Erster Start

Nach dem Deploy läuft Mealie direkt unter **https://mealie.homeserver**.

Standard-Credentials beim ersten Login:

| Feld | Wert |
|---|---|
| E-Mail | `changeme@example.com` |
| Passwort | `MyPassword` |

**Sofort danach Passwort und E-Mail in den Einstellungen ändern.**

---

## Rezept importieren

1. URL einer Kochseite kopieren (z. B. `https://www.chefkoch.de/...`)
2. In Mealie: **Rezepte** → **Erstellen** → **URL importieren**
3. Mealie extrahiert Zutaten, Schritte und Bild automatisch

---

## Konfiguration (values.yaml)

| Key | Bedeutung | Default |
|---|---|---|
| `env.ALLOW_SIGNUP` | Neue Nutzer erlauben | `false` |
| `env.BASE_URL` | URL für interne Links | `https://mealie.homeserver` |
| `persistence.size` | Datenspeicher inkl. Bilder | `5Gi` |
