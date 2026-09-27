# Mealie — Rezeptverwaltung und Wochenplaner

> **Cluster:** PROD · Ordner `argocd/apps/prod/mealie/` · URL `https://mealie.prod.homeserver` und `https://mealie-prod.pke-lab.de`. `kubectl`-Befehle in diesem Doc gelten für den PROD-Cluster ([Zugriff je Cluster](../a-betriebssystem/a0010-overview.md#kubectl-zugriff-je-cluster)).

Mealie ist eine selbst gehostete Rezeptverwaltung. Rezepte lassen sich direkt
per URL von Kochwebseiten importieren (Chefkoch, AllRecipes, BBC Food usw.).
Integriert ist ein Wochenplaner und eine automatische Einkaufsliste.

---

## Architektur

```
mealie.prod.homeserver  →  Traefik  →  mealie (Port 9000)
                                      └── PVC: data (5 Gi, nas)
```

- **Datenbank:** SQLite (in `/app/data`, kein externer DB-Server nötig)
- **Anmeldung:** Standard-Admin `changeme@example.com` / `MyPassword` beim ersten Start

---

## Erster Start

Nach dem Deploy läuft Mealie direkt unter **https://mealie.prod.homeserver**.

Standard-Credentials beim ersten Login:

| Feld | Wert |
|---|---|
| E-Mail | `changeme@example.com` |
| Passwort | `MyPassword` |

**Sofort danach Passwort und E-Mail in den Einstellungen ändern.**

---

## Authentik-SSO (im PROD-Cluster aktuell zurückgestellt)

Vorgesehen ist ein Authentik-Login vor `mealie.prod.homeserver` und `mealie-prod.pke-lab.de`
(Traefik-ForwardAuth, Zugriff für die Gruppen `admins` und `mealie-user`, siehe
[docs/d-sicherheit/d0073-authentik-sso.md](../d-sicherheit/d0073-authentik-sso.md)).
Seit dem Umzug nach PROD ist er **nicht aktiv**: PROD hat noch keinen Authentik-Outpost, deshalb wurde
die Middleware-Annotation in `argocd/apps/prod/mealie/values.yaml` bewusst entfernt (Wiedereinschalten:
[`argocd/bootstrap-prod/migrations/sso-outpost/README.md`](../../argocd/bootstrap-prod/migrations/sso-outpost/README.md)).
Aktuell schützt nur Mealies **eigene** Anmeldung die App (Standard-Admin bzw. eigener Account). Der
ungeschützte Bypass-Host `https://mealie-native.prod.homeserver` bleibt für den Fall bestehen, dass SSO
wieder aktiv ist und ausfällt.

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
| `env.BASE_URL` | URL für interne Links | `https://mealie.prod.homeserver` |
| `persistence.size` | Datenspeicher inkl. Bilder | `5Gi` |
