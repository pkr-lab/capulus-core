# Vaultwarden — Passwort-Manager

[Vaultwarden](https://github.com/dani-garcia/vaultwarden) ist eine
leichtgewichtige Rust-Implementierung der Bitwarden-Server-API. Alle
offiziellen Bitwarden-Clients (Browser-Erweiterung, Mobile-Apps, Desktop-App,
CLI) können sich gegen einen selbst gehosteten Vaultwarden-Server verbinden,
ohne die schwere offizielle Bitwarden-Server-Suite (MSSQL, mehrere
Microservices) betreiben zu müssen.

---

## Architektur

```
vault.homeserver        →  Traefik    → vaultwarden (Port 80)
vault.pke-lab.de         →  Cloudflare Tunnel → vaultwarden (Port 80)
                                            └── PVC: data (2 Gi, local-path)
```

- **Datenbank:** SQLite (in `/data`, kein externer DB-Server nötig)
- **Websockets:** laufen seit Vaultwarden 1.30 auf demselben Port wie die
  HTTP-API (`WEBSOCKET_ENABLED=true`) → Live-Sync zwischen Clients ohne
  zusätzlichen Service/Port
- **Kein Authentik-ForwardAuth vor der App:** Die Bitwarden-Clients
  sprechen die API direkt an (Master-Passwort + eigenes 2FA übernehmen die
  Absicherung). Ein ForwardAuth-Redirect würde den Login/Sync der Apps
  brechen — anders als bei reinen Web-UIs (z. B. Gotify), die kein eigenes
  Client-Protokoll haben.
- **Extern erreichbar** über den bestehenden Cloudflare Tunnel
  (`argocd/apps/platform/cloudflared/values.yaml`), damit Handy-App und
  Browser-Erweiterung auch unterwegs syncen können.

---

## 1. Erstdeployment

### 1.1 Admin-Token erzeugen (Argon2-Hash empfohlen)

Ein Klartext-`ADMIN_TOKEN` funktioniert, ist aber anfällig für
Timing-Angriffe. Vaultwarden empfiehlt stattdessen einen Argon2-PHC-Hash:

```bash
sudo docker run --rm -it vaultwarden/server:1.37.1 /vaultwarden hash
```

> **`-it` nicht vergessen** — ohne TTY/stdin bricht der Passwort-Prompt mit
> `Os { code: 6, ... "No such device or address" }` ab.

Das Kommando fragt interaktiv nach einem Passwort und gibt einen
`$argon2id$...`-Hash aus. Diesen Hash (nicht das Klartext-Passwort!) im
nächsten Schritt versiegeln.

### 1.2 SealedSecret-Ciphertext erzeugen

Über die Web-UI unter <https://kubeseal-webgui.homeserver>:

1. Öffnen und ausfüllen:
   - **Namespace**: `vaultwarden`
   - **Secret-Name**: `vaultwarden-admin`
   - **Key**: `admin-token`
   - **Value**: der `$argon2id$...`-Hash aus 1.1
2. **Encrypt** klicken, den langen Base64-String kopieren.

Oder per CLI. Falls das lokale kubeconfig nicht auf den Home-Server zeigt
(z. B. von einer Workstation ohne Cluster-Zugriff), Public Key einmalig
vom Server holen und mit `--cert` an alle `kubeseal`-Aufrufe übergeben
(Details: [docs/14-cert-login.md → kubeseal ohne lokalen
Cluster-Kontext](14-cert-login.md#kubeseal-ohne-lokalen-cluster-kontext)):

```bash
mkdir -p ~/homelab-certs
ssh -i ~/.ssh/id_ed25519 ubuntu@192.168.178.94 \
  'sudo kubectl -n sealed-secrets get secret \
   -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
   -o jsonpath="{.items[0].data.tls\.crt}" | base64 -d' \
  > ~/homelab-certs/sealed-secrets.pem

echo -n '$argon2id$...' \
  | kubeseal --raw \
      --cert ~/homelab-certs/sealed-secrets.pem \
      --namespace vaultwarden \
      --name vaultwarden-admin \
      --from-file=/dev/stdin
```

Mit direktem Cluster-Zugriff (kubeconfig zeigt auf den Home-Server) reicht
stattdessen:

```bash
echo -n '$argon2id$...' \
  | kubeseal --raw \
      --namespace vaultwarden \
      --name vaultwarden-admin \
      --controller-namespace sealed-secrets \
      --controller-name sealed-secrets-controller \
      --from-file=/dev/stdin
```

### 1.3 Ciphertext in `values.yaml` eintragen

`argocd/apps/workloads/vaultwarden/values.yaml` öffnen und den Platzhalter ersetzen:

```yaml
adminSecret:
  enabled: true
  secretName: vaultwarden-admin
  encryptedAdminToken: "AgB...langes-base64..."     # ← aus 1.2
```

Committen + pushen (macht der Nutzer selbst):

```bash
git add argocd/apps/workloads/vaultwarden/values.yaml
git commit -m "feat(vaultwarden): set sealed admin token"
git push
```

ArgoCD übernimmt die Änderung innerhalb von ~3 Minuten (oder **Refresh** in
der ArgoCD-UI bei der `vaultwarden`-App klicken).

### 1.4 Verifizieren

```bash
SRV='ssh -i ~/.ssh/id_ed25519 ubuntu@homeserver'
$SRV 'sudo kubectl -n vaultwarden get pods,svc,ingress,pvc,sealedsecret,secret'
curl -sS https://vault.tech.homeserver/alive
```

Erwartet:
- Pod `Running`, PVC `Bound`, das `vaultwarden-admin`-Secret ist vorhanden.
- `/alive` liefert einen JSON-Zeitstempel (z. B. `"2026-07-20T12:00:00..."`).

---

## 2. Ersten Account anlegen

1. **https://vault.homeserver** öffnen → *Create Account*.
2. Master-Passwort setzen (idealerweise einen langen Passphrase-Satz, den
   man sich merken kann — das ist der einzige Schlüssel zum ganzen Tresor).
3. Einloggen, im Web-Vault unter *Account Settings → Security → Two-step
   Login* 2FA aktivieren (TOTP-App oder WebAuthn/Passkey).
4. **Danach `SIGNUPS_ALLOWED: "false"`** in `values.yaml` setzen und
   pushen, damit der Server nicht dauerhaft offen für neue Registrierungen
   im Internet steht (der Tresor ist über `vault.pke-lab.de` extern
   erreichbar, siehe Architektur oben).

---

## 3. Clients verbinden

Alle offiziellen Bitwarden-Clients unterstützen einen "Self-hosted"-Server:

- **Browser-Erweiterung**: Einstellungs-Zahnrad vor dem Login → *Self-hosted
  Environment* → Server-URL: `https://vault.pke-lab.de`
- **Mobile-App (iOS/Android)**: Beim ersten Start unten *Settings* (Zahnrad)
  → gleiche Server-URL eintragen
- **Desktop-App / CLI**: gleiches Prinzip (`bw config server
  https://vault.pke-lab.de` für die CLI)

Intern im LAN funktioniert auch `https://vault.homeserver` als Server-URL,
aber nur die `pke-lab.de`-Domain ist von unterwegs erreichbar.

---

## 4. Admin-Oberfläche

Unter `https://vault.pke-lab.de/admin` (oder intern
`https://vault.homeserver/admin`) mit dem Klartext-Passwort aus Schritt 1.1
einloggen. Dort lassen sich u. a. Nutzer verwalten, Diagnosen einsehen und
SMTP für E-Mail-Versand (Passwort-Reset, Einladungen) konfigurieren, falls
später gewünscht.

---

## 5. Konfiguration (values.yaml)

| Key | Bedeutung | Default |
|---|---|---|
| `env.DOMAIN` | Öffentliche Basis-URL (Links, WebAuthn-Origin-Check) | `https://vault.pke-lab.de` |
| `env.SIGNUPS_ALLOWED` | Neue Registrierungen erlauben | `true` (nach Account-Anlage auf `false` setzen) |
| `env.WEBSOCKET_ENABLED` | Live-Sync zwischen Clients | `true` |
| `adminSecret.encryptedAdminToken` | Versiegelter Argon2-Hash für `/admin` | — (Schritt 1) |
| `persistence.size` | Datenspeicher (SQLite + Anhänge + Icon-Cache) | `2Gi` |

---

## 6. Admin-Token rotieren

```bash
docker run --rm vaultwarden/server:1.37.1 /vaultwarden hash
```

Neuen Hash mit `kubeseal` versiegeln (Schritt 1.2), `encryptedAdminToken` in
`values.yaml` ersetzen, committen + pushen. Das alte `vaultwarden-admin`
Secret im Cluster löschen, falls ArgoCD es nicht automatisch prunt.

---

## 7. Warum kein NAS-Storage für die Haupt-PVC

Eine Migration von `persistence.storageClassName` auf die NFS-`nas`-
StorageClass (wie beim Großteil der übrigen Apps, siehe
[docs/16-nas-storage.md](16-nas-storage.md)) wurde erwogen, aber **bewusst
verworfen**: das NAS erzwingt inzwischen `all_squash` (kein
`no_root_squash` mehr verfügbar), was bei Vaultwardens SQLite-Datei zu
Permission-Problemen führt — siehe Kommentar in
`argocd/apps/workloads/vaultwarden/values.yaml`. Die Haupt-PVC bleibt daher auf
`local-path` (Homeserver-System-SSD).

Stattdessen sichert ein nächtlicher `backup`-CronJob (eigene PVC, bewusst
`storageClassName: nas`, siehe `backup-cronjob.yaml`) die SQLite-Datenbank
per `sqlite3 .backup` (nutzt SQLites eigene Online-Backup-API, sicher auch
bei einer laufenden, offenen DB) auf das NAS — Details:
[docs/36-nas-backup.md](36-nas-backup.md).

---

## 8. Restore nach Redeploy / Disaster Recovery

Vaultwarden kennt keinen "User per API/Ansible anlegen"-Mechanismus, der
einen bestehenden Tresor mitbringt — Passwörter, Attachments und das
eigene 2FA/TOTP des Accounts (`info@edv-kretzer.de`) liegen alle
verschlüsselt in `db.sqlite3` + `rsa_key.pem`. Der Account ist deshalb
nach einem Redeploy (z. B. verlorene `local-path`-PVC nach einem
Node-Wechsel) automatisch wieder vollständig da, sobald diese Dateien aus
dem NAS-Backup (siehe [Abschnitt 7](#7-warum-kein-nas-storage-für-die-haupt-pvc)
und [docs/36-nas-backup.md](36-nas-backup.md)) zurückkopiert sind — ein
separater Schritt, um den Nutzer "neu anzulegen", ist nicht nötig.

Dafür gibt es die Ansible-Rolle `vaultwarden_restore`
(`ansible/roles/vaultwarden_restore/`, Playbook
`ansible/vaultwarden-restore.yml`):

```bash
make vaultwarden-restore FORCE_RESTORE=true
```

Ablauf (alles automatisiert, läuft gegen den `homeserver`-Host, der
`kubectl` bereits lokal hat):

1. `vaultwarden`-Deployment auf 0 Replicas skalieren (keine parallel
   schreibende Instanz während des Restores).
2. Ein einmaliger `Job` (Manifest wird von Ansible gerendert und direkt per
   `kubectl apply -f -` angewendet — bewusst **nicht** Teil des Helm-Charts,
   damit ArgoCD ihn nicht als Dauerzustand verwaltet/prunt) mountet die
   `vaultwarden-data`-PVC (rw) und die `vaultwarden-backup`-PVC (ro) und
   spiegelt Letztere zurück auf Erstere.
3. Deployment wieder auf 1 Replica skalieren, `rollout status` abwarten,
   `/alive` prüfen.

**Sicherheitsgurt:** Ohne `FORCE_RESTORE=true` (Default `false`) bricht die
Rolle sofort mit einer Fehlermeldung ab. Das Playbook ist bewusst **nicht**
Teil von `site.yml`/`make install` — ein automatischer Lauf bei jedem
normalen Deploy könnte sonst live Tresordaten mit einem älteren Backup-Stand
überschreiben. `make vaultwarden-restore` also nur gezielt nach einem
echten Redeploy oder Datenverlust ausführen, nie routinemäßig.

**Wichtig:** Das setzt voraus, dass die `vaultwarden-backup`-PVC auf der
NAS noch existiert und der letzte nächtliche `backup-cronjob.yaml`-Lauf
erfolgreich war (`kubectl -n vaultwarden get jobs`). Ist auch dieser Stand
verloren (z. B. NAS-Totalausfall), bleibt nur der manuelle
restic-Restore von der externen USB-Platte, siehe
[docs/36-nas-backup.md → Wiederherstellung](36-nas-backup.md#wiederherstellung)
— das NAS selbst bleibt bewusst außerhalb von Ansible verwaltet, dieser
Pfad wird nicht automatisiert.

---

## 9. Troubleshooting

| Symptom | Hinweis |
|---|---|
| Pod `CrashLoopBackOff` nach Erstdeployment | `encryptedAdminToken` ist noch `REPLACE_ME_WITH_KUBESEAL_OUTPUT` — Schritt 1.3 abschließen |
| `vaultwarden-admin`-Secret fehlt | `kubectl -n vaultwarden describe sealedsecret vaultwarden-admin` — Ciphertext muss gegen den Public Key dieses Clusters erzeugt worden sein |
| Browser-Erweiterung/App kann sich nicht verbinden | `env.DOMAIN` muss exakt zur benutzten Server-URL passen (Schema + Host), sonst schlägt der WebAuthn-Origin-Check fehl |
| Kein Live-Sync zwischen Geräten | `env.WEBSOCKET_ENABLED` prüfen; Traefik/Cloudflare müssen Websocket-Upgrades durchreichen (Standard bei beiden, kein Extra-Konfig nötig) |
| `/admin` liefert 404/Fehler trotz korrektem Token | `ADMIN_TOKEN` env im Pod prüfen (`kubectl -n vaultwarden exec deploy/vaultwarden -- env \| grep ADMIN_TOKEN`) — muss aus dem Secret injiziert worden sein |
