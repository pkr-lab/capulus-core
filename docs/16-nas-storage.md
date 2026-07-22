# NAS-Storage (UGREEN NAS, RAID5, NFS)

Persistenter Speicher für den k3s-Cluster liegt auf dem UGREEN NAS
(192.168.178.97, DNS-Name `ugreen-nas`) und ist als Kubernetes-StorageClass
`nas` verfügbar. Anders als die frühere `hdd`-StorageClass (7,3-TB-Platte
`/dev/sda` fest an worker-0 gebunden, siehe Git-Historie) ist `nas` per NFS
erreichbar — **jeder** k3s-Node kann PVCs dieser StorageClass mounten, es
gibt keine NodeAffinity-Pflicht mehr. Der Scheduler darf Pods frei über
homeserver/worker-0/worker-1 verteilen.

---

## Hardware

- 2× 4 TB + 1× 2 TB, geplant als **RAID5** über alle drei Platten.
- Netzwerk: 192.168.178.97 (LAN), DNS-Alias `ugreen-nas` (siehe
  `ansible/roles/dnsmasq/templates/dnsmasq.conf.j2`).

### RAID5-Kapazitätshinweis

Klassisches RAID5 rechnet **alle** Mitgliedsplatten auf die Größe der
kleinsten Platte herunter. Bei 2×4TB + 1×2TB heißt das: effektiv 3×2TB
nutzbare Rohkapazität, davon RAID5 `(n-1)×kleinste = 2×2TB = 4TB` nutzbar —
von 10 TB Rohkapazität gehen **6 TB verloren** (4 TB Parität/Verschnitt auf
den beiden 4-TB-Platten + die RAID5-Parität selbst). Vor dem Anlegen des
Storage-Pools in UGOS abwägen:

| Option | Nutzbare Kapazität | Ausfallsicherheit | Hinweis |
|---|---|---|---|
| RAID5 über alle 3 Platten | ~4 TB | 1 Platte darf ausfallen | verschenkt die Mehrkapazität der 4-TB-Platten |
| RAID5 nur über die 2×4TB-Platten, 2-TB-Platte separat (JBOD/einzeln) | ~4 TB (RAID5) + 2 TB (einzeln, ohne Redundanz) | RAID5-Teil: 1 Platte darf ausfallen; Einzelplatte: keine Redundanz | mehr Gesamtkapazität (~6 TB), aber die Einzelplatte ist ein Risiko — passt z. B. für unkritische Scratch-/Backup-Daten |
| UGOS-eigenes Hybrid-RAID (falls vom Gerät unterstützt, analog Synology SHR) | ~6 TB | 1 Platte darf ausfallen | beste Kapazitätsausnutzung bei gemischten Plattengrößen — **am Gerät prüfen, ob UGOS das für dieses Modell anbietet** |

Die finale Entscheidung triffst du am Gerät (UGOS-Speicher-Manager zeigt die
tatsächlich nutzbare Kapazität pro Option an, bevor der Pool angelegt wird).

---

## NFS-Export in UGOS einrichten (manuell, kein Ansible-Playbook)

Das NAS läuft auf einer eigenen Firmware (UGOS) — es gibt bewusst **kein**
Ansible-Playbook dafür (anders als worker-0/worker-1, die reine Ubuntu-Hosts
sind). Einrichtung über die UGOS-Weboberfläche:

1. Storage-Pool anlegen (RAID5, siehe oben) → Speicherplatz/Freigabe erstellen,
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

### Sonderfälle: tinyteller & day-pilot

Diese beiden liefen vorher **nicht** über die `hdd`-StorageClass, sondern
als Docker-Compose direkt auf worker-0 (`/opt/...`, System-SSD). Sie sind
jetzt eigene ArgoCD-Apps (`argocd/apps/tinyteller`, `argocd/apps/day-pilot`)
und brauchen kein PVC-Migrations-Runbook wie oben:

- **tinyteller** ist zustandslos — nichts zu migrieren, einfach die neue App
  syncen lassen.
- **day-pilot** hat Postgres+Redis-Daten unter `/opt/day-pilot` auf
  worker-0. Empfohlen: `pg_dump`/`pg_restore` statt Tar-Copy (sauberer bei
  Postgres-Major-Version-Sprüngen):
  ```bash
  # Auf worker-0, aus dem laufenden Compose-Container:
  docker exec day-pilot-db pg_dump -U daypilot daypilot > daypilot.sql

  # Nach dem Deploy der neuen day-pilot-App im Cluster:
  kubectl -n day-pilot exec -i deploy/day-pilot-postgres -- \
    psql -U daypilot -d daypilot < daypilot.sql
  ```
  Redis ist reiner Cache/Queue-Zustand — muss nicht migriert werden, baut
  sich beim ersten Request neu auf.

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

## Ausblick: Backups auf externer NAS-Platte

Eine externe USB-Platte soll später direkt am UGREEN NAS angeschlossen
werden, für regelmäßige Backups der wichtigsten Daten (Vaultwarden-Vault,
Paperless-Dokumente). **Das ist explizit nicht Teil dieser Migration** —
erst nachdem die Datenmigration oben abgeschlossen und verifiziert ist.
Geplanter Ansatz für eine spätere Iteration:

- Backup-Job (z. B. `CronJob` im Cluster oder ein UGOS-eigener Backup-Task)
  sichert Vaultwarden-PVC (`argocd/apps/vaultwarden`, aktuell auf
  `local-path`) und die Paperless-`data`/`media`-PVCs (jetzt auf `nas`)
  regelmäßig auf die externe Platte.
- Restic oder rsync als Werkzeug, verschlüsselt bei Vaultwarden-Daten.
- Eigene Doku + Ansible-Rolle folgt in einem eigenen Branch, sobald die
  externe Platte angeschlossen ist.
