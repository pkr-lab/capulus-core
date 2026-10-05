# Incident-Report — 05.10.2026: Pi-hole-Update legt DNS und Cloudflare-Tunnel lahm

| | |
|---|---|
| **Betroffen** | Gesamte Namensauflösung über dnsmasq (homeserver, PROD-VM, alle Clients mit `192.168.178.94` als DNS), damit beide Cloudflare-Tunnel und alle öffentlich erreichbaren PROD-Dienste |
| **Ausfall** | Ab ca. 14:20 UTC (16:20 CEST) bis zur manuellen Behebung am selben Nachmittag |
| **Datenverlust** | Keiner |
| **Ursache** | Pi-hole-Update mit `strategy: Recreate`: Der alte Pod war weg, bevor das neue Image gezogen war. Der Image-Pull brauchte DNS, DNS brauchte Pi-hole (Deadlock) |
| **Status** | Betrieb manuell wiederhergestellt. Chart auf `RollingUpdate` mit DNS-Readiness-Probe umgestellt, siehe [Behebung der Ursache](#behebung-der-ursache) |

---

## Kurzfassung

Renovate hob Pi-hole von `2026.07.2` auf `2026.09.0` (PR #382, gemergt 14:20 UTC). Der Pi-hole-Chart rollte mit
`strategy: Recreate` aus: Kubernetes beendete den laufenden Pod, bevor der neue existierte. Pi-hole ist der **einzige** Upstream
von dnsmasq auf dem homeserver, und über dnsmasq lösen auch der homeserver selbst und die PROD-VM auf. Mit dem Ende des alten
Pods war also jede Auflösung externer Namen weg.

Der neue Pod musste `pihole/pihole:2026.09.0` von Docker Hub laden. containerd auf dem homeserver fragt dafür
`registry-1.docker.io` über systemd-resolved → dnsmasq → Pi-hole an, also beim gerade nicht existierenden Pod. Der Pull scheiterte,
der Pod blieb in `ImagePullBackOff`. Ohne Eingriff hätte sich das nie gelöst. Auch ein Rollback per Git hätte nicht geholfen,
weil ArgoCD GitHub ebenfalls nicht mehr auflösen konnte.

Sichtbar wurde der Ausfall über den PROD-Tunnel: cloudflared wurde im selben Zeitraum durch das Renovate-Update auf `2026.9.3`
neu gestartet, konnte die Cloudflare-Edge (`region2.v2.argotunnel.com`) nicht auflösen und beendete sich. Die cloudflared-Version
selbst war **nicht** die Ursache.

---

## Systemüberblick (DNS-Kette)

```
cloudflared-Pod (PROD)
  → CoreDNS PROD (10.47.0.10)
  → /run/systemd/resolve/resolv.conf der prod-vm  → nur 192.168.178.94
  → dnsmasq auf dem homeserver (192.168.178.94:53), einziger Upstream:
       server=192.168.178.94#30053
  → Pi-hole im TECH-Cluster (NodePort 30053)
  → Fritz!Box (192.168.178.1)
  → Internet

containerd / ArgoCD / CoreDNS TECH auf dem homeserver
  → systemd-resolved (DNS=192.168.178.94)
  → dnsmasq → Pi-hole → …
```

| Baustein | Konfiguration | Rolle im Vorfall |
|---|---|---|
| `dnsmasq` (homeserver) | `ansible/roles/dnsmasq/templates/dnsmasq.conf.j2`, `no-resolv`, ein einziges `server=` | Kein Fallback, sobald Pi-hole fehlt, Timeouts für alle externen Namen |
| systemd-resolved (homeserver) | `DNS=192.168.178.94`, `FallbackDNS=192.168.178.1` | `FallbackDNS` greift nur, wenn **kein** DNS konfiguriert ist, hier also nie |
| PROD-VM | cloud-init `nameservers: [192.168.178.94]` (`ansible/host_vars/homeserver/vars.yml`) | Hängt vollständig an dnsmasq auf dem homeserver |
| Pi-hole | `argocd/apps/tech/pihole`, `replicaCount: 1`, damals `strategy: Recreate`, Readiness nur TCP-Port 53 | Auslöser |
| cloudflared PROD | `argocd/apps/prod/cloudflared`, Tunnel `3faaf987…` | Symptomträger |

---

## Zeitleiste

Zeitangaben in UTC. Die Uhrzeiten der manuellen Schritte sind aus den Pod-Altern abgeleitet und daher ungefähr.

| Zeit | Ereignis | Beleg |
|---|---|---|
| 12:07 | Renovate erstellt die Updates `cloudflare/cloudflared` → `2026.9.3` und `pihole/pihole` → `2026.09.0` | Commits `3dd1dec`, `d08a7c6` |
| 14:20 | PR #382 (Pi-hole) gemergt, ArgoCD synct kurz darauf | Merge-Commit `1849b56` |
| ca. 14:20–14:25 | `Recreate`: alter Pi-hole-Pod beendet, neuer Pod `pihole-6b7bb4b544-wzfpd` angelegt, Image-Pull scheitert → `ImagePullBackOff` | Pod-Alter 18m beim ersten Check |
| 14:38:47 | PROD-cloudflared startet, `Failed to fetch features … server misbehaving` | Tunnel-Log |
| 14:38:56 | `Couldn't resolve SRV record &{region2.v2.argotunnel.com. 7844 2 1}` → Shutdown | Tunnel-Log, Anzeige in Cloudflare |
| danach | Diagnose (siehe unten) | Befehlsausgaben |
| danach | Sofort-Fix: dnsmasq temporär auf Fritz!Box, Pi-hole-Pod neu angelegt, nach 22 s `1/1 Running` | `kubectl get pods -w` |
| danach | dnsmasq-Konfiguration zurückgestellt, cloudflared neu ausgerollt | Befehlsausgaben |

---

## Diagnose

### 1. Fehlerbild im Tunnel-Log

```
ERR Failed to fetch features, default to disable error="lookup cfd-features.argotunnel.com on 10.47.0.10:53: server misbehaving"
ERR Initiating shutdown error="Couldn't resolve SRV record &{region2.v2.argotunnel.com. 7844 2 1}: lookup region2.v2.argotunnel.com. on 10.47.0.10:53: server misbehaving"
```

- Tunnel-ID `3faaf987-…` gehört zu `argocd/apps/prod/cloudflared/values.yaml`, also PROD.
- `10.47.0.10` ist CoreDNS im PROD-Cluster (Service-CIDR `10.47.0.0/16`, `ansible/host_vars/prod-vm/vars.yml`).
- `server misbehaving` ist Gos Meldung für **SERVFAIL**. CoreDNS war also erreichbar, bekam aber selbst keine Antwort von seinem
  Upstream. Eine NetworkPolicy scheidet damit aus, sie hätte einen Timeout erzeugt.
- Schon die allererste Abfrage schlug fehl: DNS war beim Start bereits kaputt, nicht erst durch cloudflared.

### 2. Prüfung der DNS-Kette

```bash
kubectl -n pihole get pods
```
```
NAME                      READY   STATUS             RESTARTS   AGE
pihole-6b7bb4b544-wzfpd   0/1     ImagePullBackOff   0          18m
```

```bash
dig @192.168.178.94 -p 30053 region2.v2.argotunnel.com SRV
```
```
;; communications error to 192.168.178.94#30053: connection refused
```
Kein Pi-hole-Endpoint hinter dem NodePort.

```bash
dig @192.168.178.94 region2.v2.argotunnel.com SRV
```
```
;; communications error to 192.168.178.94#53: timed out
```
dnsmasq läuft, wartet aber vergeblich auf seinen einzigen Upstream.

```bash
kubectl -n cloudflared run dnstest --rm -it --image=busybox --restart=Never -- nslookup …
```
```
dnstest   0/1   ErrImagePull
```
Bestätigt den Deadlock: Auch jedes andere Image ließ sich nicht mehr ziehen.

### 3. Schlussfolgerung

Pi-hole fehlt → dnsmasq ohne Upstream → homeserver und PROD-VM ohne externe Namensauflösung → Pi-hole-Image nicht ladbar →
Pi-hole fehlt weiter. Der Kreis schließt sich, eine Selbstheilung ist ausgeschlossen.

---

## Fehlerbehebung (durchgeführte Schritte)

### Schritt 1: dnsmasq vorübergehend direkt an die Fritz!Box hängen

Auf dem homeserver:

```bash
sudo cp /etc/dnsmasq.conf /etc/dnsmasq.conf.bak
sudo sed -i 's|^server=192.168.178.94#30053|server=192.168.178.1|' /etc/dnsmasq.conf
sudo systemctl restart dnsmasq
```

Prüfung, dass externe Namen wieder auflösen:

```bash
dig @192.168.178.94 registry-1.docker.io +short
```
```
184.195.20.173
44.196.55.242
…
```

### Schritt 2: Pi-hole-Pod neu anlegen lassen

Der hängende Pod wird gelöscht, damit Kubernetes nicht erst das Pull-Backoff (bis zu 5 Minuten) abwartet:

```bash
kubectl -n pihole delete pod pihole-6b7bb4b544-wzfpd
kubectl -n pihole get pods -w
```
```
pihole-6b7bb4b544-qq28m   0/1     ContainerCreating   0          1s
pihole-6b7bb4b544-qq28m   0/1     Running             0          12s
pihole-6b7bb4b544-qq28m   1/1     Running             0          22s
```

Das Image `2026.09.0` ließ sich jetzt ziehen und startete fehlerfrei. Die neue Version selbst war also in Ordnung.

### Schritt 3: dnsmasq-Konfiguration zurückstellen

```bash
sudo mv /etc/dnsmasq.conf.bak /etc/dnsmasq.conf
sudo systemctl restart dnsmasq
```

Wichtig, sonst läuft das gesamte Netz ohne Werbefilterung. Spätestens der tägliche Semaphore-Lauf um 06:00 (`site.yml`, Rolle
`dnsmasq`) hätte die Datei ebenfalls zurückgeschrieben.

### Schritt 4: cloudflared neu ausrollen und prüfen

```bash
kubectl -n cloudflared rollout restart deploy/cloudflared
kubectl -n cloudflared get pods
```

Kontrolle der Auflösung. `region2.v2.argotunnel.com` ist das **Ziel** eines SRV-Eintrags, kein SRV-Name selbst, eine
`SRV`-Abfrage darauf liefert daher korrekt eine leere Antwort. Aussagekräftig sind:

```bash
dig @192.168.178.94 +short _v2-origintunneld._tcp.argotunnel.com SRV
dig @192.168.178.94 +short region2.v2.argotunnel.com
```

In Cloudflare unter *Zero Trust → Networks → Tunnels* muss `homeserver-prod` wieder als **HEALTHY** mit Connectoren erscheinen.

### Schritt 5: Aufräumen

```bash
kubectl -n cloudflared delete pod dnstest --ignore-not-found
```

Der Testpod blieb nach dem Abbruch mit `Ctrl+C` in `ImagePullBackOff` hängen.

---

## Notfall-Ablauf

Für den Fall, dass Pi-hole erneut ausfällt und sein Image nicht ziehen kann (Symptom: Pi-hole-Pod in `ImagePullBackOff` oder
`ErrImagePull`, gleichzeitig `dig @192.168.178.94 github.com` mit Timeout):

```bash
sudo cp /etc/dnsmasq.conf /etc/dnsmasq.conf.bak
sudo sed -i 's|^server=192.168.178.94#30053|server=192.168.178.1|' /etc/dnsmasq.conf
sudo systemctl restart dnsmasq
dig @192.168.178.94 registry-1.docker.io +short

kubectl -n pihole delete pod -l app.kubernetes.io/name=pihole
kubectl -n pihole get pods -w

sudo mv /etc/dnsmasq.conf.bak /etc/dnsmasq.conf
sudo systemctl restart dnsmasq
dig @192.168.178.94 -p 30053 github.com +short
dig @192.168.178.94 github.com +short
```

Danach in **beiden** Clustern die cloudflared-Pods prüfen (`kubectl -n cloudflared get pods`) und bei Bedarf
`kubectl -n cloudflared rollout restart deploy/cloudflared` ausführen. Für PROD dazu in den PROD-Kontext wechseln.

---

## Behebung der Ursache

Umgesetzt in `argocd/apps/tech/pihole/templates/deployment.yaml`:

| Vorher | Nachher | Wirkung |
|---|---|---|
| `strategy: Recreate` | `RollingUpdate`, `maxSurge: 1`, `maxUnavailable: 0` | Der alte Pod beantwortet weiter DNS, während das neue Image gezogen wird und startet |
| — | `minReadySeconds: 10` | Der neue Pod muss 10 s stabil bereit sein, bevor der alte beendet wird |
| Readiness: `tcpSocket` auf Port 53 | Readiness: `dig +short +norecurse +retry=0 +time=2 @127.0.0.1 pi.hole` | Bereit erst, wenn FTL wirklich DNS-Anfragen beantwortet. Gleicher Check wie der `HEALTHCHECK` im Upstream-Image |

Warum das mit der `local-path`-PVC funktioniert und warum `replicaCount` bei `1` bleibt, steht in
[`60040-helm-charts-tech.md → pihole`](../6-hintergruende/60040-helm-charts-tech.md#pihole).

Bewusst **nicht** umgesetzt: ein Fallback-Upstream (Fritz!Box) in dnsmasq. Ohne `strict-order` verteilt dnsmasq Anfragen auf den
schnellsten Server, ein Teil liefe dann an Pi-hole vorbei. Die Umstellung des Updates beseitigt den Auslöser, ohne die Filterung
aufzuweichen.

---

## Lehren

1. **Infrastruktur, von der der Node selbst abhängt, darf beim Update nie ganz verschwinden.** Pi-hole ist für den homeserver
   genauso kritisch wie CoreDNS. `Recreate` ist hier falsch, auch wenn es für eine RWO-PVC naheliegt.
2. **Zirkuläre Abhängigkeiten prüfen:** Pi-hole läuft im Cluster, dessen Image-Pulls Pi-hole brauchen. Solange das Image schon auf
   dem Node lag, fiel das nicht auf. Ein Versionssprung reicht, damit es zuschlägt.
3. **Symptom ≠ Ursache:** Der Fehler zeigte sich im cloudflared-Log direkt nach einem cloudflared-Update. Die eigentliche Ursache war
   das parallel gemergte Pi-hole-Update.

---

## Offene Punkte

- [ ] PROD-cloudflared im PROD-Kontext explizit als `Running` bestätigen und Tunnel-Status in Cloudflare prüfen.
- [ ] Nach dem nächsten Pi-hole-Update von Renovate prüfen, dass alter und neuer Pod kurz parallel laufen und DNS durchgehend antwortet
      (`while true; do dig @192.168.178.94 +short +time=1 github.com; sleep 1; done` während des Syncs).
- [ ] Renovate-Gruppierung prüfen: Infrastruktur-Images (Pi-hole, cloudflared) nicht am selben Tag mergen, damit ein Ausfall eindeutig
      einer Änderung zugeordnet werden kann.
