# MediaMTX — Live-Streaming (RTMP/RTSP → HLS)

[MediaMTX](https://github.com/bluenviron/mediamtx) ist ein selbst-gehosteter
Streaming-Server: Encoder (Kamera, OBS, ffmpeg) **publishen** ein Live-Signal
per RTMP oder RTSP, MediaMTX macht es intern als HLS und WebRTC verfügbar,
Zuschauer schauen es im Browser.

**Sicherheitsmodell dieses Setups — zwei getrennte Zugriffsrichtungen:**

| Richtung | Protokoll | Zugriff | Absicherung |
|---|---|---|---|
| **Publish** (Kamera/OBS → Server) | RTMP/RTSP | Nur LAN/Tailnet (NodePort) | mediamtx interne Auth — Nutzername/Passwort im Stream-URL |
| **Read** (Zuschauer → Server) | HLS (HTTP) | Intern (`stream.homeserver`) + öffentlich über Cloudflare Tunnel (`stream.pke-lab.de`) | mediamtx interne Auth — HTTP-Basic-Auth-Dialog im Browser |

Beide Mechanismen laufen komplett **lokal in mediamtx** (`authMethod:
internal`, siehe [mediamtx-Doku](https://mediamtx.org/docs/features/authentication))
— kein externer Identity-Provider, kein OAuth-Provider, kein JWKS-Endpunkt
nötig. Passwörter werden nur als SHA256-Hash in der Konfiguration
hinterlegt, nie im Klartext.

```
                    LAN / Tailnet only (NodePort 31935/31554)
OBS / ffmpeg / Kamera ───────────────────────────────────────▶ mediamtx (RTMP/RTSP)
   rtmp://streamer:<passwort>@...                                  │
                                                                    │ intern
                                                                    ▼
                                                              HLS (Port 8888)
                                                                    │
                                              ┌─────────────────────┴─────────────────────┐
                                              ▼                                           ▼
                                http://stream.homeserver                    https://stream.pke-lab.de
                                  HTTP-Basic-Auth (mediamtx)              (Cloudflare Tunnel, HTTP-Basic-Auth)
```

---

## Inhaltsverzeichnis

1. [Voraussetzungen](#voraussetzungen)
2. [Warum Publish nicht über Cloudflare läuft](#warum-publish-nicht-über-cloudflare-läuft)
3. [Schritt 1 — Chart deployen](#schritt-1--chart-deployen)
4. [Schritt 2 — Zugangsdaten generieren](#schritt-2--zugangsdaten-generieren)
5. [Schritt 3 — Streamen (OBS/ffmpeg)](#schritt-3--streamen-obsffmpeg)
6. [Verifizierung](#verifizierung)
7. [Aufnahmen (optional)](#aufnahmen-optional)
8. [Troubleshooting](#troubleshooting)
9. [Rollback](#rollback)

---

## Voraussetzungen

- ArgoCD läuft, Root-ApplicationSet aktiv (`argocd/bootstrap/root-applicationset.yaml`).
- Cloudflare Tunnel ist eingerichtet (`argocd/apps/cloudflared/`, siehe
  [docs/22-cloudflare-tunnel.md](22-cloudflare-tunnel.md)) — dieses Dokument
  ergänzt dort lediglich einen neuen `hostname`-Eintrag, keine neue
  Tunnel-Einrichtung nötig.
- `openssl` lokal verfügbar (zum Hashen der Passwörter, Schritt 2).

Kein Authentik, kein zusätzlicher Identity-Provider nötig — mediamtx
verwaltet Publish- und Zuschauer-Zugang komplett selbst.

---

## Warum Publish nicht über Cloudflare läuft

RTMP/RTSP sind reine TCP-Protokolle ohne HTTP-Host-Header — Cloudflare
Tunnel kann sie zwar grundsätzlich als generischen TCP-Stream tunneln, aber
ohne den HTTP-Layer greift keine hostnamenbasierte Routing-Regel. Ein offen
ins Internet getunnelter RTMP-Port wäre nur durch das Stream-Passwort
geschützt — ein System, das in diesem Repo konsequent vermieden wird (siehe
[docs/22 → Sicherheitsprinzipien](22-cloudflare-tunnel.md#sicherheitsprinzipien)).

Stattdessen bleibt Publish wie ArgoCD/Semaphore/Headlamp strikt
LAN/Tailnet-only (NodePort, siehe
[README.md#networking--security](../README.md#networking--security)) —
wer streamen will, braucht ohnehin Tailscale oder ist im Heimnetz. Die
eigentliche Autorisierung *innerhalb* dieses vertrauenswürdigen Netzes
übernimmt mediamtx' interne Auth (Schritt 2): Netzwerkzugriff allein reicht
nicht, ohne gültiges Nutzername/Passwort-Paar lehnt mediamtx den Publish ab.

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
  streamer:
    user: "sha256:CHANGEME"
    pass: "sha256:CHANGEME"
  viewer:
    user: "sha256:CHANGEME"
    pass: "sha256:CHANGEME"
```

Die `CHANGEME`-Platzhalter sind absichtlich ungültige Hashes — Publish und
Playback sind damit standardmäßig für **niemanden** erreichbar, bis in
Schritt 2 echte Hashes eingetragen werden.

Committen und pushen (wie jede andere App in diesem Repo, siehe
[docs/05-argocd.md](05-argocd.md)):

```bash
git add argocd/apps/mediamtx docs/24-mediamtx.md
git commit -m "feat(mediamtx): add live-streaming server with internal auth"
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

## Schritt 2 — Zugangsdaten generieren

mediamtx unterstützt gehashte Zugangsdaten direkt in der Konfiguration
(`sha256:<Base64-Hash>` für Nutzername **und** Passwort) — kein Klartext,
keine SealedSecret nötig, da ein Hash allein nutzlos ist, ohne das
Ursprungspasswort zu kennen.

### 2.1 — Streamer-Zugang (Publish)

> **Wichtig:** Das Streamer-Passwort landet bei RTMP unverändert (ohne
> URL-Encoding) in einer Query-String (`?user=...&pass=...`, siehe
> Schritt 3) — weder OBS noch mediamtx kodieren das automatisch.
> Sonderzeichen wie `&`, `@`, `%`, `#`, Leerzeichen oder gar
> Steuerzeichen (z. B. aus manchen Passwort-Managern) führen zu einem
> Parse-Fehler und die Verbindung schlägt fehl (siehe Troubleshooting).
> **Nur alphanumerische Zeichen verwenden**, z. B. generiert mit:
> ```bash
> openssl rand -hex 20
> ```
> Für den Zuschauer-Zugang (2.2) gilt diese Einschränkung nicht — der läuft
> über HTTP-Basic-Auth, die codiert automatisch.

```bash
echo -n "<streamer-username>" | openssl dgst -binary -sha256 | openssl base64
echo -n "<streamer-passwort>" | openssl dgst -binary -sha256 | openssl base64
```

Beide Ausgaben mit `sha256:`-Präfix in
[argocd/apps/mediamtx/values.yaml](../argocd/apps/mediamtx/values.yaml)
unter `auth.streamer.user` / `auth.streamer.pass` eintragen.

### 2.2 — Zuschauer-Zugang (Read/Playback)

Gleiches Vorgehen für `auth.viewer.user` / `auth.viewer.pass`:

```bash
echo -n "<viewer-username>" | openssl dgst -binary -sha256 | openssl base64
echo -n "<viewer-passwort>" | openssl dgst -binary -sha256 | openssl base64
```

> Für mehrere Zuschauer mit unterschiedlichen Passwörtern: den `viewer`-
> Eintrag in `authInternalUsers`
> ([templates/configmap.yaml](../argocd/apps/mediamtx/templates/configmap.yaml))
> um weitere Einträge mit `action: read` / `action: playback` ergänzen —
> analog zum bestehenden Muster, ein Eintrag pro Person.

Committen, pushen — ArgoCD synct die neue ConfigMap, mediamtx lädt sie
automatisch neu (Pod-Neustart per `checksum/config`-Annotation im
Deployment).

---

## Schritt 3 — Streamen (OBS/ffmpeg)

Server-Adresse: `<server-ip>` = die LAN- oder Tailscale-IP des Home-Servers
(siehe [docs/06-tailscale.md](06-tailscale.md)).

**RTMP (OBS):**

RTMP kennt kein `user:pass@host` in der URL (anders als RTSP) — mediamtx
nimmt die Zugangsdaten bei RTMP stattdessen als Query-Parameter entgegen.
Die gehören an den Stream-Key, nicht an die Server-URL:

- **Server:** `rtmp://<server-ip>:31935/live`
- **Stream-Key:** `mystream?user=<streamer-user>&pass=<streamer-passwort>`

Der eigentliche Pfad ist dann `live/mystream` (Server-Pfad + Stream-Key,
ohne die Query-Parameter) — unter genau diesem Pfad rufst du den Stream
später zum Zuschauen ab.

**RTSP/ffmpeg-Beispiel:**

```bash
ffmpeg -re -i input.mp4 -c copy \
  -f rtsp "rtsp://<streamer-user>:<streamer-passwort>@<server-ip>:31554/mystream"
```

Ohne gültiges (oder falsches) Nutzername/Passwort-Paar lehnt mediamtx den
Publish mit einem Auth-Fehler ab — siehe [Troubleshooting](#troubleshooting).

---

## Verifizierung

**Pods laufen:**

```bash
ssh ubuntu@192.168.178.94 'sudo kubectl -n mediamtx get pods'
```

**Publish testen (mit den Zugangsdaten aus Schritt 2.1):**

```bash
ffmpeg -re -i input.mp4 -c copy \
  -f rtsp "rtsp://<streamer-user>:<streamer-passwort>@<server-ip>:31554/test"
```

**Playback intern:**

Browser → `http://stream.homeserver/test` → mediamtx fragt per
HTTP-Basic-Auth-Dialog nach den Zugangsdaten aus Schritt 2.2, danach der
eingebaute HLS-Player.

**Playback extern (über Mobilfunknetz, NICHT über Heimnetz/Tailscale
testen):**

```
https://stream.pke-lab.de/test
```

Erwartet: derselbe Basic-Auth-Dialog, nach korrekten Zugangsdaten der
HLS-Player mit dem Live-Stream.

**Publish ohne/mit falschem Passwort wird abgelehnt:**

```bash
ffmpeg -re -i input.mp4 -c copy -f rtsp "rtsp://<server-ip>:31554/test"
# Erwartet: Verbindung wird von mediamtx mit Auth-Fehler abgelehnt.
```

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

Meist ein YAML-Syntaxfehler in der ConfigMap (`authInternalUsers` etc.) —
`kubectl -n mediamtx get configmap mediamtx-config -o yaml` gegenprüfen.

**Publish/Playback schlägt mit Auth-Fehler fehl, obwohl Zugangsdaten
korrekt scheinen:**

- Hash falsch generiert — `sha256:`-Präfix vergessen, falscher Encoding-
  Schritt (muss `openssl dgst -binary -sha256 | openssl base64` sein, nicht
  `-hex`), oder Nutzername/Passwort beim Hashen vertauscht.
- Noch die `CHANGEME`-Platzhalter aus dem initialen Chart-Deploy aktiv
  (Schritt 1) — Schritt 2 noch nicht durchgeführt/gepusht.
- ArgoCD hat die neue ConfigMap noch nicht gesynct oder der Pod noch nicht
  neu gestartet — `kubectl -n mediamtx get configmap mediamtx-config -o yaml`
  prüfen, ob die eingetragenen Hashes tatsächlich ankamen.

**`stream.pke-lab.de` zeigt 404/502:**

Prüfen, ob `argocd/apps/cloudflared/values.yaml` den `stream.pke-lab.de`-
Eintrag enthält, auf `mediamtx.mediamtx.svc.cluster.local:8888` zeigt und
der `cloudflared`-Pod die neue Config geladen hat (siehe [docs/23 →
ConfigMap-Änderung kommt nicht im Pod
an](23-cloudflare-deploy.md#configmap-änderung-kommt-nicht-im-pod-an)).

**`stream.pke-lab.de`/`stream.homeserver` fragt gar nicht nach Login:**

- Der `viewer`-Eintrag in `authInternalUsers` fehlt `action: read` bzw.
  `action: playback` — ohne die entsprechende Permission behandelt mediamtx
  den Pfad als offen für den `any`-Eintrag (falls vorhanden) statt einen
  Login zu erzwingen. Mit `kubectl -n mediamtx get configmap
  mediamtx-config -o yaml` gegenprüfen, dass kein zusätzlicher, zu offener
  `any`-Eintrag mit `read`/`playback`-Permission in der Liste steht.

**OBS zeigt "Failed to connect to server":**

- NodePort-Ports (31935/31554) nicht über LAN/Tailnet erreichbar prüfen:
  `nc -zv <server-ip> 31935`.
- Bei RTMP (OBS) die Zugangsdaten als `user:pass@host` in der Server-URL
  eingetragen — das funktioniert nur bei RTSP. RTMP braucht die Query-
  Parameter-Form `?user=...&pass=...` **im Stream-Key** (siehe Schritt 3);
  eine Server-URL wie `rtmp://user:pass@host:1935/live` lässt OBS die
  Verbindung entweder gar nicht erst aufbauen oder mediamtx lehnt sie ab.
- Falsche/vertauschte Groß-/Kleinschreibung oder Sonderzeichen im Passwort
  ohne URL-Encoding — Sonderzeichen im Stream-Key ggf. prozentkodieren.

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
