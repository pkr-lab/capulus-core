# WireGuard-Backup-Tunnel (Tailscale-Ausfallsicherung)

Dieses Dokument behandelt den eigenständigen WireGuard-Tunnel, der als
Notfall-Zugriffsweg dient, falls Tailscale ausfällt (Control-Plane/DERP-Relays
down, Account-Problem, Bug im Client). Rolle: `ansible/roles/wireguard_backup`.

---

## Überblick

**Zweck:** reiner Notfall-Zugriff aufs Homeserver selbst (SSH, `kubectl`,
ArgoCD) — **kein** Ersatz für Tailscale im Alltag und **kein** LAN-Router wie
die [Tailscale-Subnet-Route](c0010-tailscale.md#subnet-routing).

**Warum ein zweiter VPN-Stack statt "einfach mehr Tailscale":** Tailscale
selbst ist von Tailscales eigener Infrastruktur abhängig (Login-Server,
DERP-Relays, Client-Updates). Ein Ausfall dort betrifft *alle* Tailscale-
Geräte gleichzeitig. Der WireGuard-Backup-Tunnel läuft komplett
eigenständig (Kernel-WireGuard via `wg-quick`, kein Third-Party-Dienst) und
bleibt daher erreichbar, wenn Tailscale es nicht ist.

**Warum "nur Notfall" und nicht Alltags-VPN:**

- **Genau ein Peer** (dein Backup-Gerät) — kein Geräte-Management, keine ACLs.
- **Kein LAN-Routing** — `AllowedIPs` auf Server-Seite ist auf die
  Tunnel-IP des einen Peers beschränkt, es gibt keine
  PostUp/PostDown-NAT/Forward-Regeln. Selbst wenn das Backup-Gerät
  kompromittiert würde, kommt ein Angreifer nur bis zum Homeserver selbst,
  nicht ins restliche LAN.
- **Nicht-Standard-Port** — reduziert Rauschen von automatisierten
  Portscans/Log-Spam, ist aber nicht der eigentliche Sicherheitsmechanismus
  (siehe unten).
- **Kein DNS-Eintrag, keine Erwähnung im normalen Zugriffs-Workflow** —
  taucht bewusst nirgendwo außer hier und in `group_vars/all.yml` auf.
- **Optionaler Preshared Key** — zusätzliche symmetrische Schicht über der
  asymmetrischen WireGuard-Handshake-Kryptografie.

**Die eigentliche Sicherheit kommt aus WireGuards Protokoll-Design:** Ein
WireGuard-Endpunkt antwortet **nicht** auf Pakete ohne gültige Kryptografie
— kein TCP-Handshake, kein Port-"offen"-Signal, kein Fehlercode. Für einen
Portscanner sieht der Port exakt so aus wie ein geschlossener/gefilterter
Port. Das ist der Hauptgrund für die Wahl von WireGuard gegenüber z. B.
OpenVPN.

---

## Architektur

```
Backup-Gerät (Laptop/Handy)          Homeserver
  10.99.99.2/32                        10.99.99.1/24
  wg0 / "Homeserver-Backup" ────UDP────▶ wg-backup (Port 51888, CHANGE)
        AllowedIPs = 10.99.99.1/32           AllowedIPs (Peer) = 10.99.99.2/32
        Endpoint = <öffentliche IP/DDNS>:<Port>
```

Split-Tunnel: Nur Traffic zum Homeserver (`10.99.99.1`) geht durch den
Tunnel, der restliche Internet-Traffic des Backup-Geräts bleibt unberührt
(kein "kompletter VPN"-Modus).

---

## Setup

### 1. Client-Keypair erzeugen (auf dem Backup-Gerät, NICHT auf dem Server)

```bash
wg genkey | tee client-private.key | wg pubkey > client-public.key
```

`client-private.key` bleibt ausschließlich auf dem Backup-Gerät — nie ins
Repo, nie an den Server übertragen, nie in Ansible-Vault. Nur der
**Public Key** wird gebraucht.

### 2. Optional: Preshared Key erzeugen (empfohlen)

```bash
wg genpsk
```

Verschlüsselt in `ansible/group_vars/all.yml` ablegen:

```bash
ansible-vault encrypt_string '<PSK-AUSGABE>' --name 'wireguard_backup_peer_preshared_key'
```

Den verschlüsselten Block in `ansible/group_vars/all.yml` einfügen (siehe
auskommentierten Platzhalter dort).

### 3. `group_vars/all.yml` konfigurieren

```yaml
wireguard_backup_port: <eigener Port>              # CHANGE, Default 51888
wireguard_backup_peer_public_key: "<client-public.key-Inhalt>"
wireguard_backup_peer_preshared_key: !vault | ...   # aus Schritt 2, optional
```

### 4. Router-Portforward (einmalig, außerhalb von Ansible)

Im Router: UDP `<wireguard_backup_port>` → LAN-IP des Homeservers
(`192.168.178.94`, siehe [c0030-port-uebersicht.md](c0030-port-uebersicht.md)).

Für den `Endpoint` in der Client-Config wird entweder eine statische
öffentliche IP oder ein DDNS-Hostname gebraucht (unabhängig vom
Cloudflare-Tunnel, der outbound-only ist und dafür nicht genutzt werden
kann — siehe [docs/e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md)).
Die meisten Router bieten einen eingebauten DDNS-Client (z. B. an
DuckDNS/No-IP); falls noch keiner eingerichtet ist, vorher einrichten.

### 5. Ansible-Rollout

```bash
ansible-playbook ansible/site.yml --tags wireguard --ask-vault-pass
```

Die Rolle installiert `wireguard`, generiert (einmalig) das
Server-Keypair, schreibt `/etc/wireguard/wg-backup.conf`, öffnet den Port
in UFW und startet `wg-quick@wg-backup`. Am Ende der Ausgabe steht der
**Server-Public-Key** — für die Client-Config gebraucht.

### 6. Client-Config zusammenbauen (auf dem Backup-Gerät)

```ini
[Interface]
PrivateKey = <Inhalt von client-private.key>
Address = 10.99.99.2/32

[Peer]
PublicKey = <Server-Public-Key aus Schritt 5>
PresharedKey = <PSK aus Schritt 2, falls gesetzt>
Endpoint = <öffentliche IP oder DDNS-Name>:<wireguard_backup_port>
AllowedIPs = 10.99.99.1/32
PersistentKeepalive = 25
```

Als `.conf` importieren (WireGuard-App auf iOS/Android/macOS/Windows) oder
unter Linux: `sudo wg-quick up ./homeserver-backup.conf`.

---

## Verbindung testen

```bash
# Auf dem Backup-Gerät
sudo wg-quick up wg0        # oder Toggle in der App
ping 10.99.99.1
ssh ubuntu@10.99.99.1
curl -s http://10.99.99.1:30080/api/version     # ArgoCD (Klartext, nur CLI/API)
kubectl --server=https://10.99.99.1:6443 get nodes

# Auf dem Server
sudo wg show wg-backup       # sollte "latest handshake" zeigen, sobald der Client verbindet
```

**Wichtig:** Diesen Test **einmal nach dem Setup** durchführen, während
Tailscale noch normal funktioniert — nicht erst während eines echten
Tailscale-Ausfalls zum ersten Mal ausprobieren.

---

## Notfall-Runbook: Tailscale ist down

1. Backup-Gerät: WireGuard-Tunnel aktivieren (App-Toggle oder
   `wg-quick up`).
2. `ssh ubuntu@10.99.99.1` bzw. `kubectl --server=https://10.99.99.1:6443 …`.
3. Nach getaner Arbeit: Tunnel wieder deaktivieren — er soll außerhalb von
   Notfällen inaktiv bleiben (auf Client-Seite; der Server-Dienst selbst
   läuft dauerhaft, siehe Sicherheits-Überlegungen oben).

---

## Troubleshooting

```bash
# Server: läuft der Tunnel?
sudo systemctl status wg-quick@wg-backup
sudo wg show wg-backup
sudo journalctl -u wg-quick@wg-backup --since "30 minutes ago"

# UFW-Regel vorhanden?
sudo ufw status | grep <wireguard_backup_port>

# Kein Handshake trotz korrektem Endpoint/Port:
# - Router-Portforward prüfen (UDP, nicht TCP)
# - Öffentliche IP/DDNS-Name aktuell? (dynamische IP ändert sich ggf.)
# - Uhrzeit auf beiden Geräten korrekt (WireGuard-Handshake ist zeitsensitiv)
```

Kein Handshake ist von außen nicht von einem geschlossenen Port zu
unterscheiden (siehe oben) — das erschwert das Debuggen absichtlich für
Angreifer, aber auch etwas für dich selbst. Im Zweifel zuerst lokal im LAN
gegen die LAN-IP testen, um Router/DDNS als Fehlerquelle auszuschließen.
