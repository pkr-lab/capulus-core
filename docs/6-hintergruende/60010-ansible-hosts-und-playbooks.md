# Ansible: Hosts, VMs und Playbooks — Hintergründe

Begründungen zu `ansible/host_vars/`, `ansible/group_vars/`, `ansible/inventory/`, den Playbooks in `ansible/`
und zur Rolle `libvirt_host`. Was läuft und wie man es bedient, steht in
[a0030](../a-betriebssystem/a0030-installation.md) und [40080](../4-planung/40080-multi-cluster-entw-prod-tech.md);
zum Vorfall mit dem Basis-Image siehe [50010](../5-incidents/50010-prod-vm-basis-image-ersetzt.md).
Übersicht dieser Kategorie: [60000](60000-uebersicht.md).

---

## ENTW-Cluster (`entw-vm`)

| Entscheidung | Begründung |
|---|---|
| Eigenständiger k3s-Server, **kein** Beitritt zu TECH, eigene ArgoCD-Instanz auf dem Branch `entw` | Die ENTW-Instanz kennt keinen anderen Cluster. TECH und PROD lesen `main` und dort nur `argocd/apps/tech/*` bzw. `argocd/apps/prod/*`. |
| Ein ApplicationSet `home-server-apps-entw`, Projekt `entw` erlaubt jeden Namespace | Jeder neue Ordner unter `argocd/apps/entw/` wird ohne weitere Freigabe deployt. Das ist gewollt, die VM ist eine Trainingsumgebung. |
| Kein Tailscale, kein CrowdSec, keine Watchdogs | Die VM ist absichtlich verwundbar (Trainings-/Pentest-Umgebung) und soll keinen Tailscale-Schlüssel tragen (Entscheidung 2026-09-18). |
| Erreichbarkeit über den Subnet-Router `homeserver` (192.168.178.0/24) | Die Tailscale-ACL lässt sich auf das Ziel `192.168.178.100` beschränken. |
| Kein Audit-Log, kein RAM-Schutz | Wegwerf-Cluster mit 12 GiB. Das Tuning des Hauptclusters (`system-reserved` 1Gi usw.) passt nicht. |
| `argocd_platform_apps` / `argocd_workloads_apps` in `host_vars/entw-vm` steuern nur noch `security-tier`-Label und Tier-NetworkPolicy der dort gelisteten Namespaces (Bestand) | Neue Apps bekommen keine Policy (Trainingsumgebung). Was deployt wird, entscheidet allein der Ordner `argocd/apps/entw/`. |

Die statische IP setzt cloud-init (Rolle `libvirt_host`), deshalb steht in `host_vars` `network_configure_static_ip: false`.

## PROD-Cluster (`prod-vm`)

- Eigenständiger k3s-Server in der KVM-VM auf dem Homeserver, kein Beitritt zu TECH und **kein ArgoCD in der VM**: Der Hub in
  TECH registriert PROD ([argocd/bootstrap-prod](../../argocd/bootstrap-prod/README.md)).
- Audit-Log und Secrets-Verschlüsselung bleiben auf den Rollen-Defaults, weil PROD die echten Familien- und Vereinsdaten trägt.
- Die VM-Definition (6 vCPU / 24 GiB / 100 GiB, IP `.99`) steht in `host_vars/homeserver`, nicht in den Rollen-Defaults, weil
  worker-1 (ENTW) eine andere Liste braucht.
- Pod-/Service-Netze ohne Überlappung: TECH `10.42`/`10.43`, ENTW `10.44`/`10.45`, PROD `10.46`/`10.47`.

## DNS von PROD-VM und Homeserver

| Stelle | Begründung |
|---|---|
| `dns:` der prod-vm zeigt **nur** auf `network_static_ip` (dnsmasq des Homeservers) | dnsmasq löst `*.homeserver` (tech/prod/dev) auf und leitet den Rest an Pi-hole. Mit `1.1.1.1` als Zweitserver würde CoreDNS in PROD zufällig gegen einen Resolver fragen, der `*.homeserver` nicht kennt. Abhängigkeit: Fällt dnsmasq oder Pi-hole aus, verliert die PROD-VM ihr DNS. |
| dnsmasq leitet an Pi-hole (NodePort), Pi-hole an die Fritz!Box | Jedes Gerät, das dnsmasq als DNS nutzt, bekommt automatisch Werbeblocking, ohne Router-Konfiguration. |
| `*.dev.homeserver` → ENTW-VM; einzeln umgezogene PROD-Hosts (`dnsmasq_prod_vm_hosts`) → PROD-VM | Die spezifischere Domain bzw. der exakte Host gewinnt gegenüber `address=/homeserver/`. Alle anderen `*.prod.homeserver`-Namen bleiben bis zu ihrem Umzug auf dem Hauptcluster (`.94`). |
| Rolle `dnsmasq`: Neustart bei Fehlern, **ohne** Start-Limit | Das Debian-Unit hat kein `Restart=`. Stürzt dnsmasq beim Start ab (Konflikt `bind-interfaces`/`bind-dynamic` durch den libvirt-Snippet, Vorfälle 2026-09-18 und 2026-09-24), bleibt er bis zum nächsten Eingriff tot, und damit das DNS des ganzen LANs und der PROD-VM. Ohne Start-Limit, sonst gibt systemd nach fünf Versuchen auf. |
| Handler-Reihenfolge in `dnsmasq/handlers` | Handler laufen in der Reihenfolge der Datei: erst systemd neu laden (Drop-ins), dann dnsmasq neu starten, damit der Neustart die neuen Unit-Einstellungen bekommt. |

---

## Rolle `libvirt_host`

### Grundentscheidungen

- **KVM/libvirt statt Proxmox** ([40030](../4-planung/40030-gitlab-hosting-proxmox-pruefung.md), Baustein 5 in 40080): ein schlankes
  Paket auf dem bestehenden Ubuntu Server, kein OS-Wechsel.
- **`virt-install`/`virsh` statt der Collection `community.libvirt`**: keine neue Galaxy-Abhängigkeit für eine einzelne Rolle
  (passt zum Muster „kein Tool mehr als nötig“).
- **Host-generisch**: Netzwerkwerte kommen aus den Ansible-Facts (`ansible_default_ipv4.*`) statt aus den
  homeserver-spezifischen `network_*`-Variablen. Auf worker-1 wären IP und NIC-Name andere (`eno1` bzw. `enp4s0` gegen `enp2s0`).
- **`libvirt_host_vms` ist im Default leer.** Die echten Listen (PROD-VM auf homeserver, ENTW-VM auf worker-1) stehen in
  `host_vars/<host>/vars.yml`. Sonst würde jeder Host mit der Rolle auch die VMs eines anderen Hosts bauen wollen.
- **Master-Schalter `libvirt_host_enabled`** war bewusst `false`, bis das Wartungsfenster des jeweiligen Hosts anstand
  (homeserver/PROD riskant, worker-1/ENTW deutlich weniger). Er wird pro Host aktiviert, nicht per Rollen-Default für alle.
- `qemu-kvm` ist auf Ubuntu 26.04 („resolute“) ein virtuelles Paket (aufgeteilt in `qemu-system-x86` / `qemu-system-x86-hwe`), apt
  kann sich bei einer expliziten Liste nicht entscheiden. Genommen wird `qemu-system-x86`, passend zum laufenden `-generic`-Kernel.
- Die VMs werden per `include_tasks: vm.yml` geloopt, weil ein `loop` auf einem `block` in Ansible nicht existiert.
- MAC-Adressen: bei Kollision im LAN eine eigene wählen (`openssl rand -hex 5 | sed 's/\(..\)/\1:/g; s/.$//'` unter dem
  QEMU/KVM-Präfix `52:54:00`).
- Der Admin-SSH-Public-Key wird per cloud-init in den `ubuntu`-User jeder VM eingetragen, gleiches Prinzip wie bei den
  Bare-Metal-Nodes, damit Ansible sich danach identisch verhält.

### Bridge-Umbau (Tag `libvirt-bridge`, hohes Risiko)

Der Umbau baut die physische NIC in die Linux-Bridge `br0` ein und verschiebt die Host-IP darauf. Ein Fehler trennt den Host
vom Netz. Für den Homeserver (einziges Interface, keine Out-of-Band-Konsole, 24/7-Single-Point-of-Failure) ist das hochriskant,
für worker-1 weniger. Deshalb:

| Regel | Grund |
|---|---|
| Eigener Tag `libvirt-bridge`, nie Teil eines generischen `make install` | Der Task darf nicht versehentlich mitlaufen. Nur mit Wartungsfenster und Rollback-Plan ausführen. |
| Bridge-Parameter (`libvirt_host_bridge_interface`, `libvirt_host_static_ip`) **explizit** in `host_vars` pinnen | Nach einem Teil-Setup liefern die Default-Route-Facts `br0` bzw. die DHCP-Adresse (`.67` auf worker-1). Die Bridge würde sich dann selbst enslaven bzw. die falsche IP bekommen (Vorfall worker-1, 2026-09-19). |
| Die Rolle prüft, dass die NIC existiert, **bevor** eine Netplan-Datei angefasst wird | Der Homeserver-NIC hieß `eno1`, heißt seit dem Boot vom 2026-09-11 aber `enp4s0` (Kernel/initramfs vergibt den Namen neu, mit `ip -br link` prüfen). Ein falscher Name legte am 2026-09-20 die Bridge ohne Uplink an und trennte den Homeserver vom LAN. |
| Abbruch vor dem Löschen alter Netplan-Configs, wenn die Facts schon auf `br0` zeigen | Nach einem Teil-Setup würde sich die Bridge sonst selbst enslaven. |
| SSH-`ControlMaster`-Verbindung nach `netplan apply` zurücksetzen | Die gecachte Verbindung ist danach tot und würde minutenlang hängen. |
| UFW-Regel für geroutete Pakete | Mit geladenem `br_netfilter` (k3s/Flannel) laufen Bridge-Pakete durch iptables, und UFW verwirft geroutete Pakete standardmäßig (`deny (routed)`). Das LAN erreichte die VM dann nur per ICMP, TCP lief ins Timeout (Vorfall prod-vm, 2026-09-19). |
| `disable_eee_interface` auf die physische NIC setzen (`libvirt_host_bridge_interface`) | Die Rollen-Default (`ansible_default_ipv4.interface`) liefert nach dem Umbau `br0`, dort scheitert `ethtool --set-eee` (Vorfall 2026-09-20). EEE gibt es nur an der physischen NIC. |

### dnsmasq-Snippet von `libvirt-daemon-system`

`libvirt-daemon-system` legt `/etc/dnsmasq.d/libvirt-daemon` mit `bind-interfaces` an. Das kollidiert mit dem bewusst auf
`bind-dynamic` gestellten System-dnsmasq („cannot set --bind-interfaces and --bind-dynamic“). Am 2026-09-18 legte das den
System-dnsmasq des Homeservers komplett lahm, also echter DNS-Ausfall für das ganze LAN. Libvirts eigener dnsmasq für `virbr0`
braucht den Snippet nicht, der Ausschluss von `virbr0` passiert bei `bind-dynamic` implizit über die vorhandene
`interface=`/`listen-address`-Allowlist.

- **Nur Entfernen reicht nicht.** Das `postinst` von `libvirt-daemon-config-network` legt den Symlink bei jedem Paket-Upgrade neu
  an (`if [ ! -e ... ]`), auch per `unattended-upgrades`. Am 2026-09-24 um 06:08 passierte das erneut (Upgrade `12.0.0-1ubuntu5.3`
  auf `.4`), dnsmasq war bis zum Reboot tot und das `*.homeserver`-DNS im LAN weg.
- Die Rolle legt deshalb einen **leeren Platzhalter als reguläre Datei** an. Er besteht den `-e`-Test und verhindert die Neuanlage.
- Der Neustart läuft **sofort** (`meta: flush_handlers`), nicht erst am Play-Ende: War dnsmasq durch den Snippet abgestürzt, ist das
  LAN-DNS weg, bis er neu startet, und das soll nicht vom Erfolg der übrigen Tasks abhängen.
- Der Handler heißt anders als der der Rolle `dnsmasq` („System-dnsmasq nach Snippet-Entschärfung neu starten“), weil
  Handler-Namen play-weit gelten.

### Basis-Image und VM-Disks

- Das Ubuntu-Cloud-Image wird **einmalig** geladen und danach nie ersetzt. `get_url` schickt bei vorhandenem Ziel ein
  `If-Modified-Since` und überschreibt die Datei, sobald Canonical unter derselben URL ein neueres Build veröffentlicht. Das
  passierte beim täglichen Semaphore-Lauf um 06:00 und tauschte die Basis der VM-Disks aus (Vorfall 2026-09-23, siehe
  [50010](../5-incidents/50010-prod-vm-basis-image-ersetzt.md)).
- Neue VMs bekommen deshalb eine **eigenständige Disk** (Kopie des Basis-Images, danach vergrößert, kein Backing-File). Das kostet
  nur den tatsächlich belegten Platz (~3 GB), nicht die virtuelle Größe. Das Basis-Image dient nur noch als Vorlage für **neue** VMs.
- Vor der Umstellung angelegte VMs hängen noch als Overlay am Basis-Image. Ersetzt jemand die Basis-Datei von Hand, startet die VM
  nicht mehr. Die Rolle warnt nur, ein Umbau braucht eine ausgeschaltete VM (Runbook in 50010).
- URL-Notiz: `resolute` ist der Ubuntu-26.04-Codename, `/releases/26.04/…` leitet per 302 dorthin um (geprüft 2026-09-18,
  HTTP 200, ~863 MB).
- `libvirt-guests` (`ON_BOOT=start`, `ON_SHUTDOWN=shutdown`, `SHUTDOWN_TIMEOUT=300`): Der Ubuntu-Default `suspend` würde den
  kompletten Arbeitsspeicher der VM (PROD: 24 GiB) beim Herunterfahren auf die Platte schreiben. Das ist langsam, läuft bei knappem
  Timeout in einen harten Abbruch und stellt eine VM mit altem Speicherstand gegen veränderte Umgebung (NFS, DNS) wieder her.
  Stattdessen ACPI-Shutdown, die VM fährt sauber herunter (k3s, Datenbanken). Ein systemd-Drop-in startet `libvirt-guests` nach
  `dnsmasq` und `tailscaled`, weil die PROD-VM `*.homeserver` und externe Namen über den dnsmasq des Hosts auflöst. Beim
  Herunterfahren gilt die umgekehrte Reihenfolge: erst die VMs, solange dnsmasq noch antwortet. `Wants=` ist auf Hosts ohne dnsmasq
  (worker-1) wirkungslos.

### worker-1: Speicher

Die ENTW-VM bekommt dauerhaft **20 GiB**: Die Root-Partition von worker-1 hat nur 31 GiB frei (57 GiB gesamt, `df -h` vom
2026-09-18). Eine zweite, 465 GiB große Platte (`/dev/sda`) wurde geprüft und verworfen: Beim Formatieren traten wiederholt
„Input/output error“ und `hostbyte=DID_BAD_TARGET` im Kernel-Log auf (Bus-/Verbindungsebene, `smartctl` kann die Platte nicht
einmal auslesen) — zu unzuverlässig für VM-Storage.

---

## Worker-Nodes und ihre Playbooks

### worker-0: DNS und Tailscale

- worker-0 hängt an einem Fritz-WLAN-Repeater und bekommt darüber kein nutzbares DHCPv6-DNS. Das eigene Netplan hat
  `nameservers: []` (Subiquity-Installer-Default) und funktionierte nur, weil ein **manuell** (nicht Ansible-verwaltet)
  installiertes Tailscale per `--accept-dns` als Resolver einsprang. Lief dessen Login ab („Needs login“, kein Selbstheilen), hatte
  worker-0 gar kein DNS mehr. Sichtbar wurde das als `Failed to update apt cache after 5 retries:` mit **leerer** Fehlermeldung im
  Task der Rolle `worker_apt_update`.
- Konsequenz: Tailscale ist seit 2026-09-15 über die Rolle `tailscale` Ansible-verwaltet, und `worker_apt_update` setzt bei Bedarf
  statische Fallback-Nameserver per Netplan-Drop-in (`worker_apt_update_dns_fallback_enabled`, pro Host per Opt-in, Default `false`).
  worker-1 bekommt per DHCPv6 vom Router zuverlässig DNS, der Fallback ist dort nur zusätzliche Absicherung.
- Beide Worker sind **reine Tailnet-Clients, keine Subnet-Router** (das übernimmt der Homeserver für das ganze LAN), deshalb
  `tailscale_advertise_routes: ""` bzw. kein `--advertise-routes`.
- Jeder Worker braucht einen **eigenen** Auth-Key. Der globale Default in `group_vars/all.yml` ist vom Homeserver verbraucht
  (Single-Use ist Policy, siehe [c0010](../c-netzwerk-dns/c0010-tailscale.md#auth-key-besorgen)), und der für worker-0 erzeugte
  ist ebenfalls nicht wiederverwendbar. Einmalig: Auth-Key erzeugen (Reusable aus, Ephemeral aus), nach dem ersten erfolgreichen
  Connect unter „Machines“ **„Disable key expiry“** setzen, damit der unbeaufsichtigte, nachts per WoL geweckte Node nicht
  erneut stillschweigend in „Needs login“ hängen bleibt, dann
  `ansible-vault encrypt_string 'tskey-auth-…' --name 'tailscale_auth_key'` und in `host_vars/<worker>/vars.yml` bzw.
  `vault.yml` eintragen.
- Sudo-Passwörter: `ansible-vault encrypt_string 'DEIN_SUDO_PW' --name 'vault_worker-0_become_password'` (worker-1:
  `vault_worker_1_become_password`, Ablage in `host_vars/worker-1/vault.yml`, Vorlage ist `host_vars/worker-0/vault.yml`).

### Reihenfolge in `worker-0.yml` / `worker-1.yml`

Seit der NAS-gestützten `nas`-StorageClass sind beide Worker reine k3s-Compute-Nodes. Die frühere HDD-Rolle (`sda`) und die
Docker-Compose-Dienste (Paperless-ngx, TinyTeller) sind entfallen, beide laufen als ArgoCD-App. Die Reihenfolge ist zwingend:

| Schritt | Rolle | Warum an dieser Stelle |
|---|---|---|
| 1 | `worker_apt_update` | Sonst bekommt der Node nie ein OS-Update (keine `common`-Rolle). Setzt bei Bedarf Fallback-DNS und muss deshalb **vor** `tailscale` laufen, das für die eigene Paketinstallation funktionierendes DNS braucht. Läuft normalerweise nachts um 01:00 über `nightly_worker_wake`. |
| 2 | `tailscale` | Ansible-verwaltet (Vorfall worker-0, siehe oben), mit eigenem, vault-verschlüsseltem `tailscale_auth_key`. |
| 3 | `k3s_agent` | Braucht einen laufenden k3s-Server auf dem Homeserver (`.94`). |
| 4 | `disable_eee` | Vorfall 2026-09-02 auf dem Homeserver: EEE verursachte einen Link-Drop ohne Selbstheilung. |
| 5 | `thermal_watchdog`, `resource_watchdog` | Automatischer Shutdown bei Übertemperatur bzw. anhaltend hoher CPU/RAM-Last. |
| 6 | `journal_upload` | Der DaemonSet `victoria-logs-collector` liest nur Container-Logs, nicht das journald des Nodes. |
| 6b | `smartctl_exporter` | S.M.A.R.T.-Werte für Grafana. |
| 7 | `wake_on_lan` | Damit `cluster_power_manager` den Node aus dem ausgeschalteten Zustand wecken kann. |
| 8 | `cluster_power_manager_target` | Autorisiert den auf dem Homeserver erzeugten Shutdown-Key, beschränkt auf `poweroff`. Setzt voraus, dass `site.yml` schon gegen den Homeserver gelaufen ist, sonst existiert der Public Key dort noch nicht. |
| 9 | Uncordon | Stellt sicher, dass der Node schedulbar bleibt (macht `kubectl drain`/`cordon` aus Wartungsschritten rückgängig). |
| 10 (nur worker-1) | `libvirt_host` | ENTW-VM. Wird über `host_vars/worker-1` aktiviert (seit 2026-09-18) und erbt nicht automatisch den globalen Schalter. |

In `site.yml` muss `cluster_power_manager` **vor** den Worker-Playbooks laufen (er erzeugt das SSH-Schlüsselpaar für den
Shutdown). `semaphore_targets` verteilt danach den Semaphore-SSH-Key auf alle Ziele (wird übersprungen, wenn im Inventar keine Ziele
stehen), und `semaphore_bootstrap` legt anschließend Projekte, Keys, Repositories, Inventories und Templates über die REST-API an,
damit die UI ohne Klicks benutzbar ist.

## Zugang und Notfallzugang

- **WireGuard-Backup-Port ist 51888**, nicht 443. Port 443 wurde probiert und scheitert am AppArmor-Profil von `wg-quick`
  (`/etc/apparmor.d/wg-quick`, Ubuntu-Standard-Hardening): Dessen `ip`-Sub-Profil bekommt nur `net_admin`/`sys_module`, nicht
  `net_bind_service`. Das Binden an Ports unter 1024 schlägt mit „RTNETLINK answers: Permission denied“ fehl. Das Profil wird
  absichtlich **nicht** per lokalem Override gelockert (würde Canonicals Sandboxing für `wg-quick` aufweichen).
- Der Pre-Shared-Key ist optional, aber empfohlen (zusätzliche symmetrische Schicht):
  `ansible-vault encrypt_string 'DEIN_PSK' --name 'wireguard_backup_peer_preshared_key'`.
- Weitere Hintergründe zum Tunnel: [60020](60020-ansible-rollen.md#wireguard_backup).
- Die physische NIC des Homeservers heißt `enp4s0` (siehe Bridge-Umbau oben), bei Zweifeln mit `ip -br link` prüfen.
