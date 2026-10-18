# 020 MediaMTX: ungesalzene SHA-256-Zugangsdaten im öffentlichen Repo, API/Metrics ohne Authentifizierung für alle Quell-IPs, RTMP/RTSP im Klartext

- Severity: Medium
- Bereich: Repo
- Betroffen: `argocd/apps/tech/mediamtx/values.yaml:73-77`, `argocd/apps/tech/mediamtx/templates/configmap.yaml:29-49`, NodePorts `31935` und `31554`
- Status: Teilweise behoben am 2026-10-18 (Punkt 2 im Code, gestaged, wirkt nach Merge; Punkte 1 und 3 brauchen deine Entscheidung)

## Beschreibung

Drei Punkte an der MediaMTX-Konfiguration:

1. Die Zugangsdaten für `streamer` und `viewer` stehen als `sha256:<base64>` im Klartext in `values.yaml` im öffentlichen Repo. MediaMTX verwendet hier einen ungesalzenen SHA-256 über Benutzer und Passwort. Das ist kein Klartext, aber offline mit GPU in kurzer Zeit gegen Wörterbücher und kurze Passwörter prüfbar. Die Passwortstärke ist nicht bekannt.
2. Der interne Benutzer `any` (ohne Passwort) darf `api` und `metrics` für **alle** IPs (`ips: []`). Die Kommentare begründen es mit ClusterIP-Isolation. Die API erlaubt aber das Ändern der Pfadkonfiguration (u. a. `runOnInit`-Kommandos). Jeder Pod mit Netzzugriff auf Port 9997 erreicht sie; die Ingress-Regel führt nur auf Port 8888 (HLS).
3. Veröffentlichen läuft über die NodePorts RTMP `31935` und RTSP `31554` unverschlüsselt. Zugangsdaten und Stream sind im LAN mitlesbar. `webrtc: yes` und HLS sind über den Tunnel öffentlich (`stream-prod.pke-lab.de`).

## Nachweis

```
$ sed -n 71,77p argocd/apps/tech/mediamtx/values.yaml
auth:
  streamer:
    user: "sha256:jGl…(maskiert)"
    pass: "sha256:7o3…(maskiert)"
  viewer:
    user: "sha256:01y…(maskiert)"
    pass: "sha256:9yN…(maskiert)"

$ sed -n 44,49p argocd/apps/tech/mediamtx/templates/configmap.yaml
      - user: any
        pass:
        ips: []
        permissions:
          - action: api
          - action: metrics
```

## Risiko / Angriffsszenario

Wird eines der Passwörter erraten, kann ein Angreifer Streams einspeisen (Streamer) oder mitsehen (Viewer). Aus dem Cluster heraus kann die API zur Pfad-Manipulation genutzt werden. Mitlesen im LAN liefert die Zugangsdaten.

## Empfohlene Behebung

1. Zugangsdaten als `argon2:` statt `sha256:` ablegen und aus `values.yaml` in ein SealedSecret verlagern, das als Datei eingebunden wird. Bei dieser Gelegenheit rotieren.
2. `any`-Benutzer auf die tatsächlich nötigen Quellen begrenzen (z. B. `ips: ['127.0.0.1', '<Pod-CIDR der Monitoring-Pods>']`) oder `api: no` setzen, wenn die API nicht gebraucht wird.
3. RTMP/RTSP nur aus dem LAN erlauben (UFW/Pfad) oder auf RTMPS/RTSPS umstellen, wenn Streamer außerhalb des Heimnetzes liegen.

## Rollback

Alte Auth-Werte zurückschreiben und synchronisieren; Streamer-Clients wieder umstellen.

## Verifikation

```
kubectl -n mediamtx run curl --rm -it --restart=Never --image=curlimages/curl -- curl -s -o /dev/null -w '%{http_code}\n' http://mediamtx.mediamtx.svc:9997/v3/config/global/get
```
Aus einem Pod ohne Freigabe: `401` bzw. Timeout. Aus dem Monitoring-Pod: `200`. Streamer mit neuen Zugangsdaten verbinden, Viewer sehen den Stream.

## Risiko der Behebung

Niedrig bis mittel: Der Readiness-Probe-Zugriff und das Monitoring dürfen durch die IP-Beschränkung nicht ausgesperrt werden; Streamer müssen neue Zugangsdaten bekommen.

## Behebung (2026-10-18)

**Fix (Punkt 2, API ohne Authentifizierung).**

- Die mediamtx-API ist abgeschaltet (`api: no`), der Benutzer `any` ohne Passwort ist entfernt. Port 9997 ist weder im Pod (`containerPort`) noch im Service vorhanden. Metrics waren nie aktiviert (`metrics` fehlt in der Konfiguration, Standard `no`).
- Der einzige Verbraucher der API war die Readiness-Probe (`/v3/paths/list`). Sie prüft jetzt per `tcpSocket` den HLS-Port 8888. Die Liveness-Probe (TCP auf RTSP) bleibt.
- Die bestehende NetworkPolicy `tier-default-ingress` bleibt unverändert (erlaubt Traffic nur aus dem eigenen Namespace, `kube-system`, `monitoring`, `cloudflared`).

**Nachweis** (vor dem Merge):

| Test | Ergebnis |
|---|---|
| `helm template` | kein `9997`, kein `api`-Port, kein `any`-Benutzer, Readiness `tcpSocket` auf `hls` |
| `docker run bluenviron/mediamtx:1.21.2` (Tag aus dem Chart, ohne Netzwerk) mit der gerenderten Konfiguration | `configuration loaded`, Listener RTSP `:8554`, RTMP `:1935`, HLS `:8888`, WebRTC `:8889`; kein API-Listener auf `:9997` |
| `kubectl apply --dry-run=server` | Service, Deployment, ConfigMap, Ingress, HPA akzeptiert (der NodePort-Service meldete nur die Kollision mit dem bestehenden Release `31935`, weil der Test unter anderem Release-Namen lief) |

**Geänderte Dateien.**

- `argocd/apps/tech/mediamtx/templates/configmap.yaml`, `templates/deployment.yaml`, `templates/service.yaml`, `values.yaml`
- Doku: `docs/6-hintergruende/60040-helm-charts-tech.md` (Abschnitt mediamtx, außerdem die falsche Aussage „SHA256-Hash können gefahrlos in Git landen“ korrigiert)

**Rollback.** `git revert` des Commits; ArgoCD stellt API-Port, Service-Port, `any`-Benutzer und HTTP-Readiness wieder her.

**Offen (braucht deine Entscheidung).**

- **Punkt 1, Zugangsdaten:** Die Hashes sind weiter `sha256:` in `values.yaml`. Der Wechsel auf `argon2:` aus einem SealedSecret setzt neue Passwörter für `streamer` und `viewer` voraus (alle Encoder, zum Beispiel OBS, und alle Zuschauer müssen sie bekommen). Das ist eine Rotation, die ich ohne dich nicht anstoße. Mindestens sollten die Passwörter lang und zufällig sein.
- **Punkt 3, Klartext RTMP/RTSP:** Die NodePorts `31935` und `31554` bleiben unverschlüsselt. Umstellen auf RTMPS/RTSPS braucht ein Zertifikat im Pod und neue URLs in allen Encodern. Nötig nur, wenn Streamer außerhalb vertrauter Netze senden; sonst Restrisiko LAN. Im Pod startet außerdem der Standard-Listener MoQ (`:8892`, `:8893`), der nicht im Service steht und nicht genutzt wird.
