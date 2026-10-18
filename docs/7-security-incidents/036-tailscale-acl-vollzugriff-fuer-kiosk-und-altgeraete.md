# 036 Tailscale-ACL: Kiosk-Geräte und ein alter Runner haben Vollzugriff auf den homeserver, fremde Konten erreichen Port 443

- Severity: Medium
- Bereich: Netzwerk
- Betroffen: Tailscale-ACL (Admin-Konsole, nicht im Repo); wirksamer Paketfilter auf dem homeserver (`tailscale debug netmap`)
- Status: Offen

## Beschreibung

Der Paketfilter, den der homeserver aus der Tailscale-ACL erhält, enthält vier Regeln. Die erste erlaubt **alle Ports und Protokolle** (TCP, UDP, ICMP) auf den homeserver von sechs Geräten: `infotafel`, `vereinsheim-alarmmonitor` (beide Kiosk-Geräte an anderen Standorten), `pk-handy-1`, `pke-ms-7e59`, `macbook-air---peter` und `github-runnervmlun5p` (früherer Runner-Knoten, dem Org-Konto zugeordnet, seit 26 Tagen offline). Die zweite Regel erlaubt Port 443 von acht Geräten, darunter `ipad-pkr` und `iphone-ruth` (Konto `tailscale@`, also ein anderer Benutzer als die Org-Identität). Die vierte Regel, der aktive Runner (`github-runnervmlun5p-1`, getaggt), darf nur `80` und `30080` auf `.94` und `.100`: so sollte es überall aussehen.

Die UFW-Regel „allow all from 100.64.0.0/10“ auf dem homeserver (Incident 008) wird damit durch die ACL begrenzt, aber nur auf diese sechs Geräte, nicht auf die tatsächlich benötigten Ports.

## Nachweis

```
$ ssh homeserver 'sudo tailscale debug netmap' | python3 (Auswertung PacketFilter)
Regel 0  Srcs: infotafel, pk-handy-1, github-runnervmlun5p, pke-ms-7e59, vereinsheim-alarmmonitor, macbook-air---peter
         Dsts: homeserver (100.74.0.59) Ports 0-65535   Proto: TCP, UDP, ICMP
Regel 1  Srcs: dieselben + ipad-pkr, iphone-ruth        Dsts: homeserver  Port 443/tcp
Regel 2  Srcs: homeserver, worker-0                     Dsts: homeserver  Port 443/tcp
Regel 3  Srcs: github-runnervmlun5p-1 (tagged)          Dsts: 192.168.178.94:80,30080  192.168.178.100:80,30080

$ ssh homeserver 'tailscale status'
100.110.81.85   github-runnervmlun5p      it.dlrg.jugend.andernach@  linux  offline, last seen 26d ago
100.120.11.84   ipad-pkr                  tailscale@                 iOS
100.97.30.28    iphone-ruth               tailscale@                 iOS
100.123.214.4   vereinsheim-alarmmonitor  it.dlrg.jugend.andernach@  linux  active; direct …
```

## Risiko / Angriffsszenario

Wird einer der Kiosk-Rechner kompromittiert (Standort mit Fremdzugang, ein SSH-Schlüssel im öffentlichen Repo: Incident 001), erreicht der Angreifer jeden Port des homeservers: SSH, k3s-API, power-agent, ArgoCD. Das offline-Gerät `github-runnervmlun5p` behält seine Rechte, falls sein Knotenschlüssel noch gültig ist und das Gerät wieder online geht.

## Empfohlene Behebung

1. In der Tailscale-ACL für Kiosk-Geräte ein Tag (`tag:kiosk`) einführen und nur die tatsächlich nötigen Ziele freigeben (z. B. `homeserver:443`, ntfy, n8n-Webhook-Port), nicht `*:*`.
2. Altes Gerät `github-runnervmlun5p` aus dem Tailnet entfernen; Runner nur noch als ephemere, getaggte Knoten (`tag:ci`).
3. Konten fremder Benutzer (`tailscale@`) prüfen: falls Familienmitglieder, über eine eigene Gruppe auf `443` begrenzen, oder per Tailscale-Share statt Tailnet-Mitgliedschaft einbinden.
4. Schlüsselablauf (Key Expiry) und Geräte-Genehmigung (Device Approval) aktivieren, SSH nur per Tailscale-SSH mit Check-Mode für Admin-Geräte.

## Rollback

Die Tailscale-Admin-Konsole hält die ACL-Versionen vor; die vorherige Fassung lässt sich dort wiederherstellen.

## Verifikation

```
ssh homeserver 'sudo tailscale debug netmap' | python3 -c 'Auswertung PacketFilter wie oben'
nc -zv -w3 100.74.0.59 22        (vom Alarmmonitor aus)
```
Regel 0 listet keine Geräte mit `0-65535` mehr; der Test vom Alarmmonitor auf Port 22 scheitert, der benötigte Zugriff (z. B. 443) funktioniert.

## Risiko der Behebung

Mittel: Eine zu enge Regel trennt Geräte (Alarmmonitor, Infotafel) von Diensten und lässt Alarmierung oder Anzeige ausfallen. Vorher je Gerät die benötigten Ziele und Ports erheben.

## Bearbeitungsstand (2026-10-18)

Nicht umgesetzt: Die ACL liegt in der Tailscale-Admin-Konsole (kein API-Zugang aus dieser Umgebung, nicht im Repo). Vorbereitet ist der Vorschlag, den du dort einträgst; er ändert nur Regel 0 und 1.

**Lesend ermittelt.** Von den sechs Geräten der Regel 0 hat nur `pke-ms-7e59` (dein PC) aktuell Verbindungen zu SSH, 80, 443 und 6443 des homeservers. `infotafel` und `vereinsheim-alarmmonitor` brauchen laut Rollen und Skripten nur HTTP/HTTPS zum Cluster (Heartbeat zu `alamos-apager`, ntfy, `vm-write`/`logs-write`, Skripte senden noch per `http://`, siehe 046). Die Gegenrichtung (homeserver → Pi für Ansible, node_exporter `9100`, WoL-Agent `9102`) betrifft nur Regeln mit dem Pi als Ziel. Veraltete Geräte: `github-runnervmlun5p` (offline seit 27 Tagen), `github-runnervmlun5p-1` (getaggt, offline seit 27 Tagen).

**Vorschlag für die ACL (Hu-JSON, zu prüfen gegen deine bestehende Datei).**

```
{
  "tagOwners": { "tag:kiosk": ["autogroup:admin"] },
  "acls": [
    {"action": "accept", "src": ["pke-ms-7e59", "macbook-air---peter", "pk-handy-1"], "dst": ["homeserver:*"]},
    {"action": "accept", "src": ["tag:kiosk"], "dst": ["homeserver:80,443"]},
    {"action": "accept", "src": ["ipad-pkr", "iphone-ruth"], "dst": ["homeserver:443"]},
    {"action": "accept", "src": ["homeserver", "worker-0"], "dst": ["homeserver:443"]},
    {"action": "accept", "src": ["tag:ci"], "dst": ["192.168.178.94:80", "192.168.178.100:80"]}
  ]
}
```

Danach `infotafel` und `vereinsheim-alarmmonitor` mit `tailscale up --advertise-tags=tag:kiosk` (oder im Admin-Panel Tags setzen) markieren und `github-runnervmlun5p` sowie `github-runnervmlun5p-1` aus dem Tailnet löschen. Der Port `30080` in der CI-Regel entfällt (Incident 013, ArgoCD läuft jetzt über den HTTPS-Ingress); die CI nutzt `argocd.tech.homeserver` über `443` — falls der Runner `443` braucht, `tag:ci` entsprechend auf `homeserver:443` ändern.

**Risiko.** Ein Gerät, das mehr als `80,443` auf den homeserver braucht, verliert den Zugriff und die Alarmierung kann ausfallen (Kiosk). Vorher je Gerät die Ziele prüfen und die ACL zuerst mit dem Test-Feature der Admin-Konsole („Preview rules“) durchspielen.

**Rollback.** Die Konsole hält die ACL-Versionen vor; die vorherige Fassung wiederherstellen.

