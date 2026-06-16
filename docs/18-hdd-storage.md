# HDD-Storage auf worker-0 (sda, 7,3 TB)

Die 7,3-TB-Festplatte (sda) an worker-0 (192.168.178.95) ist als
Kubernetes-StorageClass `hdd` verfügbar. Alle Anwendungen die größere
Mengen persistenter Daten benötigen nutzen diese StorageClass.

## Architektur

```
worker-0 (192.168.178.95)
└── /dev/sda (7,3 TB, via fstab persistent gemountet)
    └── /mnt/hdd/
        ├── k8s-storage/      ← StorageClass "hdd" provisioniert hier
        │   ├── pvc-<uuid>/   ← automatisch von Kubernetes angelegt
        │   └── ...
        ├── backups/          ← manuelle Backups
        ├── media/            ← Mediendateien
        └── windeployment/    ← (legacy, jetzt per PVC verwaltet)

Kubernetes (hdd-storage Namespace)
└── local-path-provisioner (homelab.io/hdd-path)
    └── StorageClass "hdd"
        ├── reclaimPolicy: Retain   ← Daten bleiben beim PVC-Löschen erhalten
        ├── WaitForFirstConsumer    ← PV entsteht erst beim Pod-Scheduling
        └── nodePathMap → nur worker-0
```

## StorageClass `hdd` verwenden

### PVC anlegen

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: meine-app-daten
  namespace: meine-app
spec:
  storageClassName: hdd       # ← HDD-Storage
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi          # Beliebige Größe bis ~7 TB
```

### Pod / Deployment (NodeAffinity Pflicht)

Da die Festplatte ausschließlich auf worker-0 liegt, müssen Pods mit
`hdd`-PVCs dort schedulen. **NodeAffinity ist Pflicht:**

```yaml
spec:
  template:
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: In
                    values:
                      - worker-0
      volumes:
        - name: daten
          persistentVolumeClaim:
            claimName: meine-app-daten
      containers:
        - name: app
          volumeMounts:
            - name: daten
              mountPath: /data
```

> **Warum NodeAffinity?**  
> `local-path-provisioner` legt Volumes als lokale Verzeichnisse auf
> dem jeweiligen Node an. Ohne NodeAffinity würde Kubernetes versuchen,
> den Pod auf dem Control-Plane (homeserver) zu schedulen — dort gibt es
> aber keinen `hdd`-Provisioner und der PVC bleibt ewig `Pending`.

## Vergleich der StorageClasses

| | `local-path` (Standard) | `hdd` |
|---|---|---|
| Speicherort | `/var/lib/rancher/k3s/storage` | `/mnt/hdd/k8s-storage` |
| Node | homeserver (Control-Plane) | worker-0 |
| Kapazität | begrenzt (System-SSD) | ~7,3 TB |
| reclaimPolicy | Delete | **Retain** |
| Geeignet für | kleine Configs, temporäre Daten | große Daten, Medien, ISO-Images |

## Einrichtung (Ansible)

Die Festplatte wird von der Ansible-Rolle `hdd_storage` eingerichtet:

```bash
# Nur HDD-Rolle ausführen:
make hdd

# Oder als Teil des vollständigen worker-0 Setups:
make worker-0
```

Die Rolle:
1. Ermittelt UUID von `/dev/sda` via `blkid`
2. Trägt die Festplatte mit UUID in `/etc/fstab` ein (`nofail`)
3. Legt Verzeichnisstruktur unter `/mnt/hdd` an

## Kubernetes-App `hdd-storage`

Die ArgoCD-App `hdd-storage` deployt:
- Einen eigenen `local-path-provisioner` mit Provisioner-Name `homelab.io/hdd-path`
- Die StorageClass `hdd`
- RBAC (ServiceAccount, ClusterRole, ClusterRoleBinding)

```bash
# Status prüfen:
kubectl -n hdd-storage get pods
kubectl get storageclass hdd

# Aktuelle PVCs auf HDD:
kubectl get pvc -A | grep hdd

# Belegter Speicher auf worker-0:
ssh ubuntu@192.168.178.95 'df -h /mnt/hdd && du -sh /mnt/hdd/k8s-storage/*'
```

## Neue Anwendung hinzufügen (Checkliste)

```
[ ] PVC mit storageClassName: hdd anlegen
[ ] NodeAffinity (kubernetes.io/hostname: worker-0) im Deployment setzen
[ ] Sinnvolle Größe wählen (df -h /mnt/hdd auf worker-0 prüfen)
[ ] ArgoCD-App in argocd/apps/<name>/ anlegen
[ ] Nach Merge: kubectl -n <namespace> get pvc prüfen (Status: Bound)
```

## reclaimPolicy: Retain — was das bedeutet

Die StorageClass `hdd` hat `reclaimPolicy: Retain`. Das bedeutet:
- Wenn eine PVC gelöscht wird, bleibt das PersistentVolume (und das Verzeichnis
  auf der Festplatte) erhalten
- Das PV wechselt in den Status `Released`
- Die Daten müssen manuell gesichert / gelöscht werden

```bash
# Released PVs anzeigen:
kubectl get pv | grep Released

# PV manuell löschen (erst nach Datensicherung!):
kubectl delete pv <pv-name>

# Verzeichnis auf worker-0 dann manuell löschen:
ssh ubuntu@192.168.178.95 'sudo rm -rf /mnt/hdd/k8s-storage/<pv-name>'
```

## Fehlerbehebung

### PVC bleibt `Pending`

```bash
kubectl describe pvc <name> -n <namespace>
# Häufige Ursache: Pod läuft nicht auf worker-0 (NodeAffinity fehlt)
# oder hdd-storage Provisioner-Pod läuft nicht

kubectl -n hdd-storage get pods
kubectl -n hdd-storage logs deploy/hdd-local-path-provisioner
```

### Festplatte nach Reboot nicht gemountet

```bash
# Auf worker-0:
ssh ubuntu@192.168.178.95 'cat /etc/fstab | grep mnt/hdd'
ssh ubuntu@192.168.178.95 'mount | grep /mnt/hdd'

# Manuell mounten (Neustart von Ansible-Rolle nötig wenn fstab fehlt):
make hdd
```

### Speicher fast voll

```bash
ssh ubuntu@192.168.178.95 'df -h /mnt/hdd'
ssh ubuntu@192.168.178.95 'du -sh /mnt/hdd/k8s-storage/* | sort -rh | head -20'
```
