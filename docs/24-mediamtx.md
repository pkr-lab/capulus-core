# MediaMTX — Live-Streaming (RTMP/RTSP → HLS)

[MediaMTX](https://github.com/bluenviron/mediamtx) ist ein selbst-gehosteter
Streaming-Server: Encoder (Kamera, OBS, ffmpeg) **publishen** ein Live-Signal
per RTMP oder RTSP, MediaMTX macht es intern als HLS und WebRTC verfügbar,
Zuschauer schauen es im Browser.

**Sicherheitsmodell dieses Setups — zwei getrennte Zugriffsrichtungen:**

| Richtung | Protokoll | Zugriff | Absicherung |
|---|---|---|---|
| **Publish** (Kamera/OBS → Server) | RTMP/RTSP | Nur LAN/Tailnet (NodePort) | Authentik-JWT — nur wer autorisiert ist, darf einspeisen |
| **Read** (Zuschauer → Server) | HLS (HTTP) | Intern (`stream.homeserver`) + öffentlich über Cloudflare Tunnel (`stream.pke-lab.de`) | Authentik-Login + erzwungenes TOTP (Google Authenticator o. Ä.) |

Beide Mechanismen laufen komplett über Authentik (kostenlos, selbst-gehostet,
kein Cloudflare-Zero-Trust-Abo nötig) und schützen unterschiedliche Dinge:
die JWT-Prüfung entscheidet **wer streamen darf**, die
ForwardAuth+TOTP-Prüfung entscheidet **wer zuschauen darf** — unabhängig
davon, ob intern oder extern zugegriffen wird.

```
                    LAN / Tailnet only (NodePort 31935/31554)
OBS / ffmpeg / Kamera ───────────────────────────────────────▶ mediamtx (RTMP/RTSP)
   ?token=<Authentik-JWT>                                          │
                                                                    │ intern
                                                                    ▼
                                                              HLS (Port 8888)
                                                                    │
                                                                    ▼
                                                    Traefik (ForwardAuth-Middleware)
                                                                    │
                                                     Authentik-Login + TOTP-Code
                                                                    │
                                              ┌─────────────────────┴─────────────────────┐
                                              ▼                                           ▼
                                http://stream.homeserver                    https://stream.pke-lab.de
                                     (LAN/Tailnet)                          (Cloudflare Tunnel, Zuschauer)
```

---

## Inhaltsverzeichnis

1. [Voraussetzungen](#voraussetzungen)
2. [Warum Publish nicht über Cloudflare läuft](#warum-publish-nicht-über-cloudflare-läuft)
3. [Schritt 1 — Chart deployen](#schritt-1--chart-deployen)
4. [Schritt 2 — Authentik: Publish-Autorisierung einrichten](#schritt-2--authentik-publish-autorisierung-einrichten)
5. [Schritt 3 — Streamen (OBS/ffmpeg)](#schritt-3--streamen-obsffmpeg)
6. [Schritt 4 — Authentik: Zuschauer-Zugang mit TOTP (Google Authenticator)](#schritt-4--authentik-zuschauer-zugang-mit-totp-google-authenticator)
7. [Verifizierung](#verifizierung)
8. [Issuer/Audience schärfen](#issueraudience-schärfen)
9. [Aufnahmen (optional)](#aufnahmen-optional)
10. [Troubleshooting](#troubleshooting)
11. [Rollback](#rollback)

---

## Voraussetzungen

- ArgoCD läuft, Root-ApplicationSet aktiv (`argocd/bootstrap/root-applicationset.yaml`).
- Authentik ist deployt und erreichbar (`argocd/apps/authentik/`, siehe
  [docs/13-sso-authentik.md](13-sso-authentik.md)).
- Cloudflare Tunnel ist eingerichtet (`argocd/apps/cloudflared/`, siehe
  [docs/22-cloudflare-tunnel.md](22-cloudflare-tunnel.md)) — dieses Dokument
  ergänzt dort lediglich einen neuen `hostname`-Eintrag, keine neue
  Tunnel-Einrichtung nötig. Kein Cloudflare-Zero-Trust-Account nötig — die
  Zuschauer-Autorisierung läuft komplett über das ohnehin schon deployte
  Authentik (Schritt 4).

---

## Warum Publish nicht über Cloudflare läuft

RTMP/RTSP sind reine TCP-Protokolle ohne HTTP-Host-Header — Cloudflare
Tunnel kann sie zwar grundsätzlich als generischen TCP-Stream tunneln, aber
ohne den HTTP-Layer greift weder Cloudflare Access noch eine
hostnamenbasierte Routing-Regel. Ein offen ins Internet getunnelter
RTMP-Port wäre nur durch das Stream-Passwort geschützt — ein System, das
in diesem Repo konsequent vermieden wird (siehe
[docs/22 → Sicherheitsprinzipien](22-cloudflare-tunnel.md#sicherheitsprinzipien)).

Stattdessen bleibt Publish wie ArgoCD/Semaphore/Headlamp strikt
LAN/Tailnet-only (NodePort, siehe
[README.md#networking--security](../README.md#networking--security)) —
wer streamen will, braucht ohnehin Tailscale oder ist im Heimnetz. Die
eigentliche Autorisierung *innerhalb* dieses vertrauenswürdigen Netzes
übernimmt das Authentik-JWT (Schritt 2): Netzwerkzugriff allein reicht
nicht, ohne gültiges Token lehnt mediamtx den Publish ab.

---

## Schritt 1 — Chart deployen

Der Chart liegt bereits unter `argocd/apps/mediamtx/` (Helm-Chart, analog zu
`ntfy`/`cloudflared`). Relevante Werte in
[argocd/apps/mediamtx/values.yaml](../argocd/apps/mediamtx/values.yaml):

```yaml
publishService:
  ports:
    rtmp: { port: 1935, nodePort: 31935 }
    rtsp: { port: 8554, nodePort: 31554 }

auth:
  jwks: "http://authentik-server.authentik.svc.cluster.local/application/o/mediamtx/jwks/"
```

Committen und pushen (wie jede andere App in diesem Repo, siehe
[docs/05-argocd.md](05-argocd.md)):

```bash
git add argocd/apps/mediamtx argocd/apps/cloudflared/values.yaml docs/24-mediamtx.md
git commit -m "feat(mediamtx): add live-streaming server with Authentik JWT publish auth and TOTP viewer auth"
git push
```

ArgoCD legt die `Application` **mediamtx** im gleichnamigen Namespace an und
synct automatisch (~3 Minuten, wie in
[docs/23-cloudflare-deploy.md → Erstdeployment](23-cloudflare-deploy.md#erstdeployment)
beschrieben).

```bash
ssh ubuntu@192.168.178.94 'sudo kubectl -n mediamtx get pods,svc'
```

---

## Schritt 2 — Authentik: Publish-Autorisierung einrichten

Ziel: Nur Mitglieder einer dedizierten Authentik-Gruppe bekommen ein JWT,
das mediamtx als gültige Publish-Berechtigung akzeptiert.

### 2.1 — Gruppe anlegen

1. **http://authentik.homeserver/if/admin/** → **Directory → Groups → Erstellen**
2. Name: `mediamtx-streamers`
3. Deine(n) Streamer-User(s) unter **Members** hinzufügen.

### 2.2 — Property Mapping (Scope Mapping) für die Publish-Claim

MediaMTX erwartet im JWT eine Claim `mediamtx_permissions`, z. B.:

```json
{ "mediamtx_permissions": [{ "action": "publish" }] }
```

1. **Customization → Property Mappings → Erstellen → Scope Mapping**
2. Felder:
   - **Name:** `mediamtx: publish permissions`
   - **Scope name:** `mediamtx_permissions`
   - **Expression:**
     ```python
     if ak_is_group_member(request.user, name="mediamtx-streamers"):
         return {
             "mediamtx_permissions": [
                 {"action": "publish"},
             ]
         }
     return {}
     ```
3. Speichern.

### 2.3 — OAuth2/OpenID Provider anlegen

1. **Applications → Providers → Erstellen** → Typ **OAuth2/OpenID Provider**
2. Felder:
   - **Name:** `mediamtx`
   - **Client type:** `Confidential`
   - **Authorization flow:** Standard belassen
   - **Scopes:** Standard-Scopes **plus** die eben erstellte
     `mediamtx_permissions`-Mapping unter **Advanced protocol settings →
     Scopes** hinzufügen
   - **Subject mode:** Standard belassen
3. Unter **Advanced protocol settings → Client Credentials Grant** (Machine-
   to-Machine-Flow, kein Browser-Login nötig für OBS/ffmpeg): als
   **Mapping** eine Expression hinterlegen, die einen festen Streamer-User
   zurückgibt, z. B.:
   ```python
   from authentik.core.models import User
   return User.objects.get(username="<dein-streamer-username>")
   ```
   Dieser User muss Mitglied von `mediamtx-streamers` sein (Schritt 2.1).
4. **Fertigstellen** — **Client ID** und **Client Secret** notieren
   (Secret **nicht** in Git ablegen — lokal in einem Passwort-Manager oder
   `.env` auf der Streaming-Maschine, dieses Repo braucht dafür kein
   SealedSecret, da mediamtx nur den öffentlichen JWKS-Endpunkt prüft).

### 2.4 — Application anlegen

1. **Applications → Applications → Erstellen**
2. Felder: **Name:** `MediaMTX`, **Slug:** `mediamtx` (muss exakt zur
   `auth.jwks`-URL in `values.yaml` passen: `.../application/o/mediamtx/jwks/`),
   **Provider:** `mediamtx`
3. Speichern.

### 2.5 — Token besorgen (Client-Credentials-Flow)

```bash
curl -s -X POST http://authentik.homeserver/application/o/token/ \
  -d grant_type=client_credentials \
  -d client_id=<CLIENT_ID> \
  -d client_secret=<CLIENT_SECRET> \
  | jq -r .access_token
```

Das zurückgegebene `access_token` ist das JWT, das mediamtx gegen den
JWKS-Endpunkt validiert.

> **Token-Laufzeit beachten:** Access Tokens laufen nach der in Authentik
> konfigurierten Zeit ab (Provider-Default meist Minuten). Für einen
> Dauerstream das Token bei Bedarf per Skript regelmäßig neu anfordern und
> den Streaming-Client neu starten, oder die Token-Lebensdauer am Provider
> hochsetzen (**Applications → Providers → mediamtx → Access token
> validity**).

---

## Schritt 3 — Streamen (OBS/ffmpeg)

Server-Adresse: `<server-ip>` = die LAN- oder Tailscale-IP des Home-Servers
(siehe [docs/06-tailscale.md](06-tailscale.md)).

**RTMP (OBS):**

- **Server:** `rtmp://<server-ip>:31935/live`
- **Stream-Key:** `mystream?token=<JWT aus Schritt 2.5>`

**RTSP/ffmpeg-Beispiel:**

```bash
ffmpeg -re -i input.mp4 -c copy \
  -f rtsp "rtsp://<server-ip>:31554/mystream?token=<JWT>"
```

Ohne gültiges (oder abgelaufenes) Token lehnt mediamtx den Publish mit
einem Auth-Fehler ab — siehe [Troubleshooting](#troubleshooting).

---

## Schritt 4 — Authentik: Zuschauer-Zugang mit TOTP (Google Authenticator)

Statt Cloudflare Access (kostenpflichtige Zero-Trust-Produkte nicht nötig)
übernimmt hier Authentik selbst die Zuschauer-Autorisierung — komplett
selbst-gehostet und kostenlos. TOTP/MFA ist Teil der freien
Open-Source-Version von Authentik (**kein Enterprise-Tarif nötig** —
Enterprise betrifft nur Dinge wie Google-Workspace-Sync, Client-Zertifikate
oder RAC/RDP-Erweiterungen, nicht die MFA-Stages).

Das funktioniert über denselben ForwardAuth-Mechanismus, der in diesem
Repo bereits für Gotify/Semaphore genutzt wird (siehe
[docs/13-sso-authentik.md](13-sso-authentik.md)) — hier zusätzlich mit
einer eigenen Authentifizierungs-Flow, die TOTP **erzwingt**.

### 4.1 — Gruppe für Zuschauer anlegen

1. **http://authentik.homeserver/if/admin/** → **Directory → Groups → Erstellen**
2. Name: `mediamtx-viewers`
3. Alle berechtigten Zuschauer als **Members** hinzufügen (für jeden ist ein
   eigenes Authentik-Benutzerkonto nötig — anders als bei Cloudflare Access
   gibt es hier keinen anonymen E-Mail-Code, dafür bleibt alles
   selbst-gehostet).

### 4.2 — TOTP-Stages anlegen

1. **Flows & Stages → Stages → Erstellen → Authenticator TOTP Setup Stage**
   - **Name:** `mediamtx-totp-setup`
   - Zwingt neue Zuschauer beim ersten Login, TOTP einzurichten (QR-Code
     scannen mit Google Authenticator, Authy, o. Ä.)
2. **Flows & Stages → Stages → Erstellen → Authenticator Validation Stage**
   - **Name:** `mediamtx-totp-validate`
   - **Device classes:** nur `TOTP` auswählen
   - **Not configured action:** `Configure` (leitet zu `mediamtx-totp-setup`
     weiter, falls noch kein TOTP eingerichtet ist)

### 4.3 — Eigene Authentication Flow

1. **Flows & Stages → Flows → default-authentication-flow** öffnen →
   **Export** (Sicherung) — dann eine neue Flow anlegen:
2. **Flows & Stages → Flows → Erstellen**
   - **Name:** `mediamtx-viewer-authentication`
   - **Slug:** `mediamtx-viewer-authentication`
   - **Designation:** `Authentication`
3. **Stage Bindings** in dieser Reihenfolge hinzufügen:
   1. `default-authentication-identification` (Order `10`, aus dem
      Standard-Flow übernehmen — Username/Passwort-Eingabe)
   2. `default-authentication-password` (Order `20`)
   3. `mediamtx-totp-validate` (Order `30`)
   4. `default-authentication-login` (Order `40`, schließt den Login ab)

   > Genaue Stage-Namen können je nach Authentik-Version leicht abweichen —
   > im Zweifel die Stages des bestehenden `default-authentication-flow`
   > als Vorlage nehmen und nur `mediamtx-totp-validate` zusätzlich
   > einfügen.

### 4.4 — Proxy Provider + Application

1. **Applications → Providers → Erstellen** → Typ **Proxy Provider**
2. Felder:
   - **Name:** `mediamtx-viewer`
   - **Mode:** `Forward auth (single application)`
   - **External host:** `https://stream.pke-lab.de`
   - **Authentication flow:** `mediamtx-viewer-authentication` (aus 4.3 —
     **nicht** den System-Default belassen, sonst greift kein TOTP-Zwang)
3. **Fertigstellen.**
4. **Applications → Applications → Erstellen**
   - **Name:** `MediaMTX Stream`, **Slug:** `mediamtx-viewer`,
     **Provider:** `mediamtx-viewer`
   - **Access:** unter **Policy/Group/User Bindings** die Gruppe
     `mediamtx-viewers` als Bedingung binden (nur Mitglieder kommen durch)
5. Provider zum **Embedded Outpost** hinzufügen: **Applications →
   Outposts → authentik Embedded Outpost → bearbeiten** → `mediamtx-viewer`
   unter **Applications** auswählen → Speichern.

> Für den internen Hostnamen `stream.homeserver` reicht dieselbe
> Application/Provider-Konfiguration — die ForwardAuth-Middleware in
> `argocd/apps/mediamtx/values.yaml` greift auf beiden Hostnamen aus dem
> Ingress (siehe `templates/ingress.yaml` + `templates/ingress-outpost.yaml`),
> Authentik unterscheidet nicht nach Hostname, sondern prüft die Session.

Ab jetzt verlangen sowohl `http://stream.homeserver` als auch
`https://stream.pke-lab.de` einen Authentik-Login **mit** TOTP-Code, bevor
der HLS-Player angezeigt wird.

---

## Verifizierung

**Pods laufen:**

```bash
ssh ubuntu@192.168.178.94 'sudo kubectl -n mediamtx get pods'
```

**Publish testen (mit gültigem Token aus Schritt 2.5):**

```bash
ffmpeg -re -i input.mp4 -c copy \
  -f rtsp "rtsp://<server-ip>:31554/test?token=<JWT>"
```

**Playback intern:**

Browser → `http://stream.homeserver` → mediamtx zeigt eine Liste aktiver
Pfade; `http://stream.homeserver/test` zeigt den eingebauten HLS-Player.

**Playback extern (über Mobilfunknetz, NICHT über Heimnetz/Tailscale
testen):**

```
https://stream.pke-lab.de/test
```

Erwartet: Weiterleitung zum Authentik-Login, nach Benutzername/Passwort
zusätzlich Abfrage des TOTP-Codes aus der Authenticator-App, danach der
HLS-Player mit dem Live-Stream.

**Publish ohne/mit falschem Token wird abgelehnt:**

```bash
ffmpeg -re -i input.mp4 -c copy -f rtsp "rtsp://<server-ip>:31554/test"
# Erwartet: Verbindung wird von mediamtx mit Auth-Fehler abgelehnt.
```

---

## Issuer/Audience schärfen

`values.yaml` lässt `auth.issuer`/`auth.audience` standardmäßig leer (=
Prüfung deaktiviert), weil ein falscher Wert **jeden** Publish-Versuch mit
"invalid token" ablehnen würde, ohne dass vorher ein echtes Token getestet
werden konnte. Nach dem ersten erfolgreichen Publish (Schritt 3) den
`iss`-Claim eines echten Tokens auslesen:

```bash
JWT="<Token aus Schritt 2.5>"
echo "$JWT" | cut -d. -f2 | base64 -d 2>/dev/null | jq .iss
```

Wert in `argocd/apps/mediamtx/values.yaml` unter `auth.issuer` eintragen,
committen, pushen — schließt die (theoretische) Lücke, dass ein JWT eines
fremden, aber ebenfalls per JWKS erreichbaren Issuers akzeptiert würde.

---

## Aufnahmen (optional)

Dieses Setup speichert standardmäßig **nichts** — reines Live-Durchreichen.
Für Aufzeichnung auf Platte müsste `paths.all_others.record: yes` plus eine
PVC (analog zu `argocd/apps/ntfy/templates/pvc.yaml`) ergänzt werden — bei
Bedarf separat einrichten, um den Speicherbedarf bewusst zu halten.

---

## Troubleshooting

**mediamtx-Pod crasht / `CrashLoopBackOff`:**

```bash
ssh ubuntu@192.168.178.94 'sudo kubectl -n mediamtx logs deploy/mediamtx'
```

Meist eine YAML-Syntaxfehler in der ConfigMap (`authJWTExclude` etc.) —
`kubectl -n mediamtx get configmap mediamtx-config -o yaml` gegenprüfen.

**Publish schlägt mit Auth-Fehler fehl, obwohl Token vorhanden:**

- Token abgelaufen (Access-Token-Lifetime in Authentik, siehe Hinweis in
  Schritt 2.5) → neues Token anfordern.
- Falscher `client_id`/`client_secret` oder der im Client-Credentials-
  Mapping referenzierte User ist nicht Mitglied von `mediamtx-streamers`.
- `mediamtx_permissions`-Scope wird nicht in den Provider-Scopes des
  `mediamtx`-Providers mitgeschickt (Schritt 2.3).
- JWKS nicht erreichbar: `kubectl -n mediamtx exec` in den Pod, `wget -qO-
  http://authentik-server.authentik.svc.cluster.local/application/o/mediamtx/jwks/`
  prüfen.

**`stream.pke-lab.de` zeigt 404:**

Prüfen, ob `argocd/apps/cloudflared/values.yaml` den `stream.pke-lab.de`-
Eintrag enthält, auf `traefik.kube-system.svc.cluster.local:80` zeigt (nicht
mehr direkt auf den mediamtx-Service) und der `cloudflared`-Pod die neue
Config geladen hat (siehe [docs/23 → ConfigMap-Änderung kommt nicht im Pod
an](23-cloudflare-deploy.md#configmap-änderung-kommt-nicht-im-pod-an)).

**`stream.pke-lab.de`/`stream.homeserver` fragt gar nicht nach Login:**

- ForwardAuth-Middleware-Annotation in `argocd/apps/mediamtx/values.yaml`
  (`ingress.annotations`) fehlt oder ist falsch geschrieben — mit
  `kubectl -n mediamtx get ingress -o yaml` gegenprüfen.
- Traefik-Service-Name stimmt nicht (`kubectl -n kube-system get svc
  traefik` prüfen — falls anders benannt, `cloudflared`-Regel anpassen).

**TOTP-Code wird nicht abgefragt / Login schließt sofort ab:**

- Provider `mediamtx-viewer` nutzt noch die System-Default-Authentication-
  Flow statt `mediamtx-viewer-authentication` (Schritt 4.4) — prüfen unter
  **Applications → Providers → mediamtx-viewer → Authentication flow**.
- `mediamtx-totp-validate`-Stage fehlt in der Stage-Bindings-Liste der
  Flow oder steht in falscher Reihenfolge (muss nach der
  Passwort-Stage, vor der abschließenden Login-Stage stehen).

**Zuschauer ohne Mitgliedschaft in `mediamtx-viewers` kommt trotzdem durch:**

Policy/Group-Binding auf der Application `MediaMTX Stream` prüfen
(Schritt 4.4) — ohne Bindung lässt Authentik jeden erfolgreich
eingeloggten Benutzer durch, unabhängig von der Gruppe.

**OBS zeigt "Failed to connect to server":**

- NodePort-Ports (31935/31554) nicht über LAN/Tailnet erreichbar prüfen:
  `nc -zv <server-ip> 31935`.
- Stream-Key-Feld muss `<pfad>?token=<JWT>` enthalten, nicht nur `<pfad>`.

---

## Rollback

Wie jede andere App per Git-Revert:

```bash
git log --oneline -- argocd/apps/mediamtx
git revert <commit-hash>
git push
```

Um mediamtx vorübergehend abzuschalten, ohne die App zu löschen, reicht
`replicaCount: 0` in `values.yaml` setzen und pushen — der
`stream.pke-lab.de`-Hostname liefert danach mangels laufendem Backend nur
noch einen 502.
