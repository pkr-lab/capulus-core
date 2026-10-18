# 026 alamos-relay (öffentlich): einthreadiger HTTP-Server ohne Socket-Timeout, Token im URL-Pfad

- Severity: Low
- Bereich: Extern
- Betroffen: `argocd/apps/tech/alamos-relay/templates/configmap-script.yaml:108` (`HTTPServer(...)`), Host `alamos-relay-prod.pke-lab.de`
- Status: Teilweise behoben am 2026-10-18 (Punkt 1 und Token im Log im Code, gestaged, wirkt nach Merge; Token im Pfad und Cloudflare-WAF offen)

## Beschreibung

Der Relay-Dienst leitet Alarmmeldungen weiter an n8n. Er prüft das Token im Pfad (`/relay/<token>`, Vergleich mit `hmac.compare_digest`, gut), nutzt aber den einthreadigen `http.server.HTTPServer` ohne `settimeout`. Eine einzige offen gehaltene Verbindung (Slowloris) blockiert die Weiterleitung weiterer Alarme. Cloudflare puffert Anfragen und mildert das, ein direkter Zugriff im LAN nicht. Das Token steht im URL-Pfad und landet dadurch in Zugriffslogs (Traefik, Cloudflare) und in Browser-/Proxyverläufen.

## Nachweis

```
$ sed -n 108p argocd/apps/tech/alamos-relay/templates/configmap-script.yaml
        HTTPServer(("0.0.0.0", port), Handler).serve_forever()
```

## Risiko / Angriffsszenario

Ein Angreifer ohne Kenntnis des Tokens kann den Alarmweg lahmlegen, ohne Authentifizierung zu brechen. Wer Zugriff auf Logs hat, sieht das Token.

## Empfohlene Behebung

1. `ThreadingHTTPServer` verwenden und `timeout`/`settimeout(10)` auf Verbindungen setzen.
2. Token zusätzlich/alternativ als Header (`Authorization`) erwarten, falls der Absender (Alamos) das erlaubt; Zugriffslogs anonymisieren.
3. Cloudflare-WAF-Regel: Rate-Limit für den Host.

## Rollback

Vorherigen ConfigMap-Stand wiederherstellen.

## Verifikation

```
python3 - <<'EOF'
import socket,time
s=socket.create_connection(("alamos-relay-prod.pke-lab.de",443))
EOF
curl -s -o /dev/null -w '%{http_code}\n' https://alamos-relay-prod.pke-lab.de/relay/falsch
```
Während eine Slow-Verbindung offen ist, muss der zweite Aufruf weiterhin `404` liefern.

## Risiko der Behebung

Niedrig.

## Behebung (2026-10-18)

**Fix (Punkt 1).**

- `ThreadingHTTPServer` statt `HTTPServer`, der Handler setzt `timeout = 10` (Socket-Timeout je Verbindung). Eine hängende Verbindung blockiert andere Alarme nicht mehr und wird nach 10 Sekunden getrennt.
- Body-Grenze 1 MiB (`413`), kaputte `Content-Length` ergibt `400` statt eines Absturzes im Handler.
- Zusätzlich: `log_message` ersetzt das Token im Zugriffslog des Relays durch `***` (die Standard-Zugriffszeile enthielt den Pfad `/relay/<token>` im Pod-Log und damit in VictoriaLogs).

**Nachweis** (vor dem Merge, lokal mit dem aus der ConfigMap gerenderten `app.py` gegen einen Dummy-n8n):

| Test | Ergebnis |
|---|---|
| Verbindung öffnen und nichts senden (14 s), währenddessen `GET /relay/falsch` | `404` (Dienst bleibt bedienbar) |
| `POST /relay/<token>` mit Body | `200`, Weiterleitung an das Dummy-Ziel |
| `Content-Length: 5000000` | `413` |
| `Content-Length: abc` | `400` |
| Zugriffslog (ungepuffert) | `"POST /relay/*** HTTP/1.1" 200 -`, das Token kommt nicht vor |
| `python3 -m py_compile` | ok |

**Geänderte Dateien.**

- `argocd/apps/tech/alamos-relay/templates/configmap-script.yaml`
- Doku: `docs/6-hintergruende/60040-helm-charts-tech.md`, `docs/3-apps-workloads/300i0-alamos-relay.md`

**Rollback.** `git revert`; das alte Skript kommt über die ConfigMap zurück.

**Offen.**

- **Punkt 2, Token im Pfad:** AMweb ruft den Relay mit einer festen URL auf und sendet keinen Authorization-Header; das Token bleibt im Pfad. Traefik- und Cloudflare-Zugriffslogs enthalten es weiter.
- **Punkt 3, Cloudflare-WAF-Rate-Limit** für `alamos-relay-prod.pke-lab.de`: liegt im Cloudflare-Dashboard (nicht im Repo), das ist dein Handgriff.
