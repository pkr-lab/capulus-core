# 038 Unnötige oder ungesicherte Netzwerkdienste auf homeserver und worker-1 (CUPS, SANE, rpcbind, Avahi, FRR-mgmtd, Exporter ohne Auth)

- Severity: Low
- Bereich: Netzwerk
- Betroffen: homeserver (`:631`, `:6566`, `:111`, `:5353/udp`, `:2623`, `:19443`), worker-1 (`:111`, `:2623`), alle Hosts (`:9100`, `:9633`)
- Status: Teilweise behoben am 2026-10-18 (Homeserver durch Incident 008 aus dem LAN geschlossen, geprüft; worker-1 hängt an 035, CUPS/SANE/Avahi bewusst offen)

## Beschreibung

Auf den Hosts lauschen mehrere Dienste auf allen Schnittstellen, die für den Clusterbetrieb nicht nötig sind:

- homeserver: CUPS (`0.0.0.0:631`, `[::]:631`, bewusst als Druckserver), Port `6566` (SANE-Scanner-Dienst über `inetd`, ohne Authentifizierung), `rpcbind`/`rpc.statd` (`:111`; sie werden für die NFS-Mounts benötigt, siehe unten), `avahi-daemon` (`:5353/udp`), FRR-`mgmtd` (`:2623`, meldet „Vty password is not set“, verweigert also den Zugriff), MetalLB-`statuscleaner`-Webhook (`:19443`).
- worker-1: `rpcbind` (`:111`), FRR-`mgmtd` (`:2623`).
- alle Hosts: `node_exporter` (`:9100`) und auf den Hosts mit S.M.A.R.T. der `smartctl_exporter` (`:9633`) ohne Authentifizierung und TLS; sie liefern Host- und Laufwerksdaten (Dienste, Mounts, Netzwerkschnittstellen).

Die NAS-Mounts laufen mit `vers=3` und `sec=sys` (AUTH_SYS, Klartext, nur IP-basiert). Zusammen mit der offenen Firewall-Lage (Incidents 008, 035) sind die Dienste im LAN für jeden erreichbar. CUPS hatte 2024 eine kritische Kette (cups-browsed, CVE-2024-47176 und Folgende); auf dem homeserver lauscht nur `cupsd` (kein `cups-browsed` auf UDP 631 beobachtet).

## Nachweis

```
$ ssh homeserver 'sudo ss -tulpn' | grep -E ':(631|6566|111|5353|2623|19443|9100|9633) '
tcp  0.0.0.0:631   cupsd         tcp  0.0.0.0:6566  inetd        tcp  0.0.0.0:111   rpcbind
udp  0.0.0.0:5353  avahi-daemon  tcp  0.0.0.0:2623  mgmtd        tcp  *:19443      statuscleaner
tcp  *:9100        node_exporter tcp  *:9633        smartctl_exporter

$ ssh homeserver 'findmnt -t nfs -o FSTYPE,OPTIONS' | head -2
nfs  rw,relatime,vers=3,...,hard,proto=tcp,sec=sys,mountaddr=192.168.178.97,...

$ (vom Admin-PC) printf '' | nc 192.168.178.94 2623
Vty password is not set.
```

## Risiko / Angriffsszenario

Größere Angriffsfläche für Angreifer im LAN: bekannte CUPS-/SANE-Schwachstellen, Informationsabfluss über Exporter, Dienst-Fingerprinting. Der konkrete Schaden hängt von der Firewall-Härtung ab.

## Empfohlene Behebung

1. Nicht benötigte Dienste abschalten: `sudo systemctl disable --now avahi-daemon`. `rpcbind` und `rpc.statd` **nicht** abschalten, solange die NAS-Mounts mit `vers=3` laufen (`findmnt -t nfs`): NFSv3 braucht sie. Sie per UFW auf das NAS beschränken. Auf NFSv4.1 (`nfsvers=4.1` in der StorageClass) umstellen, wenn das NAS es unterstützt, und danach `rpcbind` und `rpc.statd` abschalten.
2. CUPS und SANE per UFW auf die Clients beschränken, die drucken bzw. scannen (`ufw allow from <PC-IP> to any port 631`).
3. Exporter auf die Monitoring-Quelle begrenzen (`ufw allow from <vmagent-IP> to any port 9100,9633`) oder an `127.0.0.1`/Tailnet-IP binden.
4. FRR-`mgmtd` per MetalLB-Konfiguration nur auf `127.0.0.1` lauschen lassen.

## Rollback

Dienste wieder aktivieren (`systemctl enable --now …`), UFW-Regeln löschen.

## Verifikation

```
ssh homeserver 'sudo ss -tulpn' | grep -E ':(111|5353|2623|6566) '
nmap -Pn -p 111,631,2623,6566,9100,9633 192.168.178.94
```
Die abgeschalteten Ports erscheinen nicht mehr, Exporter und Drucker sind nur noch von den freigegebenen Quellen erreichbar. Grafana zeigt weiter Daten aller Hosts.

## Risiko der Behebung

Niedrig bis mittel: CUPS und SANE werden von der Rolle `cups_print_server` bzw. `scanner` bewusst betrieben; ein Abschalten setzt Drucker und Scanner außer Betrieb.

## Bearbeitungsstand (2026-10-18)

Keine neue Änderung, aber eine Messung: Die Härtung aus 008 hat den größten Teil dieses Funds auf dem homeserver bereits erledigt.

**Nachweis** (TCP-Connect aus dem LAN über die Schnittstelle `enp7s0`, damit der Tailscale-Pfad nicht mitgetestet wird):

| Host | offen | geschlossen |
|---|---|---|
| homeserver (192.168.178.94) | `22`, `631` (CUPS), `6566` (SANE), `6443` (k3s-API) | `111`, `2623`, `9100`, `9633`, `19443`, `10250` |
| worker-1 (192.168.178.96) | `22`, `111`, `2623`, `9100`, `9633`, `10250` | `631`, `6566`, `19443`, `6443` |

**Bewertung je Punkt der Empfehlung.**

- **Punkt 1 (Dienste abschalten):** `rpcbind`/`rpc.statd` bleiben, solange die NAS-Mounts `vers=3` nutzen. Die Umstellung der StorageClass auf `nfsvers=4.1` bräuchte einen Test am NAS und ändert alle `nas`-Volumes; das ist eine eigene Maßnahme. `avahi-daemon` (`5353/udp`) lasse ich laufen: CUPS nutzt ihn zur Druckerfreigabe (AirPrint), ein Abschalten kann das Drucken von iPhone und Mac beenden.
- **Punkt 2 (CUPS/SANE):** `631` und `6566` sind aus dem LAN absichtlich offen (Druck- und Scanserver für die Geräte im Haus). Auf einzelne Client-IPs zu beschränken ist möglich (`ufw allow from <IP> to any port 631`), setzt aber die Liste der Clients voraus, die ich nicht kenne.
- **Punkt 3 (Exporter):** Auf dem homeserver aus dem LAN geschlossen (008). Auf worker-1 offen, bis die UFW dort läuft (035).
- **Punkt 4 (FRR-`mgmtd` auf 127.0.0.1):** `mgmtd` gehört zum frr-k8s-Pod von MetalLB und bindet ohne Konfigurationsschalter auf alle Adressen. Hinter der Host-Firewall (008 auf dem homeserver, 035 für worker-1) ist der Port aus dem LAN nicht mehr erreichbar, der Daemon antwortet ohnehin nur „Vty password is not set“.

**Offen (deine Entscheidung).** Client-Liste für CUPS/SANE; NFSv4.1 für die NAS-Volumes (danach `rpcbind` abschalten); worker-1 über 035.

**Geänderte Dateien.** Keine.
