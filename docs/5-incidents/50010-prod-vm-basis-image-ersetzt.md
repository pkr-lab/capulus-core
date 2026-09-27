# Incident-Report — 23.09.2026: PROD-VM startet nicht mehr, Basis-Image war ausgetauscht

| | |
|---|---|
| **Betroffen** | Alle PROD-Dienste: Nextcloud, Immich, Mealie, Paperless-ngx, Wiki.js, Xibo, tinyteller, whoami, demo-app |
| **Ausfall** | Rund 24 Stunden (23.09. Abend bis 24.09. Abend) |
| **Datenverlust** | Keiner. Die Nutzerdaten lagen auf dem NAS (`Retain`), die einzige lokale Datenbank und die nicht im Repo liegenden Schlüssel konnten aus der alten Disk gerettet werden |
| **Ursache** | Die Ansible-Rolle `libvirt_host` ersetzte bei jedem täglichen Semaphore-Lauf das Basis-Image, auf dem die VM-Disk als Overlay aufsetzte |
| **Status** | Behoben und verifiziert (PR [#340](https://github.com/pkr-lab/capulus-core/pull/340)). Offen sind Aufräumarbeiten und die Prüfung der ENTW-VM, siehe [Offene Punkte](#offene-punkte) |

---

## Kurzfassung

Die PROD-VM (`prod-vm`, 192.168.178.99) ist eine KVM-VM auf dem `homeserver`. Ihre Disk war kein eigenständiges Image, sondern ein **Overlay** (qcow2 mit Backing-File) auf dem Ubuntu-Cloud-Image `ubuntu-26.04-server-cloudimg-amd64.img`. Dieses Basis-Image wurde vom täglichen Semaphore-Lauf („Deploy Home Server", 06:00) neu heruntergeladen und **überschrieben**, sobald Canonical ein neueres Build veröffentlichte. Die laufende VM merkte davon nichts. Beim nächsten Start passte das Overlay nicht mehr zur Basis, GRUB startete nicht, und die VM musste neu aufgebaut werden.

Ein neu aufgebauter PROD-Cluster ist für ArgoCD ein **fremder Cluster**: neue CA, kein ServiceAccount, kein Sealed-Secrets-Schlüssel, leere Volumes. Deshalb standen die PROD-Apps nach dem Neuaufbau nicht einfach wieder da, sondern mussten Schritt für Schritt wiederhergestellt werden (Registrierung im Hub, Schlüssel, Datenbank, NAS-Ordner, Zertifikat). Dieser Report beschreibt beides: **was die Ursache war** und **wie der Betrieb wiederhergestellt und die Ursache behoben wurde**.

---

## Systemüberblick (was man zum Verständnis wissen muss)

| Baustein | Aufgabe | Relevanz für den Vorfall |
|---|---|---|
| **TECH-Cluster** (`homeserver`, 192.168.178.94) | k3s + ArgoCD-Hub, verwaltet TECH **und** PROD | Der Hub kennt PROD nur über das Secret `cluster-prod` (ServiceAccount-Token + CA), das von Hand angelegt wird ([bootstrap-prod/README](../../argocd/bootstrap-prod/README.md)) |
| **PROD-Cluster** (`prod-vm`) | Eigener k3s-Server in einer KVM-VM auf dem homeserver, 6 vCPU / 24 GiB / 100 GiB | Wurde neu aufgebaut |
| **ENTW-Cluster** (`entw-vm`) | Gleicher Aufbau auf `worker-1` | Nutzt dieselbe Rolle, vermutlich derselbe Fehler |
| **Semaphore** | Führt Ansible aus dem Repo aus. Zeitplan „Daily 06:00" für `site.yml`, dazu nächtlich die Worker-Templates ([20030](../2-betrieb-hardware/20030-nightly-worker-update.md)) | Auslöser der Image-Ersetzung |
| **`libvirt_host`-Rolle** | Legt VMs an (Disk, cloud-init, `virt-install`). Steht als **letzte** Rolle in `site.yml`, läuft also jeden Tag mit | Ort des Fehlers |
| **NAS** (UGREEN, 192.168.178.97) | NFS für die StorageClasses `nas` und `immich-nas`, `reclaimPolicy: Retain` ([20000](../2-betrieb-hardware/20000-nas-storage.md)) | Hat die Nutzerdaten gerettet |
| **Sealed Secrets** | Secrets verschlüsselt im Git, nur der Controller des jeweiligen Clusters kann sie entschlüsseln | Der PROD-Controller hatte einen eigenen Schlüssel, den nur die alte Disk kannte |
| **k3s `secrets-encryption`** | Verschlüsselt alle Secrets im Datastore (`state.db`) mit AES | Erschwerte das Auslesen aus der alten Disk |
| **Interne CA** | Root-CA für alle Clients, PROD hat eine eigene Intermediate-CA ([d0040](../d-sicherheit/d0040-internal-tls.md)) | Intermediate-Key und -Zertifikat wurden von Hand importiert, nicht im Repo |

**Was ein Overlay (Backing-File) ist:**

```
prod-vm.qcow2  (Overlay: enthält nur, was die VM seit der Anlage geändert hat)
     │  „alles andere lies aus der Basis"
     ▼
ubuntu-26.04-server-cloudimg-amd64.img  (Basis, ~0,8 GiB: Bootloader, Dateisystem-Grundstock)
```

Ein Overlay ist nur zusammen mit **genau der Basis-Datei** gültig, mit der es angelegt wurde. Wird die Basis durch eine andere Datei gleichen Namens ersetzt, liest die VM Blöcke, die zu einem anderen Stand des Images gehören.

---

## Zeitleiste

Zeitangaben in Ortszeit (CEST). „Beleg" sagt, woher die Angabe stammt.

### Vorgeschichte

| Zeit | Ereignis | Beleg |
|---|---|---|
| 18.09. 13:13 | `prod-vm` wird angelegt (Overlay auf dem Basis-Image, cloud-init-Seed-ISO) | Dateizeit `prod-vm-seed.iso.corrupted-20260923` |
| 19.09. 00:41 (GMT) | Canonical veröffentlicht ein neues Build des 26.04-Cloud-Images | `Last-Modified` der Download-URL, am 24.09. abgefragt |
| 19.–20.09. | Umzug der Apps nach PROD; Bridge- und EEE-Vorfälle am homeserver (in `host_vars` dokumentiert) | [40080](../4-planung/40080-multi-cluster-entw-prod-tech.md) |
| **21.09. 06:00–06:11** | Der tägliche Semaphore-Lauf läuft. Um 06:11 wird das Basis-Image **ersetzt** | Änderungszeit der Datei: `2026-09-21 06:11:12` |
| 23.09. 06:02 | Letzter sauberer Shutdown der VM (Postgres: „shut down at 04:02 UTC", `mealie.log`, `db.sqlite3` mit 06:02) | Logs in den geretteten Daten |
| 23.09. | Die VM startet nicht mehr (GRUB). Reparaturversuch, Sicherung der Disk als `prod-vm.qcow2.bak-pregrubfix` (20:15), beschädigte Disk als `…corrupted-20260923` (20:25) | Dateizeiten auf dem homeserver |
| 23.09. Abend | VM und k3s neu aufgebaut: neue Disk und neue Seed-ISO (20:27), neue k3s-CA (erzeugt 17:31 UTC = 19:31 CEST). Die Zeitangaben widersprechen sich leicht (CA-Erzeugung liegt **vor** den Disk-Dateizeiten), die genaue Reihenfolge der Schritte an diesem Abend ist nicht rekonstruiert | Dateizeiten, Zertifikat der neuen CA, Node-Alter |
| 23.09. 20:31 | Der Hub verliert PROD: `x509: certificate signed by unknown authority`, alle `prod-*`-Apps stehen auf `Unknown` | Erste `ComparisonError`-Meldung, 18:31:56 UTC |
| 24.09. 06:08 | Nebenschauplatz: libvirt-Paketupdate legt den dnsmasq-Snippet-Symlink neu an (siehe [Nebenbefunde](#nebenbefunde)) | Rolle `libvirt_host`, [60010](../6-hintergruende/60010-ansible-hosts-und-playbooks.md#dnsmasq-snippet-von-libvirt-daemon-system) |

**Warum erst am 21.09.?** Canonicals Build ist vom 19.09. Die Läufe vom 19. und 20.09. haben das Image vermutlich nicht ersetzt, weil sie in einer früheren Rolle abbrachen (an diesen Tagen gab es Bridge- und EEE-Probleme am homeserver). Das ist eine Vermutung, nicht belegt.

### Wiederherstellung am 24.09.

| Zeit | Schritt | Beleg |
|---|---|---|
| ca. 17:57 | Erreichbarkeits-Sweep: PROD komplett tot, `prod-vm` ohne einen Ingress, ArgoCD meldet x509 | Diagnose |
| 18:09 | Erster Versuch, `cluster-prod` zu ersetzen. ArgoCD bleibt bei x509 (CA im Secret unbrauchbar) | Änderungszeit des Secrets 16:09:17 UTC |
| ca. 18:20 | Sealing-Key aus der alten Disk zurückgespielt | Secret `sealed-secrets-keyg9rn6` |
| ca. 18:22 | `cluster-prod` mit geprüfter CA/Token neu gesetzt, Application-Controller neu gestartet: ArgoCD verbindet sich, die Apps werden deployt | `token-len=930 ca-len=760` |
| 18:25 | Sealed-Secrets-Controller startet und lädt den alten Schlüssel; alle SealedSecrets `SYNCED` | Controller-Log 16:25:26 UTC |
| 18:26–18:32 | Der NFS-Provisioner legt für jede PVC einen **neuen, leeren** Ordner an; Wiki.js zeigt den Einrichtungsassistenten | Dateizeiten auf dem NAS |
| 18:4x | Schutz gegen Nextcloud-Neuinstallation (NetworkPolicy), NAS-Ordner umbenannt, Pods neu gestartet | `.leer-20260924-1844` |
| 18:53 | Intermediate-CA importiert, Zertifikat ausgestellt (`Ready=True`) | Secret `homeserver-wildcard-tls` 16:53:11 UTC |
| ca. 19:00 | Gesamt-Sweep und Datenprüfung je App | siehe [Verifikation](#7-verifikation) |
| später | PR #340 gemergt, prod-vm-Disk per Runbook eigenständig gemacht, `libvirt-guests` auf dem Host gesetzt | siehe [Behebung der Ursache](#behebung-der-ursache) |

---

## Ursache

### Der auslösende Fehler

Der Task in `ansible/roles/libvirt_host/tasks/main.yml` lautete sinngemäß:

```yaml
- name: Basis-Cloud-Image herunterladen (einmalig, VMs nutzen es als Backing-File)
  ansible.builtin.get_url:
    url: "https://cloud-images.ubuntu.com/releases/resolute/release/ubuntu-26.04-server-cloudimg-amd64.img"
    dest: "/var/lib/libvirt/images/ubuntu-26.04-server-cloudimg-amd64.img"
    mode: "0644"
```

Der Kommentar sagt „einmalig". Der Task ist es aber nicht: Ist das Ziel schon vorhanden und keine `checksum` angegeben, sendet `get_url` ein `If-Modified-Since` mit der Änderungszeit der lokalen Datei. Hat der Server eine **neuere** Version, wird sie in eine temporäre Datei geladen und die vorhandene Datei per Umbenennen **ersetzt**. Die URL zeigt auf `…/releases/resolute/release/`, also immer auf das jeweils aktuelle Build. Damit war „einmalig" nur so lange wahr, bis Canonical neu baute.

Die Rolle steht in `site.yml`, und Semaphore führt `site.yml` **jeden Tag um 06:00** aus (`ansible/roles/semaphore_bootstrap/defaults/main.yml`, `cron: "0 6 * * *"`). Der Task lief also täglich und ersetzte die Datei beim ersten Lauf nach jedem neuen Build.

### Warum die VM davon nichts merkte, der nächste Start aber scheiterte

1. QEMU hält die Basis-Datei beim Start **geöffnet**. Ersetzt Ansible sie per Umbenennen, liegt die neue Datei unter demselben Namen, QEMU liest weiter aus der alten, jetzt namenlosen Datei. Die **laufende** VM arbeitet unbeeinträchtigt weiter.
2. Beim **nächsten Start** öffnet QEMU die Basis neu und findet eine andere Datei. Alle Blöcke, die die VM nie selbst geschrieben hat, kommen jetzt aus dem neuen Build: Bootloader-Bereiche, Dateisystem-Grundstock, Partitionstabelle. Das Overlay erwartet aber den Stand des alten Builds.
3. Ergebnis: GRUB findet sein Dateisystem nicht mehr, die VM bootet nicht.

Das erklärt auch, warum der Fehler **verzögert** auftrat (Basis am 21.09. ersetzt, Startproblem am 23.09.): Die VM lief zwei Tage lang mit der alten Basis im Speicher weiter.

### Beleg und Unsicherheit

| Was | Stand |
|---|---|
| Basis-Datei am 21.09. um 06:11 ersetzt (11 Minuten nach Beginn des Semaphore-Laufs) | belegt (Dateizeit) |
| Semaphore-Lauf täglich 06:00, `libvirt_host` in `site.yml` | belegt (Repo) |
| Die Disk war ein Overlay auf genau dieser Datei | belegt (`qemu-img info --backing-chain`) |
| Canonicals Build (19.09.) ist neuer als der Stand bei Anlage der VM (18.09.) | belegt (`Last-Modified`) |
| Das Startproblem wurde durch den Austausch verursacht | **sehr wahrscheinlich, nicht direkt nachgewiesen.** Die beschädigte Disk liegt unverändert als `prod-vm.qcow2.corrupted-20260923` auf dem homeserver und ließe sich gegen die Basis prüfen |
| Anlass des Herunterfahrens am 23.09. um 06:02 | nicht geklärt |

### Begünstigende Faktoren

| Faktor | Wirkung |
|---|---|
| Provisionierungs-Rolle läuft täglich mit | Ein einmaliger Schritt wurde jeden Tag ausgeführt, jeder Fehler darin wirkt sofort auf die Produktivumgebung |
| Overlay statt eigenständiger Disk | Die Disk hängt von einer Datei ab, die außerhalb der VM verändert werden kann |
| Kein Schutz und keine Warnung für abhängige Disks | Weder der Task noch ein Check bemerkte, dass VMs an der Datei hängen |
| Zustand nur auf der VM-Disk | Sealed-Secrets-Schlüssel und Intermediate-CA existierten nur dort |
| StorageClass `nas` ohne `pathPattern` | Nach einem Neuaufbau hängen die alten NAS-Ordner an keiner PV mehr |
| Manuelle, nicht dokumentierte Anbindung PROD an den Hub | Nach dem Neuaufbau musste sie von Hand neu gemacht werden, und der Verlust fiel erst beim manuellen Prüfen am 24.09. auf |
| Ubuntu-Default `ON_SHUTDOWN=suspend` bei `libvirt-guests` | 24 GiB Arbeitsspeicher würden beim Host-Neustart auf die Platte gesichert statt die VM sauber herunterzufahren (kein Auslöser dieses Vorfalls, aber ein Risiko beim Neustart) |

**Dieselbe Rolle** läuft auf `worker-1` für die ENTW-VM (`ansible/worker-1.yml`, nächtlich über `nightly_worker_wake`). Die `entw-vm` ist daher vermutlich betroffen und war zum Zeitpunkt des Berichts nicht prüfbar (worker-1 ist per Wake-on-LAN geschaltet und war aus).

---

## Auswirkungen

| Bereich | Wirkung |
|---|---|
| PROD-Dienste (9 Hosts) | Intern: `*.prod.homeserver` zeigte per dnsmasq-Override auf `.99`, dort lief nur ein Traefik ohne Ingress (Default-Zertifikat, keine Routen). Extern: Cloudflare-Tunnel `homeserver-prod` ohne Verbindung (Fehler 530), Nextcloud/Immich/Wiki.js/Xibo nicht erreichbar |
| ArgoCD-Hub | Alle 16 `prod-*`-Applications `Sync: Unknown`, keine Reconciliation |
| Daten | Kein Verlust. Der Zustand lag auf NAS-Volumes (`Retain`), die lokale Nextcloud-Datenbank und die Schlüssel waren aus der alten Disk lesbar |
| TECH | Nicht betroffen |

---

## Wiederherstellung im Detail

Die Reihenfolge war entscheidend: Was zuerst deployt wird, entscheidet, ob Datenbanken auf leeren Volumes neu initialisieren. Die Hilfsskripte für Schlüssel-/Zertifikats-Extraktion und den NAS-Umbau lagen nur im Scratchpad der Sitzung und sind **nicht im Repo** (siehe [Offene Punkte](#offene-punkte)).

### 0. Diagnose

Der Erreichbarkeits-Sweep über alle Hosts zeigte für PROD durchgängig TLS-Fehler bzw. 530. Die Ursachenkette dahinter:

| Beobachtung | Bedeutung |
|---|---|
| `kubectl -n argocd get applications`: alle `prod-*` `Unknown` | Der Hub erreicht PROD nicht |
| ComparisonError `x509: certificate signed by unknown authority` | Das Secret `cluster-prod` enthält die CA der **alten** VM |
| `kubectl get ingress -A` auf der prod-vm: leer, Cluster-Alter 21 h | Es wurde nie etwas deployt |
| k3s-CA-Zertifikat: `k3s-server-ca@…`, erzeugt am 23.09. 17:31 UTC | Frischer Cluster |
| Kein `argocd-manager`-ServiceAccount auf der prod-vm | Der Hub hat dort keinen Zugang mehr |
| Im Repo: `dnsmasq_prod_vm_hosts` zeigt 9 Hosts auf `.99` | Die Namen lösten auf einen leeren Cluster auf |

### 1. Cluster im Hub registrieren

Auf der prod-vm ServiceAccount, `cluster-admin`-Binding und Token-Secret neu anlegen (Block aus [bootstrap-prod/README](../../argocd/bootstrap-prod/README.md)), dann im Hub das Secret `cluster-prod` ersetzen. Token und CA gehen dabei **direkt von der prod-vm ins Secret**, nicht per Copy-and-paste.

Stolperfallen dabei:

| Problem | Lösung |
|---|---|
| Der erste Versuch änderte das Secret (18:09), ArgoCD meldete weiter x509 | `caData` war leer oder falsch. Vor dem `apply` die Längen prüfen (`token-len` ≈ 930, `ca-len` ≈ 760) und den `apply` an eine Bedingung knüpfen |
| Auch mit korrektem Secret blieb der Status `Unknown` | Der Application-Controller läuft seit Tagen und hält die alte Cluster-Verbindung. `kubectl -n argocd rollout restart statefulset argocd-application-controller` |
| CA-Prüfung | Fingerprint der CA im Secret gegen `openssl x509 -fingerprint` auf der prod-vm vergleichen |

### 2. Sealed-Secrets-Schlüssel

Alle SealedSecrets in `argocd/apps/prod/` (cloudflared, immich, nextcloud, wikijs, wiki-docs-sync, xibosignage) waren mit dem Schlüssel des **alten** PROD-Controllers versiegelt (per `scripts/reseal-for-prod.sh`). Der neue Controller erzeugt einen eigenen Schlüssel und kann sie nicht lesen. Ein erneutes Versiegeln aus den TECH-Secrets ging nicht, weil diese Apps dort nicht mehr laufen.

Vorgehen:

1. Alte Disk (`prod-vm.qcow2.bak-pregrubfix`) mit `qemu-nbd --read-only` als Blockgerät verbinden und mit `mount -o ro,noload` einhängen. Nichts an den Sicherungen wird verändert.
2. Aus `var/lib/rancher/k3s/server/db/state.db` (SQLite-Datastore von k3s, Tabelle `kine`) die Einträge `/registry/secrets/sealed-secrets/sealed-secrets-key*` lesen (jeweils die neueste, nicht gelöschte Revision).
3. Die Werte sind **verschlüsselt** (`secrets-encryption: true`): Format `k8s:enc:aescbc:v1:<keyname>:` gefolgt von IV (16 Byte) und AES-CBC-Chiffrat mit PKCS7-Padding. Der Schlüssel steht in `var/lib/rancher/k3s/server/cred/encryption-config.json` derselben Disk.
4. Im entschlüsselten Secret stehen `tls.crt` und `tls.key` als PEM. Prüfen, dass Zertifikat und Schlüssel zusammenpassen, dann ein Secret-Manifest mit dem Label `sealedsecrets.bitnami.com/sealed-secrets-key: active` in den Namespace `sealed-secrets` der prod-vm anwenden.

Ergebnis: **ein** Schlüssel (`sealed-secrets-keyg9rn6`, gültig ab 19.09.). Der PROD-Controller lief erst seit dem 19.09. und hatte noch keinen zweiten erzeugt. Nach dem Start des Controllers: `registered private key`, alle SealedSecrets `SYNCED`.

### 3. Nextcloud-Datenbank

Der Postgres von Nextcloud lag als einziger auf `local-path`, also auf der Platte der VM. Damit ArgoCD ihn nicht auf einem leeren Volume neu initialisiert, wurde die Datenbank **vor** der Registrierung eingespielt:

1. PVC `nextcloud-postgresql-data` (Name aus dem Helm-Release `nextcloud` + `-postgresql-data`) von Hand anlegen und mit einem Helfer-Pod (`busybox`, `sleep`) einmal einbinden, damit `local-path` das Verzeichnis anlegt.
2. `pgdata_pg18` aus der alten Disk mit `tar --numeric-owner` in dieses Verzeichnis kopieren (UID/GID 999 bleiben erhalten). Danach `PG_VERSION` = 18 und Modus `drwx------` prüfen.
3. Helfer-Pod löschen. ArgoCD übernimmt den bestehenden PVC später.

Belegt: Postgres 18.6 startete mit „Database directory appears to contain a database; Skipping initialization" und „database system was shut down at 2026-09-23 04:02:24 UTC", ohne Crash-Recovery.

### 4. NAS-Volumes

**Problem:** Die StorageClass `nas` (`nfs-subdir-external-provisioner`) hat kein `pathPattern`. Für jede neue PVC legt sie einen Ordner mit **zufälliger PV-UID im Namen** an (`<namespace>-<pvc>-pvc-<uid>`). Die alten Ordner blieben wegen `Retain` unangetastet, hingen aber an keiner PV mehr, denn die PV-Objekte lagen im gelöschten Cluster. Alle Apps starteten auf **leeren** Volumes (Wiki.js zeigte den Einrichtungsassistenten).

**Lösung:** Die alten Ordner wurden auf die Pfade der neuen PVs umbenannt (`mv`). Die Zuordnung ergab sich aus Änderungszeiten und Inhalt: Die TECH-Ordner sind älter (Juli/August) und gehören zu den `Released`-PVs des TECH-Clusters, die PROD-Ordner entstanden bei der Migration am 19.09. und wurden bis 23.09. beschrieben, die leeren neuen stammen vom 24.09. 18:26 bis 18:32. Der Inhalt jedes Kandidaten wurde vorher kontrolliert (z. B. `mealie.db`, `db.sqlite3`, `pgdata_fixed_pg18`, `mysql-data-v26`). Bei der Immich-Bibliothek entscheidet der Zeitpunkt von `backups/` (nächtlicher Postgres-Dump): `…-183785f7…` ist die TECH-Quelle (Backups bis 19.09., laut Migrations-Job), `…-ff854358…` hat Backups bis 23.09. 02:00 und ist die PROD-Bibliothek.

| App | Alter Ordner (PROD, Datenstand) | Wird zum Pfad der neuen PV |
|---|---|---|
| Mealie `mealie-data` | `…-pvc-5069ad5b…` (22.09.) | `…-pvc-f341b131…` |
| Nextcloud `html` | `…-pvc-2253f744…` | `…-pvc-e9a052ce…` |
| Nextcloud `data` | `…-pvc-4569b4f5…` | `…-pvc-4cd3881a…` |
| Paperless `data` / `media` | `…-pvc-8cc3fc91…` / `…-pvc-d1313ea4…` (23.09.) | `…-pvc-4079bc0a…` / `…-pvc-eeb9c3b3…` |
| Wiki.js `postgresql-data` | `…-pvc-1dd441ab…` (`pgdata_fixed_pg18`) | `…-pvc-26d78733…` |
| Xibo `cms-library` / `cms-state` / `mysql-data` | `…-pvc-b9363d86…` / `…-1faf5ef0…` / `…-3ad195b3…` | `…-b9b62dab…` / `…-52371c6d…` / `…-2accf8d8…` |
| Immich `postgresql-data` / `server-library` / `postgres-backup` (`/volume2`) | `…-7fa31bd5…` / `…-ff854358…` / `…-00cc14c9…` | `…-5fc18131…` / `…-30acf6f8…` / `…-ec37b8f5…` |

Nicht getauscht: Paperless `consume` (Eingangsordner, leer), `export` und `redis` (nur Warteschlange), Immich-Modell-Cache (wird neu aufgebaut).

Das Umbenennen lief über ein Skript mit Trockenlauf und Schutzprüfungen: beide Ordner müssen existieren, der alte darf nicht leer sein, der neue muss **jünger** sein als der alte. Es bricht ab, wenn ein Paar nicht passt. Danach Pods der betroffenen Namespaces neu starten, damit sie den Pfad neu mounten (die laufenden Pods halten noch die alten Datei-Handles).

### 5. Beinahe-Unfall: Nextcloud installiert sich selbst neu

Der Nextcloud-Chart setzt `NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD` und die `POSTGRES_*`-Variablen. Findet der Container ein **leeres `html`-Volume**, kopiert er den Code hinein und führt anschließend `occ maintenance:install` **gegen die vorhandene, wiederhergestellte Datenbank** aus. Das würde `instanceid`, `secret` und `passwordsalt` neu erzeugen und die vorhandenen Nutzer unbrauchbar machen.

Da die Datenbank bereits echte Daten hatte und `html` zunächst leer war, sperrte eine NetworkPolicy (`tmp-block-postgres-recovery`, Ingress auf den Postgres-Pod komplett verboten) den Zugriff, bis `html` und `data` mit den alten NAS-Ordnern verbunden waren. `kubectl scale` wäre wirkungslos gewesen: ArgoCD `selfHeal` hätte es zurückgedreht, eine untracked NetworkPolicy dagegen nicht.

Es ging beinahe schief: Beim Aufräumen scheiterte der Befehl zum Löschen des Nextcloud-Pods an der Shell (`!` im Label-Selektor löste eine History-Expansion aus, `event not found`), der **letzte** Befehl derselben Eingabe (NetworkPolicy löschen) lief aber trotzdem. Der alte Pod hing damit noch an seinem leeren, inzwischen umbenannten Ordner, und die Sperre war weg. Der Pod wurde sofort gelöscht. Belegt, dass die Installation nicht lief: Im geparkten leeren Ordner existiert kein `config/`, im getauschten alten Ordner liegt die alte `config.php`, der neue Pod startete ohne „Initializing" direkt in Apache, `status.php` meldet `installed: true`.

### 6. PROD-Intermediate-CA

Das Secret `homeserver-ca-keypair` (Namespace `cert-manager`) wird laut [d0040](../d-sicherheit/d0040-internal-tls.md) einmalig von Hand importiert und liegt nicht im Repo. Der ClusterIssuer war deshalb `NotReady` und das Wildcard-Zertifikat für `*.prod.homeserver` nicht ausstellbar (Clients sahen TLS-Fehler).

Lokal lagen nur der Intermediate-**Key** und die CSR, das Zertifikat fehlte. Das Zertifikat ist öffentlich und wurde nach demselben Verfahren wie der Sealing-Key aus dem alten Secret gelesen (es wird nur `tls.crt` ausgegeben, nie der Key). Danach: `openssl verify` gegen die Root-CA (`OK`), Public-Key-Vergleich mit dem lokalen `prod-ca-key.pem` (`Key passt`), Import des Secrets. Innerhalb von Minuten `ClusterIssuer Ready`, `Certificate Ready`, und PROD lieferte eine Kette bis zur Root-CA (`Verify return code: 0`). Der Root-CA-Key wurde nicht benötigt.

### 7. Verifikation

| Prüfung | Ergebnis |
|---|---|
| TECH: 13 Login-/Health-Endpunkte | alle 200 mit gültigem TLS |
| PROD: 9 Hosts | Login-Seiten 200 (Mealie 307), TLS-Prüfung gegen die Root-CA ok |
| Nextcloud | `installed: true`, Nutzer `admin` (`occ user:list`) |
| Immich | `isInitialized: true`, 2 Nutzer, 5.953 Assets, Bibliothek mit Nutzerordnern |
| Mealie | `mealie.db` mit 1.568.768 Byte, identisch zur Migration |
| Paperless | `db.sqlite3` vom 23.09., 14 Originaldokumente |
| Wiki.js | `Authentication Strategy Local: OK`, kein Setup-Assistent mehr |
| Xibo | MySQL-`auto.cnf` vom 30.08. (kein frischer Init), Login-Seite statt Installer |
| ArgoCD | 47 von 48 Apps `Synced/Healthy` (`ollama` `Progressing`: an worker-0 gepinnt, der absichtlich aus ist) |
| Nach dem Disk-Tausch und VM-Neustart | Alle PROD-Apps innerhalb von 36 s wieder `Synced/Healthy`, Daten unverändert |

**Nicht geprüft:** Anmeldungen mit echten Zugangsdaten. Geprüft wurden Login-Seiten, Health-Endpunkte und der Datenbestand.

---

## Behebung der Ursache

### Änderungen im Repo (PR #340)

| Maßnahme | Datei |
|---|---|
| Basis-Image wird **nur heruntergeladen, wenn es fehlt** (`stat` + `force: false`), nie ersetzt | `ansible/roles/libvirt_host/tasks/main.yml` |
| Neue VMs bekommen eine **eigenständige Disk** (`qemu-img convert` + `resize`), kein Overlay | `ansible/roles/libvirt_host/tasks/vm.yml` |
| Bestehende Overlay-Disks erzeugen bei jedem Lauf eine **Warnung** (`qemu-img info --force-share`) | `ansible/roles/libvirt_host/tasks/vm.yml` |
| VMs fahren beim Host-Neustart **sauber herunter** (`ON_SHUTDOWN=shutdown`, `SHUTDOWN_TIMEOUT=300`, `ON_BOOT=start`) statt den Arbeitsspeicher zu sichern | `ansible/roles/libvirt_host/tasks/main.yml`, `defaults/main.yml` |
| `libvirt-guests` startet **nach** dnsmasq und Tailscale (die prod-vm löst Namen über den dnsmasq des Hosts auf) | Drop-in `libvirt-guests.service.d/10-ordering.conf` |
| dnsmasq startet bei Fehlern **automatisch neu** (`Restart=on-failure`, kein Start-Limit) | `ansible/roles/dnsmasq/tasks/main.yml` |
| ArgoCD-Web-UI per HTTPS über Traefik (`argocd.tech.homeserver`), als **Helm-Wert der Rolle** | `ansible/roles/argocd`, `host_vars/homeserver` |
| UFW: Port 30080 (Klartext-NodePort für CLI/CI) nur aus LAN, Tailnet und WireGuard; unbeschränkte und wirkungslose 30443-Regel entfernt | `ansible/roles/common/tasks/main.yml` |

Geprüft wurde mit `ansible-playbook --syntax-check` (`site.yml`, `worker-1.yml`, `entw.yml`), dem Rendern des ArgoCD-Templates für Hub und ENTW, den `qemu-img`-Befehlen im Kleinen auf dem homeserver (flache Disk: kein Backing-File, Overlay: `full-backing-filename` vorhanden) und dem Link-Checker `scripts/check-doc-links.py`. Der Ansible-Lauf selbst wurde nicht von Hand ausgeführt.

### Direkt auf dem Host umgesetzt

| Was | Wann | Ergebnis |
|---|---|---|
| prod-vm-Disk eigenständig gemacht (Runbook unten) | 24.09. | Disk 23,7 GiB, **kein Backing-File**; altes Overlay als `prod-vm.qcow2.overlay-alt` als Rückfall |
| `libvirt-guests` (`ON_BOOT/ON_SHUTDOWN/SHUTDOWN_TIMEOUT`) und Drop-in gesetzt, identisch zur Rolle | 24.09. | Greift beim nächsten Host-Shutdown; `libvirt-guests` wurde bewusst nicht neu gestartet, um die VM nicht herunterzufahren |

### Was der tägliche 06:00-Lauf anfasst (und was nicht)

Wichtig für jede künftige Änderung: Was der Lauf aus dem Repo neu anwendet, wird **jeden Tag** zurückgesetzt. Änderungen müssen deshalb im Repo stehen, nicht nur live.

| Wird täglich neu angewendet (Änderungen nur im Repo halten) | Wird nicht angefasst |
|---|---|
| ArgoCD-Helm-Werte (`helm upgrade --install argocd`, Werte aus `argocd-values.yaml.j2`) | Secret `cluster-prod` (PROD-Anbindung) |
| AppProjects und das Hub-ApplicationSet aus `argocd/bootstrap` (die PROD-AppProject/-ApplicationSets liegen unter `bootstrap-prod` und werden von Hand angewendet) | Sealed-Secrets-Schlüssel, `homeserver-ca-keypair` |
| Namespace-Labels und Tier-NetworkPolicies der Rolle `argocd` | NAS-Ordner, PVs, PVCs |
| dnsmasq-Konfiguration inkl. `dnsmasq_prod_vm_hosts` | die VM selbst (`virt-install` läuft nur, wenn die Domain fehlt) |
| UFW-Regeln, die im Repo stehen (hinzugefügt oder entfernt) | UFW-Regeln, die nur von Hand gesetzt wurden (blieben stehen, gingen bei einem Neuaufbau aber verloren) |
| k3s-`config.yaml` (wird neu geschrieben; k3s liest sie nur bei einem manuellen Neustart) | |

---

## Nebenbefunde

Beim Erreichbarkeits-Sweep am 24.09. fielen weitere Probleme auf, die nichts mit der Ursache zu tun hatten:

| Befund | Behebung |
|---|---|
| `alamos-relay.prod.homeserver` und `pacman.prod.homeserver` fehlten in den `dnsNames` des TECH-Wildcard-Zertifikats (TLS-Hostname-Mismatch) | PR [#335](https://github.com/pkr-lab/capulus-core/pull/335) |
| ArgoCD-Doku nannte `https://…:30443`, der Server läuft aber mit `server.insecure: true` und setzt TLS-Verbindungen zurück; die Doku behauptete zudem, 30080 sei in UFW gesperrt (stand nur von Hand in UFW) | PR #340: HTTPS-Ingress, UFW im Repo, Doku ([b0010](../b-kubernetes-gitops/b0010-argocd.md), [c0030](../c-netzwerk-dns/c0030-port-uebersicht.md) u. a.) |
| dnsmasq fiel nach einem libvirt-Paketupdate aus (das Paket legt `/etc/dnsmasq.d/libvirt-daemon` mit `bind-interfaces` neu an und kollidiert mit `bind-dynamic`). Erstmals am 18.09., erneut am 24.09. 06:08 | PR [#338](https://github.com/pkr-lab/capulus-core/pull/338): leerer Platzhalter statt Symlink, Handler; ergänzt durch den Restart-Drop-in aus PR #340 |
| Namespaces `zot` und `authelia` existierten weiter im TECH-Cluster, obwohl aus dem Repo entfernt | Am 24.09. manuell gelöscht; die PVs stehen auf `Released`, Daten liegen noch auf NAS bzw. Platte |
| `mealie-prod.pke-lab.de` liefert 404 | Vorbestehend (kein CNAME auf den PROD-Tunnel, TECH-Ingress entfernt), nicht Teil des Vorfalls und nicht angefasst |
| worker-0/worker-1 stehen seit dem 21.09. auf `NotReady` | Gewollt (`cluster_power_manager`); `ollama` bleibt deshalb `Progressing` |

---

## Runbook: bestehende Overlay-Disk eigenständig machen

Nötig für jede VM, die vor PR #340 angelegt wurde. Für `prod-vm` am 24.09. durchgeführt, für `entw-vm` noch offen. Die VM muss dafür **aus** sein, rechne mit wenigen Minuten Ausfall. Nur sinnvoll, solange die Basis-Datei seit Anlage der Disk **nicht ersetzt** wurde (Schritt 1). Sonst ist die Disk schon inkonsistent, und der Weg führt über die Wiederherstellung wie oben.

```bash
# 1. Zustand prüfen (VM darf laufen, --force-share)
sudo qemu-img info --force-share --backing-chain /var/lib/libvirt/images/prod-vm.qcow2   # "backing file:" vorhanden = Overlay
ls -l --time-style=long-iso /var/lib/libvirt/images/ubuntu-26.04-server-cloudimg-amd64.img /var/lib/libvirt/images/prod-vm.qcow2
# Änderungszeit der Basis darf NICHT neuer sein als die Anlage der Disk.

# 2. VM sauber herunterfahren
sudo virsh shutdown prod-vm && until sudo virsh domstate prod-vm | grep -q "shut off"; do sleep 3; done

# 3. Unabhängige Kopie erzeugen (liest Overlay + Basis, schreibt ein Image ohne Backing-File)
sudo qemu-img convert -O qcow2 /var/lib/libvirt/images/prod-vm.qcow2 /var/lib/libvirt/images/prod-vm-flat.qcow2
sudo qemu-img info /var/lib/libvirt/images/prod-vm-flat.qcow2 | grep -c "backing file"       # muss 0 ausgeben

# 4. Tauschen (das alte Overlay bleibt als Rückfall liegen)
sudo mv /var/lib/libvirt/images/prod-vm.qcow2 /var/lib/libvirt/images/prod-vm.qcow2.overlay-alt
sudo mv /var/lib/libvirt/images/prod-vm-flat.qcow2 /var/lib/libvirt/images/prod-vm.qcow2
sudo chown libvirt-qemu:kvm /var/lib/libvirt/images/prod-vm.qcow2

# 5. Starten und prüfen (vom Arbeitsplatz aus, dort steht der SSH-Alias prod-vm)
sudo virsh start prod-vm
ssh prod-vm 'sudo k3s kubectl get nodes'
```

Hinweis aus der Durchführung: `ssh prod-vm` in Schritt 5 lief zunächst in der homeserver-Shell und scheiterte mit „Could not resolve hostname". Der Alias `prod-vm` steht in der SSH-Config des Arbeitsplatzes, nicht auf dem homeserver.

Nach einigen Tagen ohne Auffälligkeiten `prod-vm.qcow2.overlay-alt` löschen. Für `entw-vm` (auf `worker-1`) gilt dasselbe mit `entw-vm.qcow2`.

---

## Runbook: PROD-VM neu aufgebaut, was in welcher Reihenfolge?

Falls die PROD-VM je wieder neu aufgebaut werden muss. Die Reihenfolge ergibt sich aus diesem Vorfall:

1. **Alte Disk sichern, nichts überschreiben.** Sie enthält Sealed-Secrets-Schlüssel, Intermediate-CA und die Nextcloud-Datenbank.
2. **Neue VM und k3s aufbauen** (`make libvirt-host`, `make prod`), noch **nichts** im Hub registrieren.
3. **Sealing-Key** aus der alten Disk zurückspielen (Namespace `sealed-secrets`, Label `…/sealed-secrets-key=active`).
4. **Nextcloud-Postgres** vorbereiten: PVC `nextcloud-postgresql-data` anlegen, `pgdata_pg18` hineinkopieren, **bevor** ArgoCD Nextcloud deployt.
5. **Cluster im Hub registrieren** (ServiceAccount, Token, `cluster-prod`), Längen von Token und CA prüfen, Application-Controller neu starten.
6. **Sofort danach** den Zugriff auf den Nextcloud-Postgres per NetworkPolicy sperren, bis `html` und `data` verbunden sind.
7. **NAS-Ordner** an die neuen PVC-Pfade umbenennen (Trockenlauf zuerst), Pods neu starten, dann die NetworkPolicy entfernen, aber erst, nachdem der Nextcloud-Pod mit der alten `config.php` läuft.
8. **Intermediate-CA** importieren (`homeserver-ca-keypair`), `Certificate` abwarten.
9. **Sweep** über alle Hosts, Datenprüfung je App (siehe [Verifikation](#7-verifikation)).

---

## Lessons Learned

**Was gut lief**

- Die Daten lagen auf dem NAS mit `Retain`, dadurch war der Vorfall ein Ausfall und kein Datenverlust.
- Die alte Disk blieb lesbar. Wer sie beim Neuaufbau überschrieben hätte, hätte den Sealing-Key, die CA und die Nextcloud-Datenbank verloren.
- GitOps hat den Wiederaufbau der Anwendungen selbst in Minuten erledigt, sobald der Cluster angebunden war.
- Die Wiederherstellung wurde schrittweise verifiziert (Daten je App), nicht nur über HTTP-Statuscodes.

**Was schlecht lief**

- Eine Provisionierungs-Rolle mit „einmalig" im Kommentar lief täglich und ersetzte eine Datei, von der Produktiv-VMs abhängen. Ein Kommentar ist keine Garantie: der Task musste selbst idempotent gegen Änderungen an der Quelle sein.
- Der Zustand, der nur auf der VM lag (Sealing-Key, Intermediate-CA), hatte keine zweite Kopie.
- Der Verlust der Hub-Anbindung fiel erst beim manuellen Prüfen am 24.09. auf. 16 Applications standen rund 21 Stunden auf `Unknown`, ein Alarm dazu ist nicht belegt.
- Die Wiederherstellung hing an Wissen, das nirgends stand: `pathPattern` fehlt, Nextcloud installiert sich bei leerem Volume neu, die PROD-Anbindung ist ein Handgriff.
- Manuelle Live-Änderungen (UFW 30080) waren nicht im Repo und wären bei einem Neuaufbau verloren gegangen.

---

## Offene Punkte

- [ ] **Semaphore-Lauf anstoßen** („Deploy Home Server"), damit ArgoCD-Ingress (`argocd.tech.homeserver` liefert bis dahin 404 mit gültigem Zertifikat), UFW-Beschränkung für 30080 und das dnsmasq-Drop-in angewendet werden.
- [ ] **`entw-vm` auf `worker-1` prüfen** (Schritt 1 des Runbooks) und die Disk bei Bedarf eigenständig machen. Hier ist mit demselben Schaden zu rechnen.
- [ ] **Aufräumen auf dem homeserver:** `/root/sealing-keys.yaml` mit `shred` löschen, `/mnt/oldprod` aushängen, `qemu-nbd --disconnect /dev/nbd0`. Nach einigen Tagen `prod-vm.qcow2.overlay-alt`, `prod-vm.qcow2.bak-pregrubfix` und `prod-vm.qcow2.corrupted-20260923` löschen (zusammen ca. 80 GB).
- [ ] **12 leere `*.leer-<zeit>`-Ordner auf dem NAS** löschen (`/volume1/k8s-storage`, `/volume2/immich-storage`). Der Ordner von Nextcloud `html` enthält einen halb kopierten Code-Stand.
- [ ] **PVs von `zot` und `authelia`** (`Released`) samt Daten entfernen, wenn sie nicht mehr gebraucht werden.
- [ ] **Sealed-Secrets-Schlüssel und Intermediate-CA sichern** (Passwort-Manager, siehe [d0060](../d-sicherheit/d0060-secrets-rotation.md)): pro Cluster `kubectl -n sealed-secrets get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml`, dazu `prod-ca.pem` und `prod-ca-key.pem`. Die Datei `~/prod-ca/cat prod ca key pem BEGIN.txt` enthält Schlüsseltext und gehört dort hinein und dann gelöscht.
- [ ] **Alarm für `Unknown`-Applications:** Applications im Status `Unknown` oder `OutOfSync` länger als ca. 10 Minuten melden (Grafana/vmalert, siehe [20050](../2-betrieb-hardware/20050-gitops-und-backup-alerts.md)).
- [ ] **StorageClass `nas`/`immich-nas` mit `pathPattern`** (z. B. `${.PVC.namespace}/${.PVC.name}`) ausstatten, damit ein neuer Cluster die alten Ordner wieder findet. Bestehende PVs müssen dabei migriert werden, daher vorher planen.
- [ ] **Wiederherstellungs-Skripte ins Repo** (`scripts/recovery/`): Extraktion von Sealing-Key und Zertifikat aus einer alten k3s-Disk, NAS-Umbenennung mit Trockenlauf.
- [ ] **Prüfen, ob `libvirt_host` täglich laufen muss.** Mit dem idempotenten Download ist es ungefährlich, aber eine Provisionierungs-Rolle muss nicht jeden Morgen gegen Produktiv-VMs laufen (Tag `libvirt-host` nur bei Bedarf).
- [ ] **`mealie-prod.pke-lab.de`** (404) klären, unabhängig vom Vorfall.
