# 19 — Zammad Helpdesk / Ticket-System

Zammad ist ein Open-Source Helpdesk- und Ticketing-System.  
Die Deployment-Konfiguration liegt unter `argocd/apps/zammad/`.

---

## Übersicht

| Komponente        | Technologie                    | Namespace   |
|-------------------|-------------------------------|-------------|
| Zammad App        | Rails + Puma                  | `zammad`    |
| Datenbank         | PostgreSQL (Bitnami Sub-Chart) | `zammad`    |
| Cache / Websockets| Redis (Bitnami Sub-Chart)      | `zammad`    |
| Volltextsuche     | PostgreSQL-basiert (eingebaut) | —           |
| Ingress           | Traefik                       | `zammad`    |
| Secrets           | SealedSecrets                 | `zammad`    |
| Auto-Updates      | Renovate (patch + minor)      | —           |

---

## Voraussetzungen

- ArgoCD läuft und das Root-ApplicationSet ist aktiv (`argocd/bootstrap/root-applicationset.yaml`)
- Sealed-Secrets Controller ist installiert (`argocd/apps/sealed-secrets/`)
- `kubeseal` CLI ist lokal installiert
- `kubectl` ist mit dem Cluster verbunden

---

## Schritt 1 — Secrets generieren und versiegeln

Vor dem ersten Deployment muss das Datenbank-Passwort versiegelt werden.  
Es wird **zweimal** versiegelt (unterschiedliche Secret-Keys), enthält aber denselben Wert.

### 1.1 Passwort generieren

```bash
# PostgreSQL-Passwort für den Zammad-DB-User
DB_PASS=$(openssl rand -base64 32 | tr -d '=+/' | head -c 32)
echo "DB_PASS: $DB_PASS"
```

Passwort sicher speichern (z. B. in einem Passwort-Manager).

### 1.2 Secrets versiegeln

```bash
NS=zammad
SECRET_NAME=zammad-secrets
CONTROLLER_NS=sealed-secrets
CONTROLLER=sealed-secrets-controller

# Key 1: postgresql-pass (für den Zammad-App-Container)
echo -n "$DB_PASS" | kubeseal --raw \
  --namespace $NS --name $SECRET_NAME \
  --controller-namespace $CONTROLLER_NS \
  --controller-name $CONTROLLER \
  --from-file=/dev/stdin
# → Ausgabe als encryptedPostgresPass eintragen

# Key 2: postgresql-password (für den Bitnami-PostgreSQL-Sub-Chart)
echo -n "$DB_PASS" | kubeseal --raw \
  --namespace $NS --name $SECRET_NAME \
  --controller-namespace $CONTROLLER_NS \
  --controller-name $CONTROLLER \
  --from-file=/dev/stdin
# → Ausgabe als encryptedPostgresPassword eintragen
```

> **Hinweis:** Beide Werte enthalten dasselbe Passwort, aber unterschiedliche  
> kubeseal-Ciphertexts. Jeder `kubeseal --raw`-Aufruf erzeugt eine andere  
> Ausgabe — das ist korrekt (nichtdeterministische asymmetrische Verschlüsselung).

### 1.3 Werte in values.yaml eintragen

```yaml
secrets:
  enabled: true
  name: zammad-secrets
  encryptedPostgresPass: "<Ausgabe von Aufruf 1>"
  encryptedPostgresPassword: "<Ausgabe von Aufruf 2>"
```

---

## Schritt 2 — Helm-Abhängigkeit laden (lokal, optional)

ArgoCD lädt die Abhängigkeit beim Sync selbst herunter.  
Für lokale Tests (`helm template`, `helm lint`) einmalig ausführen:

```bash
cd argocd/apps/zammad
helm dependency update
```

---

## Schritt 3 — Deployment via ArgoCD

Nach dem Commit der Änderungen erkennt das Root-ApplicationSet den neuen Ordner  
`argocd/apps/zammad/` automatisch und erstellt die ArgoCD-Application.

```
ArgoCD → Home → zammad
Status: Syncing → Healthy
```

Den Sync-Fortschritt überwachen:

```bash
kubectl get pods -n zammad -w
```

Typische Pod-Reihenfolge beim ersten Start:
1. `zammad-postgresql-0` — startet zuerst (Datenbankinitialisierung)
2. `zammad-redis-master-0` — startet parallel
3. `zammad-init-*` — führt Datenbankmigrationen durch
4. `zammad-*` (App-Pod) — startet nach erfolgreichem Init

---

## Schritt 4 — Ersten Admin-Account anlegen

Nach dem erfolgreichen Start ist Zammad unter http://zammad.homeserver erreichbar.

1. Browser öffnen: `http://zammad.homeserver`
2. Setup-Wizard durchlaufen:
   - **System-URL** eintragen: `https://zammad.pke-lab.de`
   - **Admin-E-Mail** und Passwort festlegen
   - E-Mail-Kanal konfigurieren (optional, kann später gemacht werden)
3. Login mit den im Wizard erstellten Zugangsdaten

---

## Schritt 5 — DNS-Eintrag setzen

In `ansible/group_vars/all.yml` den Zammad-Hostnamen zu `dnsmasq_hosts` hinzufügen:

```yaml
dnsmasq_hosts:
  # ... bestehende Einträge ...
  - name: zammad
    ip: "{{ homeserver_ip }}"
```

Ansible-Playbook ausführen:

```bash
ansible-playbook ansible/site.yml --tags dnsmasq
```

---

## Schritt 6 — HTTPS / TLS (optional)

Für TLS via Traefik die Ingress-Annotation in `values.yaml` anpassen:

```yaml
zammad:
  ingress:
    annotations:
      traefik.ingress.kubernetes.io/router.entrypoints: websecure
      traefik.ingress.kubernetes.io/router.tls: "true"
    tls:
      - hosts:
          - zammad.pke-lab.de
        secretName: zammad-tls  # Cert-Manager oder manuelles TLS-Secret
```

---

## Schritt 7 — SSO via Authentik (optional)

Zammad unterstützt SAML-basiertes SSO. Anleitung:

### 7.1 Authentik SAML-Provider erstellen

In Authentik:
1. **Applications → Providers → Create** → SAML Provider
2. **Name:** `Zammad`
3. **ACS URL:** `https://zammad.pke-lab.de/auth/saml/callback`
4. **Issuer:** `https://zammad.pke-lab.de`
5. **Service Provider Binding:** `Post`
6. Metadaten-URL notieren: `https://authentik.pke-lab.de/...`

### 7.2 Zammad SAML konfigurieren

In Zammad:
1. **Admin → Security → Third-party Applications → Authentication via SAML**
2. **IDP SSO target URL:** `https://authentik.pke-lab.de/application/saml/<slug>/sso/binding/redirect/`
3. **IDP Cert Fingerprint:** aus den Authentik-Metadaten
4. **Name Identifier Format:** `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`

---

## Automatische Updates (Renovate)

Renovate ist in `renovate.json` konfiguriert und aktualisiert das Zammad Helm Chart  
automatisch bei **patch**- und **minor**-Updates:

```json
{
  "matchPackageNames": ["zammad"],
  "matchUpdateTypes": ["patch", "minor"],
  "automerge": true
}
```

- **Patch/Minor:** Renovate öffnet einen PR und merged ihn automatisch nach grünem CI.
- **Major:** Renovate öffnet nur einen PR zur manuellen Prüfung (Breaking Changes).

Renovate prüft das Chart-Repository `https://zammad.github.io/zammad-helm` auf neue Versionen.

---

## Troubleshooting

### Pods starten nicht

```bash
# Events prüfen
kubectl describe pod -n zammad -l app.kubernetes.io/name=zammad

# Logs des Init-Containers prüfen
kubectl logs -n zammad -l app.kubernetes.io/component=zammadInit --previous
```

### SealedSecret wird nicht entschlüsselt

```bash
# Status des SealedSecrets prüfen
kubectl describe sealedsecret -n zammad zammad-secrets

# Sealed-Secrets Controller Logs
kubectl logs -n sealed-secrets -l app.kubernetes.io/name=sealed-secrets
```

### Datenbank-Verbindungsfehler

```bash
# PostgreSQL-Pod Status
kubectl get pod -n zammad -l app.kubernetes.io/name=postgresql

# Direkte DB-Verbindung testen
kubectl exec -it -n zammad zammad-postgresql-0 -- \
  psql -U zammad -d zammad -c '\dt'
```

### ArgoCD zeigt OutOfSync

Liegt meist an generischen Ressourcen (z. B. von PostgreSQL), die ArgoCD nicht kennt.  
ServerSideApply ist aktiviert (`syncOptions: ServerSideApply=true`), was die meisten  
Konflikte löst. Bei anhaltenden Problemen manuell syncen:

```bash
argocd app sync zammad --force
```

---

## Ressourcenverbrauch (Richtwerte Home Lab)

| Komponente     | CPU Request | RAM Request | RAM Limit |
|----------------|-------------|-------------|-----------|
| Zammad App     | 100m        | 512Mi       | 1Gi       |
| PostgreSQL     | 50m         | 256Mi       | 512Mi     |
| Redis          | 25m         | 64Mi        | 128Mi     |
| Nginx Sidecar  | 25m         | 64Mi        | 128Mi     |
| **Gesamt**     | ~200m       | ~896Mi      | ~1.8Gi    |

---

## Relevante Links

- [Zammad Helm Chart Repository](https://github.com/zammad/zammad-helm)
- [Zammad Helm Chart values.yaml](https://github.com/zammad/zammad-helm/blob/main/zammad/values.yaml)
- [Zammad Admin-Dokumentation](https://admin-docs.zammad.org)
- [Zammad SAML-Dokumentation](https://admin-docs.zammad.org/en/latest/settings/security/third-party/saml.html)
- [Authentik SSO Übersicht](docs/14-sso-authentik.md)
- [ArgoCD Setup](docs/05-argocd.md)
