# Gotify Push-Benachrichtigungen

[Gotify](https://gotify.net) läuft als ArgoCD-verwaltete App im k3s-Cluster
(`argocd/apps/platform/gotify/`). Der Android/iOS-Gotify-Client (oder einer der
Desktop-/CLI-Clients) abonniert den Server und zeigt Push-Benachrichtigungen
an — aktuell primär für Alertmanager-Alerts aus dem Monitoring-Stack:

```
VictoriaMetrics Alertmanager ─webhook──> gotify-bridge (k3s) ─push──> Gotify ─push──> Handy
```

`gotify-bridge` (`argocd/apps/platform/gotify-bridge/`) übersetzt Alertmanager-Webhooks
in Gotify-Push-Nachrichten; das App-Token dafür liegt als Kubernetes-Secret
im `gotify-bridge`-Namespace (siehe Kommentar in
`argocd/apps/platform/gotify-bridge/values.yaml`). Jede andere App im Cluster kann
genauso einen eigenen Application-Token in der Gotify-Web-UI anlegen und
direkt gegen `https://gotify.homeserver/message` pushen.

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

Der Cluster-Controller (bereits über `argocd/apps/platform/sealed-secrets/` deployt)
akzeptiert nur Ciphertext, der mit seinem Public Key erzeugt wurde. Der
einfachste Weg ist die Web-UI unter <https://kubeseal-webgui.homeserver>:

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

`argocd/apps/platform/gotify/values.yaml` öffnen und den Platzhalter ersetzen:

```yaml
adminSecret:
  enabled: true
  username: admin
  secretName: gotify-admin
  encryptedPassword: "AgB...langes-base64..."     # ← aus 1.2
```

Committen + pushen:

```bash
git add argocd/apps/platform/gotify/values.yaml
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
curl -sS https://gotify.homeserver/health
```

Erwartet:
- Pod `Running`, PVC `Bound`, das `gotify-admin`-Secret ist vorhanden
  (vom Controller aus dem SealedSecret entschlüsselt).
- `/health` liefert `{"health":"green",...}`.

Bei `https://gotify.homeserver` mit `admin` + dem Passwort aus 1.1 einloggen.

---

## 2. Application-Token für eine neue Integration anlegen

1. In der Gotify-Web-UI: **Apps → CREATE APPLICATION**
   - Name/Beschreibung frei wählbar, z. B. `gotify-bridge` oder der Name der
     jeweiligen App.
2. Den generierten Token (langer opaker String) kopieren und als Kubernetes-
   Secret bzw. SealedSecret der jeweiligen App hinterlegen — z. B. für
   `gotify-bridge` siehe Kommentar in
   `argocd/apps/platform/gotify-bridge/values.yaml`.
3. Manueller Push-Test (Token-Sanity-Check):

```bash
curl -fsS -X POST "https://gotify.homeserver/message" \
  -H "X-Gotify-Key: DEIN_APP_TOKEN" \
  -F "title=test" -F "message=hello" -F "priority=5"
```

---

## 3. Admin-Passwort / App-Token rotieren

- **Admin-Passwort**: per `kubeseal` aus einem neuen Klartext neu erzeugen,
  `adminSecret.encryptedPassword` in `values.yaml` ersetzen, committen +
  pushen. Das alte `gotify-admin`-Secret im Cluster löschen, falls ArgoCD es
  nicht automatisch prunt, dann den Gotify-Pod neu starten.
- **App-Token**: den alten in der Gotify-Web-UI widerrufen, einen neuen
  anlegen, in das Secret der jeweiligen App eintragen (siehe Abschnitt 2).

---

## 4. Troubleshooting

| Symptom | Hinweis |
|---|---|
| Pod CrashLoopBackOff nach Erstdeployment | `encryptedPassword` ist noch `REPLACE_ME_WITH_KUBESEAL_OUTPUT` — Schritt 1.3 abschließen |
| `gotify-admin`-Secret fehlt | `kubectl -n gotify describe sealedsecret gotify-admin` — Controller-Logs erklären Entschlüsselungsfehler; Ciphertext muss gegen den Public Key dieses Clusters erzeugt worden sein |
| Keine Pushes von Alertmanager | `kubectl -n gotify-bridge logs deploy/gotify-bridge` prüfen; Token im `gotify-bridge`-Secret gegen einen manuellen curl-Test (Abschnitt 2) verifizieren |
| Falscher Hostname (`gotify.homeserver` löst nicht auf) | Prüfen, ob `gotify` in `dnsmasq_hosts` in `group_vars/all.yml` steht, dann `make dnsmasq` |
