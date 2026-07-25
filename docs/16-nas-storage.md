# NAS-Storage (UGREEN NAS, RAID1, NFS)

Persistenter Speicher für den k3s-Cluster liegt auf dem UGREEN NAS
(192.168.178.97, DNS-Name `ugreen-nas`) und ist als Kubernetes-StorageClass
`nas` verfügbar. Anders als die frühere `hdd`-StorageClass (7,3-TB-Platte
`/dev/sda` fest an worker-0 gebunden, siehe Git-Historie) ist `nas` per NFS
erreichbar — **jeder** k3s-Node kann PVCs dieser StorageClass mounten, es
gibt keine NodeAffinity-Pflicht mehr. Der Scheduler darf Pods frei über
homeserver/worker-0/worker-1 verteilen.

> **Zweiter, dedizierter Export für Immich:** Neben `nas` (→
> `/volume1/k8s-storage`) existiert eine zweite, unabhängige StorageClass
> `immich-nas` (→ `/volume2/immich-storage`, App
> `argocd/apps/immich-storage/`) — bewusst getrennt, damit die
> Fotobibliothek nicht im geteilten Cluster-Storage-Export landet. Details:
> [docs/35-immich.md](35-immich.md).

---

## Hardware

- 2× 4 TB im **RAID1** (Mirror) — nutzbare Kapazität ~4 TB, 1 Platte darf
  ausfallen.
- 1× 2 TB aktuell **nicht** Teil des Storage-Pools — ungenutzte Reserve,
  spätere Verwendung noch offen.
- Netzwerk: 192.168.178.97 (LAN), DNS-Alias `ugreen-nas` (siehe
  `ansible/roles/dnsmasq/templates/dnsmasq.conf.j2`).

### RAID-Kapazitätshinweis

Klassisches RAID5 über alle drei Platten würde alle Mitgliedsplatten auf
die Größe der kleinsten Platte herunterrechnen: effektiv 3×2TB nutzbare
Rohkapazität, davon `(n-1)×kleinste = 2×2TB = 4TB` nutzbar — von 10 TB
Rohkapazität gingen 6 TB verloren, und die 2-TB-Platte wäre fest gebunden.

**Entscheidung: RAID1 nur über die beiden 4-TB-Platten.** Nutzbare
Kapazität ist mit ~4 TB identisch zu RAID5-über-alle-3-Platten, der Mirror
ist aber einfacher/robuster (kein Parity-Rebuild), und die 2-TB-Platte
bleibt als Reserve frei statt fest in einen RAID-Verbund eingebunden zu
sein.

| Option | Nutzbare Kapazität | Ausfallsicherheit | Hinweis |
|---|---|---|---|
| RAID5 über alle 3 Platten | ~4 TB | 1 Platte darf ausfallen | bindet die 2-TB-Platte fest ein, kein Spielraum für spätere Nutzung |
| **RAID1 über die 2×4TB-Platten (gewählt)** | ~4 TB | 1 Platte darf ausfallen | einfacher Mirror, 2-TB-Platte bleibt als Reserve frei |
| UGOS-eigenes Hybrid-RAID über alle 3 Platten (falls vom Gerät unterstützt, analog Synology SHR) | ~6 TB | 1 Platte darf ausfallen | beste Kapazitätsausnutzung bei gemischten Plattengrößen — bindet aber alle 3 Platten fest ein |

Die tatsächlich nutzbare Kapazität zeigt der UGOS-Speicherpool-Assistent vor
dem endgültigen Anlegen des Pools an.

---

## NFS-Export in UGOS einrichten (manuell, kein Ansible-Playbook)

Das NAS läuft auf einer eigenen Firmware (UGOS) — es gibt bewusst **kein**
Ansible-Playbook dafür (anders als worker-0/worker-1, die reine Ubuntu-Hosts
sind). Einrichtung über die UGOS-Weboberfläche:

1. Storage-Pool anlegen (RAID1, siehe oben) → Speicherplatz/Freigabe erstellen,
   z. B. `k8s-storage`.
2. NFS-Dienst aktivieren (Systemsteuerung → Dateidienste → NFS).
3. Für die Freigabe `k8s-storage` einen NFS-Regel-Eintrag anlegen:
   - Erlaubte Hosts: `192.168.178.0/24` (LAN-Subnetz reicht; genauer geht
     `192.168.178.94/32`, `192.168.178.95/32`, `192.168.178.96/32` für nur
     die drei k3s-Nodes)
   - Berechtigung: Lese-/Schreibzugriff
   - Squash: `no_root_squash` (der Provisioner legt Verzeichnisse als root an)
4. Exportpfad notieren (z. B. `/volume1/k8s-storage` — der genaue Pfad hängt
   vom NAS-Modell/UGOS-Version ab) und in
   `argocd/apps/nas-storage/deployment.yaml` (`NFS_SERVER`/`NFS_PATH` sowie
   den `nfs`-Volume-Block) eintragen — dort stehen aktuell Platzhalter.
5. Verbindung testen, bevor die App im Cluster deployed wird:
   ```bash
   # von einem k3s-Node aus:
   sudo mount -t nfs 192.168.178.97:/volume1/k8s-storage /mnt
   touch /mnt/test && ls /mnt && sudo umount /mnt
   ```

---

## StorageClass `nas` verwenden

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: meine-app-daten
  namespace: meine-app
spec:
  storageClassName: nas
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
```

Kein NodeAffinity nötig — der Pod darf auf jedem Node schedulen:

```bash
kubectl -n nas-storage get pods
kubectl get storageclass nas
kubectl get pvc -A | grep nas
```

Die App `nas-storage` (`argocd/apps/nas-storage/`) deployt dafür den
`nfs-subdir-external-provisioner`, der PVCs als Unterverzeichnisse auf dem
NFS-Export anlegt.

---

## Monitoring (Grafana "Home Server Auslastung")

Das NAS ist kein k3s-Node und wird daher nicht vom `prometheus-node-exporter`-
DaemonSet erfasst. Stattdessen laufen zwei Exporter **manuell als Docker-
Container direkt auf dem NAS** (UGOS unterstützt Docker über die App
"Container Manager"/SSH — analog zum Docker-Compose-Setup auf anderen
UGREEN-Geräten in diesem Fleet). `argocd/apps/monitoring/templates/
vmstaticscrape-ugreen-nas.yaml` zapft beide per `VMStaticScrape` an; das
Dashboard `dashboard-homeservers.yaml` erwartet die Metriken unter
`instance="ugreen-nas"`.

1. **node_exporter** (CPU/RAM/Netzwerk/Disk-Auslastung, Temperatur) —
   erscheint dadurch automatisch in allen bestehenden Panels des
   `$instance`-Filters:
   ```bash
   docker run -d --name node-exporter --restart unless-stopped \
     --net host --pid host \
     -v /:/host:ro,rslave \
     prom/node-exporter:latest \
     --path.rootfs=/host
   ```
2. **smartctl_exporter** (S.M.A.R.T.-Werte je Platte: Health, Temperatur,
   Betriebsstunden — eigene Sektion ganz unten im Dashboard). Braucht
   Zugriff auf die Block-Devices, daher `--privileged`:
   ```bash
   docker run -d --name smartctl-exporter --restart unless-stopped \
     --net host --privileged \
     -v /dev:/dev:ro \
     prometheuscommunity/smartctl-exporter:latest
   ```

Ports `9100` (node_exporter) und `9633` (smartctl_exporter) müssen von den
k3s-Nodes aus erreichbar sein (ggf. UGOS-Firewall-Regel analog zum NFS-Export
oben ergänzen). Nach dem Start:

```bash
curl 192.168.178.97:9100/metrics | head
curl 192.168.178.97:9633/metrics | head
```

Metrik-Namen (`smartctl_device_smart_status`, `smartctl_device_temperature`,
`smartctl_device_power_on_hours`, Label `device`) stammen vom
`prometheuscommunity/smartctl-exporter`-Image — bei Abweichungen die Panel-
Queries in `dashboard-homeservers.yaml` gegen die tatsächliche `/metrics`-
Ausgabe abgleichen.

---

## Migrations-Runbook: `hdd` (worker-0/sda) → `nas` (NAS)

Betroffen sind 9 PVCs über 8 Apps: `n8n`, `monitoring` (vmsingle),
`paperless-ngx` (5× — data/media/consume/export/redis), `wikijs`
(postgresql), `zammad` (2× — primary DB, redis), `mealie`, `grocy`,
`uptime-kuma`, `minio`. `storageClassName` ist auf bestehenden PVCs
unveränderlich — die `values.yaml`-Änderungen (bereits committet) sind daher
gefahrlos: ArgoCD zeigt nur `OutOfSync`, bis die Daten pro App manuell
migriert werden.

**Voraussetzung:** `nas-storage`-App ist deployt, `kubectl get storageclass
nas` existiert, NFS-Export ist erreichbar (siehe oben).

### Ablauf pro App

```
1. Auto-Sync der App in ArgoCD pausieren
2. Workload auf 0 Replicas skalieren (stoppt Schreibzugriffe)
3. Temp-Pod auf ALTER PVC starten
4. Temp-PVC auf "nas" anlegen (anderer Name als Original)
5. Temp-Pod auf NEUER (nas) PVC starten
6. Daten Pod-zu-Pod kopieren (tar-Pipe über kubectl exec)
7. Alte PVC löschen
8. ArgoCD syncen → Chart legt frische PVC mit Original-Namen auf "nas" an
9. Daten von Temp-PVC in die frische PVC kopieren
10. Temp-Pod + Temp-PVC löschen, Workload wieder hochskalieren, Auto-Sync reaktivieren
```

### Befehle

```bash
NS=<namespace>            # z.B. minio / monitoring / wikijs
OLD_PVC=<alte-pvc>         # kubectl get pvc -n $NS
APP_KIND=deployment        # oder: statefulset / vmsingle (Operator-CRD)
APP_NAME=<workload-name>

# 1. Auto-Sync pausieren (ArgoCD UI: App → ... → Disable Auto-Sync)
argocd app set $NS --sync-policy none

# 2. Herunterskalieren
kubectl -n $NS scale $APP_KIND/$APP_NAME --replicas=0
# Operator-CRD (z.B. VMSingle) statt scale:
# kubectl -n $NS patch vmsingle $APP_NAME --type merge -p '{"spec":{"replicaCount":0}}'

# 3. Source-Pod auf der alten PVC
kubectl -n $NS run migrate-source --image=alpine:3.20 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"shell","image":"alpine:3.20","command":["sleep","3600"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"'$OLD_PVC'"}}]}}'

# 4. Temp-PVC auf nas (Größe an Original anpassen)
kubectl -n $NS apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${OLD_PVC}-nas-migration
spec:
  storageClassName: nas
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 10Gi
EOF

# 5. Target-Pod auf der neuen (nas) PVC
kubectl -n $NS run migrate-target --image=alpine:3.20 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"shell","image":"alpine:3.20","command":["sleep","3600"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"'$OLD_PVC'-nas-migration"}}]}}'

# 6. Kopieren + verifizieren
kubectl -n $NS exec migrate-source -- tar cf - -C /data . | \
  kubectl -n $NS exec -i migrate-target -- tar xf - -C /data
kubectl -n $NS exec migrate-source -- du -sh /data
kubectl -n $NS exec migrate-target -- du -sh /data   # Größen vergleichen!

# 7. Alte PVC löschen (erst wenn 6. verifiziert ist!)
kubectl -n $NS delete pod migrate-source
kubectl -n $NS delete pvc $OLD_PVC

# 8. ArgoCD syncen → legt frische PVC mit Original-Namen auf nas an
argocd app sync $NS

# 9. Daten von Temp-PVC in die frische PVC kopieren
kubectl -n $NS run migrate-restore --image=alpine:3.20 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"shell","image":"alpine:3.20","command":["sleep","3600"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"'$OLD_PVC'"}}]}}'
kubectl -n $NS exec migrate-target -- tar cf - -C /data . | \
  kubectl -n $NS exec -i migrate-restore -- tar xf - -C /data

# 10. Aufräumen + hochskalieren
kubectl -n $NS delete pod migrate-target migrate-restore
kubectl -n $NS delete pvc ${OLD_PVC}-nas-migration
kubectl -n $NS scale $APP_KIND/$APP_NAME --replicas=1
argocd app set $NS --sync-policy automated --auto-prune --self-heal
```

> **Hinweis VictoriaMetrics (`vmsingle`):** Der Operator verwaltet Deployment
> + PVC selbst; Namen vorab mit `kubectl -n monitoring get pvc,deploy`
> prüfen (typischerweise `vmsingle-<release>-victoria-metrics-k8s-stack`).
>
> **Hinweis MinIO:** PVC- und Deployment-Name sind im Standalone-Modus
> üblicherweise schlicht `minio` (`kubectl -n minio get pvc,deploy`).

### Sonderfall: tinyteller

Lief vorher **nicht** über die `hdd`-StorageClass, sondern als
Docker-Compose direkt auf worker-0 (`/opt/...`, System-SSD). Ist jetzt eine
eigene ArgoCD-App (`argocd/apps/tinyteller`) und braucht kein
PVC-Migrations-Runbook wie oben — **tinyteller** ist zustandslos, nichts zu
migrieren, einfach die neue App syncen lassen.

---

## Rückbau (nach erfolgreicher Migration & Verifikation)

Diese Schritte sind **nicht** Teil des Migrations-Commits — erst ausführen,
wenn alle 9 PVCs oben verifiziert auf `nas` laufen:

```bash
# 1. hdd-storage-App aus ArgoCD entfernen
git rm -r argocd/apps/hdd-storage/

# 2. Auf worker-0: sda aushängen und aus /etc/fstab entfernen
ssh ubuntu@192.168.178.95 'sudo umount /mnt/hdd; sudo sed -i "\|/mnt/hdd|d" /etc/fstab'

# 3. Optional: Festplatte physisch entfernen oder anderweitig nutzen
```

---

## Fehlerbehebung

### PVC bleibt `Pending`

```bash
kubectl describe pvc <name> -n <namespace>
# Häufige Ursache: nas-storage-Provisioner-Pod läuft nicht, oder der
# NFS-Export ist vom Node aus nicht erreichbar (nfs-common fehlt, Firewall
# auf dem NAS blockt den Node)

kubectl -n nas-storage get pods
kubectl -n nas-storage logs deploy/nas-nfs-subdir-external-provisioner
```

### NFS-Mount schlägt fehl

```bash
# nfs-common muss auf JEDEM k3s-Node installiert sein (ansible/roles/k3s_agent)
ssh ubuntu@192.168.178.95 'dpkg -l | grep nfs-common'

# Manueller Mount-Test vom Node aus:
ssh ubuntu@192.168.178.95 'sudo mount -t nfs 192.168.178.97:/volume1/k8s-storage /mnt && sudo umount /mnt'
```

### Speicher fast voll

Auf dem NAS selbst über UGOS prüfen (Speicher-Manager → Auslastung).

---

## Neue Anwendung hinzufügen (Checkliste)

```
[ ] PVC mit storageClassName: nas anlegen
[ ] KEINE NodeAffinity nötig (anders als früher bei "hdd")
[ ] ArgoCD-App in argocd/apps/<name>/ anlegen
[ ] Nach Merge: kubectl -n <namespace> get pvc prüfen (Status: Bound)
```

---

## Backups auf externer NAS-Platte

Eine externe USB-Platte hängt direkt am UGREEN NAS und sichert regelmäßig
**beide** Storage-Pools (`volume1` inkl. `k8s-storage` und `volume2` inkl.
`immich-storage`) per restic (inkrementell, dedupliziert, verschlüsselt).
Läuft als UGOS-Task-Scheduler-Job direkt auf dem NAS, analog zur
Monitoring-Exporter-Einrichtung oben. Vollständige Anleitung inkl.
Zeitplan-Empfehlungen und Restore: **[docs/36-nas-backup.md](36-nas-backup.md)**.
