# 37 — Cluster Power Manager: Worker per Wake-on-LAN dazuschalten

Homeserver (192.168.178.94) läuft dauerhaft. worker-0 und worker-1
(192.168.178.95/.96) sollen dagegen **nur dann laufen, wenn sie
tatsächlich gebraucht werden**: Wird die Last auf dem Homeserver zu
groß, weckt der Homeserver worker-0 per Wake-on-LAN (WoL), bei
anhaltend hoher Last zusätzlich worker-1. Geht die Last wieder zurück,
schaltet der Homeserver die Worker in umgekehrter Reihenfolge wieder ab.

Ergänzt [thermal_watchdog/resource_watchdog](04-k3s.md), die jeden Node
bei **eigener** Übertemperatur/Überlast selbst herunterfahren — dieses
Feature steuert stattdessen die **anderen** Nodes basierend auf der Last
des Homeservers.

---

## Architektur

```
┌─────────────────────── homeserver (Control-Plane, immer an) ───────────────────────┐
│                                                                                       │
│  cluster-power-manager.service                                                      │
│  ├─ pollt lokale CPU/RAM (kein Prometheus/k8s in der Messkette,                      │
│  │  gleiches Prinzip wie resource_watchdog)                                         │
│  │                                                                                   │
│  ├─ Last sustained hoch  ──▶ wakeonlan worker-0-MAC ──▶ warten auf Ready            │
│  │                            (weiter hoch) ──▶ wakeonlan worker-1-MAC              │
│  │                                                                                   │
│  └─ Last sustained niedrig ──▶ kubectl cordon+drain ──▶ ssh poweroff                │
│                                 (zuletzt geweckter Worker zuerst)                    │
└───────────────────────────────────────────────────────────────────────────────────────┘
              │ Magic Packet (UDP, Broadcast)      │ SSH (forced command: nur poweroff)
              ▼                                     ▼
┌─────────────────────┐                   ┌─────────────────────┐
│ worker-0 (.95)       │                   │ worker-1 (.96)       │
│ wake_on_lan-Rolle:   │                   │ wake_on_lan-Rolle:   │
│ ethtool wol g beim   │                   │ ethtool wol g beim   │
│ Boot (NIC muss WoL   │                   │ Boot                 │
│ auch im BIOS an      │                   │                       │
│ haben)               │                   │                       │
└─────────────────────┘                   └─────────────────────┘
```

**Warum kein Prometheus/VictoriaMetrics in der Entscheidung?** Gleicher
Grund wie bei thermal_watchdog/resource_watchdog: Die Skalierungslogik
soll auch funktionieren, wenn der Monitoring-Stack selbst gerade unter
der hohen Last leidet oder auf einem der Worker läuft. Stattdessen liest
das Skript `/proc/stat`/`/proc/meminfo` direkt und prüft die
Worker-Erreichbarkeit per ICMP-Ping.

**Warum ein eigener SSH-Key statt des Semaphore-Keys?** Semaphores Key
läuft aus einem Pod im Cluster heraus und kann beliebige Playbooks
ausführen. Der hier generierte Key liegt auf dem nackten Homeserver-Host
und ist auf den Workern per `authorized_keys`-`command=`-Option **fest
auf `sudo poweroff` beschränkt** — selbst wenn der private Schlüssel
abfließen sollte, kann damit nichts anderes ausgeführt werden.

---

## Beteiligte Rollen

| Rolle | Läuft auf | Zweck |
|---|---|---|
| [`wake_on_lan`](../ansible/roles/wake_on_lan) | worker-0, worker-1 | Aktiviert WoL (`ethtool wol g`) persistent bei jedem Boot |
| [`cluster_power_manager`](../ansible/roles/cluster_power_manager) | homeserver | Erzeugt den Shutdown-SSH-Key, deployt den Watchdog (`cluster-power-manager.service`) |
| [`cluster_power_manager_target`](../ansible/roles/cluster_power_manager_target) | worker-0, worker-1 | Autorisiert den Public Key des Homeservers, beschränkt auf `poweroff` |

Reihenfolge beim erstmaligen Rollout wichtig: `make install` (site.yml,
erzeugt den SSH-Key auf homeserver) **vor** `make worker-0` /
`make worker-1` (lesen den Public Key per `delegate_to` vom Homeserver).

---

## Voraussetzungen

1. **WoL im BIOS/UEFI aktivieren** — auf worker-0 und worker-1 einmalig
   manuell (Bezeichnung je nach Hersteller z.B. "Power On by PCI-E",
   "Wake on LAN", "Resume by PME#"). Ansible kann das nicht setzen, nur
   den OS-seitigen Teil (`ethtool -s <iface> wol g`).
2. **MAC-Adressen eintragen** — auf jedem Worker per
   `ip link show` ermitteln und in
   `ansible/host_vars/worker-0/vars.yml` bzw. `worker-1/vars.yml` den
   Platzhalter `wake_on_lan_mac_address` ersetzen. Ohne echte MAC kann
   `cluster_power_manager` diesen Worker nicht wecken — der Rollout
   warnt darauf hin, bricht aber nicht ab.
3. Homeserver und beide Worker im selben L2-Segment
   (`192.168.178.0/24`) — WoL-Magic-Packets sind UDP-Broadcasts und
   werden von den meisten Routern/Switches nicht zwischen Subnetzen
   weitergeleitet.

---

## Deployment

```bash
make install     # site.yml: k3s-Server + cluster_power_manager (SSH-Key)
make worker-0    # wake_on_lan + cluster_power_manager_target auf worker-0
make worker-1    # wake_on_lan + cluster_power_manager_target auf worker-1
```

Nur den Power-Manager auf dem Homeserver neu deployen (z.B. nach
Schwellwert-Änderung in `group_vars/all.yml`):

```bash
make cluster-power-manager
```

---

## Schwellwerte & Hysterese

Defaults in
[`ansible/roles/cluster_power_manager/defaults/main.yml`](../ansible/roles/cluster_power_manager/defaults/main.yml),
überschreibbar in `ansible/group_vars/all.yml`:

| Variable | Default | Bedeutung |
|---|---|---|
| `cluster_power_manager_cpu_scale_up_threshold` | 80% | CPU-Schwelle zum Hochskalieren |
| `cluster_power_manager_ram_scale_up_threshold` | 80% | RAM-Schwelle zum Hochskalieren |
| `cluster_power_manager_scale_up_sustain_seconds` | 300s | Wie lange sustained hoch, bevor worker-0 geweckt wird |
| `cluster_power_manager_scale_up_sustain_seconds_stage2` | 300s | Zusätzliche Zeit, bevor auch worker-1 geweckt wird |
| `cluster_power_manager_cpu_scale_down_threshold` | 30% | CPU-Schwelle zum Herunterskalieren |
| `cluster_power_manager_ram_scale_down_threshold` | 30% | RAM-Schwelle zum Herunterskalieren |
| `cluster_power_manager_scale_down_sustain_seconds` | 900s | Wie lange sustained niedrig, bevor EIN Worker abgeschaltet wird |
| `cluster_power_manager_min_uptime_seconds` | 900s | Mindest-Laufzeit eines Workers nach dem Wecken, bevor er für Shutdown in Frage kommt |

**Bewusste Asymmetrie:** Die Scale-down-Schwelle (30%) liegt deutlich
unter der Scale-up-Schwelle (80%), und die Sustain-Dauer zum Abschalten
(900s) ist länger als zum Aufwecken (300s). Ohne diese Hysterese und die
Mindest-Laufzeit würde ein Worker direkt nach dem Aufwecken wieder
abgeschaltet werden, sobald die (durch ihn selbst mitverursachte)
Homeserver-Last kurzzeitig sinkt — klassisches Flapping. Pro
Scale-down-Sustain-Periode wird immer nur **ein** Worker abgeschaltet
(zuletzt geweckter zuerst), nicht beide gleichzeitig.

CPU **oder** RAM über Schwelle löst Hochskalieren aus; CPU **und** RAM
müssen für Herunterskalieren beide unter der (niedrigeren) Schwelle
liegen.

---

## Testen ohne echten Shutdown

```bash
# Auf homeserver:
sudo systemctl edit --runtime cluster-power-manager
# In der sich öffnenden Datei:
[Service]
Environment=DRY_RUN=1
# Speichern, dann:
sudo systemctl restart cluster-power-manager
sudo journalctl -u cluster-power-manager -f
```

Mit `DRY_RUN=1` protokolliert und benachrichtigt (ntfy) das Skript jeden
Wake-/Shutdown-Schritt, führt aber weder `wakeonlan` noch
`kubectl cordon/drain` noch den SSH-Poweroff tatsächlich aus. Der
`systemctl edit --runtime`-Drop-in verschwindet beim nächsten Boot
automatisch wieder.

Manueller WoL-Test unabhängig vom Watchdog:

```bash
# Von homeserver oder einem beliebigen Host im selben Subnetz:
wakeonlan <mac-adresse-worker-0>
```

---

## Fehlerbehebung

**Worker wacht nach `wakeonlan` nicht auf:**

- WoL im BIOS/UEFI wirklich aktiviert? (Nach jedem BIOS-Update prüfen —
  manche Boards setzen das beim Update zurück.)
- `ethtool <iface> | grep Wake-on` auf dem Worker prüfen (sollte `g`
  zeigen) — falls nicht, ist `enable-wol.service` nicht gelaufen:
  `sudo systemctl status enable-wol.service`.
- Netzteil-Zustand: manche Mainboards unterstützen WoL nur aus S3
  (Suspend), nicht aus S5 (vollständig ausgeschaltet) — BIOS-Doku des
  jeweiligen Boards prüfen.

**Worker wird nicht automatisch heruntergefahren:**

```bash
# Auf homeserver:
sudo journalctl -u cluster-power-manager -n 100
# Manueller Test des SSH-Pfads (sollte NUR poweroff ausführen können):
sudo ssh -i /etc/cluster-power-manager/id_ed25519 ubuntu@192.168.178.95 whoami
# -> führt trotz "whoami" den forced command (sudo poweroff) aus,
#    das ist beabsichtigt (siehe cluster_power_manager_target)
```

Falls die SSH-Verbindung mit `Permission denied` fehlschlägt: Lief
`make worker-0`/`make worker-1` **nach** `make install`? Der Public Key
muss zuerst auf homeserver existieren, bevor er auf den Workern
autorisiert werden kann.

**Ständiges Auf-/Abschalten (Flapping):**

`cluster_power_manager_scale_down_sustain_seconds` und
`cluster_power_manager_min_uptime_seconds` erhöhen (siehe
[Schwellwerte](#schwellwerte--hysterese)) — deutet meist darauf hin,
dass die Scale-up/down-Schwellen zu dicht beieinander liegen oder die
typische Lastspitze kürzer ist als die konfigurierte Sustain-Dauer.

---

## Relevante Links

- [k3s-Referenz (Cluster-Topologie, cordon/drain/uncordon)](04-k3s.md)
- [resource_watchdog / thermal_watchdog](../ansible/roles/resource_watchdog)
- [NAS-Backup](36-nas-backup.md)
