# 20 — Wiki.js

Wiki.js ist ein Open-Source-Wiki/Knowledge-Base-System mit Markdown-Editor,
eingebauten Benutzergruppen und pfadbasierten Zugriffsregeln (Page Rules).
Die Deployment-Konfiguration liegt unter `argocd/apps/wikijs/`.

---

## Übersicht

| Komponente        | Technologie                            | Namespace |
|--------------------|-----------------------------------------|-----------|
| Wiki.js App        | Node.js (ghcr.io/requarks/wiki)         | `wikijs`  |
| Datenbank          | PostgreSQL 16 (eigenes Deployment)      | `wikijs`  |
| Ingress            | Traefik                                 | `wikijs`  |
| Secrets            | SealedSecrets                           | `wikijs`  |
| Persistenz         | StorageClass `hdd` auf worker-0         | —         |

Wiki.js speichert **sämtliche** Inhalte — Seiten, Versionshistorie und
hochgeladene Assets (Bilder, PDFs, etc.) — direkt in PostgreSQL. Der
Wiki.js-Pod selbst ist zustandslos und braucht kein eigenes PVC; nur
PostgreSQL benötigt Persistenz. PostgreSQL läuft mit `storageClassName: hdd`
und ist via NodeAffinity an `worker-0` gebunden (siehe
[docs/18-hdd-storage.md](18-hdd-storage.md)) — damit liegen alle Wiki-Daten
auf der 7,3-TB-HDD statt auf der Homeserver-System-SSD.

> **Warum kein Bitnami-PostgreSQL-Subchart wie bei Zammad/Authentik?**
> Bitnami hat im August 2025 sein kostenloses Chart-Katalog-Angebot stark
> eingeschränkt (Legacy-Images ohne weitere Updates, neue Versionen nur noch
> per Subscription). Für eine einzelne, kleine Wiki-Datenbank reicht ein
> schlankes eigenes Deployment mit dem offiziellen `postgres`-Image —
> weniger Abhängigkeiten, kein Risiko durch zukünftige Bitnami-Breaking-Changes.

---

## Voraussetzungen

- ArgoCD läuft und das Root-ApplicationSet ist aktiv (`argocd/bootstrap/root-applicationset.yaml`)
- Sealed-Secrets Controller ist installiert (`argocd/apps/sealed-secrets/`)
- **`hdd-storage`-App ist deployt** (`argocd/apps/hdd-storage/`) und die
  StorageClass `hdd` existiert: `kubectl get storageclass hdd`
- **worker-0 ist online** und `/mnt/hdd` ist gemountet (siehe
  [docs/18-hdd-storage.md](18-hdd-storage.md)) — sonst bleibt die
  PostgreSQL-PVC auf `Pending`
- `kubeseal` CLI ist lokal installiert
- `kubectl` ist mit dem Cluster verbunden
- (Optional, für SSO) Authentik läuft bereits (siehe [docs/14-sso-authentik.md](14-sso-authentik.md))

---

## Schritt 1 — Secret versiegeln

Vor dem ersten Deployment muss das Datenbank-Passwort versiegelt werden.
Im Gegensatz zu Zammad reicht hier **ein** Wert für **einen** Secret-Key —
sowohl PostgreSQL (`POSTGRES_PASSWORD`) als auch Wiki.js (`DB_PASS`) lesen
denselben Key `db-password` aus demselben Secret.

```bash
# Passwort generieren
DB_PASS=$(openssl rand -base64 32 | tr -d '=+/' | head -c 32)
echo "DB_PASS: $DB_PASS"   # sicher speichern (z. B. Passwort-Manager)

# Versiegeln
echo -n "$DB_PASS" | kubeseal --raw \
  --namespace wikijs \
  --name wikijs-secrets \
  --controller-namespace sealed-secrets \
  --controller-name sealed-secrets-controller
```

Die Ausgabe in `argocd/apps/wikijs/values.yaml` eintragen:

```yaml
secrets:
  enabled: true
  name: wikijs-secrets
  encryptedDbPassword: "<Ausgabe von kubeseal>"
```

> **Wichtig:** Niemals Klartext-Passwörter committen — nur den versiegelten Ciphertext-Blob.

---

## Schritt 2 — Deployment via ArgoCD

Nach dem Commit der Änderungen erkennt das Root-ApplicationSet den neuen Ordner
`argocd/apps/wikijs/` automatisch und erstellt die ArgoCD-Application.

```
ArgoCD → Home → wikijs
Status: Syncing → Healthy
```

Sync-Fortschritt beobachten:

```bash
kubectl get pods -n wikijs -w
```

Erwartete Reihenfolge:
1. `wikijs-postgresql-*` startet zuerst auf **worker-0** (NodeAffinity, PVC auf `hdd`)
2. `wikijs-*` (App-Pod) — verbindet sich mit PostgreSQL und führt beim ersten
   Start automatisch die DB-Migrationen durch (kann 1–2 Minuten dauern)

> Falls `wikijs-postgresql-*` dauerhaft `Pending` bleibt: worker-0 ist offline
> oder die `hdd`-StorageClass fehlt — siehe
> [docs/18-hdd-storage.md](18-hdd-storage.md) → Fehlerbehebung.

**DNS:** `wiki.homeserver` ist sofort erreichbar — dank der Wildcard-DNS-Konfiguration
(`address=/homeserver/<server-ip>` in dnsmasq, siehe [docs/09-dns-architecture.md](09-dns-architecture.md))
ist **kein** manueller DNS-Eintrag nötig.

---

## Schritt 3 — Ersten Admin-Account anlegen

1. Browser öffnen: `http://wiki.homeserver`
2. Setup-Wizard durchlaufen:
   - **Site-Titel** vergeben
   - **Admin-Account**: E-Mail + Passwort festlegen
   - Telemetrie-Einstellung nach Wunsch
3. Login mit den im Wizard erstellten Zugangsdaten

---

## Schritt 4 — Berechtigungskonzept: Bereiche mit unterschiedlichen Rechten

**Kurze Antwort auf die Ausgangsfrage:** Eine zweite App ist dafür **nicht**
nötig. Wiki.js bringt mit **Groups** + **Page Rules** genau dieses Feature
bereits eingebaut mit:

- Eine **Group** definiert globale Basis-Rechte (lesen/schreiben/verwalten)
  für ihre Mitglieder.
- Pro Group lassen sich zusätzlich **Page Rules** anlegen: pfadbasierte
  Regeln (z. B. "Pfad beginnt mit `vereins-intern/`"), die Lesen/Schreiben/
  Verwalten gezielt erlauben oder verweigern — unabhängig von den globalen
  Rechten der Group.
- Spezifischere Regeln überschreiben generischere; bei gleicher Spezifität
  gewinnt "Verweigern" gegen "Erlauben". Ohne explizite Erlaubnis ist eine
  Aktion **immer verweigert** (Default-Deny).

### 4.1 — Beispiel-Konzept: "öffentlich lesbar" + "intern voller Zugriff"

In Authentik (`http://authentik.homeserver/if/admin/`) zwei Gruppen anlegen
(**Directory → Groups**), z. B.:

- `wiki-lesend` — alle, die nur lesen dürfen
- `wiki-redaktion` — alle, die Inhalte bearbeiten dürfen

In Wiki.js (**Administration → Groups → Erstellen**) passend dazu zwei
Groups anlegen:

**Group "Lesend"**
1. Tab **Permissions**: nur `read:pages` global aktivieren
2. Tab **Page Rules → Erstellen**:
   - Pfad: `/` (oder gezielt `public/`), Match: `Start (Starts with)`
   - Berechtigung: `Lesen` → Erlauben
   - Optional: Pfad `intern/`, Match: `Start`, Berechtigung `Lesen` → **Verweigern**
     (überschreibt die generischere `/`-Regel für diesen Unterpfad)

**Group "Redaktion"**
1. Tab **Permissions**: `read:pages`, `write:pages`, `manage:pages`, `read:comments`, `write:comments` global aktivieren
2. Keine einschränkenden Page Rules nötig — volle Rechte überall

So entsteht z. B. ein öffentlich lesbarer Bereich (Checklisten, SOPs für
alle) und ein interner Bereich, den nur die Redaktion sehen und bearbeiten
kann — ein einziges Wiki, klar getrennte Sichtbarkeiten.

> Mehr Details zu Match-Typen (Starts With / Ends With / Regex / Exact) und
> Regel-Priorität: [docs.requarks.io/groups](https://docs.requarks.io/groups).

---

## Schritt 5 — SSO via Authentik (OIDC) inkl. Gruppen-Zuordnung

### 5.1 — OAuth2/OIDC-Provider in Authentik anlegen

1. **Applications → Providers → Erstellen** → `OAuth2/OpenID Provider`
2. Felder:
   - **Name:** `wikijs`
   - **Authorization flow:** `default-provider-authorization-implicit-consent`
   - **Client type:** `Confidential`
   - **Redirect URIs:** `http://wiki.homeserver/login/<strategy-id>/callback`
     (die `<strategy-id>` zeigt Wiki.js erst nach dem Anlegen der Strategie
     in Schritt 5.3 an — Redirect URI danach in Authentik nachtragen)
3. **Fertigstellen** — Client ID und Client Secret notieren

### 5.2 — Application anlegen

**Applications → Applications → Erstellen**:
- Name: `Wiki.js`, Slug: `wikijs`, Provider: `wikijs`
- Launch URL: `http://wiki.homeserver`

### 5.3 — Login-Strategie in Wiki.js konfigurieren

**Administration → Login** → Strategie `OAuth2 / OpenID` hinzufügen:

| Feld                  | Wert                                                              |
|------------------------|--------------------------------------------------------------------|
| Authorization Endpoint | `http://authentik.homeserver/application/o/authorize/`            |
| Token Endpoint         | `http://authentik.homeserver/application/o/token/`                |
| User Info Endpoint     | `http://authentik.homeserver/application/o/userinfo/`             |
| Issuer                 | `http://authentik.homeserver/application/o/wikijs/`               |
| Client ID / Secret     | aus Schritt 5.1                                                    |
| Scope                  | `openid profile email`                                            |

Speichern, dann die jetzt angezeigte Callback-URL (`/login/<strategy-id>/callback`)
in den Redirect URIs des Authentik-Providers (Schritt 5.1) nachtragen.

> Client ID/Secret werden ausschließlich über die Wiki.js-Datenbank
> verwaltet (Admin-UI) — es gibt keine Umgebungsvariable dafür, daher landen
> diese Werte **nicht** in `values.yaml`/SealedSecrets.

### 5.4 — Authentik-Gruppen automatisch nach Wiki.js übernehmen (optional)

Damit Authentik-Gruppenmitgliedschaft automatisch die passende Wiki.js-Group
zuweist (z. B. `wiki-redaktion` → Wiki.js-Group "Redaktion"):

1. In Authentik: **Customization → Property Mappings → Erstellen** → Scope Mapping
   - Name: `wikijs-groups`, Scope name: `profile`
   - Expression:
     ```python
     return {"wiki-groups": ["Redaktion"]} if ak_is_group_member(request.user, name="wiki-redaktion") else {"wiki-groups": ["Lesend"]}
     ```
2. Im `wikijs`-Provider unter **Advanced protocol settings** die neue Mapping
   zu **Scope mappings** hinzufügen
3. Wiki.js übernimmt den `wiki-groups`-Claim automatisch beim Login und weist
   die Gruppen zu — die Gruppen müssen vorher in Wiki.js existieren (Schritt 4.1)

> Self-Registration muss in Wiki.js aktiviert sein (**Administration → Login**
> → "Allow new users to register"), sonst werden unbekannte SSO-Logins abgelehnt.

---

## Troubleshooting

### Wiki.js-Pod startet, bleibt aber `Not Ready`

```bash
kubectl logs -n wikijs -l app.kubernetes.io/name=wikijs
```

Meist liegt es an einer noch laufenden DB-Migration (erster Start) oder
einer falschen `DB_HOST`/`DB_PASS`-Kombination.

### PostgreSQL-Pod startet nicht / `CrashLoopBackOff`

```bash
kubectl logs -n wikijs -l app.kubernetes.io/name=wikijs-postgresql
kubectl describe pod -n wikijs -l app.kubernetes.io/name=wikijs-postgresql
```

### SealedSecret wird nicht entschlüsselt

```bash
kubectl describe sealedsecret -n wikijs wikijs-secrets
kubectl logs -n sealed-secrets -l app.kubernetes.io/name=sealed-secrets
```

### PostgreSQL-PVC bleibt `Pending`

PostgreSQL läuft auf der HDD-StorageClass und ist an `worker-0` gebunden:

```bash
kubectl describe pvc -n wikijs wikijs-postgresql-data
kubectl get nodes worker-0   # muss Ready sein
kubectl -n hdd-storage get pods
```

Details: [docs/18-hdd-storage.md](18-hdd-storage.md) → Fehlerbehebung.

### OIDC-Login schlägt fehl ("invalid_redirect_uri" o.ä.)

Die Redirect URI in Authentik muss **exakt** mit der von Wiki.js angezeigten
Callback-URL übereinstimmen (inkl. `<strategy-id>`, kein Trailing Slash).

---

## Ressourcenverbrauch (Richtwerte Home Lab)

| Komponente   | CPU Request | RAM Request | RAM Limit | Storage                |
|---------------|-------------|--------------|-----------|--------------------------|
| Wiki.js App   | 100m        | 256Mi        | 512Mi     | —                        |
| PostgreSQL    | 50m         | 256Mi        | 512Mi     | 20Gi (`hdd`, worker-0)   |
| **Gesamt**    | ~150m       | ~512Mi       | ~1Gi      | 20Gi auf der HDD         |

Die 20Gi für PostgreSQL sind ein Startwert (Seiten + Assets liegen beide in
der DB) — bei Bedarf in `argocd/apps/wikijs/values.yaml` unter
`postgresql.persistence.size` erhöhen.

---

## Relevante Links

- [Wiki.js Dokumentation](https://docs.requarks.io)
- [Wiki.js — Groups & Permissions](https://docs.requarks.io/groups)
- [Wiki.js Docker-Installation](https://docs.requarks.io/install/docker)
- [Wiki.js GitHub Repository](https://github.com/requarks/wiki)
- [Authentik — Wiki.js Integration](https://integrations.goauthentik.io/documentation/wiki-js/)
- [Authentik SSO Übersicht](14-sso-authentik.md)
- [HDD-Storage auf worker-0](18-hdd-storage.md)
- [DNS-Architektur (Wildcard `*.homeserver`)](09-dns-architecture.md)
- [ArgoCD Setup](05-argocd.md)
