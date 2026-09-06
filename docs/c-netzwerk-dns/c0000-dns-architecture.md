# DNS-Architektur & Ausfallsicherheit

Dieses Dokument beantwortet eine sehr berechtigte Frage:

> *"Wenn ich den Home-Server als zentralen DNS-Server für mein LAN
> eintrage und der mal ausfällt, geht zu Hause das ganze Internet weg.
> Wie verhindere ich das?"*

Kurzfassung: **Mach den Home-Server NIEMALS zum einzigen DHCP-DNS-Server
in der Fritz!Box.** Die Fritz!Box kann per DHCP nur **eine** lokale
DNS-IP verteilen — es gibt also keinen automatischen Fallback. Stattdessen
behandelst du `*.homeserver` als *opt-in*-Komfort pro Gerät.

---

## Warum die naheliegende Lösung schlecht ist

```
            ┌───────────────────────────────────────┐
            │  Fritz!Box (DHCP)                     │
            │  → "Dein DNS-Server ist 192.168...1". │
            └───────────────────────────────────────┘
                            │
                            ▼
            ┌──────────────────────────────────────┐
            │  Jedes LAN-Gerät: Smart-TV,          │
            │  IoT-Steckdose, Drucker, Telefon...  │
            │  Alle fragen NUR 192.168.178.94      │
            └──────────────────────────────────────┘
                            │
                Home-Server crashed
                            │
                            ▼
            ┌──────────────────────────────────────┐
            │  Komplett-Ausfall:                   │
            │  - Kein YouTube auf dem TV           │
            │  - Heizungssteuerung tot             │
            │  - Familie ist sauer                 │
            └──────────────────────────────────────┘
```

- Die Fritz!Box **kann nur einen** lokalen DNS-Server per DHCP
  verteilen ([AVM Wissensdatenbank][avm-dns], bestätigt in mehreren
  Community-Threads).
- Das "Alternative DNSv4 server"-Feld in der Fritz!Box ist für die
  **Fritz!Box selbst** (externe Auflösung), wird **nicht** an die
  Clients weitergereicht.
- Selbst wenn die Fritz!Box zwei Server verteilen könnte: das
  Fallback-Verhalten von Windows/Linux/macOS-Clients ist nicht
  konsistent (Windows ~1s, Linux ~5s, manche Devices erkennen den
  Ausfall gar nicht oder cachen).

→ Wer den Home-Server zum *einzigen* DNS für alles macht, hängt sein
gesamtes Heimnetz an dessen Uptime.

---

## Die richtige Architektur

```
┌───────────────────────────────────────────────────────────────────┐
│  Fritz!Box bleibt unverändert der DHCP-DNS für alle LAN-Geräte    │
└───────────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
   ┌──────────────────────┐    ┌──────────────────────────┐
   │  Geräte OHNE Bedarf  │    │  Geräte MIT Bedarf an    │
   │  für *.homeserver    │    │  *.homeserver-Hostnames  │
   │  (TV, IoT, Drucker)  │    │  (dein Laptop, Handy)    │
   └──────────────────────┘    └──────────────────────────┘
              │                           │
              ▼                           ▼
       Fritz!Box-DNS               (siehe drei Wege unten)
              │                           │
              ▼                           ▼
            Internet                  *.homeserver
                                      + Internet
```

Wenn der Home-Server ausfällt:
- "Geräte ohne Bedarf" → merken **nichts**, Internet läuft weiter.
- "Geräte mit Bedarf" → `*.homeserver` schlägt fehl, aber Internet
  läuft (je nach gewähltem Weg sofort oder nach kurzem Timeout).

---

## Die drei Wege für deine Power-User-Geräte

### Weg 1: Tailscale Split DNS (empfohlen)

Dein Laptop und dein Handy haben sowieso schon Tailscale, weil du
remote auf den Server willst. Tailscale Split DNS löst beide
Probleme gleichzeitig:

- Auf jedem Tailscale-Client zusätzlich `*.homeserver`-Auflösung.
- Funktioniert auch zu Hause am LAN, weil Tailscale automatisch direkt
  über das LAN routet, wenn beide Peers im selben Netz sind.
- Fritz!Box bleibt unangetastet.
- Home-Server down → Tailscale-Client fragt für `*.homeserver` ins
  Leere (NXDOMAIN nach kurzem Timeout), alle anderen DNS-Queries
  laufen ganz normal über die Fritz!Box.

**Setup**: einmaliger Admin-Console-Schritt, beschrieben in
[docs/b-kubernetes-gitops/b0030-semaphore.md → Zugriff über Tailscale](../b-kubernetes-gitops/b0030-semaphore.md#zugriff-über-tailscale-einmaliger-admin-schritt).

**Verfügbarkeit**: macOS, Windows, Linux, iOS, Android — überall wo
Tailscale läuft, was praktisch jedes moderne Gerät ist.

### Weg 2: Pro Gerät manuell zweiten DNS-Server eintragen

Wenn ein bestimmtes Gerät kein Tailscale haben soll (z.B. ein
Familien-Tablet), trägst du dort manuell zwei DNS-Server in den
WLAN-Einstellungen ein:

- **Primär**: `192.168.178.94` (Home-Server / dnsmasq)
- **Sekundär**: `192.168.178.1` (Fritz!Box)

Verhalten:
- Home-Server up → `*.homeserver` und alles andere laufen schnell
  über dnsmasq (Internet-Queries forwarded an die Fritz!Box).
- Home-Server down → das Gerät timed out nach ~5 s und nutzt
  automatisch die Fritz!Box. `*.homeserver` schlägt fehl, alles
  andere geht normal.

**Wo eingetragen?**
- macOS: *Systemeinstellungen → Netzwerk → WLAN → Details → DNS*
- Windows: *Netzwerk- und Internet-Einstellungen → WLAN →
  Hardwareeigenschaften → DNS-Server-Zuweisung → Bearbeiten*
- Linux (NetworkManager): `nmcli con modify <verbindung> ipv4.dns
  "192.168.178.94 192.168.178.1"` + `ipv4.ignore-auto-dns yes`
- iOS: *Einstellungen → WLAN → Netzwerk → DNS konfigurieren →
  Manuell*
- Android: *WLAN-Einstellungen → Erweitert → IP-Einstellungen →
  Statisch* (oder über Private-DNS-Funktion, abhängig von Version)

### Weg 3: `/etc/hosts`-Einträge (Linux/macOS) bzw. `hosts`-Datei (Windows)

Für einzelne, langlebige Hostnamen — wenn du es ganz statisch willst:

```
192.168.178.94  semaphore.tech.homeserver argocd.homeserver headlamp.tech.homeserver
```

Vorteil: funktioniert auch wenn der dnsmasq down ist (das ist halt
eine lokale Datei, kein Netzwerk-Lookup).
Nachteil: musst du auf jedem Gerät pflegen und bei jedem neuen
Service ergänzen.

---

## Was passiert eigentlich am Home-Server selbst?

Der Home-Server hat zwei DNS-Einträge in seiner `/etc/resolv.conf`:

```
nameserver 192.168.178.94   # dnsmasq (sich selbst)
nameserver 192.168.178.1     # Fritz!Box (Fallback)
```

→ Eigene Auflösung läuft schnell über das lokale dnsmasq. Falls dnsmasq
crasht, fällt der Server selbst nach ~5 s auf die Fritz!Box zurück und
bleibt funktional.

---

## Pi-hole: Werbeblocking im DNS-Forward

Seit `argocd/apps/platform/pihole/` existiert, leitet dnsmasq alle nicht-`*.homeserver`-
Anfragen nicht mehr direkt an die Fritz!Box weiter, sondern zuerst an Pi-hole
(k3s-NodePort auf `192.168.178.94:30053`, siehe `pihole_dns_nodeport` in
`ansible/group_vars/all.yml`). Pi-hole filtert Werbe-/Tracking-Domains heraus
und reicht den Rest an die Fritz!Box weiter.

```
Client → dnsmasq (192.168.178.94:53)
           ├── *.homeserver           → statische IPs (wie gehabt)
           └── alles andere           → Pi-hole (NodePort :30053)
                                            → Fritz!Box (192.168.178.1)
                                            → Internet
```

Das betrifft **nur** Geräte, die dnsmasq bereits als DNS nutzen (siehe die
drei Wege oben) — ohne Router-Änderung. Fällt Pi-hole aus, liefert dnsmasq
schlicht keine Antwort für nicht-`*.homeserver`-Namen mehr (kein Fallback auf
die Fritz!Box), bis der Pod wieder läuft; `*.homeserver` bleibt unberührt.

---

## Was ist mit der "Local DNS server"-Option in der Fritz!Box?

```
Fritz!Box → Heimnetz → Netzwerk → Netzwerkeinstellungen →
"Lokaler DNS-Server"
```

**Lass das Feld leer.** Wenn du dort `192.168.178.94` einträgst,
verteilt die Fritz!Box den Home-Server als einzigen DNS-Server an alle
LAN-Geräte per DHCP — genau das Single-Point-of-Failure-Szenario, das
wir vermeiden wollen.

---

## TL;DR Entscheidungsbaum

```
Brauche ich *.homeserver auf diesem Gerät?
 │
 ├── Nein → nichts tun. Fritz!Box-DNS reicht.
 │
 └── Ja → Hat das Gerät Tailscale?
      │
      ├── Ja → Tailscale Split DNS aktivieren (1× im Tailscale-Admin)
      │
      └── Nein → DNS-Server am Gerät manuell auf
                 192.168.178.94 + 192.168.178.1 setzen
```

---

## Nachtrag 2026-09-06: UFW blockierte Loopback-DNS

Der Home-Server war über HTTPS von außen normal erreichbar, aber
Tailscale zeigte "last seen" mehrere Tage alt, und ein Ansible-Lauf
schlug bei `Download Tailscale GPG signing key` mit
`Temporary failure in name resolution` fehl. Root Cause war **kein**
Netzwerk-/NIC-Problem (siehe
[20020-cluster-power-manager.md → Nachtrag 2026-09-02](../2-betrieb-hardware/20020-cluster-power-manager.md)
für den vorherigen, unabhängigen Vorfall), sondern eine **UFW-Firewall-
Regression**: die aktive nftables-Regelmenge hatte die Standardregel
`-A ufw-before-input -i lo -j ACCEPT` verloren (`/etc/ufw/before.rules`
auf der Platte war unverändert korrekt), obwohl `ufw status` selbst
unauffällig aussah. `/var/log/ufw.log` zeigte live geblockte
`IN=lo SRC=127.0.0.1 DST=127.0.0.1`-Pakete.

Das legt jeglichen Verkehr über Loopback lahm:
- `systemd-resolved`'s DNS-Stub auf `127.0.0.53:53` hing (kein
  Timeout, kein Fehler — einfach kein Response), was jede Anwendung
  betrifft, die über NSS/glibc auflöst (Tailscale, apt, curl, Python/
  Ansible `get_url`).
- Interner k3s-API-Verkehr auf Port 6444 (Loopback) war ebenfalls
  betroffen — `kubectl get nodes` hing aus demselben Grund.
- Eingehender Verkehr über `eno1` (HTTPS, SSH) war NICHT betroffen,
  weil der lief nie über Loopback — daher wirkte der Server von außen
  gesund.

**Ursache:** `/etc/ufw/user.rules` wurde am 2026-09-05 06:00 neu
geschrieben (vermutlich durch einen automatisierten Ansible-Lauf, der
`community.general.ufw`-Regeln aus der `common`- und `dnsmasq`-Rolle neu
angewendet hat). UFW's nftables-Backend hat dabei offenbar mit den
bereits vorhandenen k3s/kube-router-nftables-Tabellen kollidiert und die
eigene Default-Regel `-i lo -j ACCEPT` beim Neuaufbau verloren — ein
bekanntes Zusammenspiel-Problem zwischen UFW (nftables-Backend) und
kube-proxy/kube-router auf demselben Host.

**Sofortiger Fix:** `sudo ufw disable && sudo ufw --force enable` baut
die nftables-Tabellen komplett neu auf und stellt die Loopback-Regel
wieder her.

**Dauerhafte Absicherung:** `ansible/site.yml` prüft in den
`post_tasks` (Tag `always`, läuft also bei jedem Playbook-Aufruf,
unabhängig von `--tags`) per `iptables -C ufw-before-input -i lo -j
ACCEPT`, ob die Regel aktiv ist, und führt bei Bedarf denselben
disable/enable-Zyklus automatisch aus. Das behebt nicht die
Ursache (ein UFW/nftables-Bug im Zusammenspiel mit k3s), heilt aber
zuverlässig jeden Ansible-Lauf danach selbst.

[avm-dns]: https://en.fritz.com/service/knowledge-base/dok/FRITZ-Box-7590/165_Configuring-different-DNS-servers-in-the-FRITZ-Box/
