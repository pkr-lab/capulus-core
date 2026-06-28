# Gotify Push-Benachrichtigungen

[Gotify](https://gotify.net) läuft als ArgoCD-verwaltete App im k3s-Cluster
(`argocd/apps/gotify/`) und empfängt Push-Benachrichtigungen aus der
Scanner-Pipeline auf dem Home-Server. Der Android/iOS-Gotify-Client (oder
einer der Desktop-/CLI-Clients) abonniert den Server und zeigt für jedes
Scan-Event eine Push-Benachrichtigung an.

```
[Scan-Taste] → scanbd → scan_button.sh
                          └── scan_to_pdf.sh ─curl──> Gotify (k3s) ─push──> Handy
```

Die Scan-Skripte lesen `/etc/scanner/gotify.env` (Mode `0640 root:scanner`)
zur Laufzeit ein — der App-Token taucht weder im Skript-Body noch im
systemd-Journal noch in Git auf.

---

## 1. Erstdeployment des Gotify-Servers

### 1.1 Admin-Passwort mit Vault verschlüsseln

```bash
ansible-vault encrypt_string 'DEIN_STARKES_ADMIN_PW' \
  --name 'gotify_admin_password'
```

Den resultierenden `!vault |`-Block in `ansible/group_vars/all.yml` einfügen
(siehe den auskommentierten Stub am Ende der Datei). Dieser Wert wird **nicht**
direkt von Ansible gelesen — er wird nur unter Vault aufbewahrt, damit der
Klartext bei einer Rotation nicht verloren geht.

### 1.2 SealedSecret-Ciphertext erzeugen

Der Cluster-Controller (bereits über `argocd/apps/sealed-secrets/` deployt)
akzeptiert nur Ciphertext, der mit seinem Public Key erzeugt wurde. Der
einfachste Weg ist die Web-UI unter <http://kubeseal-webgui.homeserver>:

1. Öffnen und ausfüllen:
   - **Namespace**: `gotify`
   - **Secret-Name**: `gotify-admin`
   - **Key**: `password`
   - **Value**: das Klartext-Admin-Passwort aus 1.1
2. **Encrypt** klicken, den langen Base64-String kopieren.

Oder per CLI (von einer Workstation mit installiertem `kubeseal` und dem
öffentlichen Cluster-Zertifikat unter `~/.kube/sealed-secrets.pem`):

```bash
echo -n 'DEIN_STARKES_ADMIN_PW' \
  | kubeseal --raw \
      --namespace gotify \
      --name gotify-admin \
      --from-file=/dev/stdin
```

### 1.3 Ciphertext in `values.yaml` eintragen

`argocd/apps/gotify/values.yaml` öffnen und den Platzhalter ersetzen:

```yaml
adminSecret:
  enabled: true
  username: admin
  secretName: gotify-admin
  encryptedPassword: "AgB...langes-base64..."     # ← aus 1.2
```

Committen + pushen:

```bash
git add argocd/apps/gotify/values.yaml
git commit -m "feat(gotify): set sealed admin password"
git push
```

ArgoCD übernimmt die Änderung innerhalb von ~3 Minuten (oder **Refresh** in
der ArgoCD-UI bei der `gotify`-App klicken, um sie sofort anzuwenden).

### 1.4 Verifizieren

> Die folgenden Shell-Snippets nutzen ein `SRV`-Kürzel für den SSH-Befehl auf
> den Home-Server. `homeserver` durch den Inventory-Host oder die
> Tailscale-IP ersetzen, falls dein Setup abweicht:
>
> ```bash
> SRV='ssh -i ~/.ssh/id_ed25519 ubuntu@homeserver'
> ```

```bash
$SRV 'sudo kubectl -n gotify get pods,svc,ingress,pvc,sealedsecret,secret'
curl -sS http://gotify.homeserver/health
```

Erwartet:
- Pod `Running`, PVC `Bound`, das `gotify-admin`-Secret ist vorhanden
  (vom Controller aus dem SealedSecret entschlüsselt).
- `/health` liefert `{"health":"green",...}`.

Bei `http://gotify.homeserver` mit `admin` + dem Passwort aus 1.1 einloggen.

---

## 2. Application-Token für den Scanner anlegen

1. In der Gotify-Web-UI: **Apps → CREATE APPLICATION**
   - Name: `Scanner`
   - Beschreibung: `Fujitsu scanner pipeline`
2. Den generierten Token (langer opaker String) kopieren.

---

## 3. Scanner-Skripte mit Gotify verdrahten

### 3.1 Token mit Vault verschlüsseln

```bash
ansible-vault encrypt_string 'DEIN_GOTIFY_APP_TOKEN' \
  --name 'scanner_gotify_token'
```

### 3.2 Integration in `group_vars/all.yml` aktivieren

```yaml
scanner_gotify_enabled: true
scanner_gotify_url: "http://gotify.homeserver"
scanner_gotify_token: !vault |
          $ANSIBLE_VAULT;1.1;AES256
          ... eingefügter Block aus 3.1 ...
```

### 3.3 Ausrollen

```bash
make scanner
```

Die Rolle:
- fügt `curl` zum Paket-Set hinzu,
- legt `/etc/scanner` an (`0750 root:scanner`),
- rendert `/etc/scanner/gotify.env` (`0640 root:scanner`, `no_log`),
- deployt `scan_button.sh` und `scan_to_pdf.sh` neu mit eingebautem
  `gotify_notify`-Helper.

### 3.4 End-to-End-Test

```bash
# Prüfen, ob saned die env-Datei lesen kann
$SRV 'sudo -u saned bash -lc ". /etc/scanner/gotify.env && echo $GOTIFY_ENABLED $GOTIFY_URL"'
# erwartet: 1 http://gotify.homeserver

# Manueller Push vom Host (Token-Sanity-Check):
$SRV 'curl -fsS -X POST "http://gotify.homeserver/message" \
        -H "X-Gotify-Key: $(grep ^GOTIFY_TOKEN= /etc/scanner/gotify.env | cut -d= -f2-)" \
        -F "title=test" -F "message=hello" -F "priority=5"'

# Hardware-Button am Scanner drücken — beobachten:
$SRV 'journalctl -t scanbd-scan -f'
```

Erwartete Pushes:
- **Erfolg**: `Scan erfolgreich` + `scan-<ts>.pdf (<n> Seiten) → Paperless`
- **Kein Papier im ADF**: `Scan fehlgeschlagen` + `Keine Seiten gescannt — ADF leer oder Scanner blockiert?`
- **scan_button-Trap außerhalb der Pipeline**: `Scan abgebrochen` + `scan_button trap rc=<rc>`

---

## 4. Admin-Passwort / App-Token rotieren

- **Admin-Passwort**: per `kubeseal` aus einem neuen Klartext neu erzeugen,
  `adminSecret.encryptedPassword` in `values.yaml` ersetzen, committen +
  pushen. Das alte `gotify-admin`-Secret im Cluster löschen, falls ArgoCD es
  nicht automatisch prunt, dann den Gotify-Pod neu starten.
- **App-Token**: den alten in der Gotify-Web-UI widerrufen, einen neuen
  anlegen, Schritte 3.1–3.3 wiederholen. Die env-Datei (`0640`) wird von
  Ansible neu geschrieben — nie manuell editieren.

---

## 5. Troubleshooting

| Symptom | Hinweis |
|---|---|
| Pod CrashLoopBackOff nach Erstdeployment | `encryptedPassword` ist noch `REPLACE_ME_WITH_KUBESEAL_OUTPUT` — Schritt 1.3 abschließen |
| `gotify-admin`-Secret fehlt | `kubectl -n gotify describe sealedsecret gotify-admin` — Controller-Logs erklären Entschlüsselungsfehler; Ciphertext muss gegen den Public Key dieses Clusters erzeugt worden sein |
| Keine Pushes trotz erfolgreichem Scan | `sudo cat /etc/scanner/gotify.env` prüfen und sicherstellen, dass `GOTIFY_ENABLED=1`; `journalctl -t scanbd-scan -g "gotify notify failed"` prüfen |
| Pushes funktionieren per curl, aber nicht aus den Skripten | `saned` ist wahrscheinlich nicht in der Gruppe `scanner` → `make scanner` erneut ausführen |
| Falscher Hostname (`gotify.homeserver` löst nicht auf) | Prüfen, ob `gotify` in `dnsmasq_hosts` in `group_vars/all.yml` steht, dann `make dnsmasq` |
