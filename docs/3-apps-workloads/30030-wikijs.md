# 20 — Wiki.js

Wiki.js ist ein Open-Source-Wiki/Knowledge-Base-System mit Markdown-Editor,
eingebauten Benutzergruppen und pfadbasierten Zugriffsregeln (Page Rules).
Die Deployment-Konfiguration liegt unter `argocd/apps/workloads/wikijs/`.

---

## Übersicht

| Komponente        | Technologie                            | Namespace |
|--------------------|-----------------------------------------|-----------|
| Wiki.js App        | Node.js (ghcr.io/requarks/wiki)         | `wikijs`  |
| Datenbank          | PostgreSQL 16 (eigenes Deployment)      | `wikijs`  |
| Ingress            | Traefik                                 | `wikijs`  |
| Secrets            | SealedSecrets                           | `wikijs`  |
| Persistenz         | StorageClass `nas` (UGREEN NAS, NFS)    | —         |

Wiki.js speichert **sämtliche** Inhalte — Seiten, Versionshistorie und
hochgeladene Assets (Bilder, PDFs, etc.) — direkt in PostgreSQL. Der
Wiki.js-Pod selbst ist zustandslos und braucht kein eigenes PVC; nur
PostgreSQL benötigt Persistenz. PostgreSQL läuft mit `storageClassName: nas`
(siehe [docs/16-nas-storage.md](16-nas-storage.md)) — keine NodeAffinity
mehr nötig, damit liegen alle Wiki-Daten auf dem NAS statt auf der
Homeserver-System-SSD.

> **Warum kein Bitnami-PostgreSQL-Subchart wie bei Zammad?**
> Bitnami hat im August 2025 sein kostenloses Chart-Katalog-Angebot stark
> eingeschränkt (Legacy-Images ohne weitere Updates, neue Versionen nur noch
> per Subscription). Für eine einzelne, kleine Wiki-Datenbank reicht ein
> schlankes eigenes Deployment mit dem offiziellen `postgres`-Image —
> weniger Abhängigkeiten, kein Risiko durch zukünftige Bitnami-Breaking-Changes.

---

## Voraussetzungen

- ArgoCD läuft und das Root-ApplicationSet ist aktiv (`argocd/bootstrap/root-applicationset.yaml`)
- Sealed-Secrets Controller ist installiert (`argocd/apps/platform/sealed-secrets/`)
- **`nas-storage`-App ist deployt** (`argocd/apps/platform/nas-storage/`) und die
  StorageClass `nas` existiert: `kubectl get storageclass nas`
- **NAS ist online und der NFS-Export erreichbar** (siehe
  [docs/16-nas-storage.md](16-nas-storage.md)) — sonst bleibt die
  PostgreSQL-PVC auf `Pending`
- `kubeseal` CLI ist lokal installiert
- `kubectl` ist mit dem Cluster verbunden

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

Die Ausgabe in `argocd/apps/workloads/wikijs/values.yaml` eintragen:

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
`argocd/apps/workloads/wikijs/` automatisch und erstellt die ArgoCD-Application.

```
ArgoCD → Home → wikijs
Status: Syncing → Healthy
```

Sync-Fortschritt beobachten:

```bash
kubectl get pods -n wikijs -w
```

Erwartete Reihenfolge:
1. `wikijs-postgresql-*` startet zuerst (PVC auf `nas`, kein Node-Pin mehr)
2. `wikijs-*` (App-Pod) — verbindet sich mit PostgreSQL und führt beim ersten
   Start automatisch die DB-Migrationen durch (kann 1–2 Minuten dauern)

> Falls `wikijs-postgresql-*` dauerhaft `Pending` bleibt: das NAS ist
> offline oder die `nas`-StorageClass fehlt — siehe
> [docs/16-nas-storage.md](16-nas-storage.md) → Fehlerbehebung.

**DNS:** `wiki.homeserver` ist sofort erreichbar — dank der Wildcard-DNS-Konfiguration
(`address=/homeserver/<server-ip>` in dnsmasq, siehe [docs/09-dns-architecture.md](09-dns-architecture.md))
ist **kein** manueller DNS-Eintrag nötig.

---

## Schritt 3 — Ersten Admin-Account anlegen

1. Browser öffnen: `https://wiki.homeserver`
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

In Wiki.js (**Administration → Groups → Erstellen**) zwei Groups anlegen:

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

PostgreSQL läuft auf der `nas`-StorageClass (NFS, UGREEN NAS):

```bash
kubectl describe pvc -n wikijs wikijs-postgresql-data
kubectl -n nas-storage get pods
```

Details: [docs/16-nas-storage.md](16-nas-storage.md) → Fehlerbehebung.

---

## Ressourcenverbrauch (Richtwerte Home Lab)

| Komponente   | CPU Request | RAM Request | RAM Limit | Storage                |
|---------------|-------------|--------------|-----------|--------------------------|
| Wiki.js App   | 100m        | 256Mi        | 512Mi     | —                        |
| PostgreSQL    | 50m         | 256Mi        | 512Mi     | 20Gi (`nas`)             |
| **Gesamt**    | ~150m       | ~512Mi       | ~1Gi      | 20Gi auf dem NAS         |

Die 20Gi für PostgreSQL sind ein Startwert (Seiten + Assets liegen beide in
der DB) — bei Bedarf in `argocd/apps/workloads/wikijs/values.yaml` unter
`postgresql.persistence.size` erhöhen.

---

## Autoskalierung (HPA)

Die Wiki.js-App-Komponente skaliert per HPA auf 1–3 Replicas (CPU 75% /
RAM 80%) — da Seiten und Assets vollständig in PostgreSQL liegen (kein
PVC am App-Pod), ist das ohne weitere Vorkehrungen (kein Affinity-Trick
nötig) sicher. PostgreSQL selbst bleibt unangetastet (Single-Writer,
kein HPA). Details für alle Apps: [39-hpa-autoscaling.md](39-hpa-autoscaling.md).

---

## Relevante Links

- [Wiki.js Dokumentation](https://docs.requarks.io)
- [Wiki.js — Groups & Permissions](https://docs.requarks.io/groups)
- [Wiki.js Docker-Installation](https://docs.requarks.io/install/docker)
- [Wiki.js GitHub Repository](https://github.com/requarks/wiki)
- [NAS-Storage (UGREEN NAS)](16-nas-storage.md)
- [DNS-Architektur (Wildcard `*.homeserver`)](09-dns-architecture.md)
- [ArgoCD Setup](05-argocd.md)
