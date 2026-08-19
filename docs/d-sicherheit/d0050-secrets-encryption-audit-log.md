# k3s Secrets-Encryption-at-Rest + Audit-Log (Security-Härtung Phase 4)

Detail-Doku zu Phase 4 aus [docs/d-sicherheit/d0010-security-hardening-roadmap.md](d0010-security-hardening-roadmap.md).

**Status (13.08.2026): Fertig, live und verifiziert.** Rollout
durchgeführt: Config ausgerollt, Datastore-Backup (`tar` bei gestopptem
Dienst), zwei kontrollierte Neustarts, `rotate-keys` bis
`reencrypt_finished`. Verifiziert:

- `k3s secrets-encrypt status` → `Enabled`, aktiver Key
  `aescbckey-2026-08-13T19:36:33+02:00`, `All hashes match`.
- **Byte-Level-Beweis:** `sqlite3`-Query gegen `state.db` zeigt für ein
  Secret den Präfix `k8s:enc:aescbc:v1:` (hex-dekodiert) statt lesbarem
  Klartext — Secrets liegen tatsächlich verschlüsselt auf der Platte, nicht
  nur laut Status-Text.
- Audit-Log schreibt reale Events nach `/var/log/k3s/audit.log`
  (`kind":"Event"`, Metadata-Level, Read-Traffic wie erwartet
  herausgefiltert).
- ArgoCD weiterhin 35/36 `Healthy` nach beiden Neustarts (`immich` kurz
  `Degraded` geflackert, exakt während des ersten Neustarts, danach von
  selbst wieder `Healthy` — ArgoCDs Health-Check konnte den API-Server für
  den Moment des Neustarts nicht erreichen, kein echter Fehler).
- HTTP-Stichproben lokal (`*.homeserver`) und extern über den
  Cloudflare-Tunnel (`*.pke-lab.de`) erfolgreich, `cloudflared`-Logs
  sauber.

---

## Ziel

Sealed Secrets ([docs/…](.)) verschlüsselt nur den Git-Zustand — der
private Schlüssel, mit dem der `sealed-secrets-controller` sie beim
Cluster-Sync entschlüsselt, landet als **Klartext-Secret** im
k3s-Datastore (`/var/lib/rancher/k3s/server/db/state.db`, SQLite). Jeder,
der Lesezugriff auf diese Datei bekommt (z. B. durch physischen
Server-Zugriff oder eine Sicherheitslücke im k3s-Prozess selbst), sieht
alle Secrets im Klartext — unabhängig von Sealed Secrets.

`--secrets-encryption` löst das auf Layer der etcd/SQLite-Persistenz:
Secrets werden vor dem Schreiben auf Platte verschlüsselt, der
Schlüssel liegt separat unter `/var/lib/rancher/k3s/server/cred/encryption-config.json`.

Zusätzlich, im selben Rutsch: Audit-Log für den kube-apiserver — bislang
gibt es keine Nachvollziehbarkeit, wer wann welche Kubernetes-Ressource
angelegt/geändert/gelöscht hat.

---

## Design-Entscheidungen

### k3s-Version und CLI-Workflow

Cluster läuft `v1.36.3+k3s1` (deutlich über der `v1.28`-Schwelle, ab der
k3s den modernen `rotate-keys`-Befehl anbietet). Der alte
`prepare` → `rotate` → `reencrypt`-Dreischritt (so ursprünglich in
docs/d-sicherheit/d0010-security-hardening-roadmap.md skizziert) ist für diese Version **deprecated** — hier bewusst
durch den modernen Weg ersetzt:

```
sudo k3s secrets-encrypt status   # vorher: Enabled/Disabled?
# Config-Flag setzen + restart (siehe Rollout unten)
sudo k3s secrets-encrypt status   # danach: "Enabled" — NEUE Secrets verschlüsselt,
                                   # bestehende noch nicht
sudo k3s secrets-encrypt rotate-keys   # verschlüsselt auch bestehende Secrets nach
sudo k3s secrets-encrypt status   # pollen bis Stage "reencrypt_finished"
sudo systemctl restart k3s        # laut k3s-Doku nach reencrypt_finished nochmal nötig
```

Nicht verwendet: `k3s secrets-encrypt enable` (CLI-Variante ohne
Config-Datei-Änderung) — für ein Ansible-verwaltetes Setup ist der
Config-Flag-Weg (`secrets-encryption: true` in `config.yaml`, dann
Restart) der zum Rest des Repos passende, deklarative Weg; beide
Mechanismen führen zum selben Ziel, sind aber keine zwei Schritte, die
man kombinieren muss.

### Provider: `aescbc` (Default), nicht `secretbox`

Keine Notwendigkeit für den saubereren, aber weniger verbreiteten
`secretbox`-Provider (XSalsa20/Poly1305) — `aescbc` ist der k3s-Standard,
ausreichend für dieses Bedrohungsmodell (Schutz vor Klartext-Zugriff auf
die Datei, nicht vor einem staatlichen Akteur mit Kryptoanalyse-Budget).

### Beide Änderungen (Encryption + Audit-Log) im selben Restart

Beide sind reine kube-apiserver-Startparameter — der Cluster ist so oder
so für die Dauer eines Neustarts (wenige Sekunden bis ~1 Minute) ohne
API-Server, unabhängig davon, wie viele Flags sich gleichzeitig ändern.
Ein gemeinsamer Restart statt zwei getrennter reduziert die Anzahl der
Downtime-Fenster. Über zwei unabhängige Ansible-Variablen
(`k3s_secrets_encryption_enabled`, `k3s_audit_log_enabled` in
[ansible/group_vars/all.yml](../../ansible/group_vars/all.yml)) lässt sich
bei Bedarf trotzdem einzeln togglen und getrennt ausrollen.

### Audit-Policy: Metadata-Level, kein Full-Request-Response-Dump

Read-Traffic (`get`/`list`/`watch` — der weitaus größte Anteil, ständiges
Polling von Grafana/vmagent/ArgoCD) komplett ausgeschlossen. Für
Secrets/ConfigMaps bewusst **Metadata**-Level statt `RequestResponse` —
sonst würde das Audit-Log genau die Klartext-Werte mitschreiben, vor
denen die Secrets-Encryption gerade schützen soll. Volle Regel-Liste:
[ansible/roles/k3s/templates/audit-policy.yaml.j2](../../ansible/roles/k3s/templates/audit-policy.yaml.j2).

Retention bewusst begrenzt (14 Tage / 5 Backups / 100 MB je Datei) —
Homelab-Cluster mit reichlich freiem Plattenplatz (769 Gi frei, Stand
13.08.), Grenze ist hier "sinnvoll genug für Incident-Nachvollziehbarkeit"
statt "Kapazität sparen".

---

## Rollout

**1. Config ausrollen** (schreibt nur Dateien, kein Neustart, kein
Risiko):

```bash
make k3s
```

Prüfen, dass beide Dateien wie erwartet auf dem Server liegen:

```bash
ssh ubuntu@192.168.178.94 "sudo cat /etc/rancher/k3s/config.yaml; echo ---; sudo test -f /etc/rancher/k3s/audit-policy.yaml && echo 'audit-policy.yaml vorhanden'"
```

**2. Backup + Neustart in einem Wartungsfenster** (Cluster ist für die
Dauer des Neustarts ohne API-Server — laufende Pods bleiben unberührt,
aber `kubectl`/ArgoCD-Sync/Traefik-Routing-Änderungen pausieren kurz):

```bash
ssh ubuntu@192.168.178.94 << 'EOF'
sudo systemctl stop k3s
sudo tar czf ~/k3s-db-backup-pre-phase4-$(date +%Y%m%d-%H%M).tar.gz \
  -C /var/lib/rancher/k3s/server db
sudo systemctl start k3s
EOF
```

`tar` bei gestopptem Dienst statt `cp` im laufenden Betrieb (wie in
Phase 3) — hier zusätzlich sqlite `state.db`/`state.db-wal`/`state.db-shm`
konsistent zusammen sichern, weil diesmal die Secrets selbst betroffen
sind, nicht nur deklarative NetworkPolicy-Objekte.

**3. Warten, bis der Cluster wieder gesund ist:**

```bash
ssh ubuntu@192.168.178.94 "sudo systemctl status k3s --no-pager | head -5"
kubectl get nodes
kubectl get pods -A --no-headers | grep -v Running | grep -v Completed
```

**4. Verifizieren, dass Encryption + Audit-Log aktiv sind:**

```bash
ssh ubuntu@192.168.178.94 "sudo k3s secrets-encrypt status"
# Erwartung: "Encryption Status: Enabled"

ssh ubuntu@192.168.178.94 "sudo tail -5 /var/log/k3s/audit.log"
# Erwartung: JSON-Zeilen mit "kind":"Event"
```

**5. Bestehende Secrets nachträglich verschlüsseln** (Schritt 2 aktiviert
nur NEUE/geänderte Secrets — ohne diesen Schritt bleiben alle
bestehenden Secrets im Klartext):

```bash
ssh ubuntu@192.168.178.94 "sudo k3s secrets-encrypt rotate-keys"
```

Status pollen, bis Stage `reencrypt_finished` erreicht ist:

```bash
ssh ubuntu@192.168.178.94 "sudo k3s secrets-encrypt status"
# mehrfach wiederholen, Stage-Feld beobachten
```

**6. Laut k3s-Doku abschließender Neustart, damit der Server den
finalen Stand übernimmt:**

```bash
ssh ubuntu@192.168.178.94 "sudo systemctl restart k3s"
kubectl get nodes   # nochmal auf Ready warten
```

**7. Verifizieren, dass Secrets tatsächlich verschlüsselt auf der Platte
liegen** (der eigentliche Beweis, nicht nur der Status-Text):

```bash
ssh ubuntu@192.168.178.94 "sudo k3s secrets-encrypt status"
# Erwartung: "Encryption Status: Enabled", aktiver Key gelistet
```

Optional, für den harten Beweis auf Byte-Ebene (sqlite3 ist auf dem Host
nicht installiert — Kurzinstallation nur für diesen einen Check, danach
wieder entfernen, falls gewünscht):

```bash
ssh ubuntu@192.168.178.94 << 'EOF'
sudo apt-get install -y sqlite3
sudo sqlite3 /var/lib/rancher/k3s/server/db/state.db \
  "select hex(substr(value,1,20)) from kine where name like '%/secrets/%' limit 1;"
# Erwartung: Bytes beginnend mit dem "k8s:enc:aescbc:v1:"-Präfix (hex),
# NICHT lesbarer Klartext eines Secret-Feldnamens.
EOF
```

**8. Cluster-weite Funktionsprüfung** (wie nach jeder Phase):

```bash
kubectl get applications -n argocd -o custom-columns='NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status'
```

Plus Stichproben lokal (`*.homeserver`) **und** extern über den
Cloudflare-Tunnel (`*.pke-lab.de`) — gleiche Disziplin wie nach dem
NetworkPolicy-Rollout (Phase 3), da ein API-Server-Neustart theoretisch
auch Traefik/ArgoCD-Reconciliation kurz stören könnte.

---

## Rollback

**Falls der apiserver nach Schritt 2 nicht mehr startet** (z. B. Fehler
in der Audit-Policy-Syntax): schnellster Fix ohne Datenverlust — die
Zusatzflags aus `/etc/rancher/k3s/config.yaml` manuell entfernen
(`secrets-encryption`, `kube-apiserver-arg`-Block) und neu starten, dann
in Ruhe den Fehler in der Policy-Datei beheben, bevor erneut versucht
wird:

```bash
ssh ubuntu@192.168.178.94 "sudo systemctl status k3s --no-pager -l | tail -30"
# Fehlerursache aus den Logs lesen, dann:
ssh ubuntu@192.168.178.94 "sudo journalctl -u k3s -n 100 --no-pager"
```

**Falls das Datastore selbst beschädigt wirkt** (deutlich unwahrscheinlicher
— dieser Vorgang ändert nur, WIE geschrieben wird, nicht WAS): aus dem
Backup aus Schritt 2 wiederherstellen:

```bash
ssh ubuntu@192.168.178.94 << 'EOF'
sudo systemctl stop k3s
sudo rm -rf /var/lib/rancher/k3s/server/db
sudo tar xzf ~/k3s-db-backup-pre-phase4-<timestamp>.tar.gz -C /var/lib/rancher/k3s/server
sudo systemctl start k3s
EOF
```

Zusätzlich `secrets-encryption: true` und den `kube-apiserver-arg`-Block
wieder aus `ansible/group_vars/all.yml` entfernen (bzw.
`k3s_secrets_encryption_enabled`/`k3s_audit_log_enabled` auf `false`) und
`make k3s` erneut laufen lassen, damit der nächste reguläre Ansible-Lauf
nicht wieder dieselbe Config schreibt.

---

## Bekannte Einschränkungen

- **Single-Node-Setup:** Dieser Cluster hat nur einen Control-Plane-Node
  (`homeserver`) — die in der k3s-Doku erwähnten HA-spezifischen Schritte
  (Server einzeln nacheinander neu starten, Hash-Abgleich zwischen
  Servern) entfallen hier komplett.
- **Encryption-Key-Rotation danach:** Für künftige Rotationen (z. B.
  turnusmäßig, siehe Phase 7 in docs/d-sicherheit/d0010-security-hardening-roadmap.md) reicht danach ein einzelnes
  `sudo k3s secrets-encrypt rotate-keys` + Restart, kein erneutes
  Ersteinrichtungs-Prozedere.
- **`sqlite3`-Paket** wird nur für den optionalen Verifikations-Schritt 7
  gebraucht, ist keine Voraussetzung für den eigentlichen
  Encryption-Mechanismus (der läuft rein in k3s selbst, ohne externe
  Tools).
