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
│  (meldet sich als USB-Device    ├─ Warteschlange "Samsung_M2026"        │
│   "M2020 Series")                ├─ IPP-Sharing (cupsctl --share-printers)│
│                                   └─ Treiber: selbst gebauter QPDL-Filter│
│                                      (siehe "Warum QPDL" unten)         │
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
   `cups_print_server_ppd` laufen lassen — installiert Pakete + Sharing,
   baut (falls `cups_print_server_build_qpdl_driver: true`) den
   QPDL-Treiber, und zeigt am Ende per Debug-Ausgabe alle erkannten
   Device-URIs (`lpinfo -v`) sowie zum Samsung/SPL passende PPDs
   (`lpinfo -m`) an.
3. Den passenden PPD-Wert aus Schritt 2 in
   `ansible/group_vars/all.yml` eintragen (Device-URI ist für den M2026
   bereits eingetragen):
   ```yaml
   cups_print_server_ppd: "samsung/m2020.ppd"   # bestätigter Treffer für den M2026
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

Der M2026 meldet sich per USB als generische **"M2020 Series"** — viele
günstige Samsung-SPL2-Modelle (M2020/M2021/M2022/M2026) teilen sich
denselben USB-Controller-Chip und damit dieselbe USB-Produktkennung.

**Weder `printer-driver-splix` noch `hplip` unterstützen dieses Modell:**

- `lpinfo -m | grep -i samsung` im `printer-driver-splix`-Katalog zeigt
  nur ältere Modelle (ML-/CLP-/CLX-/SCX-Serien bis ca. 2013) — die
  M2020-Serie fehlt komplett.
- `sudo hp-setup -i` erkennt das USB-Gerät nicht mal als unterstütztes
  HPLIP-Modell ("No device selected/specified or that supports this
  functionality").
- Grund: Die M2020-Serie spricht ein neueres Protokoll namens **QPDL**
  (nicht das ältere SPL2/SPLc, das splix abdeckt). Das ist der eigentliche
  Grund, warum dieses sehr verbreitete Billig-Modell unter Linux
  notorisch schwer einzurichten ist.

**Lösung: selbst gebauter QPDL-Filter (opt-in, standardmäßig aktiviert
für dieses Deployment über `cups_print_server_build_qpdl_driver: true`
in `group_vars/all.yml`).**

Es gibt einen QPDL-Treiber-Patch für splix, der nie ins offizielle
[OpenPrinting/splix](https://github.com/OpenPrinting/splix)-Repo gemergt
wurde (letzter offizieller Release: 2.0.2, das ist auch, was Ubuntu
paketiert hat). Der Patch liegt auf
[gitlab.com/ScumCoder/splix](https://gitlab.com/ScumCoder/splix)
(Branch `patches`) und wird von der Rolle auf einen **festen Commit
gepinnt** gebaut:
`f97086c367d926dc4b6f84facabc9c3029729cba` ("Fix m2020 being excluded
from built artifacts").

### Warum dieser Fremdcode vertrauenswürdig genug ist

Bevor das in die Rolle eingebaut wurde, wurde der tatsächliche
Filter-Quellcode geprüft (nicht nur die PPD-Textdatei):

- Gleicher GPLv2-Lizenzkopf und Autoren-Handschrift ("Aurélien Croc
  (AP²C)") wie im offiziellen splix — es ist strukturell dieselbe
  Codebasis, nur um eine zusätzliche Protokoll-Variante (`qpdl.cpp`,
  `rastertoqpdl.cpp`, analog zu den offiziellen `spl2.cpp`/`splc.cpp`)
  erweitert.
- Keine Netzwerk-Calls, kein `curl`/`wget`, keine Obfuskation. Die
  einzigen `fork()`/`exec()`-Aufrufe (`pstoqpdl.cpp`) sind normales
  CUPS-Filter-Chaining (PostScript → Raster → QPDL-Pipeline), exakt wie
  es jeder andere CUPS-Treiber auch macht.
- Der gepinnte Commit stammt von einem erkennbaren Maintainer
  (`scumcoder@yandex.ru`) und behebt exakt dieses eine bekannte Problem
  ("m2020 excluded from built artifacts") — kein Bulk-Import
  unbekannten Codes.
- CUPS-Filter laufen ohnehin **nicht als root** — `cupsd` startet sie
  standardmäßig als unprivilegierter `lp`-User.
- Der Commit ist bewusst gepinnt (nicht der Branch-`HEAD`), damit ein
  späterer Push auf den Branch nicht unbemerkt anderen Code einschleust.

Trotzdem bleibt es **inoffizieller, nie überprüfter Community-Code** —
wer das nicht auf dem eigenen Homeserver haben möchte, setzt
`cups_print_server_build_qpdl_driver: false` und nutzt stattdessen einen
der Fallbacks unten.

**Nach dem Build** zeigt `lpinfo -m | grep -i -E 'samsung|spl'` einen
neuen Treffer `samsung/m2020.ppd Samsung M2020 Series` (statische PPD,
kein `drv://`-Bundle-Eintrag) — dieser String kommt in
`cups_print_server_ppd` (bereits für den M2026 eingetragen:
`samsung/m2020.ppd`).

**Falls der QPDL-Build nicht gewünscht ist (Fallback-Optionen):**

- **Raw-Queue**: `cups_print_server_ppd: "raw"` — druckt ohne
  Treiber-Rasterung, funktioniert nur zuverlässig für reinen Text, keine
  Formatierung/Grafik.
- **Original-Samsung-Treiber (ULD-Tarball)**: taucht nur noch auf
  Drittanbieter-Treiberseiten auf (driverguide.com, printerdrivers.com)
  — bewusst **nicht empfohlen**, solche Seiten sind für
  Adware/fragwürdige Downloads bekannt.
- Alternative: Warteschlange als **raw** teilen und von einem Windows-PC
  mit echtem Samsung-Treiber aus drucken (Windows rendert dann lokal und
  schickt fertige Rohdaten an die geteilte Rohqueue) — Workaround aus
  den Community-Foren, nur falls alles andere scheitert.

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

**QPDL-Build schlägt fehl (`make` / `make install` Fehler):**
Build-Log direkt auf dem Homeserver reproduzieren:
```bash
cd /usr/local/src/splix-qpdl/splix
make DISABLE_JBIG=1
```
Meist fehlende Build-Abhängigkeiten (die Rolle installiert
`build-essential`, `libcups2-dev`, `pkg-config` — bei CUPS-Versionen, bei
denen `libcupsimage` nicht mehr in `libcups2-dev` enthalten ist, zusätzlich
`libcupsimage2-dev` installieren und erneut versuchen). Nach einem Fix
`make cups-print-server` erneut laufen lassen — der `creates:`-Guard in
der Rolle baut nur neu, wenn `optimized/rastertoqpdl` noch fehlt (ggf.
manuell `rm -rf /usr/local/src/splix-qpdl` für einen sauberen Rebuild).

**Job wird angenommen, Drucker bleibt aber stumm (kein Papierauswurf):**
```bash
sudo grep -i "error\|SpliX" /var/log/cups/error_log | tail -n 40
```
Bekannter Fall: `"SpliX Cannot get paper size information. Operation
aborted."` — der QPDL-Filter (`Printer::loadInformation()` in
`printer.cpp`) verlangt eine **explizit im Job aufgelöste**
PageSize/Media-Option. Der PPD-eigene `*DefaultPageSize` allein reicht
unter dem modernen cups-filters-2.x-Kompatibilitäts-Layer
(`ppdFilterEmitJCL`, sichtbar im Log) nicht aus — ohne explizite Option
liefert der Filter leere/keine Seiten.

Behoben durch `cups_print_server_media_size` (Default `A4`), das die
Rolle als Queue-Default per `lpadmin -o PageSize=...` setzt. **Wichtig:**
bewusst `PageSize` (der literale PPD-Options-Name), nicht `media` — mit
`lpadmin -o media=...` reproduzierbar getestet, dass der Wert beim
Anlegen der Warteschlange NICHT in der PPD markiert wird (der
IPP-Alias `media` → `PageSize` wird nur bei der Job-Verarbeitung von
`lp`/`lpr` aufgelöst, nicht von `lpadmin`); `lp -o media=A4 ...` als
expliziter Job-Parameter funktioniert dagegen sofort. Betrifft nur
Warteschlangen, die vor diesem Fix angelegt wurden — `make
cups-print-server` erneut laufen lassen, um den Queue-Default
nachzuziehen. Manueller Workaround pro Job, falls weiterhin nötig:
`lp -o media=A4 ...` (oder `-o PageSize=A4`).

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
- [OpenPrinting/splix (offizielles Upstream-Repo)](https://github.com/OpenPrinting/splix)
- [gitlab.com/ScumCoder/splix, Branch `patches` (QPDL-Treiber-Quelle)](https://gitlab.com/ScumCoder/splix/-/tree/patches)
