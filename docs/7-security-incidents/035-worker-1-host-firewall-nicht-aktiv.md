# 035 worker-1: Host-Firewall ist nicht aktiv, Dienste lauschen auf allen Schnittstellen

- Severity: Medium
- Bereich: worker1
- Betroffen: worker-1 (`192.168.178.96`), `ansible/roles/k3s_agent/tasks/main.yml:62-90`, `ansible/worker-1.yml`
- Status: Offen

## Beschreibung

Auf worker-1 ist UFW zwar installiert, aber ausgeschaltet (`Status: inactive`), die iptables-Policies stehen auf `ACCEPT`. Ursache im Repo: Die Rolle `k3s_agent` legt vier UFW-Regeln an (`10250` vom Server, `8472/udp`, Pod- und Service-CIDR), aktiviert UFW aber nirgends. Die Rolle `common`, die UFW aktiviert (`state: enabled`), ist im Playbook `worker-1.yml` (und `worker-0.yml`) nicht enthalten. Die Regeln wirken nicht, der systemd-Dienst `ufw` meldet trotzdem `active`. Die vorgemerkten Regeln (`ufw show added`) enthalten **weder SSH (`22`) noch die Weiterleitung der VM-Bridge**: Wer UFW auf worker-1 einfach einschaltet, sperrt sich per SSH aus und trennt die ENTW-VM vom LAN.

Auf allen Schnittstellen erreichbar sind u. a. `22` (SSH, Passwort-Login erlaubt, Incident 009), `111` (rpcbind), `9100` (node_exporter), `9633` (smartctl_exporter), `9140/9141` (FRR-Metriken), `9120/7946` (MetalLB-Speaker), `2623` (FRR-mgmtd), `10250` (kubelet, Auth erforderlich) und `8472/udp` (VXLAN). `br0` trägt eine global routbare IPv6-Adresse; CrowdSec ist auf worker-1 nicht installiert. worker-0 war nicht erreichbar und ist ungeprüft, dort ist derselbe Zustand zu erwarten.

## Nachweis

```
$ ssh worker-1 'sudo ufw status verbose; sudo iptables -S | grep -E "^-P"'
Status: inactive
-P INPUT ACCEPT
-P FORWARD ACCEPT
-P OUTPUT ACCEPT

$ ssh worker-1 'systemctl is-active ufw; ip -br a show br0'
active
br0              UP             192.168.178.96/24 2a02:…(global, maskiert)/64 fd33:…/64 fe80::…/64

$ ssh worker-1 'sudo ss -tulpn' | grep -E ':(22|111|2623|9100|9633) '
tcp LISTEN 0.0.0.0:22 sshd        tcp LISTEN 0.0.0.0:111 rpcbind     tcp LISTEN 0.0.0.0:2623 mgmtd
tcp LISTEN *:9100 node_exporter   tcp LISTEN *:9633 smartctl_exporter

(vom Admin-PC im LAN erreichbar: 192.168.178.96:2623, :111, :9100)

$ ssh worker-1 'sudo ufw show added'
ufw allow from 192.168.178.94 to any port 10250 proto tcp comment 'k3s kubelet API from control-plane'
ufw allow 8472/udp comment 'Flannel VXLAN pod overlay network'
ufw allow from 10.42.0.0/16 comment 'k3s pod CIDR traffic'
ufw allow from 10.43.0.0/16 comment 'k3s service CIDR traffic'

$ grep -c common ansible/worker-1.yml ansible/worker-0.yml
ansible/worker-1.yml:0
ansible/worker-0.yml:0
```

## Risiko / Angriffsszenario

Jedes Gerät im LAN, im Tailnet (mit ACL-Erlaubnis) oder bei durchlässiger IPv6-Freigabe auch aus dem Internet erreicht alle Dienste des Workers. Zusammen mit Passwort-Login für `ubuntu` (NOPASSWD-sudo) und ohne Brute-Force-Schutz ist ein erratenes Passwort ein Root-Zugang auf einem Knoten mit Zugriff auf Pod-Daten, kubelet-Zertifikate und die ENTW-VM.

## Empfohlene Behebung

1. `k3s_agent` bzw. ein gemeinsamer Firewall-Task: Regeln anlegen und danach explizit aktivieren; vorher SSH und die Weiterleitung für die VM-Bridge erlauben:
   ```yaml
   - name: SSH aus LAN und Tailnet erlauben
     community.general.ufw:
       rule: allow
       port: "22"
       proto: tcp
       src: "{{ item }}"
     loop: ["{{ local_subnet }}", "100.64.0.0/10"]

   - name: VM-Bridge weiterleiten
     ansible.builtin.command: ufw route allow in on br0 out on br0
     register: worker_ufw_route
     changed_when: "'Skipping' not in worker_ufw_route.stdout"

   - name: UFW aktivieren
     community.general.ufw:
       state: enabled
       default: deny
       direction: incoming
   ```
2. Nur nötige Ports freigeben: `10250` vom Server, `8472/udp` von den Knoten, `9100`/`9633` vom Monitoring, `7946` zwischen den Knoten, `2623` gar nicht.
3. CrowdSec (SSH-Bouncer) oder `fail2ban` auf den Workern einrichten oder Passwort-Login abschalten (Incident 009).
4. Änderung zuerst an worker-1 (ENTW-VM nur Test), danach an worker-0, bei laufender zweiter SSH-Session.

## Rollback

`sudo ufw disable` stellt den offenen Zustand sofort wieder her; die Ansible-Änderung revertieren.

## Verifikation

```
ssh worker-1 'sudo ufw status verbose'
nmap -Pn -p 22,111,2623,9100,9633,10250 192.168.178.96
ping -c2 192.168.178.100
```
UFW `active` mit Default deny; von nicht freigegebenen Quellen `filtered`; die ENTW-VM (`192.168.178.100`) bleibt erreichbar; `kubectl get nodes` zeigt worker-1 `Ready`.

## Risiko der Behebung

Hoch: worker-1 betreibt die ENTW-VM über die Bridge `br0` und zwei weitere Netze (Flannel, Tailscale). Eine aktivierte Firewall mit `deny routed` trennt die VM vom LAN, wenn die Weiterleitungsregel auf `br0` fehlt. SSH-Lockout möglich.

## Bearbeitungsstand (2026-10-18)

Nicht umgesetzt. Die Maßnahme kann den Zugang zum Worker und die ENTW-VM kappen und verlangt nach deinen Regeln eine zweite SSH-Session und einen Rollback-Timer, die ich allein nicht prüfen kann. Ich habe worker-1 nur lesend untersucht (SSH als `ubuntu`) und einen konkreten Plan vorbereitet:

**Befund zusätzlich zum Incident.**

| Punkt | Wert |
|---|---|
| Schnittstellen | `enp2s0` (Port von `br0`), `br0` (192.168.178.96/24 + globale IPv6), `tailscale0` (100.124.213.94), `virbr0`, `vnet0` (ENTW-VM), `flannel.1`, `cni0` (10.42.1.1/24) |
| `net.bridge.bridge-nf-call-iptables` | `1`: Der Verkehr der ENTW-VM über `br0` durchläuft die iptables-`FORWARD`-Kette. Mit UFW (`DEFAULT_FORWARD_POLICY="DROP"`) bricht die VM-Anbindung, wenn nicht `ufw route allow in on br0 out on br0` gesetzt ist |
| tatsächlich nötige Verbindungen von außen | vom Homeserver (192.168.178.94): SSH `22`, `9100` (node_exporter), `9633` (smartctl_exporter), `10250` (kubelet, aus den Verbindungen des API-Servers); zwischen den Nodes MetalLB-Speaker `7946` (TCP und UDP) und die FRR-Metriken `9140`/`9141`; Flannel `8472/udp`; Pod-/Service-Netze `10.42.0.0/16`, `10.43.0.0/16` |
| nicht nötig, aber offen | `111` (rpcbind), `2623` (FRR-mgmtd), `5900` (VNC nur auf 127.0.0.1) |
| Tailnet | läuft über die Kette `ts-input` von Tailscale vor UFW (wie in 008) |

**Vorgeschlagene Regeln** (Muster aus 008, Infrastruktur-Hosts Vollzugriff, LAN nur SSH):

```
ufw allow from 192.168.178.94
ufw allow from 192.168.178.95
ufw allow from 10.42.0.0/16
ufw allow from 10.43.0.0/16
ufw allow in on br0 to any port 22 proto tcp
ufw allow 8472/udp
ufw route allow in on br0 out on br0
ufw route allow in on cni0
ufw route allow out on cni0
ufw route allow in on flannel.1
ufw route allow out on flannel.1
ufw default deny incoming
ufw --force enable
```

**Ablauf mit dir** (jeder Schritt mit Zeitstempel-Backup von `/etc/ufw` und `iptables-save`):

1. Zweite SSH-Session auf worker-1 offen halten. Rollback-Timer: `sudo systemd-run --on-active=5min --unit=ufw-rollback /bin/sh -c 'ufw disable'`.
2. Regeln wie oben anlegen (noch ohne `enable`), `ufw show added` prüfen.
3. `ufw --force enable`, sofort neue SSH-Verbindung testen, `kubectl get nodes` (worker-1 `Ready`), `curl http://192.168.178.96:9100/metrics` vom Homeserver, Ping und HTTP **aus der ENTW-VM** ins LAN (`virsh console` oder SSH auf die VM), ArgoCD-Sync der ENTW-Apps.
4. Erst nach deiner Bestätigung den Timer abbrechen (`systemctl stop ufw-rollback.timer`).
5. Danach die Regeln in `ansible/roles/k3s_agent/tasks/main.yml` übernehmen (die Rolle legt heute vier Regeln an, aktiviert aber nie) und `worker-1.yml` um `common` bzw. um die Aktivierung ergänzen.

**Rollback.** `ufw disable`; Konfiguration aus dem Backup `/etc/ufw.bak-<zeit>` zurückkopieren.

**Offen.** Auf worker-0 ist derselbe Zustand zu erwarten (ausgeschaltet, nicht geprüft). Sag Bescheid, wenn ein Zeitfenster passt, dann führen wir den Ablauf zusammen aus.

