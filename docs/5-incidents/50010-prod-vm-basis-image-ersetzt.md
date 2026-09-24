# Incident-Report — 23.09.2026: PROD-VM startet nicht mehr, Basis-Image war ausgetauscht

| Zeit/Status | Ereignis |
|---|---|
| 18.09. 13:13 | `prod-vm` wird von der Rolle `libvirt_host` angelegt: Disk = **Overlay** (`qemu-img create -b …`) auf `ubuntu-26.04-server-cloudimg-amd64.img` |
| 21.09. 06:11 | Die Basis-Datei wird **ersetzt** (Änderungszeit der Datei). Der tägliche Semaphore-Lauf „Deploy Home Server" beginnt um 06:00 |
| 23.09. 06:02 | Letzter sauberer Shutdown der VM (Postgres-Logs: „shut down at 04:02 UTC"), danach startet sie nicht mehr (GRUB) |
| 23.09. 20:15–20:27 | Reparaturversuch, Sicherung der alten Disk (`prod-vm.qcow2.bak-pregrubfix`, `.corrupted-20260923`), **VM komplett neu angelegt** |
| 23.09. 20:31 | Hub-ArgoCD verliert den PROD-Cluster (`x509: certificate signed by unknown authority`), alle `prod-*`-Apps `Unknown` |
| 24.09. | Wiederherstellung (siehe unten): alle PROD-Apps wieder mit ihren Daten und gültigem Zertifikat |

**Ausfall:** rund 24 Stunden, alle PROD-Dienste (Nextcloud, Immich, Mealie, Paperless, Wiki.js, Xibo, tinyteller, whoami, demo).
**Datenverlust:** keiner. Die Nutzerdaten lagen auf dem NAS (`Retain`); die einzige lokale Datenbank (Nextcloud-Postgres auf `local-path`) und der Sealed-Secrets-Schlüssel konnten aus der alten Disk gerettet werden.

---

## Ursache

`ansible/roles/libvirt_host/tasks/main.yml` lud das Basis-Image mit `get_url` herunter, **ohne zu prüfen, ob die Datei schon existiert**. Bei vorhandenem Ziel sendet `get_url` ein `If-Modified-Since` und **überschreibt die Datei**, sobald Canonical unter derselben URL (`…/releases/resolute/release/…`) ein neueres Build veröffentlicht. Der tägliche Semaphore-Lauf (`0 6 * * *`, `ansible/site.yml`, Rolle `libvirt_host` steht darin) hat das Basis-Image deshalb bei einem neuen Build ausgetauscht.

Die VM-Disk war ein **Overlay** auf genau dieser Datei. Die laufende VM merkt davon nichts (QEMU hält das alte, ersetzte Image offen). Beim **nächsten Start** öffnet QEMU aber die neue Basis: Blöcke, die nur in der Basis liegen (Bootloader, Dateisystem-Metadaten), passen nicht mehr zu dem, was das Overlay erwartet. Ergebnis: GRUB startet nicht.

Das ist die wahrscheinlichste Erklärung und passt zu allen Beobachtungen (Zeitpunkt 06:11, Overlay vom 18.09., Startproblem erst nach dem ersten Neustart der VM). Direkt nachgewiesen wurde es nicht; das beschädigte Image liegt noch als `prod-vm.qcow2.corrupted-20260923` auf dem homeserver.

**Dieselbe Rolle** läuft auf `worker-1` für die ENTW-VM (`ansible/worker-1.yml`, nächtlich über `nightly_worker_wake`). Die `entw-vm` ist damit **vermutlich ebenfalls betroffen** und sollte bei nächster Gelegenheit geprüft werden (siehe Runbook unten).

## Folgen für PROD und was wiederhergestellt werden musste

| Was | Warum kaputt | Wiederherstellung |
|---|---|---|
| Cluster im ArgoCD-Hub | Neue VM = neue k3s-CA, kein `argocd-manager`-ServiceAccount mehr | ServiceAccount + Token neu angelegt, Secret `cluster-prod` ersetzt, `argocd-application-controller` neu gestartet |
| SealedSecrets (cloudflared, immich, nextcloud, wikijs, wiki-docs-sync, xibosignage) | Mit dem Schlüssel des alten PROD-Controllers versiegelt | Schlüssel aus dem `state.db` der alten Disk zurückgespielt (k3s `secrets-encryption` ist an, der AES-Schlüssel liegt in `cred/encryption-config.json` derselben Disk) |
| Nextcloud-Datenbank | Postgres lag auf `local-path` der VM | `pgdata_pg18` aus der alten Disk in einen vorab angelegten PVC kopiert, **bevor** ArgoCD Nextcloud deployt |
| Alle NAS-Volumes | Die StorageClass `nas` hat kein `pathPattern`; der Provisioner legte pro neuer PVC einen **neuen, leeren** Ordner an. Die alten Ordner blieben (`Retain`), hingen aber an keiner PV mehr | Alte Ordner per `mv` auf die Pfade der neuen PVs umbenannt (12 Verzeichnisse), Pods neu gestartet |
| HTTPS für `*.prod.homeserver` | Das Secret `homeserver-ca-keypair` (Intermediate-CA) wird laut [d0040](../d-sicherheit/d0040-internal-tls.md) einmalig von Hand importiert und liegt nicht im Repo | Zertifikat aus der alten Disk extrahiert, gegen Root-CA und lokalen Schlüssel geprüft, importiert |

**Stolperfallen, die bei einer Wiederholung teuer werden:**

- **Nextcloud installiert sich selbst neu.** Der Chart setzt `NEXTCLOUD_ADMIN_USER`/`-PASSWORD` und die `POSTGRES_*`-Variablen. Findet der Container ein **leeres `html`-Volume**, führt er `occ maintenance:install` gegen die vorhandene Datenbank aus und überschreibt `instanceid`, `secret` und `passwordsalt`. Vorher den Zugriff auf Postgres sperren (NetworkPolicy), bis `html` und `data` mit den alten NAS-Daten verbunden sind.
- **Globs unter `/var/lib/rancher/…` und dem kubelet-Pfad** müssen als root expandiert werden (`sudo sh -c '…'`), sonst bleiben Variablen leer.
- **`kubectl scale` gegen selfHeal:** ArgoCD dreht manuelle Replika-Änderungen zurück. Zum Sperren einer App eignen sich NetworkPolicies oder Änderungen im Repo.

## Gegenmaßnahmen (umgesetzt im Repo)

| Maßnahme | Wo |
|---|---|
| Basis-Image wird **nur noch heruntergeladen, wenn es fehlt**, nie ersetzt | `ansible/roles/libvirt_host/tasks/main.yml` |
| Neue VMs bekommen eine **eigenständige Disk** (`qemu-img convert` + `resize`), kein Overlay | `ansible/roles/libvirt_host/tasks/vm.yml` |
| Bestehende Overlay-Disks erzeugen bei jedem Lauf eine **Warnung** | `ansible/roles/libvirt_host/tasks/vm.yml` |
| VMs fahren beim Host-Neustart **sauber herunter** (`ON_SHUTDOWN=shutdown`, 300 s) statt den Arbeitsspeicher zu sichern | `ansible/roles/libvirt_host/tasks/main.yml`, `defaults/main.yml` |
| `libvirt-guests` startet **nach** dnsmasq und Tailscale (die VM löst Namen über den dnsmasq des Hosts auf) | Drop-in `libvirt-guests.service.d/10-ordering.conf` |
| dnsmasq startet bei Fehlern **automatisch neu** (`Restart=on-failure`, kein Start-Limit) | `ansible/roles/dnsmasq/tasks/main.yml` |

## Runbook: bestehende Overlay-Disk eigenständig machen

Nötig für `prod-vm` (angelegt vor dieser Änderung) und vermutlich `entw-vm`. Die VM muss dafür **aus** sein, rechne mit wenigen Minuten Ausfall. Nur sinnvoll, solange die Basis-Datei seit Anlage der Disk **nicht ersetzt** wurde (Schritt 1). Sonst ist die Disk schon inkonsistent, und der Weg führt über die Wiederherstellung wie oben.

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

# 5. Starten und prüfen
sudo virsh start prod-vm
ssh prod-vm 'sudo k3s kubectl get nodes'
```

Nach einigen Tagen ohne Auffälligkeiten `prod-vm.qcow2.overlay-alt` löschen. Für `entw-vm` (auf `worker-1`) gilt dasselbe mit `entw-vm.qcow2`.

## Was zusätzlich gesichert sein sollte

Die Wiederherstellung war nur möglich, weil die alte Disk noch lesbar war. Ohne sie wären der Sealed-Secrets-Schlüssel des PROD-Controllers und die Intermediate-CA verloren gewesen. Beides gehört in den Passwort-Manager (siehe [d0060](../d-sicherheit/d0060-secrets-rotation.md)): der Sealed-Secrets-Schlüssel jedes Clusters (`kubectl -n sealed-secrets get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml`) und `prod-ca.pem` samt `prod-ca-key.pem`. Zur Einordnung des Multi-Cluster-Aufbaus: [40080](../4-planung/40080-multi-cluster-entw-prod-tech.md).
