# 38 — Drucker: Samsung Xpress M2026 per CUPS im Heimnetz freigeben

Der Samsung Xpress M2026 hängt per USB-Kabel direkt am Homeserver
(192.168.178.94). `cups_print_server` installiert CUPS + Treiber-Pakete
und gibt die Warteschlange per **IPP** (Windows/Linux/macOS) und
**AirPrint/IPP-Everywhere via Avahi/mDNS** (iOS, Android, macOS) im
gesamten Heimnetz frei — inklusive Tailnet, dank der bereits bestehenden
Tailscale-Subnet-Route auf `local_subnet` (siehe
[06-tailscale.md](06-tailscale.md#subnet-routing)).

---

## Architektur

```
┌────────────────────── homeserver (192.168.178.94) ──────────────────────┐
│                                                                          │
│  Samsung Xpress M2026 ──USB──▶ cupsd (Port 631)                        │
│                                 ├─ Warteschlange "Samsung_M2026"        │
│                                 ├─ IPP-Sharing (cupsctl --share-printers)│
│                                 └─ Treiber: printer-driver-splix / hplip│
│                                                                          │
│  avahi-daemon ──mDNS/DNS-SD──▶ bewirbt die Warteschlange als            │
│                                 AirPrint/IPP-Everywhere-Ziel            │
└─────────────────────────────┬────────────────────────────────────────────┘
                               │ LAN (UFW: local_subnet bereits erlaubt)
                               │ Tailnet (UFW: 100.64.0.0/10 bereits erlaubt)
               ┌───────────────┼───────────────┬────────────────────┐
               ▼               ▼               ▼                    ▼
        iPhone/iPad      Android          Windows/Linux         Tailscale-Client
        (AirPrint,       (Mopria/         (IPP-URL manuell      (unterwegs, über
        Auto-Discovery)  Auto-Discovery)  hinzufügen)            Subnet-Route)
```

**Warum keine eigenen UFW-Regeln?** Die `common`-Rolle erlaubt bereits
jeglichen Traffic aus `local_subnet` und dem Tailscale-Netz
(`100.64.0.0/10`) — Port 631 (IPP/CUPS-Web-UI) und mDNS (UDP 5353) sind
darüber schon abgedeckt, siehe
[ansible/roles/common/tasks/main.yml](../ansible/roles/common/tasks/main.yml).

**Warum `cupsctl` statt `cupsd.conf` templaten?** `cupsctl` ändert die
laufende Konfiguration live über die vom `cups`-Paket gepflegte Datei,
statt sie per Ansible-Template zu überschreiben — vermeidet Konflikte
mit künftigen CUPS-Paket-Updates und ist idempotent prüfbar (Rolle liest
den aktuellen Stand vorher per `cupsctl` ohne Argumente aus).

---

## Beteiligte Rollen

| Rolle | Läuft auf | Zweck |
|---|---|---|
| [`cups_print_server`](../ansible/roles/cups_print_server) | homeserver | Installiert CUPS + Treiber, aktiviert Sharing, legt die Warteschlange an |

---

## Voraussetzungen

1. Drucker per USB an den Homeserver anschließen und einschalten.
2. `make install` bzw. `make cups-print-server` **einmal ohne** gesetzte
   `cups_print_server_device_uri`/`cups_print_server_ppd` laufen lassen —
   installiert nur Pakete + Sharing und zeigt am Ende per Debug-Ausgabe
   alle erkannten Device-URIs (`lpinfo -v`) sowie zum Samsung/SPL
   passende PPDs (`lpinfo -m`) an.
3. Die passenden Werte aus Schritt 2 in
   `ansible/group_vars/all.yml` eintragen:
   ```yaml
   cups_print_server_device_uri: "usb://Samsung/M2026?serial=..."
   cups_print_server_ppd: "..."   # z.B. eine Zeile aus dem splix-PPD-Dump
   ```
4. `make cups-print-server` erneut laufen lassen — legt jetzt die
   Warteschlange an, aktiviert sie und setzt sie als System-Default.

---

## Deployment

```bash
make install            # site.yml: komplettes Setup inkl. cups_print_server
make cups-print-server  # nur die Rolle neu deployen (z.B. nach PPD-Änderung)
```

---

## Treiber-Hinweise für den M2026

Der M2026 spricht **SPL2** (kein PostScript, kein PCL) — es gibt keinen
Hersteller-Treiber mehr direkt von Samsung, da die Druckersparte 2017 an
HP ging. Zwei Pakete werden installiert, in dieser Prioritätsreihenfolge
prüfen:

1. **`printer-driver-splix`** (Open-Source-SPL-Treiber) — meist der
   direkte Treffer. PPD-Name mit
   `lpinfo -m | grep -i -E 'samsung|spl'` suchen. Community-Berichte
   zeigen, dass der M2026 in der Dropdown-/PPD-Liste nicht immer sofort
   auffindbar ist — ggf. nach `M20`, `SPL2` oder `Xpress` suchen.
2. **`hplip`** (HP hat u. a. Samsung-SPL-Support übernommen) — falls
   splix keine passende PPD liefert, hier ebenfalls mit
   `lpinfo -m | grep -i samsung` prüfen.

**Falls beide nichts Passendes liefern (Fallback-Optionen):**

- **Raw-Queue**: `cups_print_server_ppd: "raw"` — druckt ohne
  Treiber-Rasterung, funktioniert nur zuverlässig für reinen Text, keine
  Formatierung/Grafik.
- **Community-Archiv des alten "Samsung Unified Linux Driver"**
  (`bchemnet.com/suldr`) — nicht offiziell, nicht automatisiert in dieser
  Rolle eingebunden (unklare Signatur/Herkunft der Binärpakete). Nur
  manuell installieren, wenn splix/hplip wirklich nicht funktionieren.
- Alternative: Warteschlange als **raw** teilen und von einem Windows-PC
  mit echtem Samsung-Treiber aus drucken (Windows druckt dann lokal
  gerendert auf die geteilte Rohqueue) — Workaround aus den
  Community-Foren, nur falls alles andere scheitert.

---

## Client-Einrichtung

**iOS / Android / macOS (empfohlen, kein manuelles Setup):**
Drucken-Dialog öffnen → "Samsung_M2026" erscheint automatisch per
AirPrint (iOS/macOS) bzw. Mopria/Default Print Service (Android) —
funktioniert nur, wenn das Gerät im selben LAN/WLAN oder per
Tailscale-Subnet-Route verbunden ist.

**Windows:**
Drucker hinzufügen → "Der gewünschte Drucker ist nicht aufgeführt" →
URL eintragen:
```
http://homeserver:631/printers/Samsung_M2026
```
(Fallback ohne Split-DNS: `http://192.168.178.94:631/printers/Samsung_M2026`)

**Linux (CUPS-Client):**
```bash
lpadmin -p Samsung_M2026 -E -v ipp://homeserver:631/printers/Samsung_M2026 -m everywhere
```

**CUPS-Web-UI** (Warteschlangen-Status, Jobs, manuelle Konfiguration):
```
http://homeserver:631
```

---

## Testen

```bash
# Auf dem Homeserver: Status aller Warteschlangen
lpstat -t

# Testdruck von einer beliebigen Maschine mit installiertem CUPS-Client
lp -h homeserver:631 -d Samsung_M2026 /etc/hostname
```

---

## Fehlerbehebung

**Drucker taucht nicht in `lpinfo -v` auf:**
USB-Kabel/Steckplatz prüfen, `lsusb` auf dem Homeserver (Paket
`usbutils` wird von der Rolle installiert) — der M2026 sollte als
Samsung-Gerät gelistet sein. Danach `sudo systemctl restart cups` und
`lpinfo -v` erneut prüfen.

**Warteschlange angelegt, aber Druckjob bleibt hängen ("processing"):**
```bash
sudo journalctl -u cups -n 100
lpstat -p Samsung_M2026 -l
```
Meist ein Treiber-/PPD-Mismatch — anderen PPD-Treffer aus
`lpinfo -m | grep -i samsung` probieren (siehe
[Treiber-Hinweise](#treiber-hinweise-für-den-m2026)).

**Kein AirPrint-Eintrag auf iPhone/Android sichtbar:**
```bash
sudo systemctl status avahi-daemon
avahi-browse -a | grep -i samsung
```
Prüfen, ob `cups_print_server_share_printers` auf `true` steht und die
Warteschlange per `-o printer-is-shared=true` freigegeben wurde
(`lpstat -p Samsung_M2026 -l` zeigt "Sharing: Yes/No" nicht direkt an —
stattdessen `lpoptions -p Samsung_M2026 | grep shared` bzw. erneut
`make cups-print-server` laufen lassen).

**Drucken funktioniert im LAN, aber nicht über Tailscale unterwegs:**
Subnet-Route (`local_subnet`) im
[Tailscale-Admin-Panel](https://login.tailscale.com/admin/machines)
approved? Siehe [06-tailscale.md](06-tailscale.md#subnet-routing).

---

## Relevante Links

- [Tailscale-Referenz (Subnet-Routing)](06-tailscale.md)
- [ansible/roles/cups_print_server](../ansible/roles/cups_print_server)
