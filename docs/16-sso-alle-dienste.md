# 16 — SSO für alle Dienste: Ein User, ein Passwort

Dieser Guide verbindet die verbleibenden drei Dienste (Headlamp, Argo Workflows,
MinIO) mit Authentik SSO. Nach Abschluss genügt ein einziger Login für alles.

**Aktueller Stand:**

| Dienst | Typ | Status |
|---|---|---|
| Grafana | OIDC | ✅ bereits aktiv |
| Gotify | Forward Auth | ✅ bereits aktiv |
| Semaphore | Forward Auth | ✅ bereits aktiv |
| Headlamp | OIDC | ⏳ dieser Guide |
| Argo Workflows | OIDC | ⏳ dieser Guide |
| MinIO | OIDC | ⏳ dieser Guide |

---

## Voraussetzungen

```bash
# Authentik läuft
ssh ubuntu@192.168.178.94 'sudo kubectl -n authentik get pods'

# kubeseal-Controller läuft
ssh ubuntu@192.168.178.94 'sudo kubectl -n sealed-secrets get pods'

# Public Key des Controllers lokal vorhanden (einmalig holen, falls noch nicht da)
mkdir -p ~/homelab-certs
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n sealed-secrets get secret \
   -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
   -o jsonpath="{.items[0].data.tls\.crt}" | base64 -d' \
  > ~/homelab-certs/sealed-secrets.pem
```

---

## Schritt 1 — Dedizierten User in Authentik anlegen

Öffne **http://authentik.homeserver/if/admin/**

1. **Directory → Users → Erstellen**
2. Felder ausfüllen:
   - **Username:** `pke` (oder beliebig)
   - **Name:** Dein Name
   - **E-Mail:** deine@email.de
   - **Password:** sicheres Passwort wählen
3. Speichern.

**User zur Admin-Gruppe hinzufügen** (für Grafana + ArgoCD Admin-Rechte):

1. **Directory → Groups → authentik Admins** öffnen
2. Tab **Members → Add member**
3. Deinen User hinzufügen → Bestätigen

> Der `akadmin`-Account kann danach für den Alltag ignoriert werden. Dein
> `pke`-User ist von nun an dein einziger Login.

---

## Schritt 2 — Headlamp OIDC einrichten

### 2.1 — Provider in Authentik anlegen

1. **Applications → Providers → Erstellen**
2. Typ: **OAuth2/OpenID Provider** → Weiter
3. Felder:
   - **Name:** `headlamp`
   - **Authorization flow:** `default-provider-authorization-implicit-consent`
   - **Client type:** `Confidential`
   - **Redirect URIs:** `http://headlamp.homeserver/oidc-callback`
   - Alles andere: Standard lassen
4. **Fertigstellen** — Client ID und Client Secret **sofort notieren!**

### 2.2 — Application anlegen

1. **Applications → Applications → Erstellen**
2. Felder:
   - **Name:** `Headlamp`
   - **Slug:** `headlamp`
   - **Provider:** `headlamp` (gerade angelegt)
   - **Launch URL:** `http://headlamp.homeserver`
3. Speichern.

### 2.3 — Secrets versiegeln

```bash
NAMESPACE=headlamp
SECRET_NAME=headlamp-oidc
CERT=~/homelab-certs/sealed-secrets.pem

seal() {
  echo -n "$1" | kubeseal --raw \
    --namespace "$NAMESPACE" \
    --name "$SECRET_NAME" \
    --cert "$CERT" \
    --from-file=/dev/stdin
}

CLIENT_ID="<Client ID aus Schritt 2.1>"
CLIENT_SECRET="<Client Secret aus Schritt 2.1>"

echo "encryptedClientId:     $(seal "$CLIENT_ID")"
echo "encryptedClientSecret: $(seal "$CLIENT_SECRET")"
```

### 2.4 — values.yaml befüllen

In [argocd/apps/headlamp/values.yaml](../argocd/apps/headlamp/values.yaml) eintragen:

```yaml
oidcSecret:
  enabled: true
  name: headlamp-oidc
  encryptedClientId: "<Ausgabe encryptedClientId>"
  encryptedClientSecret: "<Ausgabe encryptedClientSecret>"
```

Außerdem OIDC aktivieren:

```yaml
  oidc:
    enabled: true
```

---

## Schritt 3 — Argo Workflows OIDC einrichten

### 3.1 — Provider in Authentik anlegen

1. **Applications → Providers → Erstellen**
2. Typ: **OAuth2/OpenID Provider** → Weiter
3. Felder:
   - **Name:** `argo-workflows`
   - **Authorization flow:** `default-provider-authorization-implicit-consent`
   - **Client type:** `Confidential`
   - **Redirect URIs:** `http://argo-workflows.homeserver/oauth2/callback`
   - Alles andere: Standard lassen
4. **Fertigstellen** — Client ID und Client Secret **sofort notieren!**

### 3.2 — Application anlegen

1. **Applications → Applications → Erstellen**
2. Felder:
   - **Name:** `Argo Workflows`
   - **Slug:** `argo-workflows`
   - **Provider:** `argo-workflows`
   - **Launch URL:** `http://argo-workflows.homeserver`
3. Speichern.

### 3.3 — Secrets versiegeln

```bash
NAMESPACE=argo-workflows
SECRET_NAME=argo-workflows-sso
CERT=~/homelab-certs/sealed-secrets.pem

seal() {
  echo -n "$1" | kubeseal --raw \
    --namespace "$NAMESPACE" \
    --name "$SECRET_NAME" \
    --cert "$CERT" \
    --from-file=/dev/stdin
}

CLIENT_ID="<Client ID aus Schritt 3.1>"
CLIENT_SECRET="<Client Secret aus Schritt 3.1>"

echo "encryptedClientId:     $(seal "$CLIENT_ID")"
echo "encryptedClientSecret: $(seal "$CLIENT_SECRET")"
```

### 3.4 — values.yaml befüllen

In [argocd/apps/argo-workflows/values.yaml](../argocd/apps/argo-workflows/values.yaml) eintragen:

```yaml
ssoSecret:
  enabled: true
  name: argo-workflows-sso
  encryptedClientId: "<Ausgabe encryptedClientId>"
  encryptedClientSecret: "<Ausgabe encryptedClientSecret>"
```

SSO aktivieren:

```yaml
argo-workflows:
  server:
    authModes:
      - sso
    sso:
      enabled: true
```

---

## Schritt 4 — MinIO OIDC einrichten

### 4.1 — Provider in Authentik anlegen

1. **Applications → Providers → Erstellen**
2. Typ: **OAuth2/OpenID Provider** → Weiter
3. Felder:
   - **Name:** `minio`
   - **Authorization flow:** `default-provider-authorization-implicit-consent`
   - **Client type:** `Confidential`
   - **Redirect URIs:** `http://minio.homeserver/oauth_callback`
   - Alles andere: Standard lassen
4. **Fertigstellen** — Client ID und Client Secret **sofort notieren!**

### 4.2 — Application anlegen

1. **Applications → Applications → Erstellen**
2. Felder:
   - **Name:** `MinIO`
   - **Slug:** `minio`
   - **Provider:** `minio`
   - **Launch URL:** `http://minio.homeserver`
3. Speichern.

### 4.3 — Secrets versiegeln

```bash
NAMESPACE=minio
SECRET_NAME=minio-oidc
CERT=~/homelab-certs/sealed-secrets.pem

seal() {
  echo -n "$1" | kubeseal --raw \
    --namespace "$NAMESPACE" \
    --name "$SECRET_NAME" \
    --cert "$CERT" \
    --from-file=/dev/stdin
}

CLIENT_ID="<Client ID aus Schritt 4.1>"
CLIENT_SECRET="<Client Secret aus Schritt 4.1>"

echo "encryptedClientId:     $(seal "$CLIENT_ID")"
echo "encryptedClientSecret: $(seal "$CLIENT_SECRET")"
```

### 4.4 — values.yaml befüllen

In [argocd/apps/minio/values.yaml](../argocd/apps/minio/values.yaml) eintragen:

```yaml
minio:
  oidc:
    enabled: true
    clientId: "<Client ID — kein Geheimnis, öffentlicher Identifier>"
    clientSecret: "<Client Secret — direkt eintragen, Repo ist privat>"

oidcSecret:
  enabled: true
  name: minio-oidc
  encryptedClientId: "<Ausgabe encryptedClientId>"
  encryptedClientSecret: "<Ausgabe encryptedClientSecret>"
```

> **Hinweis MinIO:** Die Community-Chart (`charts.min.io`) liest OIDC-Credentials
> direkt aus den `oidc.clientId`/`oidc.clientSecret` Values — keine native
> Kubernetes-Secret-Referenz möglich. Die `oidcSecret` SealedSecret ist ein
> Backup-Mechanismus für zukünftige Chart-Versionen.
> Da dieses Repo privat ist, ist `clientSecret` im Values-File akzeptabel.

---

## Schritt 5 — Commit und Deploy

```bash
git add argocd/apps/headlamp/values.yaml \
        argocd/apps/argo-workflows/values.yaml \
        argocd/apps/minio/values.yaml
git commit -m "feat(sso): enable OIDC for headlamp, argo-workflows, minio"
git push
```

ArgoCD synchronisiert automatisch innerhalb von ~3 Minuten.
Manuell auslösen:

```bash
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n argocd exec -it \
   $(sudo kubectl -n argocd get pod -l app.kubernetes.io/name=argocd-server -o name | head -1) \
   -- argocd app sync headlamp argo-workflows minio'
```

---

## Schritt 6 — Verifizierung

### Headlamp

1. Browser → `http://headlamp.homeserver`
2. → Weiterleitung zu Authentik Login
3. Login mit `pke` / Passwort
4. → Zurück zu Headlamp, eingeloggt

### Argo Workflows

1. Browser → `http://argo-workflows.homeserver`
2. Button **Login** → Weiterleitung zu Authentik
3. Login mit `pke` / Passwort
4. → Zurück, Workflows-UI sichtbar

### MinIO

1. Browser → `http://minio.homeserver`
2. Button **Login with SSO** → Weiterleitung zu Authentik
3. Login mit `pke` / Passwort
4. → MinIO Console

### Grafana (bereits aktiv, zum Testen)

1. Browser → `http://grafana.homeserver`
2. Direktweiterleitung zu Authentik (kein Grafana-Login-Screen)
3. Login mit `pke` / Passwort
4. → Grafana Dashboard

---

## Troubleshooting

### "Invalid redirect URI"

Authentik meldet diese Fehlermeldung, wenn die Redirect URI in der Application
nicht exakt mit der URL übereinstimmt, die der Client schickt (inkl. Protokoll,
Pfad, kein Trailing Slash).

Prüfen: Authentik Admin → Provider → Redirect URIs vergleichen mit den Werten
in dieser Anleitung.

### Headlamp zeigt nach Login "Unauthorized"

Das OIDC-Token enthält keine Kubernetes-Gruppen-Claims. Sicherstellen dass die
Scopes `openid email profile groups` konfiguriert sind (bereits so im
`values.yaml` voreingestellt).

### Argo Workflows: "SSO is not configured"

`sso.enabled: true` wurde gesetzt, aber das SealedSecret existiert noch nicht
(leere `encryptedClientId`). Das Secret muss im Cluster verfügbar sein, bevor
der Server startet.

Prüfen:
```bash
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n argo-workflows get secret argo-workflows-sso'
```

### MinIO zeigt keinen "Login with SSO" Button

OIDC ist nicht aktiviert oder `configUrl` nicht erreichbar. Prüfen:
```bash
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n minio logs -l app=minio | grep -i oidc'
```

### Passwort vergessen (Notfall-Zugang)

```bash
# Authentik: Recovery Key erzeugen
ssh ubuntu@192.168.178.94 \
  'sudo kubectl -n authentik exec -it \
   $(sudo kubectl -n authentik get pod -l app.kubernetes.io/component=server -o name | head -1) \
   -- ak create_recovery_key 1 pke'
# → gibt eine einmalige Recovery-URL aus
```
