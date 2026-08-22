# lldap — Nutzer-/Gruppenverwaltung für Authelia

[lldap](https://github.com/lldap/lldap) ist ein leichtgewichtiger
LDAP-Server (SQLite, ein Container, eigene Web-UI) — die Nutzerquelle für
[Authelia](d0070-authelia-sso.md), seit dem Cutover von der file-basierten
Nutzerdatenbank auf echte, benannte Identitäten mit granularem Zugriff.
Architektur-Begründung und Leitentscheidungen:
[docs/4-planung/40000-authelia-sso.md](../4-planung/40000-authelia-sso.md).

---

## Architektur

```
Authelia ──▶ lldap (ldap://lldap.lldap.svc.cluster.local:3890)
                │
                Bind als "authelia-bind" (lldap_strict_readonly)

Du ──▶ https://lldap.tech.homeserver (Web-UI, Port 17170, Tailscale/LAN-only)
```

- SQLite (`local-path`-PVC, 1 Gi), kein externer DB-Server.
- Zwei Ports: `3890` (LDAP, nur cluster-intern, kein Ingress) und `17170`
  (Web-UI, per Ingress erreichbar).
- Base DN: `dc=homeserver` (frei gewählt, keine echte Domain nötig).
- Der eingebaute lldap-Superuser heißt **nicht** `admin`, sondern
  **`lldap-root`** (`LLDAP_LDAP_USER_DN`) — bewusst umbenannt, damit er
  nicht mit dem App-seitigen `admin`-Identität (Authelia-Fallback-Login)
  kollidiert. Getrennte Accounts für getrennte Zwecke: `lldap-root`
  verwaltet lldap selbst, `admin` ist nur ein regulärer App-Nutzer.
- Kein SMTP-Relay — Passwort-Reset läuft ausschließlich manuell über die
  Web-UI (`lldap-root` kann jedes Nutzerpasswort direkt setzen).

---

## 1. Secrets (bereits erledigt)

Erzeugt am 22.08.2026 per `openssl rand` und mit
`kubeseal --raw --namespace lldap --name lldap-secrets` versiegelt
(`argocd/apps/platform/lldap/templates/sealedsecret.yaml`):

| Key | Zweck |
|---|---|
| `jwt-secret` | signiert lldaps eigene Web-UI-Sessions |
| `key-seed` | leitet den Schlüssel für den Passwort-Storage ab — **einmalig, niemals rotieren** (macht sonst alle gesetzten Passwörter ungültig) |
| `root-password` | Login für `lldap-root` (Web-UI-Superuser) |
| `bind-password` | Passwort für den Service-Account `authelia-bind` — **identischer Wert** zusätzlich als `ldap-bind-password` im `authelia-secrets`-SealedSecret (Authelia liest sein eigenes Namespace-Secret, kann nicht direkt auf lldaps Secret zugreifen) |

Das `lldap-root`-Passwort wurde einmalig im Chat mitgeteilt (analog zum
initialen Authelia-Admin-Passwort beim Pilot) — **sofort nach dem ersten
Login über die Web-UI ändern.**

---

## 2. Manuelles Setup über die Web-UI

Bewusst **kein** deklarativer Bootstrap-Job (siehe Rückfrage/Entscheidung
in [40000-authelia-sso.md](../4-planung/40000-authelia-sso.md)) — lldaps
`bootstrap.sh` bräuchte einen root-laufenden Einmal-Job mit `curl`/`jq`/`jo`,
das ist für 5 Nutzer mehr Infrastruktur als nötig. Stattdessen: einmaliges
manuelles Setup, gleiches Muster wie der "Erster Start" bei Uptime
Kuma/Vaultwarden in diesem Repo.

### 2.1 Login

<https://lldap.tech.homeserver> öffnen, mit `lldap-root` + dem mitgeteilten
Passwort einloggen.

### 2.2 Gruppen anlegen

**Group Management → Create a group**, zwei neue Gruppen:

- `admins` — Vollzugriff mit 2FA (aktuell: `pke`)
- `dlrg-einsatz` — Grafana-Zugriff für den Einsatzdienst

(Die eingebauten Gruppen `lldap_admin`, `lldap_password_manager`,
`lldap_strict_readonly` sind lldap-intern — nicht anfassen, außer für
Schritt 2.3.)

### 2.3 Service-Account `authelia-bind` anlegen

**User Management → Create a user**:

| Feld | Wert |
|---|---|
| User ID | `authelia-bind` |
| E-Mail | `authelia-bind@homeserver.local` (Platzhalter, wird nie versendet) |
| Display Name | `Authelia Bind` |

Danach den Nutzer öffnen → **Groups** → Mitglied von
**`lldap_strict_readonly`** machen (read-only, **nicht** `lldap_admin` —
Least Privilege, siehe
[lldap/example_configs/authelia.md](https://github.com/lldap/lldap/blob/main/example_configs/authelia.md)).
Passwort setzen: **muss exakt dem `bind-password`-Wert aus Schritt 1
entsprechen**, sonst schlägt Authelias LDAP-Bind fehl (Symptom siehe
Troubleshooting unten).

### 2.4 Die 5 App-Identitäten anlegen

Für jede Zeile: **User Management → Create a user** (User-ID, E-Mail,
Display Name), danach Passwort selbst setzen (**Reset password** in der
Nutzeransicht, min. 8 Zeichen) und ggf. Gruppenzugehörigkeit zuweisen:

| User-ID | Gruppe | Zugriff |
|---|---|---|
| `admin` | — (keine Gruppe, eigene Regel in Authelia) | Fallback/Break-Glass, alles, nur intern, kein 2FA |
| `pke` | `admins` | Vollzugriff, nur intern, 2FA Pflicht |
| `dlrg-einsatz-1` | `dlrg-einsatz` | Grafana (intern + extern) |
| `ake` | — (keine Gruppe) | Immich (intern + extern) |
| `rdn` | — (keine Gruppe) | Mealie (intern + extern) |

Weitere echte Personen für den DLRG-Einsatzdienst: einfach als neuer Nutzer
anlegen und der `dlrg-einsatz`-Gruppe hinzufügen — **keine Authelia-Config
nötig**, die Gruppen-Regel greift automatisch.

### 2.5 2FA für `pke` einrichten

`pke` braucht TOTP für den `two_factor`-Zugriff — das passiert **nicht**
in lldap, sondern beim ersten Login über Authelias eigenes Portal
(`https://auth.tech.homeserver`, QR-Code-Enrollment).

---

## 3. Verifikation

```bash
# LDAP-Bind manuell testen (Werkzeug: ldapsearch)
ldapsearch -x -H ldap://lldap.tech.homeserver:3890 \
  -D "uid=authelia-bind,ou=people,dc=homeserver" -w '<bind-password>' \
  -b "dc=homeserver" "(uid=pke)"
```

- `kubectl -n authelia logs deploy/authelia | grep -i ldap` — bei
  Startup sollte `LDAP Discovery` ohne Fehler erscheinen.
- Login-Test je Identität über das jeweils zugewiesene App-Frontend (siehe
  [d0070-authelia-sso.md](d0070-authelia-sso.md) → Access-Control-Tabelle).
- Negativ-Test: `ake` darf **nicht** auf Mealie kommen, `rdn` **nicht** auf
  Immich usw. — `default_policy: deny` blockt alles ohne passende Regel.

---

## Troubleshooting

| Symptom | Ursache |
|---|---|
| Authelia-Login schlägt für ALLE Nutzer fehl, `kubectl -n authelia logs` zeigt LDAP-Bind-Fehler | `bind-password` in `authelia-secrets` (Key `ldap-bind-password`) stimmt nicht mit dem tatsächlich in lldap gesetzten Passwort für `authelia-bind` überein — in der Web-UI neu setzen und beide Secrets synchron halten. |
| Ein Nutzer kommt trotz korrektem Passwort nicht rein | Gruppenzugehörigkeit prüfen (Web-UI → User → Groups) — `default_policy: deny` heißt: keine passende `access_control`-Regel = kein Zugriff, unabhängig vom korrekten Login. |
| lldap-Pod crasht beim Start | `/data`-PVC-Berechtigungen — Image startet bewusst als root und droppt selbst per `gosu` auf UID/GID 1000 (siehe `values.yaml`-Kommentar); mit erzwungenem `runAsNonRoot` scheitert der `chown`-Schritt. |
| `lldap-root`-Passwort vergessen | `force_ldap_user_pass_reset` in der Config auf `true` setzen (Redeploy erzwingt Reset auf den Wert aus `LLDAP_LDAP_USER_PASS`), danach wieder zurücksetzen. |
