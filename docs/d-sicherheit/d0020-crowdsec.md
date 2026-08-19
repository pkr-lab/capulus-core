# CrowdSec — Brute-Force-Schutz für SSH und Traefik

[CrowdSec](https://www.crowdsec.net/) beobachtet Logs auf verdächtige Muster
(wiederholte Fehlversuche, Scans, bekannte Angreifer-IPs aus der
Community-Blockliste) und lässt einen **Bouncer** die auffälligen IPs per
Firewall-Regel sperren. Vorher gab es auf dem Home-Server keinerlei Schutz
gegen automatisierte Brute-Force-Versuche — weder gegen SSH noch gegen die
über den Cloudflare Tunnel direkt (an Traefik vorbei oder über Traefik)
erreichbaren Web-Apps.

---

## Architektur

```
sshd (journald) ──┐
                   ├──▶ crowdsec (Agent + lokale API, Port 8080 nur localhost)
Traefik-Logs ──────┘         │
                              │ Entscheidung: IP sperren?
                              ▼
                  crowdsec-firewall-bouncer
                              │
                              ▼
                  iptables-Regel (eigene Chain, koexistiert mit UFW)
```

- **Agent + Local API (LAPI):** läuft als `crowdsec`-Systemdienst, wertet
  die konfigurierten Log-Quellen gegen installierte „Collections" (Regelsätze
  vom CrowdSec Hub) aus.
- **Bouncer:** `crowdsec-firewall-bouncer` (iptables-Variante, weil UFW auf
  Ubuntu ebenfalls iptables als Backend nutzt) fragt die LAPI nach aktiven
  Sperren und trägt sie in eine eigene iptables-Chain ein — unabhängig von
  den bestehenden UFW-Regeln, kein Konflikt.
- **Whitelist:** LAN (`local_subnet`) und Tailscale (`100.64.0.0/10`) sind
  explizit von Sperren ausgenommen, damit sich niemand aus dem eigenen
  Netz aussperrt (siehe `ansible/roles/crowdsec/templates/whitelist.yaml.j2`).

Rolle: `ansible/roles/crowdsec/`, eingebunden in `ansible/site.yml` direkt
nach der `common`-Rolle (die UFW aktiviert).

---

## Installation

```bash
make crowdsec
# oder Teil von:
make install
```

Was die Rolle macht:

1. Installiert das offizielle CrowdSec-APT-Repository (per
   `install.crowdsec.net`-Skript — analog zur Tailscale-Client-Installation
   in [docs/c-netzwerk-dns/c0010-tailscale.md](../c-netzwerk-dns/c0010-tailscale.md), weil das die vom Hersteller
   gepflegte Methode ist, das richtige Repo für die laufende Distribution zu
   finden, statt einen Codename hart zu verdrahten).
2. Installiert und startet `crowdsec` (Agent + lokale API).
3. Installiert **danach** `crowdsec-firewall-bouncer-iptables` — die
   Reihenfolge ist wichtig, weil sich der Bouncer beim Installieren
   automatisch bei der bereits laufenden lokalen API registriert.
4. Installiert die Collections `crowdsecurity/sshd`, `crowdsecurity/linux`,
   `crowdsecurity/traefik`.
5. Trägt Log-Quellen ein: SSH über `journalctl` (Unit `ssh.service`),
   Traefik über eine Datei-Glob (siehe nächster Abschnitt).
6. Trägt die LAN-/Tailscale-Whitelist ein.

---

## Traefik-Log verifizieren

**Das ist der einzige Teil, der nach dem ersten Rollout manuell geprüft
werden muss.** Traefik läuft als Pod im k3s-Cluster, CrowdSec läuft auf dem
Host — die Rolle geht davon aus, dass containerd (k3s' Container-Runtime)
die Pod-Logs unter einem Pfad ablegt, der auf
`/var/log/containers/*traefik*.log` passt (`crowdsec_traefik_log_glob` in
`ansible/roles/crowdsec/defaults/main.yml`). Der genaue Pfad hängt von der
k3s-/containerd-Version ab.

**Prüfen:**

```bash
# Zeigt den tatsächlichen Pfad zum Traefik-Container-Log
ls -la /var/log/containers/ | grep -i traefik

# CrowdSec-Metriken — "traefik"-Zeile sollte "Lines read" > 0 zeigen
sudo cscli metrics
```

Falls die Glob nichts trifft: den tatsächlichen Pfad ermitteln und
`crowdsec_traefik_log_glob` in `ansible/group_vars/all.yml` überschreiben,
dann `make crowdsec` erneut laufen lassen.

---

## Betrieb

**Aktive Sperren ansehen:**

```bash
sudo cscli decisions list
```

**Eine IP manuell sperren/entsperren:**

```bash
sudo cscli decisions add --ip 203.0.113.5 --duration 4h --reason "manual test"
sudo cscli decisions delete --ip 203.0.113.5
```

**Metriken (welche Collection wie oft ausgelöst hat):**

```bash
sudo cscli metrics
```

**Bouncer-Status:**

```bash
sudo cscli bouncers list
```

**Alerts als Verlauf:**

```bash
sudo cscli alerts list
```

---

## Troubleshooting

| Symptom | Hinweis |
|---|---|
| `cscli bouncers list` zeigt keinen Bouncer | `crowdsec-firewall-bouncer-iptables` wurde evtl. installiert, bevor `crowdsec` lief — Rolle erneut laufen lassen (`make crowdsec`), Reihenfolge in `tasks/main.yml` prüfen |
| SSH-Login aus dem eigenen LAN/Tailnet wird geblockt | Whitelist prüfen: `cat /etc/crowdsec/parsers/s02-enrich/local-whitelist.yaml` — `local_subnet` in `ansible/group_vars/all.yml` muss zum tatsächlichen LAN passen |
| Traefik-Collection löst nie aus | Siehe [Traefik-Log verifizieren](#traefik-log-verifizieren) oben |
| Nach `journalctl_filter`-Änderung keine SSH-Events mehr | `sudo systemctl restart crowdsec`, dann `sudo cscli metrics` erneut prüfen |
| Versehentlich die eigene IP gesperrt | `sudo cscli decisions delete --ip <eigene-ip>` — danach ggf. die Whitelist ergänzen, damit es nicht wieder passiert |

---

## Warum iptables-Bouncer statt nftables

UFW verwaltet auf Ubuntu standardmäßig iptables (nicht nftables direkt) —
`crowdsec-firewall-bouncer-iptables` fügt seine eigene Chain über `iptables`
ein und arbeitet damit im selben Backend wie UFW, ohne dass beide sich in
die Quere kommen. Ein Wechsel auf die nftables-Variante wäre nur sinnvoll,
falls UFW irgendwann durch eine reine nftables-Firewall ersetzt wird.
