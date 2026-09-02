# Windows-PC am Standort vereinsheim-alarmmonitor: Online-Check & Herunterfahren

Ergänzung zu
[docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md, "Wake-on-LAN für den Windows-PC"](30020-vereinsheim-alarmmonitor.md#wake-on-lan-für-den-windows-pc):
Aufwecken ist dort beschrieben und umgesetzt. Dieses Dokument deckt die
beiden fehlenden Richtungen ab — prüfen, ob der PC gerade läuft, und ihn
wieder herunterfahren.

## Inhaltsverzeichnis

1. [Online-Status prüfen](#online-status-prüfen)
2. [Herunterfahren — offen, manuell](#herunterfahren--offen-manuell)

---

## Online-Status prüfen

Für den PC ist keine feste IP im Repo hinterlegt (nur die MAC, siehe
`ansible/host_vars/vereinsheim-alarmmonitor/vars.yml`,
`banana_pi_kiosk_wol_devices.windows-pc`). Der Online-Check läuft daher
über den ARP-Cache des Pi statt über eine direkte Ping-Adresse — Pi und PC
hängen im selben Subnetz (Voraussetzung für WoL ohnehin, siehe
30020-Dokument).

Ein Broadcast-Ping ins Standort-LAN füllt den ARP-Cache, danach reicht ein
Grep auf die bekannte MAC:

```bash
ssh pela@vereinsheim-alarmmonitor \
  "ping -b -c 3 -W 1 192.168.1.255 >/dev/null 2>&1; ip neigh | grep -i e4:54:e8:5f:23:85"
```

**Auswertung:**

- **Kein Output** → PC nicht im ARP-Cache = aus/nicht erreichbar.
- **Zeile mit IP + `REACHABLE`/`STALE`** → PC ist online, die aktuelle IP
  steht direkt daneben.

`192.168.1.255` ist die Broadcast-Adresse des Standort-Subnetzes
(`192.168.1.0/24`, per `ip -4 addr show` auf dem Pi ermittelt) — bei einem
Wechsel des Subnetzes (z. B. Router-Tausch) muss dieser Wert angepasst
werden.

## Herunterfahren — offen, manuell

Bisher **nicht eingerichtet** — es gibt nur den Weg zum Aufwecken, keinen
zurück. Geplanter Ablauf, analog zum SSH-only-Prinzip, das der Pi selbst
schon für Screenshot und WoL nutzt (kein neuer Bearer-Token-Agent nötig,
da der PC direkt per SSH erreichbar wäre):

1. **Einmalig auf dem Windows-PC:** OpenSSH-Server aktivieren
   (`Einstellungen → Apps → Optionale Features → OpenSSH-Server`, oder
   `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0` in
   einer Admin-PowerShell), danach
   `Start-Service sshd; Set-Service -Name sshd -StartupType Automatic`.
2. **Von einer Tailnet-Maschine** (der Pi selbst reicht auch, gleiches
   Subnetz):
   ```bash
   ssh <windows-user>@<pc-ip> "shutdown /s /t 0"
   ```

**Bewusst nicht gewählt:** `net rpc shutdown` (Samba/RPC) — würde
Windows-Admin-Zugangsdaten auf dem Pi/in Vaultwarden erfordern und ist
fehleranfälliger (Firewall-/RPC-Freigaben nötig) als ein
Schlüssel-basierter SSH-Zugang, der zum sonstigen Muster in diesem Repo
passt.

**Offene Punkte, bevor das nutzbar ist:**

- `<pc-ip>` ist aktuell nicht fix (DHCP) — entweder vor jedem
  Shutdown-Versuch per [Online-Status prüfen](#online-status-prüfen)
  neu ermitteln, oder eine DHCP-Reservierung im Router für die MAC
  `E4:54:E8:5F:23:85` einrichten (feste IP, spart den Zwischenschritt).
- OpenSSH-Server auf dem PC muss noch aktiviert werden (Schritt 1 oben) —
  ohne das schlägt der SSH-Befehl mit Verbindungsfehler fehl.
- SSH-Host-Key-Prüfung: beim ersten Verbindungsaufbau fragt SSH nach
  Bestätigung des Fingerprints — falls das Kommando später automatisiert
  laufen soll (z. B. als eigenes `banana-pi-*.sh`-Skript analog zu WoL),
  vorher einmalig manuell verbinden oder `known_hosts` vorab befüllen.

## Relevante Links

- [docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md](30020-vereinsheim-alarmmonitor.md) — Basis-Dokument, WoL-Aufwecken, MAC-Adressen-Tabelle
- [docs/4-planung/40020-vereinsheim-wol-router-vpn.md](../4-planung/40020-vereinsheim-wol-router-vpn.md) — Architektur-Hintergrund WoL + Router-VPN-Fallback
