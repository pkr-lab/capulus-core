# Wake-on-LAN am Standort vereinsheim-alarmmonitor (+ Router-VPN-Fallback)

Architektur-Plan für Wake-on-LAN an einem externen Standort, siehe
[docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md](../3-apps-workloads/30020-vereinsheim-alarmmonitor.md).
**Umgesetzt**: Ansible-Teil (Abschnitt 1) und iOS-App-Anbindung
(Abschnitt 3). Der Router-VPN-Fallback (Abschnitt 2) bleibt ein
manueller, noch offener Schritt (Router-Zugriff vor Ort erforderlich).

---

## Kontext

`vereinsheim-alarmmonitor` (Banana Pi) sitzt an einem externen Standort
hinter einem Repeater, der über einen TP-Link-Router (Stock-Firmware) ans
Internet angebunden ist. Der Pi ist seit Phase 2 **Tailscale-only**
erreichbar — Semaphore/n8n (laufen als Pods im Cluster) haben **keinen**
Netzwerkpfad zu Tailscale-Peers, Zugriff geht nur von einer im Tailnet
angemeldeten Maschine aus.

Auslöser: Ein Windows-PC hängt per LAN am selben Router und soll per
Wake-on-LAN aus der Ferne aufweckbar sein. Zusätzlich soll es einen Weg
geben, auch den Pi selbst zu erreichen bzw. Geräte am Standort zu wecken,
falls der Pi mal aus/abgestürzt ist — dafür bietet der TP-Link-Router
(bestätigt: OpenVPN-Server im Web-UI vorhanden) sich als einzige
garantiert dauerhaft laufende Komponente am Standort an.

Ergebnis: zwei unabhängige, sich ergänzende Pfade, ohne neue Hardware:

1. **Normalfall (Pi läuft):** Pi selbst verschickt das Magic Packet lokal
   ins Standort-LAN, ausgelöst per SSH von jeder Tailnet-Maschine —
   identisches Muster zum bereits bestehenden On-Demand-Screenshot-Skript.
2. **Fallback (Pi nicht erreichbar):** Einmalig eingerichteter
   OpenVPN-Server auf dem Router bringt eine beliebige Maschine direkt ins
   Standort-LAN, von wo aus man selbst `wakeonlan` gegen Pi oder PC
   ausführt — unabhängig davon, ob der Pi überhaupt an ist.

Bewusst **kein** dauerhaftes Router-Management (kein SSH/API/
Reverse-Engineering) — der Router bleibt wie die FritzBox im
Homeserver-Netz ansonsten unangetastet, nur die einmalige
VPN-Server-Einrichtung im Web-UI ist nötig.

## 1. WoL-Relay-Skript (Erweiterung `banana_pi_kiosk`-Rolle) — umgesetzt

Kein neuer Ansible-Role nötig — das Muster existiert schon 1:1 für das
On-Demand-Screenshot-Skript
(`ansible/roles/banana_pi_kiosk/templates/banana-pi-screenshot.sh.j2`).
Das WoL-Skript ergänzt dasselbe Muster:

- `ansible/roles/banana_pi_kiosk/defaults/main.yml` — neue Defaults
  `banana_pi_kiosk_wol_enabled` (Kill-switch) und
  `banana_pi_kiosk_wol_devices` (Alias → MAC, leer per Default).
- `ansible/host_vars/vereinsheim-alarmmonitor/vars.yml` — setzt
  `banana_pi_kiosk_wol_devices.windows-pc` (MAC noch als `CHANGE-ME`
  Platzhalter, muss vor dem ersten produktiven Lauf durch die echte
  MAC-Adresse der PC-LAN-NIC ersetzt werden).
- `ansible/roles/banana_pi_kiosk/templates/banana-pi-wol.sh.j2` — neues
  Skript, Alias als `$1`, MAC-Lookup über eine aus
  `banana_pi_kiosk_wol_devices` gerenderte Bash-Map, ruft `wakeonlan`.
- `ansible/roles/banana_pi_kiosk/tasks/main.yml` — zwei neue Tasks
  (Paket `wakeonlan` installieren, Skript nach
  `/usr/local/bin/banana-pi-wol.sh` deployen), `when:
  banana_pi_kiosk_enabled | bool and banana_pi_kiosk_wol_enabled | bool`.

**Nutzung:** `ssh pela@vereinsheim-alarmmonitor banana-pi-wol.sh windows-pc`
von jeder Tailnet-Maschine.

**Vorab einmalig zu prüfen (nicht automatisierbar):**
- BIOS/UEFI + NIC-Einstellungen des PCs (Wake on Magic Packet aktivieren,
  Windows-Schnellstart deaktivieren — sonst geht der PC beim
  "Herunterfahren" nicht wirklich aus, WoL scheitert zuverlässig).
- Pi und PC im selben Subnetz (`ip a` auf dem Pi vs. IP des PCs
  vergleichen) und keine Client-/AP-Isolation im Router-WebUI aktiv.

## 2. Router-OpenVPN als Fallback — offen, manuell

Stock-Firmware ohne SSH/API — bleibt manuell im Router-Web-UI:

1. Advanced → VPN Server → OpenVPN aktivieren, Client-`.ovpn`-Profil
   exportieren.
2. Advanced → Network → Dynamic DNS einrichten (TP-Link-eigene kostenlose
   DDNS reicht) — WAN-Adresse ist vermutlich dynamisch.
3. Erreichbarkeit des OpenVPN-Ports (Standard UDP 1194) von außen testen
   (z. B. per Mobilfunknetz).
4. `.ovpn`-Profil in einen OpenVPN-Client importieren (OpenVPN Connect
   App / NetworkManager-Plugin) auf der/den Maschine(n), die den Fallback
   nutzen sollen.
5. **`.ovpn`-Datei in Vaultwarden ablegen** (enthält
   Client-Zertifikat/Key) — niemals ins Repo committen.
6. `wakeonlan`/`etherwake` lokal auf der Fallback-Maschine installieren —
   nach VPN-Verbindung wird der Magic Packet direkt von dort verschickt,
   kein Relay nötig.
7. MAC-Adresse des Pi selbst einmalig notieren (`ip link show` auf dem
   Pi, während er läuft) und neben den anderen MACs dokumentieren — wird
   nur für diesen Fallback-Pfad gebraucht.

**Sicherheitshinweis:** OpenVPN (zertifikatsbasiert) ist für
WAN-Exposition unkritisch; die Router-Web-Admin-UI bleibt weiterhin NICHT
von außen erreichbar — nur der VPN-Port wird freigegeben, kein PPTP/L2TP.

**Zur Einordnung "Open Source":** Der OpenVPN-Server im TP-Link-Web-UI
ist der echte, quelloffene OpenVPN-Daemon (nur die Bedienoberfläche ist
proprietär) — kein zusätzliches Open-Source-Tooling nötig, um den Tunnel
selbst quelloffen zu halten.

**Bewusst NICHT Teil dieses Plans (erwogen, aber verworfen):**
- `tplinkrouterc6u` (Open-Source-Python-Client für Reboot/Status/
  Client-Liste via lokaler Admin-API) — für später denkbar, falls
  Skripting über den Web-UI-Klick hinaus gewünscht ist.
- Umflashen des Routers auf OpenWrt (volle Open-Source-Firmware, echtes
  Ansible-Onboarding) — größerer Schritt, Risiko für die
  TP-Link-OneMesh-Kopplung mit dem Repeater, würde vorab eine
  Modellprüfung gegen die OpenWrt-Hardwareliste brauchen.

## 3. iOS-App-Anbindung — umgesetzt

Die "Homeserver Dashboard"-App (`ios/HomeserverDashboard/`) hat im Tab
"Steuerung" bereits Wake-on-LAN für worker-0/worker-1, proxied über
`carplay-api` (Cluster-Pod) → `power-agent` (Homeserver-Host). Dieses
Muster funktioniert für `vereinsheim-alarmmonitor` NICHT — `carplay-api`
läuft als normaler Cluster-Pod ohne Route zu Tailscale-Peers, exakt die
gleiche Einschränkung wie oben für Semaphore/n8n beschrieben.

Lösung: Ein neuer, kleiner HTTP-Agent (`banana-pi-wol-agent`, Teil der
`banana_pi_kiosk`-Rolle, `ansible/roles/banana_pi_kiosk/files/banana-pi-wol-agent.py`)
läuft direkt auf dem Pi und wird von der App **direkt** über dessen
Tailscale-IP angesprochen (`100.123.214.4:9102`) — `carplay-api` bleibt
für diesen einen Fall komplett außen vor. Der Agent kennt selbst keine
MAC-Adressen, sondern ruft nur das bereits bestehende
`banana-pi-wol.sh <alias>` auf.

**Bewusster Kompromiss:** Das bisherige Prinzip "kein dauerhaft offener
Port" auf diesem Pi (siehe Screenshot-Skript, SSH-only) weicht hier
für den Agenten auf — abgesichert stattdessen per Bearer-Token, exakt das
Modell, das `power-agent` auf dem Homeserver schon vorlebt. Eine
SSH-Client-Library direkt in der App (kein neuer offener Port) wurde
erwogen und verworfen: mehr Implementierungsaufwand, neue
Drittanbieter-Abhängigkeit, kein spürbarer Sicherheitsgewinn gegenüber
einem Token-gesicherten Agenten.

Betroffene Dateien (iOS): `Models/RemoteWolTarget.swift`,
`Services/RemoteWolAgentClient.swift` (neu), `Utilities/Constants.swift`,
`Services/KeychainService.swift`, `ViewModels/PowerViewModel.swift`,
`Views/PowerView.swift`, `Views/SettingsView.swift` (erweitert). Details
siehe [docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md, "iOS-App"](../3-apps-workloads/30020-vereinsheim-alarmmonitor.md#ios-app).

Kein `project.yml`/ATS-Eintrag nötig für die neue Base-URL: App Transport
Security gilt laut Apple-Doku ausschließlich für Domainnamen, nicht für
nackte IP-Adressen — anders als bei `*.homeserver` ist hier also keine
`NSExceptionDomains`-Ergänzung erforderlich.

## Verification

- Pi läuft: von einer Tailnet-Maschine
  `ssh pela@vereinsheim-alarmmonitor banana-pi-wol.sh windows-pc`
  ausführen, PC-Start bestätigen.
- Fallback simulieren (sobald Abschnitt 2 umgesetzt ist):
  OpenVPN-Verbindung zum Router aufbauen, lokal `wakeonlan <pc-mac>`
  ausführen, PC-Start bestätigen — unabhängig vom Pi-Status.
- Vor dem echten Rollout: `make banana-pi-kiosks-check` (Dry-Run), um
  sicherzustellen, dass die Erweiterung der bestehenden Rolle keine
  unerwarteten Diffs erzeugt.

## Relevante Links

- [docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md](../3-apps-workloads/30020-vereinsheim-alarmmonitor.md) — Basis-Architektur des Standorts
- [docs/c-netzwerk-dns/c0010-tailscale.md](../c-netzwerk-dns/c0010-tailscale.md) — Tailscale-Grundlagen
