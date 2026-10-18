# 008 UFW: LAN und gesamtes Tailnet haben vollen Zugriff, `6443`, `10250` und `8472/udp` ohne Quelleinschränkung

- Severity: Medium
- Bereich: Netzwerk
- Betroffen: `capulus-ansible/roles/common/tasks/main.yml:188-263`, `capulus-ansible/roles/k3s_agent/tasks/main.yml:72-77`
- Status: Teilweise behoben am 2026-10-17 (homeserver vollständig, worker-0, prod-vm und entw-vm nur die offenen Cluster-Ports; offen: LAN-Pauschale dort, worker-1, Tailscale-ACL, NodePorts)

## Beschreibung

Die Rolle `common` schließt die Firewall nicht auf einzelne Dienste ab, sondern vertraut ganzen Netzen: `Allow all traffic from local LAN subnet` (192.168.178.0/24) und `Allow all traffic from Tailscale network` (100.64.0.0/10) erlauben alle Ports. Damit sind alle LAN-Geräte (IoT, Gäste im Heimnetz, Fritz!Box-Geräte) und jeder Tailnet-Knoten, auch die GitHub-Runner mit `tag:ci`, gleichberechtigt mit Admin-Clients. Zusätzlich sind `6443` (k3s-API) und `10250` (kubelet) auf dem Server ohne Quelladresse freigegeben, `8472/udp` (Flannel-VXLAN, unauthentifiziert) auf Server und Agents.

Die tatsächlich wirksame Absicherung hängt damit an der Tailscale-ACL (nicht im Repo) und an der Segmentierung des Heimnetzes.

## Nachweis

```
$ grep -n -E 'name: Allow (k3s API|Flannel|kubelet|all traffic from (local|Tailscale))' capulus-ansible/roles/common/tasks/main.yml
188:- name: Allow k3s API server (port 6443)
228:- name: Allow Flannel VXLAN overlay network (UDP 8472)
235:- name: Allow kubelet API (port 10250)
254:- name: Allow all traffic from local LAN subnet
260:- name: Allow all traffic from Tailscale network

$ sed -n 254,263p capulus-ansible/roles/common/tasks/main.yml
- name: Allow all traffic from local LAN subnet
  community.general.ufw:
    rule: allow
    src: "{{ local_subnet }}"
    comment: "Local LAN subnet access"

- name: Allow all traffic from Tailscale network
  community.general.ufw:
    rule: allow
    src: "100.64.0.0/10"

$ sed -n 72,77p capulus-ansible/roles/k3s_agent/tasks/main.yml
- name: Allow Flannel VXLAN (UDP 8472) for pod overlay
    port: "8472"
```

## Phase-2-Nachweis (live, lesend)

Live-Stand `ufw status verbose` (Auszug) und Erreichbarkeit von einem LAN-Client (Admin-PC):

| Host | UFW | Auffälligkeiten |
|---|---|---|
| homeserver | aktiv, Default deny | `22`, `80`, `443`, `6443`, `10250`, `8472/udp` auch für **Anywhere (v6)**; `443/udp` und `51888/udp` (WireGuard) für Anywhere; Regeln „allow all from 192.168.178.0/24“ und „from 100.64.0.0/10“; `10250` und `8472/udp` zusätzlich offen für Anywhere |
| prod-vm, entw-vm | aktiv, Default deny | gleiche Anywhere-Regeln für `6443`, `10250`, `8472/udp` (v4 und v6) sowie `30443` (ArgoCD-UI, dort lauscht nichts: Rest einer früheren Regel) |
| worker-1 | **inaktiv** | siehe Incident 035 |

Vom Admin-PC im LAN waren erreichbar: `192.168.178.94`: `9101`, `9310`, `9100`, `631`, `6566`, `2623`, `30080`, `19443`; `192.168.178.96`: `2623`, `111`, `9100`.

Der Paketfilter in Tailscale (Incident 036) schränkt die Tailnet-Regel „allow all from 100.64.0.0/10“ in der Praxis auf einzelne Geräte ein, lässt aber sechs Geräte vollständig durch. Die IPv6-Regeln sind nur relevant, wenn die Fritz!Box eingehenden IPv6-Verkehr zu den Hosts zulässt (global routbare Adressen sind auf `br0` von homeserver und worker-1 gesetzt). Das klärt Phase 3.

## Risiko / Angriffsszenario

Ein kompromittiertes IoT-Gerät oder ein Gast im LAN erreicht SSH, k3s-API, power-agent (9101), ArgoCD (30080), Pi-hole, alle NodePorts ohne Hürde. Unauthentifiziertes VXLAN auf 8472/udp erlaubt Pakete in das Pod-Netz einzuschleusen. Ein beliebiger Tailnet-Knoten (auch ein geteilter Fremdknoten) hat denselben Vollzugriff, falls die Tailscale-ACL nicht enger ist.

## Empfohlene Behebung

1. `6443`, `10250` und `8472/udp` auf die Knoten-IPs (Server, worker-0, worker-1) und, für `6443`, auf definierte Admin-Quellen beschränken.
2. Die beiden Blanket-Regeln (`LAN`, `Tailnet`) durch explizite Dienstfreigaben ersetzen (22, 80, 443, 53, 30080, 9101 nur von den Quellen, die sie brauchen).
3. In der Tailscale-ACL `tag:ci` und Gerätegruppen auf die tatsächlich nötigen Ziel-Ports (`192.168.178.94:30080`, `192.168.178.100:30080`) begrenzen (liegt in der Tailscale-Admin-Konsole, nicht im Repo).
4. Ansible-Diff (Beispiel):
   ```diff
    - name: Allow k3s API server (port 6443)
      community.general.ufw:
        rule: allow
        port: "6443"
        proto: tcp
   +    src: "{{ item }}"
   +  loop: "{{ common_k3s_api_sources }}"
   ```

## Rollback

Alte Blanket-Regel vorübergehend wieder anlegen (`ufw allow from 192.168.178.0/24`), dann Ansible-Rolle auf den vorigen Stand zurücksetzen.

## Verifikation

```
sudo ufw status numbered
nmap -Pn -p 6443,10250,9101,30080 192.168.178.94   (von einem Gerät ohne Freigabe)
```
Von nicht freigegebenen Quellen müssen die Ports `filtered` sein, von freigegebenen offen. Cluster-Funktion prüfen: `kubectl get nodes` zeigt alle Knoten `Ready`, Pod-Netz-Verkehr zwischen den Knoten funktioniert.

## Risiko der Behebung

Hoch: Fehler in Firewall-Regeln können SSH und den Cluster aussperren. Zweite SSH-Session offen halten, `ufw` mit `--dry-run` bzw. Regeln erst hinzufügen, dann Blanket-Regeln entfernen.

## Behebung (2026-10-17)

Die Regeln wurden live mit `ufw` gesetzt (je Host Backup und Rollback-Timer, in einer zweiten Verbindung getestet), der Ansible-Code wurde danach angeglichen. Ein Ansible-Lauf (`make common`) steht noch aus, er braucht das Vault-Passwort.

**Stufe 1: offene Cluster-Ports (homeserver, worker-0, prod-vm, entw-vm).**

- Gelöscht wurden die Regeln für `6443/tcp`, `10250/tcp` und `8472/udp` für „Anywhere“, jeweils IPv4 und IPv6. Auf worker-0 war `6443` offen, obwohl dort kein API-Server läuft. Auf prod-vm und entw-vm entfiel zusätzlich die tote Regel `30443/tcp`.
- Neu und explizit: `6443` auf dem homeserver aus LAN, Tailnet und dem WireGuard-Notzugang `10.99.99.0/24`, auf prod-vm und entw-vm aus dem LAN. `10250` und `8472/udp` bleiben aus dem LAN erlaubt. Auf worker-0 ist `8472/udp` nur noch aus dem LAN offen.

**Stufe 2: Pauschalregeln (nur homeserver).**

- Gelöscht: „alles aus `192.168.178.0/24`“, „alles aus `100.64.0.0/10`“ sowie `10250` und `8472/udp` aus dem ganzen LAN.
- Neu: Vollzugriff für die Infrastruktur-Hosts `192.168.178.95`, `.96` (Worker), `.97` (NAS), `.99` (prod-vm) und `.100` (entw-vm). Das übrige LAN darf `22`, `53`, `80`, `443`, `6443`, `30080` (unverändert), `631` (CUPS) und `6566` (SANE).
- Bewusst abweichend von der Beschreibung: Die Infrastruktur-Hosts behalten Vollzugriff, statt dass jede Verbindung einzeln freigegeben wird. Ein Dienst zwischen den Knoten, der nicht im Repo steht, fällt so nicht stumm aus.

**Nachweis.**

| Test | Ergebnis |
|---|---|
| Vom LAN-Gerät `192.168.178.66` (an `enp7s0` gebunden) auf `192.168.178.94` | `22`, `53`, `80`, `443`, `6443`, `631`, `6566`, `30080` offen |
| dasselbe: `9101`, `9310`, `9100`, `9633`, `10250`, `111`, `2623`, `7946`, `45811` | gesperrt (Timeout) |
| worker-0 und prod-vm → homeserver `9100`, `9101` | offen |
| Pod im Namespace `carplay-api` → homeserver `9101`, `9310`, `9100`, `6443`, `10250` | offen |
| DNS-Abfrage vom LAN-Gerät | beantwortet |
| VictoriaMetrics-Scrape-Ziele | 37 von 37 `up` |
| Cluster | alle Nodes `Ready`, ArgoCD wie vorher, Hosts 200/302 |
| UFW-Blocks seit Stufe 2 | nur SSDP-Antworten zweier LAN-Geräte auf einen Suchlauf des Hosts und IPv6-Router-Solicitations im Pod-Netz |
| Loopback-Regel `iptables -C ufw-before-input -i lo -j ACCEPT` | auf allen vier Hosts vorhanden |

**Befunde bei der Umsetzung.**

- **Die Tailnet-Pauschale war wirkungslos.** Tailscale nimmt den Verkehr auf `tailscale0` in der Kette `ts-input` vor UFW an, die UFW-Regel hatte 0 Treffer. Was das Tailnet erreicht, bestimmt allein die Tailscale-ACL (Incident 036).
- **UFW schützt keine NodePorts und keinen LoadBalancer.** Der Verkehr läuft über `FORWARD` und wird von `KUBE-ROUTER-FORWARD` und `KUBE-FORWARD` vor UFW angenommen. Die UFW-Regeln für `80`, `443` und `30080` hatten durchgehend 0 Treffer. Die Aussage in der Doku und in dieser Beschreibung („30080 nur von LAN und Tailnet“) trifft für UFW also nicht zu. Betroffen sind `30080` (ArgoCD-Klartext-API, siehe 013), `31935`/`31554` (MediaMTX) und `30053` (Pi-hole). Sie sind nur dadurch begrenzt, dass die Node-IP nicht aus dem Internet erreichbar ist (sofern die Fritz!Box nichts weiterleitet, Phase 3) und durch die NetworkPolicies. Eine Beschränkung braucht einen anderen Mechanismus (NetworkPolicy mit `ipBlock`, `externalTrafficPolicy: Local` oder eine Traefik-Middleware).
- **Testen als LAN-Gerät:** Ein Admin-PC mit `accept-routes` routet die LAN-Adressen über `tailscale0`. Der Test sieht dann Tailnet-Verkehr, den UFW nie prüft. Der erste Testlauf zeigte deshalb alle Ports offen, bis die Quelle an die physische Schnittstelle gebunden wurde.

**Geänderte Dateien.**

- `capulus-ansible/roles/common/defaults/main.yml` (neu), `capulus-ansible/roles/common/tasks/main.yml`, `capulus-ansible/roles/k3s_agent/tasks/main.yml`, `capulus-ansible/host_vars/homeserver/vars.yml`
- Doku: `docs/6-hintergruende/60010-ansible-hosts-und-playbooks.md` (Abschnitt „Firewall (UFW, Rolle `common`)“), `docs/c-netzwerk-dns/c0030-port-uebersicht.md`, `docs/a-betriebssystem/a0010-overview.md`

**Rollback.** Die Sicherungskopien von `/etc/ufw` (`/root/ufw-backup-20261017-*`, fünf Stück auf vier Hosts) wurden am 2026-10-17 nach der Bestätigung gelöscht. Zurück geht es über den Code: die Variablen `common_ufw_lan_allow_all` und `common_ufw_tailnet_allow_all` des homeservers auf `true`, die Regeländerungen im Repo zurücknehmen und `make common` ausführen. Einzelne Regeln lassen sich von Hand wiederherstellen, zum Beispiel `sudo ufw allow from 192.168.178.0/24` für die LAN-Pauschale. Wird `user.rules` selbst überschrieben, danach `sudo ufw disable && sudo ufw --force enable` (nicht `ufw reload`, beide Teile mit `sudo`) und die Loopback-Regel prüfen.

**Offen.**

- Die LAN-Pauschale bleibt auf worker-0, prod-vm und entw-vm, bis ihre Nutzer einzeln belegt sind. worker-1 hat keine aktive Firewall (Incident 035).
- Tailscale-ACL für `tag:ci` und Gerätegruppen (Punkt 3 der Beschreibung): Incident 036.
- Beschränkung der NodePorts (siehe Befund) und IPv6-Freigaben für `22`, `80`, `443` (Incident 009, Phase 3).
- `make common` ausführen, damit Ansible und Host übereinstimmen (die Regelkommentare auf dem homeserver entsprechen bereits dem Rollenformat, der Lauf scheint also erfolgt zu sein).
