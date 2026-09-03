# Cluster Power Manager: Worker per Wake-on-LAN dazuschalten

Homeserver (192.168.178.94) läuft dauerhaft. worker-0 und worker-1
(192.168.178.95/.96) sollen dagegen **nur dann laufen, wenn sie
tatsächlich gebraucht werden**: Wird die Last auf dem Homeserver zu
groß, weckt der Homeserver worker-0 per Wake-on-LAN (WoL), bei
anhaltend hoher Last zusätzlich worker-1. Geht die Last wieder zurück,
schaltet der Homeserver die Worker in umgekehrter Reihenfolge wieder ab.

Ergänzt [thermal_watchdog/resource_watchdog](../b-kubernetes-gitops/b0000-k3s.md), die jeden Node
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
| [`wake_on_lan`](../../ansible/roles/wake_on_lan) | worker-0, worker-1 | Aktiviert WoL (`ethtool wol g`) persistent bei jedem Boot |
| [`cluster_power_manager`](../../ansible/roles/cluster_power_manager) | homeserver | Erzeugt den Shutdown-SSH-Key, deployt den Watchdog (`cluster-power-manager.service`) |
| [`cluster_power_manager_target`](../../ansible/roles/cluster_power_manager_target) | worker-0, worker-1 | Autorisiert den Public Key des Homeservers, beschränkt auf `poweroff` |
| [`power_agent`](../../ansible/roles/power_agent) | homeserver | HTTP-Gegenstück für **manuelle** Wake-/Shutdown-Taps aus der iOS-App (siehe [docs/3-apps-workloads/300d0-carplay-api.md](../3-apps-workloads/300d0-carplay-api.md#power-agent)) — nutzt denselben SSH-Key, dieselbe `woke_at`-Buchführung und dieselbe Worker-Liste wie oben weiter, damit sich App-Taps und dieser automatische Last-Watchdog nicht widersprechen. Läuft direkt nach `cluster_power_manager` in `site.yml`. |

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
[`ansible/roles/cluster_power_manager/defaults/main.yml`](../../ansible/roles/cluster_power_manager/defaults/main.yml),
überschreibbar in `ansible/group_vars/all.yml`:

| Variable | Default | Bedeutung |
|---|---|---|
| `cluster_power_manager_cpu_scale_up_threshold` | 60% | CPU-Schwelle zum Hochskalieren |
| `cluster_power_manager_ram_scale_up_threshold` | 60% | RAM-Schwelle zum Hochskalieren |
| `cluster_power_manager_scale_up_sustain_seconds` | 60s | Wie lange sustained hoch, bevor worker-0 geweckt wird |
| `cluster_power_manager_scale_up_sustain_seconds_stage2` | 200s | Zusätzliche Zeit, bevor auch worker-1 geweckt wird |
| `cluster_power_manager_cpu_scale_down_threshold` | 30% | CPU-Schwelle zum Herunterskalieren |
| `cluster_power_manager_ram_scale_down_threshold` | 30% | RAM-Schwelle zum Herunterskalieren |
| `cluster_power_manager_scale_down_sustain_seconds` | 900s | Wie lange sustained niedrig, bevor EIN Worker abgeschaltet wird |
| `cluster_power_manager_min_uptime_seconds` | 300s | Mindest-Laufzeit eines Workers nach dem Wecken, bevor er für Shutdown in Frage kommt |

**Bewusste Asymmetrie:** Die Scale-down-Schwelle (30%) liegt deutlich
unter der Scale-up-Schwelle (60%), und die Sustain-Dauer zum Abschalten
(900s) ist länger als zum Aufwecken (60s/260s). Ohne diese Hysterese und die
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

## Mehrschichtiger RAM-Schutz

Der Homeserver ist aktuell der einzige durchgehend laufende Node, und
mehrere Apps skalieren per HPA hoch (siehe
[b0040-hpa-autoscaling.md](../b-kubernetes-gitops/b0040-hpa-autoscaling.md)) —
wegen `podAffinity` bei RWO-Storage landen neue Replicas dabei zwingend
auf demselben Node wie die bereits laufenden (z. B. Immich, siehe
[300c0-immich.md](../3-apps-workloads/300c0-immich.md)). Skalierung hilft
also gegen viele parallele Anfragen, kann aber im Zweifel selbst den
RAM-Druck auf dem Homeserver erhöhen, statt ihn zu verteilen. Cluster
Power Manager weckt zwar zusätzliche Worker bei hoher Homeserver-Last,
verschiebt aber keine bereits laufenden, affinity-gebundenen Pods dorthin.

Gegen einen daraus resultierenden RAM-Engpass greifen vier Schichten,
von früh/sanft bis spät/hart:

1. **VMRule/Alertmanager-Warnung** (RAM ≥ 70% / CPU ≥ 80%, 2 Minuten,
   [vmrule-resources.yaml](../../argocd/apps/platform/monitoring/templates/vmrule-resources.yaml))
   — nur Gotify-Push, kein Eingriff. Läuft **im** Cluster und kann daher
   selbst betroffen sein, wenn genau der Ressourcendruck, vor dem sie
   warnen soll, den Monitoring-Stack mit ausbremst.
2. **resource_watchdog-Frühwarnung** (RAM ≥ 80% / CPU ≥ 85%, 60s,
   [ansible/roles/resource_watchdog](../../ansible/roles/resource_watchdog)) —
   läuft dependency-frei direkt auf dem Host (kein Prometheus/k8s in der
   Messkette) und schickt eine einmalige ntfy-Warnung, auch wenn Schicht 1
   gerade selbst ausfällt. Ebenfalls kein Eingriff, reine Vorwarnung vor
   dem automatischen Shutdown.
3. **Kubelet-Eviction** (verfügbarer RAM < 15%, `eviction-hard` +
   `system-reserved`/`kube-reserved` in `ansible/group_vars/all.yml` →
   `k3s_kubelet_*`) — der Kubelet evakuiert/killt gezielt einzelne Pods
   (typischerweise den größten Speicherverbraucher), bevor der gesamte
   Node gefährdet ist, und reserviert RAM für OS/kubelet/containerd/sshd/
   tailscaled, damit Pod-Speicherdruck nicht diese Systemdienste trifft.
   Wirkt erst nach `sudo systemctl restart k3s` (bzw. `k3s-agent`) auf dem
   jeweiligen Node.
4. **resource_watchdog-Shutdown** (RAM/CPU ≥ 90%, 300s sustained,
   [ansible/roles/resource_watchdog](../../ansible/roles/resource_watchdog)) —
   letzte Instanz, wenn Schicht 3 die Last nicht mehr abfangen konnte:
   fährt den kompletten Node herunter. Erreichbar dann nur noch über
   physischen Zugriff, NICHT mehr über Tailscale (Poweroff, kein Hang).

Schicht 2 und 3 wurden ergänzt, nachdem ein reiner Shutdown ohne
Vorwarnung (Schicht 1 + 4 allein) dazu führte, dass der Homeserver ohne
erkennbaren Grund "einfach weg" war, obwohl er nur sauber heruntergefahren
hatte.

**Nachtrag 2026-09-02:** Der Vorfall, der diese vier Schichten ausgelöst
hat, stellte sich bei der Log-Analyse als **kein** RAM/CPU-Problem heraus,
sondern als physischer Link-Verlust auf `eno1` (Realtek `r8169`,
`journalctl`: `Lost carrier` / `Link is Down` um 13:29:47, danach keine
Erholung mehr bis zum nächsten harten Reset). `ethtool --show-eee eno1`
zeigte "EEE status: enabled - active" bei 1Gbps — eine bekannte
Schwachstelle mancher Realtek-NICs. Fix:
[`ansible/roles/disable_eee`](../../ansible/roles/disable_eee)
deaktiviert Energy Efficient Ethernet persistent beim Boot (analog zum
`enable-wol.service`-Muster in
[`ansible/roles/wake_on_lan`](../../ansible/roles/wake_on_lan)) — eigene
Rolle statt Teil von `common`, damit auch worker-0/worker-1 (die
`common` nicht durchlaufen) denselben Schutz bekommen, falls sie
dieselbe NIC-Generation verbaut haben. Die vier Schichten oben bleiben
trotzdem sinnvoll — sie schützen vor echtem Ressourcendruck, unabhängig
von dieser konkreten Ursache.

---

## Relevante Links

- [k3s-Referenz (Cluster-Topologie, cordon/drain/uncordon)](../b-kubernetes-gitops/b0000-k3s.md)
- [resource_watchdog / thermal_watchdog](../../ansible/roles/resource_watchdog)
- [HPA-Autoskalierung (podAffinity/RWO-Hintergrund)](../b-kubernetes-gitops/b0040-hpa-autoscaling.md)
- [NAS-Backup](20010-nas-backup.md)
