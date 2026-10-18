# 007 k3s-Kubeconfig (cluster-admin) wird mit Modus 0644 geschrieben

- Severity: Medium
- Bereich: Repo
- Betroffen: `ansible/roles/k3s/templates/k3s-config.yaml.j2:3` (`write-kubeconfig-mode: "0644"`), Datei `/etc/rancher/k3s/k3s.yaml` auf dem Control-Plane-Host (homeserver, nicht worker0/1)
- Status: Behoben am 2026-10-17

## Beschreibung

Die k3s-Serverkonfiguration setzt `write-kubeconfig-mode: "0644"`. Die Kubeconfig enthält ein Client-Zertifikat samt Schlüssel mit Gruppe `system:masters` (cluster-admin) und ist damit für jeden lokalen Benutzer des Hosts und jeden Prozess mit Lesezugriff auf `/etc` lesbar. Der Host ist der Control-Plane-Knoten (homeserver), nicht worker-0/-1. Er gehört nicht zu den in diesem Auftrag benannten Hosts, die Prüfung auf dem Host steht deshalb aus.

## Nachweis

```
$ sed -n 1,5p ansible/roles/k3s/templates/k3s-config.yaml.j2
---
write-kubeconfig-mode: "0644"
tls-san:
  - "{{ k3s_server_ip }}"

$ grep -rn 'k3s.yaml' ansible/roles | head -3
ansible/roles/cluster_power_manager/defaults/main.yml:24:cluster_power_manager_kubeconfig: /etc/rancher/k3s/k3s.yaml
```
Auf dem Host zu prüfen: `stat -c '%a %U:%G' /etc/rancher/k3s/k3s.yaml`

## Phase-2-Nachweis (live, lesend)

Live-Stand:

```
homeserver  644 root:root /etc/rancher/k3s/k3s.yaml     (write-kubeconfig-mode "0644" in /etc/rancher/k3s/config.yaml)
prod-vm     644 root:root /etc/rancher/k3s/k3s.yaml     (write-kubeconfig-mode "0644")
entw-vm     644 root:root /etc/rancher/k3s/k3s.yaml     (write-kubeconfig-mode "0644")
```
Die Datei enthält auf allen drei Control-Plane-Hosts das cluster-admin-Zertifikat. Zur Gegenprobe: `node-token` ist ein Symlink auf `token` (Modus `0600`), der Eindruck eines weltlesbaren Tokens in Phase 1 trifft nicht zu. Auf homeserver und worker-1 existiert neben root nur der Benutzer `ubuntu` mit Login-Shell, das Risiko ist lokal begrenzt, aber real, sobald ein Dienst oder Container unter diesem Konto oder mit Host-Mount kompromittiert wird.

## Risiko / Angriffsszenario

Jeder unprivilegierte lokale Account (kompromittierter Dienst-User, Kiosk-/Print-/Libvirt-Benutzer, Container mit Host-Mount) wird mit einem Lesevorgang zum Cluster-Admin: Zugriff auf alle Secrets, Pods mit Host-Mounts, Persistenz über neue Workloads.

## Empfohlene Behebung

```diff
-write-kubeconfig-mode: "0644"
+write-kubeconfig-mode: "0600"
```
Danach `sudo systemctl restart k3s` (kurze API-Unterbrechung, laufende Workloads laufen weiter). Alle Skripte, die die Datei als Nicht-root lesen, auf eine eigene Kopie umstellen (`sudo install -m 0600 -o <user> /etc/rancher/k3s/k3s.yaml ~/.kube/config`). `power-agent` und `cluster-power-manager` laufen als root und sind nicht betroffen.

## Rollback

Wert zurück auf `"0644"`, k3s neu starten. Alternativ vorübergehend `chmod 0644 /etc/rancher/k3s/k3s.yaml`.

## Verifikation

```
stat -c '%a %U:%G' /etc/rancher/k3s/k3s.yaml
sudo -u nobody cat /etc/rancher/k3s/k3s.yaml
```
Erwartung: `600 root:root` und `Permission denied`. `kubectl get nodes` als root bzw. mit eigener Kopie funktioniert weiter.

## Risiko der Behebung

Niedrig bis mittel: Ein k3s-Neustart ist nötig, damit die Datei neu geschrieben wird. Nicht-root-Nutzer und Tools, die `/etc/rancher/k3s/k3s.yaml` direkt lesen, verlieren den Zugriff.

## Behebung (2026-10-17)

**Fix.** Die Datei `/etc/rancher/k3s/k3s.yaml` hat auf homeserver, prod-vm und entw-vm jetzt Modus `0600 root:root`. Es gab keinen k3s-Neustart. Die Datei schreibt k3s nur beim Start, ein `chmod 0600` wirkt sofort. Damit ein späterer Start nicht wieder `0644` schreibt, wurde `write-kubeconfig-mode` in `/etc/rancher/k3s/config.yaml` auf den drei Hosts auf `"0600"` gesetzt und im Template der k3s-Rolle angepasst. Der Ansible-Lauf der Rolle schreibt die `config.yaml` ohne Neustart und stimmt Host und Template ab.

Vorher geprüft: Außer root hat nur `ubuntu` eine Login-Shell, und `ubuntu` nutzt eine eigene Kopie `~/.kube/config` (`0600`), auf die `/etc/environment` (`KUBECONFIG`) zeigt. `cluster-power-manager`, `nightly-worker-wake` und `power-agent` laufen als root, alle Aufrufer im Repo verwenden `sudo k3s kubectl`.

**Nachweis** (alle drei Hosts):

| Test | Ergebnis |
|---|---|
| `stat -c '%a %U:%G' /etc/rancher/k3s/k3s.yaml` | vorher `644 root:root`, nachher `600 root:root` |
| `sudo -u nobody cat /etc/rancher/k3s/k3s.yaml` | `Permission denied` |
| `cat /etc/rancher/k3s/k3s.yaml` als `ubuntu` (homeserver) | `Permission denied` |
| `kubectl get nodes` als `ubuntu` mit eigener Kopie | alle Nodes `Ready` |
| `sudo k3s kubectl get nodes` | funktioniert |
| homeserver: `cluster-power-manager`, `power-agent` | `active`, kein `permission denied` im Journal (10 min) |

Health-Check danach: ArgoCD-Apps `Synced`/`Healthy` bis auf `logging` und `ollama` (`Progressing`, schon vorher), öffentliche Hosts antworten, in PROD und ENTW laufen alle Pods. Fehlgeschlagene Units: `systemd-journal-upload` auf dem homeserver (siehe 039), `openipmi` auf prod-vm und entw-vm. `openipmi` wurde vorher nicht gemessen, eine VM hat keine IPMI-Hardware, der Zusammenhang mit der Änderung ist nicht erkennbar.

**Geänderte Dateien.**

- `ansible/roles/k3s/templates/k3s-config.yaml.j2` (`write-kubeconfig-mode: "0600"`)
- `docs/6-hintergruende/60020-ansible-rollen.md` (Abschnitt „k3s: Modus der Kubeconfig“)
- Auf den Hosts: `/etc/rancher/k3s/config.yaml` (Zeile 3) und Modus von `/etc/rancher/k3s/k3s.yaml`

**Backups auf den Hosts.** Die Kopien der Kubeconfig (`k3s.yaml.bak-20261017-151*`, Modus `0600`, mit dem cluster-admin-Zertifikat) wurden am 2026-10-17 auf Wunsch des Betreibers gelöscht. Die Kopien von `config.yaml` (`config.yaml.bak-20261017-151*`, ohne Zugangsdaten) liegen noch neben der Datei.

**Rollback.** `sudo chmod 0644 /etc/rancher/k3s/k3s.yaml` und die Zeile in `/etc/rancher/k3s/config.yaml` zurück auf `"0644"` (oder die Backup-Datei zurückkopieren). Im Repo den Template-Wert zurücksetzen.

**Hinweise.**

- Wer sonst die Datei lesen will, braucht `sudo` oder eine eigene Kopie (`sudo install -m 0600 -o <user> /etc/rancher/k3s/k3s.yaml ~/.kube/config`).
- Auch ENTW wurde umgestellt, obwohl es die absichtlich verwundbare Trainingsumgebung ist (Entscheidung des Betreibers).
