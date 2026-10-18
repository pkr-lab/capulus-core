# 005 Wildcard-Tunnel `*.pke-lab.de`: 13 Hosts ohne vorgelagerte Zugangskontrolle, WAF-Regeln oder Security-Header

- Severity: Medium
- Bereich: Extern
- Betroffen: `argocd/apps/tech/cloudflared/values.yaml:55-61`, alle Ingresses mit `pke-lab.de`-Host, `argocd/apps/tech/traefik-config/`
- Status: Zurückgestellt am 2026-10-17 (Betreiber-Entscheidung, Wildcard bleibt vorerst)

## Beschreibung

`cloudflared` hat eine einzige Regel `*.pke-lab.de` → `https://traefik.kube-system.svc.cluster.local:443`. Jeder Ingress, der einen `pke-lab.de`-Host trägt, ist damit automatisch im Internet erreichbar. Im Repo sind das derzeit 13 Hosts. Im Cluster steht davor weder eine Traefik-Middleware (kein Forward-Auth, kein Rate-Limit, keine Security-Header, kein IP-Filter) noch ein Basic-Auth; Authentik/Authelia wurden im Oktober 2026 entfernt. Der Schutz hängt komplett am jeweiligen App-Login. Cloudflare Access ist in der Doku als optionale Zusatzmaßnahme beschrieben, im Repo nicht erkennbar (liegt außerhalb der Git-Konfiguration; Phase 3 klärt den tatsächlichen Stand).

## Nachweis

```
$ sed -n 55,61p argocd/apps/tech/cloudflared/values.yaml
  ingress:
    rules:
      - hostname: "*.pke-lab.de"
        service: https://traefik.kube-system.svc.cluster.local:443
        originRequest:
          noTLSVerify: true
    defaultService: "http_status:404"

$ helm template … | Ingress-Hosts mit pke-lab.de (aus gerenderten Charts)
immich-prod  nextcloud-prod  wiki-prod  xibo-prod  alamos-relay-prod  stream-prod
grafana-tech vault-tech      ntfy-tech  support-tech  status-prod  pacman-prod
instagram-bilder-prod (nur Pfad /webhook/instagram-bild, Exact)

$ Kind Middleware in allen gerenderten Charts: keine
```

## Phase-2-Nachweis (live, lesend)

Live-Stand in TECH und PROD: `kubectl get middlewares.traefik.io,tlsoptions.traefik.io,ingressroutes.traefik.io -A` liefert keine Ressourcen. Antworten hinter Traefik tragen keinen `Strict-Transport-Security`-Header (am Beispiel Vaultwarden gesehen, nur die eigenen Header der Anwendung sind gesetzt). Der HTTP→HTTPS-Redirect (308) funktioniert. Das Traefik-Dashboard ist aktiviert (`--api.dashboard=true`), aber nicht über einen Service oder Ingress freigegeben (`:8080` und `/dashboard/` nicht erreichbar). Der Traefik-Service ist ein `LoadBalancer` auf `192.168.178.200` (MetalLB).

## Risiko / Angriffsszenario

Die gesamte Angriffsfläche besteht aus Anwendungs-Logins, darunter Admin-nahe Oberflächen (Grafana, Xibo-CMS, Zammad-Agenten-UI, Vaultwarden-Admin, Uptime-Kuma-Login). Jede Schwachstelle oder schwache Zugangsdaten in einer dieser Anwendungen ist direkt aus dem Internet ausnutzbar; es gibt keine zweite Schicht. Neue Ingresses mit `pke-lab.de`-Host werden ungewollt automatisch veröffentlicht.

## Empfohlene Behebung

1. Admin-nahe Hosts hinter Cloudflare Access legen (Grafana, Zammad-Agenten, Xibo-CMS, Uptime-Kuma, ntfy); für Maschinen-Clients Service Tokens, für Mobile-Apps Bypass-Regeln auf den API-Pfaden.
2. Wildcard-Regel durch explizite Host-Regeln ersetzen, damit neue Ingresses nicht automatisch öffentlich werden:
   ```diff
   -      - hostname: "*.pke-lab.de"
   -        service: https://traefik.kube-system.svc.cluster.local:443
   +      - hostname: "nextcloud-prod.pke-lab.de"
   +        service: https://traefik.kube-system.svc.cluster.local:443
   +      - hostname: "immich-prod.pke-lab.de"
   +        service: https://traefik.kube-system.svc.cluster.local:443
   ```
   (alle benötigten Hosts einzeln aufführen)
3. Traefik-Middlewares ergänzen und per Annotation an die öffentlichen Ingresses hängen: Security-Header (HSTS, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`), `rateLimit` für Login-Pfade.
4. Cloudflare-WAF: Rate-Limiting für `/login`, `/api/auth`, `/identity`.

## Rollback

Wildcard-Regel wiederherstellen und synchronisieren. Access-Policies im Cloudflare-Dashboard deaktivieren.

## Verifikation

```
curl -sI https://grafana-tech.pke-lab.de/ | grep -i -E 'location|cf-access|strict-transport|x-frame'
curl -s -o /dev/null -w '%{http_code}\n' https://neuer-test-host.pke-lab.de/
```
Admin-Hosts müssen auf die Access-Anmeldung umleiten bzw. 403 liefern, ein nicht aufgeführter Host `404`. Security-Header müssen in der Antwort stehen.

## Risiko der Behebung

Mittel: Cloudflare-Access-Policies können mobile Clients (Immich, Nextcloud, ntfy, Xibo-Player) aussperren, wenn Bypass- bzw. Service-Token-Regeln fehlen.

## Stand der Bearbeitung (2026-10-17)

Die Vorbereitung ergab keine Änderung am System. Der Betreiber hat entschieden, die Wildcard-Regel vorerst beizubehalten, es wurde nichts geändert.

**Befund für die spätere Umsetzung.**

- Es laufen zwei Tunnel mit derselben Regel `*.pke-lab.de` → Traefik des eigenen Clusters: TECH (`homeserver`, 9 Hosts) und PROD (`homeserver-prod`, 4 Hosts). Welcher Host bei welchem Tunnel landet, entscheidet allein der DNS-Eintrag bei Cloudflare, der Wildcard-Eintrag zeigt auf den TECH-Tunnel. Ein neuer TECH-Ingress mit `pke-lab.de`-Host ist deshalb automatisch öffentlich.
- Hosts live ausgelesen: TECH `alamos-relay-prod`, `grafana-tech`, `instagram-bilder-prod` (nur Pfad `/webhook/instagram-bild`), `ntfy-tech`, `pacman-prod`, `status-prod`, `stream-prod`, `support-tech`, `vault-tech`. PROD `immich-prod`, `nextcloud-prod`, `wiki-prod`, `xibo-prod`. ENTW hat keinen Tunnel.
- Ausgangslage am 2026-10-17 (`GET /`): alamos-relay-prod 404, grafana-tech 302, ntfy-tech 200, pacman-prod 200, status-prod 302, stream-prod 404, support-tech 200, vault-tech 200, immich-prod 200, nextcloud-prod 302, wiki-prod 200, xibo-prod 302, unbekannter Host 404.
- Die Apps setzen Sicherheits-Header zum Teil selbst (Grafana: `x-frame-options: deny`, `x-content-type-options: nosniff`). Ein Traefik-`rateLimit` sieht hinter dem Tunnel nur die cloudflared-Pod-IP und würde alle Nutzer gemeinsam drosseln. Jede Traefik-Änderung braucht einen Neustart der einzigen Traefik-Instanz je Cluster (kurzer Ausfall aller Hosts). Edge-Header (HSTS, Managed Transform „Add security headers“) und ein WAF-Rate-Limit gehören deshalb ins Cloudflare-Dashboard.

**Offene Maßnahmen** (alle ohne Umsetzung):

| Maßnahme | Wer | Stand |
|---|---|---|
| Wildcard-Regel durch 13 explizite Hostregeln in beiden cloudflared-Konfigurationen ersetzen (Doku e0000 und e0010 anpassen) | Repo | zurückgestellt |
| Cloudflare Access für Admin-nahe Hosts (Empfehlung: grafana-tech; support-tech und xibo-prod nur mit passender Policy beziehungsweise Bypass für `/xmds.php*`; status-prod nur `/dashboard*`; nicht für ntfy, vault, nextcloud, immich, wiki, alamos-relay, stream, pacman, instagram-bilder) | Betreiber, Cloudflare | offen |
| HSTS und „Add security headers“ am Cloudflare-Rand | Betreiber, Cloudflare | offen |
| WAF-Rate-Limit für `/login`, `/api/auth`, `/identity` (Free-Plan: eine Regel) | Betreiber, Cloudflare | offen |
