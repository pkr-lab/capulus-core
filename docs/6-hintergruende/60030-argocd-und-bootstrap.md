# ArgoCD, Bootstrap und SealedSecrets — Hintergründe

Begründungen zur Rolle `argocd`, zu den Bootstrap-Dateien (`argocd/bootstrap/`, `argocd/bootstrap-prod/`), zur Promotion-Konfiguration
und zum Versiegeln von Secrets. Bedienung: [b0010](../b-kubernetes-gitops/b0010-argocd.md),
[b0020](../b-kubernetes-gitops/b0020-argocd-projects.md), [f00b0](../f-cicd-automatisierung/f00b0-promotion-chain.md).
Übersicht dieser Kategorie: [60000](60000-uebersicht.md).

---

## Generierte Bootstrap-Dateien

- `argocd/bootstrap/root-applicationset.yaml` und `projects.yaml` sind **generiert** aus den Templates der Rolle `argocd`
  (`make render-bootstrap`, Playbook `ansible/render-bootstrap.yml`). Nach jeder Änderung an den Templates, an den Namespace-Listen
  in `ansible/roles/argocd/defaults/main.yml` oder an `argocd_repo_*`/`argocd_namespace` neu rendern, die Kopie im Repo nicht von Hand
  editieren. So driftet die eingecheckte Datei nie von dem ab, was das Playbook anwendet.
- Die AppProjects werden **vor** dem ApplicationSet angewendet: Applications, die auf ein noch nicht vorhandenes Projekt zeigen,
  scheitern beim Sync.
- Layouts: Mit `argocd_entw_layout: true` (nur ENTW-Cluster) gibt es **ein** ApplicationSet `home-server-apps-entw`, das ausschließlich
  `argocd/apps/entw/*` auf `argocd_repo_revision` (Branch `entw`) liest, Projekt `entw`. Sonst (TECH-Hub) gibt es **ein**
  ApplicationSet `home-server-apps-tech` mit Projekt `tech`. TECH und PROD lesen `main` und dort nur `argocd/apps/tech/*` bzw.
  `argocd/apps/prod/*`. Das frühere Layout `platform`/`workloads` (und die Variablen `argocd_tech_layout`,
  `argocd_apps_from_lists`) gibt es nicht mehr, kein Cluster nutzte es noch.
- **Zwei getrennte ApplicationSets mit literalem `spec.project`** waren im alten Layout Absicht, und zwei Alternativen sind
  verworfen (Details in [b0020](../b-kubernetes-gitops/b0020-argocd-projects.md)): ein ApplicationSet mit `template.spec.project` je
  Generator (die CRD kennt `spec.generators[].template` außerhalb von `matrix`/`merge` nicht, `kubectl apply` scheitert mit „unknown
  field“) und eines, das `spec.project` per Go-Template aus dem Pfad ableitet (nie gegen den echten Controller verifiziert).
- **Kein Wildcard bei den AppProject-Ressourcentypen:** `clusterResourceWhitelist`/`namespaceResourceWhitelist` sind bewusst so
  offen wie ArgoCDs eingebautes Projekt `default`, weil mehrere Apps CRDs installieren (victoria-metrics-operator, sealed-secrets,
  cert-manager). Der Sicherheitsgewinn liegt bei `sourceRepos` (nur dieses Repo) und `destinations` (nur die Namespaces des Clusters),
  die Einschränkung nach Ressourcentyp ist eine bewusst spätere Verschärfung, kein Versehen.
- `traefik-config` und `coredns-custom` deployen nach `kube-system`, weil `HelmChartConfig` bzw. `ConfigMap` dort liegen müssen, wo
  Traefik/CoreDNS sie lesen. `cert-manager` hat einen eigenen Namespace, steht aber bewusst **nicht** in `argocd_platform_apps`: Das ist
  Cluster-Infrastruktur wie `kube-system`/`argocd`, kein App-Tier-Namespace, und soll deshalb keine tier-default-ingress-NetworkPolicy
  und kein `security-tier`-Label bekommen.

## `ignoreDifferences` im ApplicationSet-Template

Jeder Eintrag existiert, weil ohne ihn eine App dauerhaft „OutOfSync“ oder „Progressing“ bliebe oder ein Rechenlauf zurückgesetzt würde:

| Ressource | Warum ignoriert |
|---|---|
| `SealedSecret` `/status` | Der Status wird vom Sealed-Secrets-Controller geschrieben und weicht deshalb von Git ab. |
| Alle Deployments mit HPA: `/spec/replicas` | Die Charts setzen `replicas: null`, damit Kubernetes den Wert nur einmal bei der Erstellung defaultet. ServerSideApply behandelt ein explizites `null` aber als „Feld leeren“ und setzt es bei jedem Sync auf den Schema-Default (1) zurück. Das bekämpft die HPA-Skalierung und lässt die App dauerhaft OutOfSync (gesehen bei `zammad-railsserver`). Der Eintrag greift nur bei Applications, die eine Ressource genau dieser Art und dieses Namens enthalten, für alle anderen ist er wirkungslos. |
| Deployment `ollama`: `/spec/replicas` | Ollama läuft im Ruhezustand mit `replicas: 0` und wird nur vom täglichen n8n-Workflow „Zammad Externer KI-Lauf“ per Kubernetes-API auf 1 hoch- und wieder auf 0 heruntergeskaliert. Ohne das Ignore würde `selfHeal` den Pod während eines laufenden Laufs sofort auf den Git-Wert 0 zurücksetzen. |
| StatefulSet `zammad-redis`: `/spec/updateStrategy/rollingUpdate/maxUnavailable` | Der Chart-Default setzt `maxUnavailable: 1`, dem Cluster fehlt aber das Feature-Gate `MaxUnavailableStatefulSet`, der API-Server verwirft das Feld dauerhaft. Der Versuch, es per `maxUnavailable: null` in den Values zu entfernen, wirkt lokal mit Helm v3, **nicht** mit dem Helm v4 im `argocd-repo-server` (bestätigt mit `argocd app diff --core --hard-refresh`) und führt zum Dauerdiff. Das `null` in den Values bleibt trotzdem stehen, schadet nicht und dokumentiert die Absicht. |
| victoria-metrics-operator: Webhook-Secret und `caBundle` | Der Chart erzeugt das selbstsignierte CA/Zertifikat bei jedem Render neu (`genCA`/`genSignedCert`). Sein Schutz dagegen (`admissionWebhooks.keepTLSSecret`) nutzt Helms `lookup`, das bei `helm template` (macht der `repo-server` fürs Diffing) immer leer ist, weil dort kein Live-Cluster-Zugriff besteht. Der Schutz greift bei ArgoCD also nie, und die Daten unterscheiden sich dauerhaft vom Live-Stand. Unbedenklich, denn `admissionWebhooks.policy` steht bereits auf `Ignore` (wegen derselben Webhook-Flakiness). |
| `VMRule`: leeres `record: ""` | Die Operator-API ergänzt bei reinen Alert-Regeln ein leeres `record: ""` (Pendant zu `alert`), das die eigenen VMRule-Templates nie setzen. Das ergäbe ein Dauerdiff auf allen VMRules, deshalb ohne Namensfilter für alle. |

Dazu die Sync-Optionen `SkipDryRunOnMissingResource` und Retry: Beim Bootstrap von CRD **und** zugehöriger Ressource im selben
Sync (z. B. victoria-metrics-operator installiert die CRD `VMSingle` und ein `VMSingle`) konvergiert die erste Reconciliation nur mit dem
übersprungenen Dry-Run plus Wiederholung.

## Rolle `argocd`

- **Konto `ci`:** Ein lokales Konto ohne Login, nur API-Token, mit der eingebauten Rolle `role:readonly`. Die Promotion-Kette
  (`.github/workflows/promote-chain.yml`) liest damit den Gesundheitsstatus der Applications. Der Token wird **nicht** von Ansible
  erzeugt, sondern einmalig per `scripts/create-argocd-ci-token.sh` ([f00b0](../f-cicd-automatisierung/f00b0-promotion-chain.md#einrichtung)).
  Das Skript legt ihn direkt als GitHub-Repo-Secret ab (`hub` → `ARGOCD_HUB_TOKEN`, `entw` → `ARGOCD_ENTW_TOKEN`), gibt ihn nicht aus
  und speichert ihn nirgends. Voraussetzung: das Konto existiert (`argocd_ci_account_enabled: true`, einmal `make argocd` bzw.
  `ansible-playbook ansible/entw.yml --tags argocd`), `gh` ist als Repo-Admin angemeldet, und das Admin-Passwort ist über das Secret
  `argocd-initial-admin-secret` lesbar (sonst `ARGOCD_ADMIN_PASSWORD` setzen). `TOKEN_TTL_DAYS` (Standard 365) begrenzt die Laufzeit,
  alte Token bleiben bis zum Ablauf gültig.
- **Web-UI und NodePorts:** ArgoCD läuft mit `server.insecure`. Beide NodePorts (30080/30443) sprechen Klartext-HTTP, `https://…:30443`
  wird zurückgesetzt. Die Web-UI läuft per HTTPS über den Traefik-Ingress (internes Zertifikat, Host im SAN-Eintrag von
  `certificate-homeserver-wildcard.yaml`). 30080 dient CLI und CI. Der Ingress ist **Wert der Rolle** (`argocd_ingress_enabled`,
  `argocd_ui_host`), damit der tägliche Semaphore-Lauf (`helm upgrade`) ihn nicht zurückdreht. Standard aus: Die ENTW-Instanz hat keinen
  eigenen Ingress-Host, der Hub aktiviert ihn in `host_vars/homeserver`. Ist `argocd_ui_host` gesetzt, leitet der Chart daraus auch
  `configs.cm.url` ab (Links, SSO-Callbacks).
- **Eigene DaemonSet-Gesundheitsprüfung** (`resource.customizations.health.apps_DaemonSet` in `configs.cm`, Lua): Der DaemonSet `monitoring-prometheus-node-exporter` läuft absichtlich
  auch auf den per Wake-on-LAN geschalteten Workern, die oft aus sind. Er ist dadurch dauerhaft „nicht vollständig bereit“ und blockierte jeden Sync von `monitoring` (die Operation lief vier Tage
  lang, 2026-09-15 bis 2026-09-19). Seine Gesundheit wird deshalb ignoriert, für alle anderen DaemonSets gilt das ArgoCD-Standardverhalten. Die Lua-Sandbox von ArgoCD hat **keine**
  `string`-Bibliothek, also kein `string.format` im Skript. Die Kommentare im Skript selbst sind Teil des Konfigurationswerts und bleiben dort stehen.
- **Ablösen des alten Layouts (nur ENTW):** Die alten ApplicationSets werden vor dem neuen gelöscht, damit die alten Generatoren (Branch
  `entw`, platform/workloads) keine Applications mehr erzeugen. Das Template setzt keinen `resources-finalizer`, die Workloads bleiben
  stehen und werden von den gleichnamigen Applications aus `argocd/apps/entw/` übernommen. Das Löschen des alten AppProjects schlägt
  fehl, solange noch Applications es nutzen, der nächste Lauf holt es nach.
- **NetworkPolicies (`bootstrap-networkpolicies`)** gehören zu Phase 3 der Härtung ([d0010](../d-sicherheit/d0010-security-hardening-roadmap.md)). Es gibt eine Policy pro
  App-Namespace (dieselbe Liste wie bei den AppProjects und Namespace-Labels). Sie werden **nach** dem Labeling-Task angewendet, weil sie auf dem Label `security-tier` matchen. Beide Varianten
  erlauben **immer** zusätzlich `kube-system`, `monitoring` und `cloudflared`:
  - **grob** (Schritt 1, Standard): Ingress aus demselben `security-tier`. Cross-Tier ist blockiert, Intra-Tier bleibt uneingeschränkt.
  - **fein** (Schritt 2, nur für Namespaces in `argocd_network_policy_refined_namespaces`): Ingress nur aus dem eigenen Namespace plus gezielte Zusatz-Namespaces aus
    `argocd_network_policy_extra_ingress`, z. B. ein CronJob in einem fremden Namespace, der die App per ClusterIP anspricht. Ein solcher Eintrag ist auch nötig, weil n8n-Workflows
    per HTTP an `ntfy.ntfy.svc` pushen (`zammad-ki-entwuerfe`, `whatsapp-relay`), Details in [d0030](../d-sicherheit/d0030-network-policies.md).
  - Auf einem frischen Cluster existiert beim ersten Lauf noch kein App-Namespace (der ArgoCD-Sync hinkt hinterher). Die Datei wäre dann leer und `kubectl apply` bricht mit „no objects
    passed to apply“ ab, deshalb wird der Apply übersprungen, wenn keine der gelisteten Apps als Namespace existiert.
- `cloudflared` ist eine generelle Ingress-Ausnahme wie `kube-system`, weil der Tunnel-Pod die Origin-Services per ClusterIP direkt
  anruft (kein Traefik). Ohne sie bricht der komplette externe Zugriff (Incident beim ersten groben Rollout, siehe
  [d0030](../d-sicherheit/d0030-network-policies.md)). Die Policies sind bewusst nur `policyTypes: [Ingress]`: Laterale Bewegung
  lässt sich vollständig an der Ingress-Grenze des Ziel-Namespaces blockieren, Egress-Regeln hätten ein deutlich höheres Risiko
  (DNS zu `kube-system`, Internet für n8n/cloudflared/Renovate, OIDC-Callbacks) bei keinem zusätzlichen Gewinn.

---

## PROD im Hub (`argocd/bootstrap-prod/`)

- Die Dateien sind **handgeschrieben**, nicht generiert und nicht Teil des `argocd`-Rollenlaufs. Einmalig im TECH-Cluster anwenden,
  **nachdem** der Cluster `prod` registriert ist: `kubectl apply -f argocd/bootstrap-prod/appproject.yaml` und `applicationset.yaml`
  ([README](../../argocd/bootstrap-prod/README.md)).
- **Zwei ApplicationSets:** `helm.releaseName` zwingt ArgoCD in den Helm-Modus und scheitert bei reinen Manifest-Ordnern ohne
  `Chart.yaml`. Deshalb `home-server-apps-prod` für reine Manifest-Ordner (**explizit gelistet**, ein neuer Manifest-Ordner braucht einen
  Pfad-Eintrag) und `home-server-apps-prod-charts` für jeden Ordner mit `Chart.yaml` (automatisch). Bei `files` ist `.path.path` der Ordner
  mit der `Chart.yaml`. Ein Ordner mit `Chart.yaml` darf nicht zusätzlich im ersten Set stehen (doppelte Applications).
- **Release-Name = Ordnername** (wie in TECH), **nicht** `prod-<app>`: Sonst hießen Secrets, PVCs und Deployments in PROD anders als in
  TECH, was namensgebundene SealedSecrets und die Datenmigration erschwert. Die **Application**-Namen tragen dagegen das Präfix
  `prod-`, damit sie nicht mit gleichnamigen TECH-Applications (`nas-storage`, `sealed-secrets`, …) kollidieren.
- Das AppProject `prod` ist weit bei den Ressourcentypen (wie die alten Projekte), eng bei `sourceRepos` und `destinations` (nur dieses
  Repo, nur der PROD-Cluster). Neue PROD-Namespaces müssen in `appproject.yaml` ergänzt werden (Namespace = Ordnername unter
  `argocd/apps/prod/`). `cert-manager` und das Traefik-`TLSStore` liegen in `kube-system`, die Apps in eigenen Namespaces.

### Migrationen (`argocd/bootstrap-prod/migrations/`)

Die Jobs werden **manuell in PROD** angewendet, nicht per ArgoCD (kein Set liest den Ordner). Muster:

```bash
ssh ubuntu@192.168.178.99 'sudo k3s kubectl apply -f -' < argocd/bootstrap-prod/migrations/<app>-…-job.yaml
ssh ubuntu@192.168.178.99 'sudo k3s kubectl -n <ns> logs -f job/<job>'
ssh ubuntu@192.168.178.99 'sudo k3s kubectl -n <ns> delete job <job>'
```

Gemeinsame Regeln: Lesen aus dem TECH-Verzeichnis nur `readOnly`. Das Zielvolume wird vor dem Kopieren geleert, damit ein wiederholter Lauf
exakt den TECH-Stand ergibt. Die TECH-App wird vorher **gestoppt** und die PROD-App steht auf 0. Sie **nie** mit leeren Volumes
starten, das legt eine neue Datenbank, neue Konten und neue Secrets an. Der Job läuft als uid 1000 (gid 10 bei NAS-Daten), weil das NAS
`all_squash` erzwingt und Besitzer und Rechte danach stimmen müssen.

| App | Besonderheiten |
|---|---|
| Immich | **Zwei Läufe** mit demselben Manifest: 1. Vorlauf bei **laufendem** TECH (Bibliothek ~74 GB, ändert sich kaum, dauert lange, Nutzer merken nichts, die dabei kopierten Postgres-Dateien sind inkonsistent), 2. Endsync mit **gestopptem** TECH (server, machineLearning, postgresql auf 0), nur noch das Delta, `--delete` gleicht das Ziel exakt an. Kopiert von Postgres nur `pgdata_fixed_pg16`, das alte `pgdata_fixed` (PG 14, Rückfall des Upgrades) bleibt in TECH, der ML-Modell-Cache wird nicht kopiert (lädt neu). Läuft als root, `rsync` ohne Besitzer-/Gruppenübernahme (`--no-o --no-g`), der Modus `0700` für PGDATA wird danach gesetzt. |
| Mealie | SQLite: nur mit **gestopptem** TECH-Mealie kopieren, sonst ist die DB evtl. inkonsistent. |
| Nextcloud | Dateien (`data` ~11 GB, `html` ~1 GB). Nur mit gestoppter TECH-App und PROD-App auf 0. Die Datenbank wird separat per `pg_dumpall`/`pg_dump` übernommen (sie liegt auf `local-path`, nicht auf dem NAS). `config.php` (Modus 640, Besitzer 1000) und `data` (770, Gruppe 10) bleiben so lesbar. |
| Paperless-ngx | SQLite (`db.sqlite3` plus `-wal`/`-shm`) muss konsistent sein, also TECH gestoppt. Der Redis-Speicher wird bewusst **nicht** kopiert (nur Task-Queue). |
| Wiki.js | Nur mit sauber heruntergefahrenem TECH-Postgres und gestopptem PROD-Postgres. Kopiert nur `pgdata_fixed_pg18` (PG 18, ~1,8 GB), das alte `pgdata_fixed` (PG 16, Rückfall) bleibt in TECH. PGDATA verlangt `0700`, uid 1000 wie Postgres im Chart. |
| Xibo | MySQL (~1,1 GB), CMS-Bibliothek (~14 MB), CMS-State. TECH-CMS und -MySQL auf 0, damit die MySQL-Dateien konsistent sind. Nur das aktuelle `mysql-data-v26` (subPath im Chart), die alten 8.4-Daten (Rückfall) bleiben in TECH. MySQL verlangt Besitzer uid 1000 und unveränderte Modi (`tar -p`). |

### SSO-Outpost in PROD (`migrations/sso-outpost/`)

- Die Middleware ruft den **Remote-Outpost in PROD** (`outpost.yaml`) auf, **nicht** den eingebetteten Outpost in TECH. Ein Aufruf über
  den Traefik in TECH scheitert mit 404, weil dieser `X-Forwarded-Host` für fremde Absender überschreibt und Authentik die App nicht
  mehr zuordnen kann. Ein direkter Zugriff auf den Authentik-Service scheidet wegen NetworkPolicy und der maskierten Quell-IP
  (ServiceLB) aus.
- Der Name `authentik` im Namespace `authentik` entspricht dem Annotationswert `authentik-authentik@kubernetescrd`, den die
  App-Ingresses aus TECH schon verwenden, sie müssen in PROD nicht geändert werden.
- Der Outpost meldet sich mit einem Token bei Authentik in TECH an und bekommt von dort die zugeordneten Provider. Outpost-Eintrag und
  Token entstehen in Authentik (Outposts → Erstellen, Typ „Proxy“, Integration: keine), das Token kommt als SealedSecret
  `authentik-outpost-token` (Schlüssel `token`). Die **Version muss zur Authentik-Version in TECH passen** (`image.tag` in
  `argocd/apps/tech/authentik/values.yaml`).

## Promotion (`argocd/promotion.yaml`)

- Die Datei wird von **keinem** ApplicationSet gelesen, sondern von `scripts/promote-chain.py`.
- Gates: Eine Version muss **24 h** gesund auf ENTW laufen, bevor sie nach TECH (bzw. direkt nach PROD, wenn die App in TECH nicht
  existiert) übernommen wird, danach **2 h** gesund auf TECH, bevor der PR nach PROD entsteht.
- Optionale HTTP-Prüfungen nach dem Health-Gate, je App und Umgebung (`entw` | `tech`): `url` (Pflicht), `status` (Standard 200),
  `contains` (Text im Body), `timeout` (Sekunden). Die Hosts lösen im CI nicht per Heim-DNS auf, der Workflow setzt `curl --resolve` auf
  die IP der Umgebung (`SMOKE_IP_ENTW`/`SMOKE_IP_TECH`, Standard `192.168.178.100` / `192.168.178.94`).

---

## SealedSecrets: Fallstricke beim Versiegeln

- **Kein Zeilenumbruch mitversiegeln.** `kubeseal --raw <<< "$WERT"` (Here-String) und `openssl rand -hex 24 | kubeseal` hängen einen
  `\n` an den Klartext. Das brach zweimal:
  - Authentik/lldap (Live-Rollout): Postgres’ Entrypoint trimmte das Byte beim `initdb` weg, Authentiks eigener Config-Loader nicht.
    Ergebnis „password authentication failed for user authentik“ im echten `scram-sha-256`-Pfad, während ein `PGPASSWORD`-Test über
    `127.0.0.1` (dort gilt `trust`) fälschlich erfolgreich wirkte. Neu versiegelt mit `printf '%s' "$WERT" | kubeseal --raw …`.
  - alamos-relay: Der Pfadvergleich im Relay ist **exakt** (kein `trim`). Ein mitversiegeltes `\n` macht den Pfad dauerhaft unmatchbar,
    also 404 für jeden Request, auch mit korrektem Token in der URL. Richtig:
    `openssl rand -hex 24 | tr -d '\n' | kubeseal --raw --namespace alamos-relay --name alamos-relay-secrets --controller-namespace sealed-secrets --controller-name sealed-secrets-controller --from-file=/dev/stdin`.
  - Allgemein deshalb `echo -n` bzw. `printf '%s'` verwenden, nie ein nacktes `echo`.
- `kubeseal --raw` erlaubt nur **einen** Schlüssel pro Aufruf. Secrets mit mehreren Keys brauchen den Multi-Key-Ablauf
  (`--merge-into`, siehe [300b0](../3-apps-workloads/300b0-nextcloud.md)). Teilen sich zwei Verbraucher dasselbe Passwort (Postgres und
  Wiki.js, MySQL und Xibo), reicht **ein** Aufruf.
- **Je Cluster ein eigener Schlüssel.** Ein mit dem TECH-Schlüssel versiegeltes SealedSecret lässt sich in PROD nicht entschlüsseln.
  `scripts/reseal-for-prod.sh <app>` liest das bereits entschlüsselte, laufende Secret aus TECH und versiegelt es **offline** mit dem
  öffentlichen Zertifikat des PROD-Controllers (Klartext nur durch eine Pipe, nie in Datei, nie ausgegeben). Es überschreibt die Datei
  in der PROD-Kopie mit einem statischen SealedSecret. Voraussetzung: `kubectl`-Kontext auf TECH, `jq`, `kubeseal` und die PROD-Kopie
  (das Skript legt sie an). `--list <app>` zeigt nur, was passieren würde. Das PROD-Zertifikat holt man einmalig (öffentlicher Teil):
  `ssh ubuntu@192.168.178.99 "sudo k3s kubectl -n sealed-secrets get secret -l sealedsecrets.bitnami.com/sealed-secrets-key=active -o jsonpath='{.items[0].data.tls\.crt}' | base64 -d" > ~/prod-sealed-secrets.pem`.
- `scripts/seal-github-token.sh` versiegelt ein GitHub-Lese-Token für wiki-docs-sync (PROD) und github-release-watcher (TECH) und hebt das
  Limit der unangemeldeten GitHub-API von 60 auf 5000 Anfragen pro Stunde. Das Token liest das Skript aus einer Datei (`TOKEN_FILE`,
  Standard `~/.github_readonly_token`, Modus 600), nie als Argument, nie ausgegeben. Erzeugen: GitHub → Settings → Developer settings →
  Fine-grained personal access tokens → „Public repositories (read-only)“, keine weiteren Berechtigungen, Ablauf z. B. 1 Jahr, dann
  `read -rs T; printf %s "$T" > ~/.github_readonly_token; chmod 600 ~/.github_readonly_token; unset T`. Ergebnis ist je ein statisches
  SealedSecret `github-api-token` (Schlüssel `token`) in beiden Charts plus `github.tokenSecretName: github-api-token`. Test ohne
  Repo-Änderung: `OUT_ROOT=/tmp/x TOKEN_FILE=/tmp/dummy scripts/seal-github-token.sh`.
- **Der CA-Private-Key liegt bewusst nicht als SealedSecret im Repo**, sondern wird einmalig per `kubectl create secret` importiert
  (Begründung in [60040](60040-helm-charts-tech.md#zertifikate-und-tls)).
- `lldap` `key-seed`: **einmalig, niemals rotieren**, sonst werden alle gesetzten Passwörter ungültig ([60070](60070-authentik-und-lldap.md)).
- Im Repo stehen nur SealedSecret-Chiffretexte (Werte wie `encryptedPassword`). Klartext gehört nie ins Repo: gitleaks lässt
  Chiffretext anhand seines Präfixes `Ag` passieren und meldet Klartext-Tokens weiterhin ([f0070](../f-cicd-automatisierung/f0070-ci-lint.md)).
