# Helm-Charts im PROD-Cluster — Hintergründe

Begründungen zu `argocd/apps/prod/*`. Vieles gilt wie im TECH-Cluster und steht in [60040](60040-helm-charts-tech.md) (HPA mit
`replicas: null`, `local-path`, Squash, Root-Container, Zertifikate). Hier stehen die Besonderheiten der PROD-Kopien und der PROD-Apps.
Die Datenmigration von TECH nach PROD steht in [60030](60030-argocd-und-bootstrap.md#migrationen-argocdbootstrap-prodmigrations).

---

## Regeln für alle PROD-Kopien

- **Nie mit leeren Volumes starten.** Die PROD-Kopien (Nextcloud, Immich, Paperless-ngx, Wiki.js, Mealie, Xibo) sind am **2026-09-19** aus TECH
  übernommen worden ([migrations/README](../../argocd/bootstrap-prod/migrations/README.md)). Ein Start mit leerem Volume legt eine neue
  Datenbank, neue Konten und neue Secrets an. Beim Umschalten (Teil B der Migration) steht die App während der Endkopie auf `0`, weil der
  Kopier-Job das Zielvolume leert, danach auf `1`. Die Postgres-/MySQL-Deployments haben einen eigenen Schalter (`replicas: 0` = gestoppt, für
  Umzug oder Wartung).
- **Release-Name = Ordnername.** Secrets, PVCs und Deployments heißen in PROD wie in TECH, damit namensgebundene SealedSecrets passen
  ([60030](60030-argocd-und-bootstrap.md#prod-im-hub-argocdbootstrap-prod)).
- **SealedSecrets sind mit dem PROD-Schlüssel versiegelt**, nicht mit dem TECH-Schlüssel (`scripts/reseal-for-prod.sh`, siehe
  [60030](60030-argocd-und-bootstrap.md#sealedsecrets-fallstricke-beim-versiegeln)).
- **Keine Node-Vorgabe.** TECH pinnt `local-path`-Apps auf `homeserver`, in PROD gibt es nur die `prod-vm`.
- **Externe Hosts** laufen über den eigenen PROD-Tunnel (`homeserver-prod`, [60040](60040-helm-charts-tech.md#cloudflared)). Bei der PROD-Kopie von
  `demo-app` fiel `demo-prod.pke-lab.de` vorerst weg, weil cloudflared `*.pke-lab.de` auf den Traefik in TECH routet und PROD (noch) nicht kannte.
- Wer eine PROD-App **ohne** Authentik-Middleware betreibt, muss das wissen: Die Middleware ist in PROD-Kopien wie Mealie **bewusst ausgebaut**, solange PROD
  keinen Authentik-Outpost hat ([60030](60030-argocd-und-bootstrap.md#sso-outpost-in-prod-migrationssso-outpost)). Ohne SSO schützt nur die eigene
  Anmeldung der App (Mealie: `ALLOW_SIGNUP=false`), die Zugriffsbeschränkung über die Authentik-Policy (`admins`/`mealie-user`) entfällt. Zum
  Wiedereinbau die Annotation `traefik.ingress.kubernetes.io/router.middlewares: "authentik-authentik@kubernetescrd"` zurück in `annotations`
  setzen.

---

## Nextcloud

- **Version nicht ungeprüft hochziehen.** Tatsächlich auf der PVC installiert ist `34.0.2.1` (geprüft am 2026-08-17 mit
  `require version.php; implode(".", $OC_Version)` gegen die echte `html`-PVC). Ein Tag-Wechsel löst beim nächsten Pod-Start Nextclouds
  Upgrade-Pfad aus, und der ist auf diesem NAS aktuell fatal. **Rollback 2026-08-30:** Renovate-PR #201 hob den Tag automatisiert auf
  `34.0.3-apache` an, der Pod ging in den endlosen `CrashLoopBackOff` (siehe unten), zurückgesetzt auf `34.0.2-apache`. Das Image ist in
  `renovate.json` pausiert. Bis ein sicherer Upgrade-Weg (z. B. Primärspeicher auf S3/MinIO, [300b0](../3-apps-workloads/300b0-nextcloud.md))
  existiert, wird der Tag **nur manuell und vorsichtig** angehoben.
- **Warum das Upgrade scheitert (`all_squash`):** Der offizielle Entrypoint wählt seine `rsync`-Optionen für den App-Code-Sync anhand von `id -u`. Als
  root nutzt er `-rlDog --chown www-data:www-data` und versucht Owner/Group auf **jeder einzelnen** der tausenden App-Dateien zu setzen, sobald
  `version.php` auf der PVC von der Image-Version abweicht. Unter `all_squash` schlägt jeder `chown` mit „Operation not permitted“ fehl, `rsync` endet mit
  Exit 23, der Container crasht, bei jedem Neustart erneut (empirisch reproduziert mit dem Tag-Bump auf 34.0.3, Troubleshooting in 300b0). Als
  Nicht-root wählt der Entrypoint die `chown`-freie Variante (`-rlD`). Das wurde geprüft und verworfen: Das Image ist nicht für beliebige
  Nicht-root-UIDs gebaut, z. B. ist `/usr/local/etc/php/conf.d/` nur für root beschreibbar, dort schreibt der Entrypoint u. a. die Redis-Session-Config
  hinein („Permission denied“ schon vor dem App-Sync, per Testpod verifiziert). Root beizubehalten ist deshalb die einzig praktikable Option.
- Das Apache-Image läuft als root (kein `USER`, der Apache-Master-Prozess braucht Port 80), analog zu Vaultwarden ohne `runAsNonRoot`. Ein früherer
  Kommentar nahm an, der `nas`-Export sei mit `no_root_squash` freigegeben, das ist seit dem Umstieg auf `all_squash` überholt.
- **Mehrere App-Pods sind sicher**, obwohl `html`/`data` `ReadWriteOnce`-PVCs sind: Nextcloud nutzt ein eigenes Redis (per `REDIS_HOST` verdrahtet) für
  verteiltes Datei-Locking. Solange der Storage geteilt **und** das Locking extern ist, unterstützt die Architektur mehrere Pods. Wegen RWO/NFS zusätzlich
  `podAffinity`, damit alle Replicas auf demselben Node laufen (die Affinity steht fest im Deployment-Template, kein konfigurierbarer Wert mehr). Das Redis
  hat keine PVC: Locks und Transactional-Cache sind bei einem Neustart unkritisch und werden neu aufgebaut.
- `trustedDomains` enthält den internen Host (`*.homeserver`, Traefik) **und** den externen (Cloudflare). Ohne beide weist Nextcloud Requests mit
  „Access through untrusted domain“ ab. Die `overwrite*`-Einstellungen (`overwritehost`, `overwriteprotocol`, `overwrite.cli.url`) erzwingen den öffentlichen Host für alle
  generierten URLs (v. a. Freigabe-Links), unabhängig davon, über welchen Host man zugreift. Gesetzt wird das per `occ` aus dem PostSync-Reparatur-Job. In **PROD ist der Job aus**: `config.php` kommt
  aus TECH und ist schon korrekt, auf einem leeren Volume würde er scheitern.
- **Postgres:** Major-Upgrade 16 → 18 am 2026-08-30 (Dump/Restore, [300b0](../3-apps-workloads/300b0-nextcloud.md)). `PGDATA` in
  `postgres-deployment.yaml` zeigt seitdem auf `pgdata_pg18`, der alte `pgdata`-Ordner liegt als **Rollback-Fallback** auf derselben PVC und kann nach
  ein paar Tagen störungsfreiem Betrieb aufgeräumt werden. Die DB liegt auf `local-path`, Files und Blobs bleiben auf `nas`.

## Immich

- **Postgres** ist das offizielle `immich-app/postgres`-Image mit VectorChord: Das Standard-Postgres-Image reicht nicht, weil die Vektor-Ähnlichkeitssuche
  eine Extension braucht, die Immich selbst mitliefert. Major-Upgrade 14 → 16 am 2026-08-30 (Dump/Restore, [300c0](../3-apps-workloads/300c0-immich.md)):
  Es gibt keinen exakten `pgvectors0.2.0`-Tag für Postgres 16 (GHCR-Tag-Liste geprüft), der nächste Treffer derselben `vectorchord0.4.3`-Familie ist
  `pgvectors0.2.1` (Patch-Bump, innerhalb des laut Immich-Doku unterstützten Bereichs VectorChord `>=0.3,<2.0`). `PGDATA` zeigt auf `pgdata_fixed_pg16`, der
  alte `pgdata_fixed`-Ordner ist Rollback-Fallback und kann nach ein paar störungsfreien Tagen aufgeräumt werden.
- **Server:** Mehr Pods helfen gegen Abstürze durch **viele gleichzeitige** Uploads (mehr parallele Job-Verarbeitung), lösen aber **nicht** das Problem, dass ein
  einzelnes sehr großes Foto oder Video mehr RAM braucht, als `resources.limits` erlaubt: dafür `limits.memory` anheben. Die Pods laufen per `podAffinity`
  immer auf demselben Node wie die vorhandenen Server-Pods, weil die `library`-PVC `ReadWriteOnce` ist.
- **Machine-Learning** (Gesichtserkennung, CLIP-Suche) ist reine CPU-Inferenz, kein GPU-Passthrough. `maxReplicas` ist bewusst niedriger als beim Server,
  jede Inferenz-Instanz belegt bis zu 4 CPU-Kerne und 4 Gi RAM. Co-Location per `podAffinity` wegen des `RWO`-Model-Caches.
- Der Redis/Valkey-Speicher (Job-Queue) hat **keine PVC**: Jobs werden bei einem Neustart aus der Postgres-Datenbank neu eingeplant. Die Empfehlung der Immich-Doku
  für Datenintegrität ist gesetzt. Der Postgres-Backup-CronJob liefert zusätzlich zum Datei-Backup (restic auf `immich-nas`) einen transaktionskonsistenten, einzeln
  rückspielbaren Dump ([40080](../4-planung/40080-multi-cluster-entw-prod-tech.md)).
- Der Storage `immich-nas` ist mit `no_root_squash` exportiert, das Image läuft ohne erzwungenes `runAsNonRoot` (analog zu Nextcloud).
- **Externe Bibliothek** (optional, standardmäßig aus): direkter, read-only NFS-Mount für vorhandene Fotoordner (z. B. ein Massen-Export aus OneDrive), die nicht
  über die Upload-API laufen, sondern per Immichs „External Library“ eingelesen werden. Die Dateien bleiben als normale Ordnerstruktur auf dem NAS, ohne
  Duplikat in der `library`-PVC. Der Unterordner auf dem NAS muss vorher manuell angelegt werden ([300c0](../3-apps-workloads/300c0-immich.md), „Externe Bibliothek“).

## Wiki.js und wiki-docs-sync

- Wiki.js speichert Seiten **und Assets** vollständig in PostgreSQL, der App-Pod braucht kein PVC und keine NodeAffinity (Postgres schon). Postgres-Major-Upgrade
  16 → 18 am 2026-08-30, `PGDATA` = `pgdata_fixed_pg18`, der alte `pgdata_fixed`-Ordner ist Rollback-Fallback (aufräumbar nach einigen störungsfreien Tagen).
  Das Postgres-Passwort ist **ein** Wert, den Postgres (`POSTGRES_PASSWORD`) und Wiki.js (`DB_PASS`) gemeinsam lesen.
- **`maxReplicas` ist auf 1 gedeckelt.** Die Seiten liegen zwar vollständig in PostgreSQL, aber Wiki.js cached den API-Enable-Status und die Key-Validierung offenbar
  pro Pod-Instanz ohne Sync zwischen Replicas (ohne Redis o. Ä.). Mehrere gleichzeitig aktive Pods führten zu inkonsistenten „API Key invalid“/„API disabled“-Fehlern
  beim wiki-docs-sync. Das Wiki selbst stoppt man mit `wikijs.autoscaling.enabled=false` plus `wikijs.replicaCount=0`.
- **wiki-docs-sync:**
  - Der CronJob läuft alle 15 Minuten. `sync.py` listet `docs/` **eine Ebene rekursiv**: 1 Call für `docs/` selbst plus 1 pro Unterordner (auch `assets/` und
    `superpowers/`). Mit heute 14 Unterordnern sind das 15 Contents-API-Calls pro Lauf, also ~60 pro Stunde und damit genau das Limit für unauthentifizierte
    Anfragen (60/h, früher waren es ~44/h bei ~11 Calls). Jeder weitere Kategorie-Ordner überschreitet es. Deshalb ist der GitHub-PAT (Secret `github-api-token`,
    `scripts/seal-github-token.sh`, hebt das Limit auf 5000/h) hier faktisch Pflicht. Er ist nur für die Contents-Listing-Anfragen relevant, nicht für die
    Datei-Downloads über `raw.githubusercontent.com`, und kommt aus einem **vorhandenen** Secret, das der Chart nicht anlegt.
  - `wikijs.url` ist der **interne ClusterIP-Service**, nicht die öffentliche Cloudflare-Tunnel-URL: Cloudflares Bot-Schutz blockt Requests von `urllib`
    (403, „error code 1010“), und der Sync-Job läuft ohnehin im selben Cluster wie Wiki.js.
  - **`locale` steht separat vom `pathPrefix`:** Wiki.js reserviert zweistellige Pfad-Segmente (z. B. `en`) für das Locale, es wird **nicht** Teil des
    `pathPrefix`, sondern von Wiki.js automatisch vor den Pfad gehängt. `docsSubpath` ist der Unterordner unterhalb des `pathPrefix`, in den die
    `docs/*.md`-Dateien gespiegelt werden, `github.extraFiles` (z. B. `README.md` mit `slug: ReadMe`) landen dagegen direkt unter dem `pathPrefix`. Der `slug` bestimmt
    Wiki.js-Seitenpfad und Fallback-Titel.
  - Der Wiki.js-API-Token liegt als SealedSecret `wiki-docs-sync-wikijs-token` im Chart-Template (Wiki.js: Administration → Utilities → API Access). Die
    Templates lesen keinen `secrets:`-Block aus den Values.
  - Die frühere NetworkPolicy-Ausnahme wiki-docs-sync → wikijs (`argocd_network_policy_extra_ingress`) gibt es nicht mehr: Beide Apps laufen in PROD, und dort gibt
    es keine Standard-Policy ([40080](../4-planung/40080-multi-cluster-entw-prod-tech.md), [d0030](../d-sicherheit/d0030-network-policies.md)).

## Xibo (xibosignage)

- **MySQL** ist ein eigenes Deployment mit dem offiziellen Image, **kein** Bitnami-Subchart (wie bei Wiki.js und Immich), mit Persistenz auf `nas`. Major-Upgrade 8.4 → 26.7
  am 2026-08-30 (Dump/Restore, [300e0](../3-apps-workloads/300e0-xibosignage.md)): Der `mountPath` zeigt seitdem per `subPath` auf `mysql-data-v26`, die alten
  8.4-Daten liegen als Rollback-Fallback an der PVC-Wurzel und können nach einigen störungsfreien Tagen aufgeräumt werden. Das DB-Passwort ist **ein** Wert, den
  MySQL und Xibo CMS gemeinsam lesen.
- **CMS-Container läuft mit Default-User (root):** Das offizielle `xibo-cms`-Image braucht beim ersten Start root. `entrypoint.sh` schreibt `/root/.my.cnf`, konfiguriert
  Apache/PHP/cron unter `/etc` und schreibt `web/settings.php` im Container-eigenen Rootfs. Mit erzwungenem `runAsUser: 1000` schlagen alle Schritte mit
  „Permission denied“ fehl (`CrashLoopBackOff`). Nur die Datenbank bekommt `runAsUser`/`runAsGroup`.
- **Zusatzdienste**, die die CMS-Oberfläche erwartet, auch wenn sie hier wenig nutzen: **XMR** (Xibo Message Relay, ZeroMQ-Broker zwischen CMS und Playern) ist für den
  Chromium-Kiosk-Ansatz (kein echter Xibo-Player) aktuell ungenutzt, aber Teil der offiziellen CMS-Referenzarchitektur. **Memcached** ist der Objekt-/Session-Cache
  (`CMS_USE_MEMCACHED`/`MEMCACHED_HOST`, `-m 15` = 15 MiB wie im offiziellen `docker-compose.yml`). **QuickChart** rendert Chart-Widgets serverseitig als PNG (optional).
- Der eingebaute Cron des CMS-Containers ist aktiviert: Er erledigt periodische Wartungs-Tasks (Layout-Status, Thumbnails, Stats-Aggregation, Player-Actions), ohne ihn bleiben
  Displays und Layouts nach dem ersten Sync nicht aktuell. Das Upload-Limit ist hoch gesetzt, damit große Fotos vom Handy oder NAS-Sync nicht daran scheitern. Weitere
  Variablen: `config.env.template` im Upstream-Repo `xibosignage/xibo-docker`.
- `custom`, `backup`, `userscripts` und `ca-certs` (aus dem offiziellen `docker-compose.yml`) teilen sich **eine kleine PVC** mit unterschiedlichen `subPath`s (spart drei winzige PVCs).
- **Zwei verschiedene Ordner nicht verwechseln:** Xibo verwaltet seine Medien-Bibliothek (interne Dateinamen und Hashes) **exklusiv selbst**. Das ist **nicht** der Ordner, in den
  n8n/OnlineSync Rohdateien legt (`xibosignage-inbox`/`-display` in `argocd/apps/tech/n8n`, [300e0](../3-apps-workloads/300e0-xibosignage.md)).
- Der externe Host läuft **ohne** Authentik-ForwardAuth (anders als Mealie/Uptime Kuma): Nur das CMS-Login schützt ihn, analog zum früheren n8n-Setup. Der n8n-Playlist-Sync
  braucht per NetworkPolicy eine Ingress-Ausnahme auf `cms-web`. Die Ausnahme gilt nur in TECH, in PROD gibt es keine Standard-Policy, sie hätte das CMS sonst auf einen
  nicht vorhandenen `n8n`-Namespace isoliert ([40080](../4-planung/40080-multi-cluster-entw-prod-tech.md)).

## Paperless-ngx, Mealie, TinyTeller

- **Paperless-ngx** wurde am 2026-09-19 von TECH kopiert. Der v3-Sprung ging von `2.20.15` (Zwischenschritt, siehe `git log`) aus: Die Konfiguration war schon sauber
  für v3 (`PAPERLESS_SECRET_KEY` und `PAPERLESS_DBENGINE` gesetzt, keine deprecated Env-Vars, keine Verschlüsselung im Einsatz), der Such-Index baut sich beim ersten
  Start automatisch neu auf (Whoosh → tantivy). `PAPERLESS_URL` (öffentliche Adresse hinter dem Reverse-Proxy) setzt `CSRF_TRUSTED_ORIGINS` und `ALLOWED_HOSTS`. Ohne sie scheitert das Login
  mit „CSRF verification failed / Origin checking failed“ (TLS endet im Traefik, Django sieht HTTP). OCR: Deutsch plus Englisch (`deu+eng`, weitere per `deu+eng+fra`), ein
  Worker/Thread reicht für den Heimbetrieb. Der `SECRET_KEY` gehört in ein SealedSecret, ein fester Platzhalter ist nur vorläufig und nach dem Deploy sofort zu ersetzen.
- **Mealie:** siehe oben (Authentik-Middleware in PROD ausgebaut, Kopier-Job nur mit gestopptem TECH-Mealie, weil SQLite). Ein Worker reicht für den Heimbetrieb.
- **TinyTeller** war früher Docker-Compose auf worker-0 (eigene Ansible-Rolle, inzwischen entfernt) und ist jetzt eine reguläre k8s-App. Zustandslos (keine PVC), läuft auf jedem Node, keine NodeAffinity.
  - Das Frontend-Image (`ghcr.io/jaydee94/tiny-teller-frontend`) hat den Upstream-Host `backend` **fest in seiner nginx-Config** (Docker-Compose-Erbe). Der Service
    `backend-alias-service` existiert nur, damit `backend` im Namespace per DNS auflöst. Er ist kein eigenständiger Endpoint und zeigt auf dieselben Pods wie der eigentliche `-backend`-Service.
  - Ein Host, Pfad-Routing: `/api` → Backend, alles andere → Frontend. **Annahme:** Das Frontend ruft die API relativ unter `/api` auf. Erwartet das gebaute Frontend stattdessen eine
    absolute API-URL, muss `CORS_ORIGIN` angepasst und ggf. auf zwei Hosts (Frontend/API) umgestellt werden.
  - **Offen:** Sobald der eigene Fork (`pkr-lab/tiny-teller`) per CI nach `ghcr.io/pkr-lab/tiny-teller-…` veröffentlicht wird, hier umstellen. Ist das Package dann privat: entweder Sichtbarkeit auf
    „Public“ stellen oder ein `imagePullSecrets`-Secret (`kubernetes.io/dockerconfigjson`, z. B. `ghcr-pull`) referenzieren.

## Sonstiges

- **demo-app** (ENTW, PROD): Der anzuzeigende Text steckt in der Environment-Variable `MESSAGE`, die man live mit `kubectl set env …` überschreibt. Kubernetes ersetzt `$(MESSAGE)` durch den
  Wert, `http-echo` gibt danach exakt diesen Text als Body aus.
- **cert-manager (PROD):** Zertifikat und Issuer siehe [60040](60040-helm-charts-tech.md#zertifikate-und-tls).
- **PROD-Namespaces** müssen in `argocd/bootstrap-prod/appproject.yaml` stehen, sonst scheitert der Sync mit
  `application destination … is not permitted in project 'prod'` ([b0020](../b-kubernetes-gitops/b0020-argocd-projects.md)).
