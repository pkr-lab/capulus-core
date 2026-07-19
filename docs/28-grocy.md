# Grocy — Haushalts-ERP

Grocy ist ein leichtgewichtiges Haushalts-ERP: Vorräte verwalten,
Einkaufslisten erstellen, Ablaufdaten tracken, Putzplan pflegen — alles in
einer Oberfläche.

---

## Architektur

```
grocy.homeserver  →  Traefik  →  grocy (Port 80)
                                     └── PVC: config (5 Gi, hdd, worker-0)
```

- **Datenbank:** SQLite (in `/config`, kein externer DB-Server nötig)
- **Image:** linuxserver/grocy (PUID/PGID-basiert, läuft als UID 1000)

---

## Erster Start

Nach dem Deploy ist Grocy direkt unter **http://grocy.homeserver** erreichbar.

Standard-Credentials:

| Feld | Wert |
|---|---|
| Benutzername | `admin` |
| Passwort | `admin` |

**Sofort in den Einstellungen das Passwort ändern.**

---

## Erste Schritte

1. **Produkte anlegen:** *Vorräte* → *Produkte* → *Produkt hinzufügen*
2. **Lagerorte definieren:** Kühlschrank, Keller, Vorratsschrank
3. **Einkaufsliste:** Produkte mit Mindestbestand → automatisch auf Einkaufsliste
4. **Ablaufdaten:** Beim Einlagern Ablaufdatum angeben → Grocy warnt rechtzeitig

---

## Konfiguration (values.yaml)

| Key | Bedeutung | Default |
|---|---|---|
| `env.PUID` | Linux-User-ID für Dateiberechtigungen | `1000` |
| `env.PGID` | Linux-Group-ID | `1000` |
| `env.TZ` | Zeitzone | `Europe/Berlin` |
| `persistence.size` | Datenspeicher | `5Gi` |
