# Helm-Charts im TECH-Cluster — Hintergründe

Begründungen zu `argocd/apps/tech/*/values.yaml`, zu den Chart-Templates und den Dockerfiles der TECH-Apps. Bedienung der Apps steht in
den Docs unter `3-apps-workloads/`. Themen mit eigenem Doc: Monitoring in [60060](60060-monitoring-und-alerting.md), Authentik und lldap in
[60070](60070-authentik-und-lldap.md), carplay-api in [60080](60080-carplay-api-und-ios-app.md), pacman in
[60090](60090-pacman-schulungsobjekt.md). PROD-Apps stehen in [60050](60050-helm-charts-prod.md).

---

## Gemeinsame Muster

### HPA und `replicas: null`

- Bei Charts, deren Values-Schema keine Autoscaling-Schlüssel kennt (headlamp, kubeseal-webgui, zammad nginx/railsserver), definiert der
  Wrapper eine **eigene** `HorizontalPodAutoscaler`-Vorlage. `scaleTargetRef.name` ist der **literale** Deployment-Name, den der
  Upstream-Chart rendert (per `helm template` geprüft), kein Helm-`include`, weil die Templates des Upstream-Charts nicht uns gehören.
- Der Replica-Wert steht in den Values auf **`null`** (nicht weggelassen): Das Upstream-Template rendert `replicas:` leer,
  Kubernetes behandelt das Feld als nicht gesetzt, defaultet bei der Erstellung auf 1 und rührt es danach nicht mehr an. So bekämpft
  `selfHeal` von ArgoCD den HPA nicht bei jedem Sync. Ein festes `1` würde die Deployments nach jedem HPA-Scale-Up sofort auf 1
  zurücksetzen. Der Wert „Only used while `autoscaling.enabled` is false“ gilt in allen anderen Charts: Danach übernimmt der HPA.
- Skaliert wird oft **nur nach CPU**: Memory-Utilization triggerte bei zammad-railsserver ständig auf `maxReplicas`, obwohl die
  CPU-Last einstellig blieb (Rails pendelt sich dauerhaft über 80 % des Requests ein, normales RAM-Verhalten). Bei cloudflared,
  pacman und whoami ist der Footprint winzig oder speicherunabhängig.
- Der Ignore-Eintrag im ApplicationSet-Template ([60030](60030-argocd-und-bootstrap.md#ignoredifferences-im-applicationset-template))
  ist das Gegenstück auf ArgoCD-Seite.

### Speicher: `local-path`, NAS und Squash

- **`local-path` bindet den Pod an den Node**, auf dem die PVC zuerst provisioniert wird. Diese Apps sind deshalb fest auf
  `homeserver` gepinnt (aktuell ohnehin der einzige Ready-Node), damit der Scheduler sie nicht zufällig auf worker-0/worker-1 legt
  ([20000](../2-betrieb-hardware/20000-nas-storage.md)).
- Die StorageClass **`nas`** (NFS, UGREEN NAS `192.168.178.97`, RAID1) ersetzt die alte `hdd`-StorageClass (worker-0/sda). Eigenschaften:
  `reclaimPolicy: Retain` (Daten bleiben beim Löschen der PVC), `volumeBindingMode: Immediate` (NFS ist von jedem Node mountbar), keine
  Volume-Expansion (der `nfs-subdir-external-provisioner` kann PVCs nicht vergrößern). Pods brauchen **keine** NodeAffinity mehr, und der
  Provisioner läuft auf jedem Node, die „Bindung“ ist der NFS-Mount und nicht der lokale Pfad. Die Leader-Election des Provisioners
  läuft über Endpoints im eigenen Namespace.
- `immich-nas` ist ein **eigener** Provisioner für den Export `/volume2/immich-storage`, getrennt vom generischen Export
  `/volume1/k8s-storage`: Kapazitätsplanung und Backup der Fotobibliothek bleiben so unabhängig vom übrigen Cluster-Storage. Er ist mit
  `no_root_squash` exportiert.
- Das NAS erzwingt inzwischen **`all_squash`** auf der `nas`-Klasse (kein `no_root_squash` mehr verfügbar), auch Root-Requests werden
  gesquasht. Deshalb liegen **reine State-Daten** auf `local-path`: die Postgres-Datenverzeichnisse von Zammad, Nextcloud, Wiki.js und
  Immich, VictoriaMetrics und Vaultwarden. Dateien und Blobs bleiben auf `nas`. Ein Umzug bestehender PVCs braucht das
  Migrations-Runbook in [20000](../2-betrieb-hardware/20000-nas-storage.md), denn `storageClassName` ist immutable.
- `local-path` legt das Verzeichnis als `root:root` (0777) an. `fsGroup` setzt nur die Gruppe, nicht den Owner, deshalb scheitert der
  interne `chmod`-Fixup eines Nicht-root-Postgres (UID 1001) wie zuvor auf NFS. Der Bitnami-Fix ist ein Init-Container
  (`volumePermissions`), der einmalig als root vorchownt.

### Root-Container und `runAsNonRoot`

Diese Images laufen bewusst **als root** oder brauchen einen Root-Start, ein erzwungenes `runAsNonRoot`/`runAsUser` bricht sie:

| App | Grund |
|---|---|
| uptime-kuma | Das Image hat kein `USER` und erwartet root: Der Entrypoint (`/app/extra/entrypoint.sh`) `chown`t `/app/data` selbst nach `$PUID:$PGID` und wechselt danach per `setpriv`. Mit erzwungenem Nicht-root-Start scheitert der `chown` immer mit „Operation not permitted“, unabhängig von StorageClass und Volume-Ownership. `PUID`/`PGID` steuern den Privilege-Drop (läuft am Ende als 1000:1000). |
| lldap | Der Entrypoint startet als root, `chown`t `/app` und `/data` auf UID/GID (Default 1000) und wechselt per `gosu` (gleiches Muster wie uptime-kuma). |
| vaultwarden | Das offizielle Image läuft als root (kein `USER`), anders als n8n/gotify. |
| pihole | FTL braucht root plus Capabilities (`NET_ADMIN`/`NET_RAW` laut Upstream-Doku, auch ohne DHCP), um Port 53 zu binden. Kein `drop: ALL` mehr: Der Entrypoint braucht das normale Docker-Default-Set (u. a. `CHOWN`, `SETGID`, `SETUID`, `FOWNER`), um auf den internen `pihole`-User zu wechseln und Volume-Dateien zu `chown`en. Mit `drop: ALL` brach der Start mit einer Kette von „Operation not permitted“ ab. Da der Container ohnehin als root läuft (Single-Tenant-Node), bringt selektives Droppen hier keinen relevanten Gewinn. |
| gotify | Läuft nicht-root: `GOTIFY_SERVER_PORT` steht auf 8080, damit der Container mit einer UID ohne Root-Rechte einen Port ≥ 1024 bindet. |
| pacman | Distroless-Image: Das Basis-Image `:nonroot` hat bereits die numerische UID 65532. `USER nonroot` (symbolisch) im Dockerfile würde einen nicht-numerischen User in die OCI-Config schreiben, den die `runAsNonRoot`-Prüfung des kubelet ablehnt („image has non-numeric user (nonroot)“). |

Die Dockerfiles von carplay-api und pacman sind Multi-Stage-Builds: Ein statisches Go-Binary kommt auf ein Distroless-Image ohne Shell,
Paketmanager und libc — nichts, was ein Angreifer im kompromittierten Container nutzen könnte, und nichts zu patchen. Beim carplay-api ist
die im Image gesetzte UID nur der Image-Default, das `securityContext` des Deployments (`runAsUser: 1000`) überschreibt sie.

### Images und Build

- Tags sind zur Reproduzierbarkeit **gepinnt**. Selbst gebaute Images (pacman, carplay-api, n8n) baut
  `.github/workflows/build-images.yml` bei jeder Änderung an `Dockerfile`/`src`; der Lauf öffnet einen PR, der `image.tag` setzt
  ([600a0](600a0-ci-workflows-und-skripte.md), [f0060](../f-cicd-automatisierung/f0060-build-images.md)).
- Ist das GHCR-Package privat, braucht der Namespace ein Pull-Secret:
  `kubectl -n carplay-api create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=<user> --docker-password=<pat>`.
- **Chart-Versionen schweben:** `argo-workflows` und `minio` hängen mit `version: "*"` an ihren Community-Charts (beobachtet zum Zeitpunkt
  der Erstellung: argo-helm 1.0.x bzw. `charts.min.io` 5.x). Ein neuer Upstream-Stand wird also automatisch gezogen. Eine konkrete Version
  festlegen, sobald sie mit `helm search repo` geprüft ist.

### Externe Hosts, Namen und ForwardAuth

- Externe Hosts hängen am Cloudflare-Tunnel-Wildcard (`*.pke-lab.de`) und werden an Traefik weitergereicht
  ([c0040](../c-netzwerk-dns/c0040-domain-tiers.md)). Externe Namen tragen einen **Bindestrich** statt Punkt (Cloudflares kostenloses
  Universal-SSL deckt nur eine Label-Ebene ab), z. B. `mealie-prod.pke-lab.de`. Zwei Namen weichen bewusst vom App-Namen ab: `status`
  statt `uptime-kuma` (damit die eingesetzte Software nicht aus der URL erkennbar ist) und `support` statt `zammad` (so lautet der
  öffentliche Hostname in cloudflared).
- **Nicht** hinter Authentik-ForwardAuth stehen: Vaultwarden (die Bitwarden-Apps und Browser-Erweiterungen sprechen die API direkt,
  Master-Passwort und eigenes 2FA sichern sie, ein Redirect würde Login/Sync brechen), Grafana (keine wichtigen Daten dahinter, eigener
  Login reicht, Nutzerentscheidung 22.08.2026 auch nach der Authentik-Ablösung), der externe Status-Host von Uptime Kuma und Xibo (nur das
  CMS-Login), mediamtx (eigene interne Auth, siehe unten) und lldap (nur intern).
- **Zweite Ingresses ohne ForwardAuth:** Bei Uptime Kuma und Mealie als „Knopfdruck zur nativen Anmeldung“ (Bypass-Ingress, Ziel des
  Fallback-Links auf Authentiks Login-Seite, bei Mealie auch für die Mobile-App), bei Gotify als `gotify-api.tech.homeserver` für native
  App-Zugriffe wie iGotify und bei Semaphore als `semaphore-api.tech.homeserver`, weil die Rolle `semaphore_bootstrap` die REST-API ohne
  Browser-Session-Cookie anspricht. Alle vom `*.homeserver`-Wildcard automatisch aufgelöst.
- **Admin-Tools bleiben intern** (lldap, Headlamp, Semaphore, MinIO: „Nicht freigeben“ in
  [e0000](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md)). Ein Dienst wird nur öffentlich, wenn sein `ingress.hosts` einen
  eigenen `*-pke-lab.de`-Host enthält.

---

## Zertifikate und TLS

**Warum es kein Wildcard-Zertifikat gibt.** Ein echtes `*.homeserver` ist strukturell unmöglich (Single-Label-TLD, RFC-6125-/
`X509_check_host`-Regel, unabhängig vom Tool, siehe [d0040](../d-sicherheit/d0040-internal-tls.md)). Das Zertifikat
`homeserver-wildcard-tls` (Namespace `kube-system`) enthält deshalb eine **explizite `dnsNames`-Liste**, tier-behaftet
(`<app>.tech.homeserver`, `<app>.prod.homeserver`). Ein neuer Host braucht **einen Eintrag dort plus Commit**. Das ist inhärent zur
fehlenden Wildcard-Fähigkeit, nicht spezifisch für cert-manager.

| Stelle | Begründung |
|---|---|
| cert-manager statt manuellem Ablauf | Ersetzt „SAN-Liste live aus dem Cluster ziehen, mit `openssl` signieren, `kubeseal`“ und das committete SealedSecret. cert-manager erneuert vor Ablauf (`duration`/`renewBefore`), der Kalender-Reminder für den 11.11.2028 entfällt. Der alte SealedSecret trug noch die **untierte** Liste von vor der Domain-Tier-Migration, das war der eigentliche Grund für Hostname-Mismatches auf jedem tier-behafteten Host. |
| SAN-Einträge, die man leicht vergisst | `argocd.tech.homeserver` (Web-UI per Ingress), der Journal-Upload-Host (Rolle `journal_upload`: ohne Eintrag scheitert die TLS-Prüfung, und der Upload-Dienst läuft in eine Fehlerschleife), `alamos-relay.prod.homeserver` und `pacman.prod.homeserver` (liefen noch in TECH, hatten aber keinen SAN-Eintrag: TLS-Prüfung gegen `https://alamos-relay.prod.homeserver` scheiterte mit Hostname-Mismatch, Sweep 2026-09-24). Authentik braucht **einen** Hostnamen (Authelia brauchte wegen einer statischen Cookie-Domain pro Tier zwei), die lldap-Web-UI ist LAN/Tailscale-only. |
| ClusterIssuer nutzt die **bestehende** Root-CA | Kein `SelfSigned`-Bootstrap mit neu erzeugter Root-CA (der cert-manager-Standardweg): Das würde eine komplett neue CA erzeugen und auf **jedem Client-Gerät** einen erneuten Trust-Store-Rollout brauchen. Stattdessen wird die vorhandene CA (`rootCA.pem`/`rootCA-key.pem`) einmalig als Kubernetes-Secret importiert, das auf allen Geräten installierte `docs/assets/homeserver-root-ca.pem` bleibt gültig (Befehl in d0040, „Einmaliger Import“). |
| CA-Key **nicht** als SealedSecret | Der CA-Key wandert bewusst ins Cluster (cert-manager muss selbst signieren und erneuern können), ist aber höherwertig als ein App-Secret: Ein Leak der Sealed-Secrets-Controller-Keys aus dem Repo darf ihn nicht mit offenlegen. Der Import bleibt ein einmaliger manueller `kubectl create secret`-Schritt außerhalb von GitOps, das Secret existiert nur im Cluster. |
| PROD: eigene Intermediate-CA | Der PROD-Issuer signiert mit einer PROD-eigenen Intermediate-CA aus der gemeinsamen Root-CA (Entscheidung 0.3, Baustein 4 in [40080](../4-planung/40080-multi-cluster-entw-prod-tech.md)). Clients vertrauen weiter nur der Root-CA, kein neuer Trust-Rollout. Der Root-Key verlässt den Rechner nicht, nur der Intermediate-Key liegt in PROD (Secret `homeserver-ca-keypair` im Namespace `cert-manager`, einmalig manuell importiert, nie im Repo, auch nicht versiegelt). Das PROD-Zertifikat hat dieselben Secret-/Namespace-Namen (`homeserver-wildcard-tls` in `kube-system`), damit das `TLSStore` unverändert greift, aber nur die `*.prod.homeserver`-Hosts. |
| cert-manager-Values | CRDs sind Teil des Helm-Release (ArgoCD wendet alles in einem Sync an, kein manueller Vorab-Schritt). Sie bleiben erhalten, falls die App aus ArgoCD entfernt wird: Ein versehentliches Prune soll nicht alle Zertifikatsdefinitionen mitreißen. Die `startupapicheck` ist **deaktiviert**: Ihr Job hängt bei jedem Sync ein zusätzliches Job-Objekt an, das manuell aufgeräumt werden müsste (ArgoCD prunt abgeschlossene Jobs nicht), die echte Verifikation läuft über den Status des `Certificate`. |
| `TLSStore` `default` | Der Name `default` ist keine freie Wahl, sondern die von Traefik reservierte Sonder-Ressource, die für jeden Router ohne explizites `TLSStore` gilt. Ohne sie fiele jeder Router auf Traefiks selbstsigniertes Zertifikat zurück (Browser-Warnung trotz Verschlüsselung). Bewusst **ein** `TLSStore` statt `spec.tls.secretName` an jedem der ~36 Ingress-Objekte. |
| Globaler HTTP→HTTPS-Redirect (`ports.web.http.redirections`) | Ohne ihn beantwortet Traefik Port 80 für jeden Host weiterhin unverschlüsselt, das Zertifikat greift nur auf `:443`. Sichtbar wurde das über Authentik: Dessen ForwardAuth-Middleware berechnet die Rückkehr-URL dynamisch aus dem tatsächlichen Request-Schema (`trustForwardHeader: true`), kam der Request über Port 80, blieb der gesamte Login-Flow samt Auth-Cookie auf Klartext-HTTP. cloudflared zeigt für externe Hosts ohnehin auf den HTTPS-Entrypoint und ist vom Redirect nicht betroffen. |
| Folge des Redirects | Der Redirect ist ein **308**, und viele Clients folgen ihm bei `POST` nicht (`urllib`, `systemd-journal-upload`, `ansible.builtin.uri`). Deshalb sind `https://` und der Port Pflicht bei `journal_upload`, `semaphore_api_base`, vmagent und der Zammad-URL des github-release-watcher ([60020](60020-ansible-rollen.md)). |

### Traefik-Metriken und `HelmChartConfig`

- Die `HelmChartConfig` braucht ein **explizites `metadata.namespace: kube-system`** (wie `coredns-custom`). Ohne landet das Objekt in
  der Namenskonvention des ApplicationSets (Namespace `traefik-config`, passend zum Ordner), wo k3s’ interner helm-controller es nie
  findet, weil er nur nach einer `HelmChartConfig` mit demselben Namen **und** Namespace wie das zugehörige `HelmChart` sucht.
- `expose.default: false` nimmt Port 9100 nicht nur aus dem Ingress, sondern **komplett aus dem generierten `traefik`-Service**
  (`kubectl get svc traefik -n kube-system` zeigte nur `web`/`websecure`). Der `VMServiceScrape` referenziert einen Service-Port namens
  `metrics`, ohne den lief der Scrape ins Leere: VictoriaMetrics hatte **null** `traefik_*`-Metriken, und alle „User Requests“-Panels in den
  generierten Pro-App-Dashboards standen dauerhaft auf „No data“ (korrigiert 2026-09-15, live verifiziert). Der Fix
  `metrics.prometheus.service.enabled: true` lässt den Traefik-Chart einen **zusätzlichen, rein clusterinternen** ClusterIP-Service
  `traefik-metrics` mit einem Port `metrics` rendern (gleicher Selektor plus `app.kubernetes.io/component: metrics`), ohne Port 9100 auf den
  externen LoadBalancer-Service zu legen. Geprüft mit `helm show values traefik/traefik --version 40.1.0` (entspricht dem k3s-Addon
  `traefik-40.1.4+up40.1.0`).
- Der Scrape selektiert nur `app.kubernetes.io/name: traefik` (nicht zusätzlich die Instance), weil k3s’ Addon-Charts den Instance-Suffix
  je nach Version anders benennen (`kubectl get svc traefik -n kube-system --show-labels`). Er trifft **zwei** Services (Haupt-Service ohne
  Port `metrics`, `traefik-metrics` mit dem Port), nur dort greift der Endpoint.
- **`honorLabels: true` ist nötig:** Ohne schreibt VMAgent beim Scrapen sein eigenes `service`-Label (= Name des gescrapten k8s-Service,
  hier `traefik-metrics`) über Traefiks `service`-Label (der eigentliche Router-Service, z. B. `pacman-pacman-80@kubernetes`, per
  `addServicesLabels: true`). Traefiks Original landet dann nur in `exported_service`. Live verifiziert am 2026-09-15: Alle
  `traefik_service_requests_total`-Serien trugen `service="traefik-metrics"`, wodurch jede Dashboard-Query mit `service=~"^<namespace>-.*"` leer
  blieb, obwohl die Metriken längst ankamen.

### coredns-custom

k3s-CoreDNS lädt automatisch alle ConfigMap-Keys mit dem Suffix `.server` aus diesem ConfigMap (`import /etc/coredns/custom/*.server`).
Hintergrund: dnsmasq auf dem Host (`192.168.178.94:53`) löst `*.homeserver` für LAN und Tailscale auf, Cluster-Pods nutzen aber CoreDNS
(`10.43.0.10`) und kennen die Domain nicht. Anfragen an z. B. `semaphore.tech.homeserver` scheiterten mit „no such host“. Der Block
leitet alle `*.homeserver`-Anfragen an dnsmasq weiter.

### cloudflared

- **Zwei Replicas** = zwei unabhängige Edge-Verbindungen für denselben Tunnel (cloudflared unterstützt das nativ, kein Leader-Election
  nötig). Wirksam solange `autoscaling.enabled=false`, danach übernimmt der HPA (`minReplicas: 2`, damit zwei Verbindungen das Minimum
  bleiben). Skalierung nur nach CPU (winziger Footprint: 32Mi Request, 128Mi Limit).
- Tunnel-Name und Tunnel-ID (UUID aus `cloudflared tunnel create`) sind **kein Secret**, nur Bezeichner, unbedenklich im Klartext.
- **PROD hat einen eigenen Tunnel** `homeserver-prod`. Es kommen nur Hosts an, deren DNS-Eintrag per
  `cloudflared tunnel route dns homeserver-prod <host>` auf diesen Tunnel zeigt. Der Wildcard `*.pke-lab.de` zeigt weiter auf den TECH-Tunnel. Die
  Regel in der PROD-Konfiguration ist deshalb bewusst ein Wildcard: Welcher Host ankommt, entscheidet allein das DNS.

---

## Apps

### alamos-apager und alamos-relay

- **alamos-apager:** Hält pro Standort nur den Redirect Stationsname → AMweb-URL und einen Heartbeat-Zeitstempel vor. Die echte AMweb-URL
  (Secret-Volume unter `STATIONS_DIR`) verlässt den Cluster nie Richtung Pi. `GET /start?station=<name>` → 302 auf die AMweb-URL,
  `GET /heartbeat?station=<name>` → Lebenszeichen des Pi, `GET /metrics` → Prometheus-Metriken. Ein Hintergrund-Thread prüft
  periodisch, ob ein Standort länger als `HEARTBEAT_TIMEOUT_SECONDS` keinen Heartbeat gesendet hat, und meldet das per ntfy (kein
  Zammad-Ticket, [30010](../3-apps-workloads/30010-alamos-apager.md)). Der Timeout soll **deutlich über dem Heartbeat-Intervall** des
  Pi-Timers liegen (`alamos_kiosk_heartbeat_interval`), damit ein einzelner verpasster Ping keinen Fehlalarm auslöst.
- **`/metrics`** exportiert je Standort den Zeitstempel der letzten erfolgreichen `/start`-Anfrage (= der Kiosk-Browser hat die echte
  AMweb-URL tatsächlich angefragt) und des letzten Heartbeats. Genutzt vom n8n-Workflow „Banana-Pi-Down → Zammad-Ticket“, um im Ticket zu
  zeigen, wann der Standort zuletzt erfolgreich war ([30020](../3-apps-workloads/30020-vereinsheim-alarmmonitor.md)). Es wird
  **cluster-intern per `VMServiceScrape`** gescrapt und funktioniert unabhängig davon, ob ein Standort per LAN oder Tailscale angebunden ist,
  weil alamos-apager selbst immer im Cluster läuft. Das SealedSecret mit den Standort→URL-Paaren (ein Key pro Standort) erzeugt der Chart
  **nicht**, der `kubeseal`-Befehl steht in 30010.
- **alamos-relay:** Öffentlich per Cloudflare-Tunnel erreichbar, damit ALAMOS AMweb ohne Blockade durch Private Network Access den
  Webhook aufrufen kann, ohne n8n selbst öffentlich zu machen ([300i0](../3-apps-workloads/300i0-alamos-relay.md)). Einziger Endpunkt:
  `GET/POST /relay/<TOKEN>`. Das Token kommt aus dem SealedSecret (`RELAY_TOKEN`), der Pfadvergleich läuft per `hmac.compare_digest`
  (konstante Laufzeit, kein Timing-Seitenkanal). Jede andere Pfad/Methode-Kombination bekommt **exakt dieselbe** 404-Antwort wie ein falsches
  Token, ein Angreifer kann Pfad und Token nicht unterscheiden. Bei Treffer wird der Request 1:1 (Methode, Query, Body, Content-Type) an
  `N8N_TARGET_URL` weitergereicht und n8ns Antwort 1:1 zurückgegeben, damit ALAMOS dieselbe Rückmeldung sieht wie bei einem direkten Aufruf.
  Der Aufruf ist ein normaler Server-zu-Server-Call, kein Browser beteiligt (vermuteter Grund, warum der direkte Aufruf von AMweb aus nicht
  funktionierte, [300h0](../3-apps-workloads/300h0-alamos-einsatz-zammad.md), „Private Network Access“). Das Ziel ist der **interne
  Cluster-DNS-Name** (`n8n` im Namespace `n8n`, Port 80), **nicht** Traefik/`n8n.prod.homeserver`: ein unnötiger Umweg über den
  Ingress-Controller. Token-Erzeugung mit `tr -d '\n'`: [60030](60030-argocd-und-bootstrap.md#sealedsecrets-fallstricke-beim-versiegeln).
- **Egress-Beschränkung nur hier:** Dieser Pod ist der einzige, der selbst Egress einschränkt (`networkpolicy-default-deny-egress`,
  sonst bleibt die Egress-Seite der ansible-verwalteten Policy offen, was für einen **öffentlich erreichbaren** Pod nicht reicht). Selbst wer
  Pfad/Token errät oder den Python-Prozess kompromittiert, erreicht nur n8ns Webhook-Port. Erlaubt sind nur DNS (ohne die
  DNS-Ausnahme blockiert das Default-Deny auch die Auflösung, ein klassischer Fehler bei Egress-Policies) und die **n8n-Pods** (nicht „irgendwas im
  n8n-Namespace“) auf ihrem Webhook-Port. Ingress bleibt unangetastet (`kube-system` und `cloudflared` müssen den Pod erreichen). Die
  n8n-Seite spiegelt das über `argocd_network_policy_extra_ingress → n8n` in `ansible/roles/argocd/defaults/main.yml`, sonst blockt
  n8ns eigene verfeinerte Policy den Namespace weiterhin ([d0030](../d-sicherheit/d0030-network-policies.md), Schritt 2).

### argo-workflows und minio

- **argo-workflows:** Controller und Server sind auf den Release-Namespace beschränkt (einfacher und sicherer als cluster-weit für ein
  Ein-Nutzer-Heim-CI). HTTP im Klartext, TLS endet bzw. entfällt hinter Traefik im LAN. Artefakt-Repository und Log-Archiv liegen auf MinIO
  (cluster-intern), die Zugangsdaten kommen aus dem Secret `argo-artifacts-s3` und **müssen den MinIO-Root-Zugangsdaten entsprechen**.
  Für Kaniko-Pushes nach GHCR ein `dockerconfigjson` bauen und unter dem Schlüssel `.dockerconfigjson` versiegeln
  ([f0000](../f-cicd-automatisierung/f0000-argo-workflows.md)). Eine ClusterRole erlaubt dem `argo-workflow`-ServiceAccount, Pods und
  Workloads in allen Namespaces zu lesen, zu skalieren und zu überwachen, ausschließlich vom Workflow `nightly-pod-maintenance` genutzt.
- **minio:** Der Chart-Default für `replicas` ist 16 (verteilt), im Standalone-Betrieb muss das überschrieben werden, damit Scheduling und
  Validierung einen einzelnen Pod erwarten. Der Default-Request von **16 Gi Speicher** wäre auf dem Homeserver nie schedulbar und wird hart
  überschrieben. Die S3-API bleibt cluster-intern (`minio.minio.svc:9000`), nur die Konsole hat einen Ingress. Buckets werden beim ersten
  Start automatisch angelegt. Liegt die bestehende PVC schon auf einer anderen StorageClass, muss vor dem Sync manuell migriert werden
  (`storageClassName` ist immutable, Runbook in 20000). Die Root-Zugangsdaten sind ein SealedSecret (`minio-root`, Schlüssel `rootUser`/
  `rootPassword`).

### github-release-watcher

- Der CronJob läuft alle 120 Minuten. **`*/120` im Minutenfeld ist kein gültiger Cron-Ausdruck** (das Feld endet bei 59), Schrittweite muss
  im Stundenfeld stehen.
- `currentVersion` ist die **aktuell deployte** Version und wird **manuell** gepflegt (Git als Source of Truth). Sie **muss nach jedem Upgrade
  des Dienstes nachgezogen werden**, sonst zeigt die App-Update-Liste falsche oder veraltete Ergebnisse. Leer heißt „unbekannt“, die App zeigt
  dann keinen Update-Status statt eines falschen. Das Format muss zum `tag_name`-Stil des Repos passen (Nextcloud: Docker-Tag `34.0.2-apache`
  ↔ Release `v34.0.2`; n8n taggt `n8n@2.33.7`, nicht `v2.33.7`, das Image trägt zusätzlich `-imap`; Paperless, Wiki.js und Immich mit `v`-Präfix;
  Vaultwarden ohne). Vor dem Ausfüllen mit `curl https://api.github.com/repos/<owner>/<repo>/releases/latest` gegenprüfen.
- `notifyZammad: true` erzeugt bei einem neuen Release ein Zammad-Ticket (nur für DocFlowEngine aktiv), `false` zeigt neue Releases **nur**
  in der App-Update-Liste. Die neu hinzugekommenen Self-Hosted-Apps haben `false` und erzeugen keine Tickets.
- **Zammad veröffentlicht keine GitHub-Releases** (nur Tags/eigener Changelog): `/releases/latest` liefert dauerhaft 404, was der Watcher als
  „keine Releases vorhanden“ behandelt (kein Fehler). Der Eintrag bleibt für den Fall, dass sich das ändert, `has_update` bleibt dort immer
  „unbekannt“.
- Ein optionaler GitHub-PAT hebt das Limit der unangemeldeten API (60 Anfragen/h, bei 10 Repos im 120-Minuten-Takt knapp) auf 5000/h. Er
  kommt aus einem **vorhandenen** Secret, das der Chart nicht anlegt ([60030](60030-argocd-und-bootstrap.md)).
- Die Zammad-Ticket-URL ist `https://`, nicht `http://`: Traefik antwortet mit 308, und `urllib` folgt einem 308 bei POST nicht (die
  Ticketanlage schlüge fehl). Die interne Root-CA kommt aus `templates/ca-configmap.yaml`. Die Zammad-Gruppe erwartet bei Untergruppen
  den vollqualifizierten Namen mit `::` (`ParentGruppe::Untergruppe`), Agenten der Gruppe bekommen eine E-Mail, wenn ihre Profil-Benachrichtigung
  „Neues Ticket“ aktiv ist. Die Anfrager-Adresse **muss vor dem Aktivieren** (`suspend: false`) angepasst werden.
- `role.yaml`: `create` lässt sich nicht per `resourceNames` einschränken (das Objekt existiert vorher nicht), es ist eine eigene Regel ohne
  `resourceNames`. Eine zweite Rolle erlaubt dem carplay-api-ServiceAccount (anderer Namespace) **nur** das Lesen der Update-Status-ConfigMap,
  keinen Zugriff auf die State-ConfigMap oder sonst etwas ([60080](60080-carplay-api-und-ios-app.md)). Der ServiceAccount-Name muss zu
  `carplay-api` passen (`kubectl get sa -n carplay-api`).

### Benachrichtigungen: ntfy, ntfy-bridge, gotify, gotify-bridge

- **ntfy `base-url` muss der extern erreichbare HTTPS-Host sein**, nicht der interne `.tech.homeserver`-Name. Für iOS relayt ntfy.sh nur einen
  stillen „Wake-up“-Push, den Nachrichtentext holt das Handy danach über die Notification-Service-Extension per GET auf `${base-url}/…`. Ist
  die `base-url` ein LAN-only-Name (außerhalb WLAN/Tailscale nicht auflösbar) oder reines HTTP (von iOS App Transport Security geblockt),
  scheitert der Abruf still: Die Benachrichtigung kommt an (der APNs-Relay-Teil funktioniert), aber **ohne Inhalt**, und in der App wird nichts nachgeladen.
  Live bestätigt am 2026-09-15 (Tausende `messages_published`, `base-url` stand noch auf dem internen Host).
- `auth-default-access: read-write` heißt: Jeder darf ohne Auth publizieren und abonnieren. Für Auth auf `deny-all` stellen und Nutzer über
  die ntfy-CLI anlegen (dann muss carplay-api ein Zugriffstoken bekommen).
- **gotify-bridge** braucht das App-Token aus der Gotify-UI (Apps → + App) als Secret `gotify-bridge-token`, **bevor** deployt wird
  (`kubectl -n gotify-bridge create secret generic gotify-bridge-token --from-literal=token=…` oder versiegelt mit `kubeseal --raw`).
  **ntfy-bridge** bekommt die Basis-URL **ohne Topic**, z. B. `http://ntfy.ntfy.svc.cluster.local`.

### mediamtx

- Die Konfiguration enthält nur die von den Defaults abweichenden Keys, mediamtx merged sie über seine eingebauten Standardwerte.
- **Publish (RTMP/RTSP) läuft als NodePort** für Encoder wie OBS/ffmpeg und ist **bewusst nicht** über den Cloudflare-Tunnel erreichbar:
  Streaming-Quellen bleiben intern ([30040](../3-apps-workloads/30040-mediamtx.md), „Warum Publish nicht über Cloudflare läuft“). Die
  NodePorts sind durch die UFW-Regeln bereits auf LAN und Tailnet beschränkt, es ist keine zusätzliche Firewall-Änderung nötig. Welche Ports
  extern freigegeben werden, steuert ausschließlich `ingress` bzw. `argocd/apps/tech/cloudflared/values.yaml`.
- Die Absicherung des Playbacks läuft komplett über mediamtx’ **eigene interne Benutzerverwaltung** (`authMethod: internal`), sie deckt
  Publish und Playback ab, kein externer Identity-Provider und kein JWKS-Endpunkt nötig. Der Browser bekommt einen normalen HTTP-Basic-Dialog von
  mediamtx selbst. Nutzername und Passwort liegen nur als **SHA256-Hash** (`sha256:<Base64>`) vor und können gefahrlos in Git landen. Die
  Platzhalter im Chart sind **absichtlich ungültige Hashes**: Auth ist damit standardmäßig für jeden dicht, bis echte Hashes eingetragen sind.
- **Speicher:** 256Mi reichten im Leerlauf, unter echter Last (aktiver Publish plus HLS-Muxing für mehrere Zuschauer) kam es aber zu
  wiederkehrendem OOMKilled → Pod-Neustart → 502 beim Zuschauer. Deshalb 512Mi als Puffer.

### n8n

- Das Image ist ein Custom-Build (`argocd/apps/tech/n8n/image/Dockerfile`): `n8n-nodes-imap` plus `whatsapp-web.js` und Chromium für die
  Workflows, die WhatsApp-Nachrichten aus einem Code-Node senden. Verwendet wird das offizielle npm-Paket `whatsapp-web.js`
  (github.com/wwebjs/whatsapp-web.js), **nicht** das ältere `wwebjs@1.23.1-alpha.7` (Alpha von 04/2024 mit Puppeteer 18 und ohne
  Kanal-Unterstützung, also ohne `@newsletter`-IDs).
- Der Code-Node „An WhatsApp senden“ startet `whatsapp-web.js`/Chromium in einem **eigenen Node-Prozess** (`child_process`), weil der Task-Runner
  alle Prototypen einfriert und Puppeteer darin scheitert. Externe npm-Module braucht der Code-Node deshalb nicht, `whatsapp-web.js` lädt nur der
  Kindprozess.

### ollama

- Wird ausschließlich vom n8n-Workflow „Zammad Externer KI-Lauf (täglich)“ zwischen 0 und 1 hin- und hergeschaltet (PATCH auf die
  Scale-Subresource). ArgoCD ignoriert `/spec/replicas` bewusst ([60030](60030-argocd-und-bootstrap.md#ignoredifferences-im-applicationset-template)).
  Die Rolle `role-n8n-scaler` erlaubt dem n8n-ServiceAccount (anderer Namespace) **nur** die Scale-Subresource dieses einen Deployments. Der
  ServiceAccount-Name muss zu `serviceAccount.name` in `argocd/apps/tech/n8n/values.yaml` passen (Default: Release-Name `n8n`).
- **Netzwerk-Isolation:** `networkpolicy-default-deny` blockiert Ingress **und** Egress (keine Regeln = alles blockiert), Ollama kommt weder
  ins Internet noch zu anderen Systemen im Cluster ([300g0](../3-apps-workloads/300g0-ollama.md)). Einzige Ausnahme sind die n8n-Pods auf
  dem HTTP-Port, über das von Kubernetes automatisch gesetzte Label `kubernetes.io/metadata.name`, ein manuelles Labeln des n8n-Namespace
  ist nicht nötig. Egress bleibt ohne jede Ausnahme.
- **Ressourcen (gegen die Node-Kapazität geprüft am 19.08.2026):** `kubectl describe node worker-0` zeigt Allocatable nur 4 CPU / ~7,3 Gi RAM
  (Lenovo M90q). Der alte Default (6 CPU / 8 Gi Requests) lag über der gesamten Kapazität, der Pod wäre nie über Pending hinausgekommen.
  Andere Pods auf worker-0 sind nur kleine DaemonSets (~150m CPU / ~256Mi), Ollama bekommt den Großteil des Nodes. Speicher am 27.08.2026 auf
  6 Gi/7 Gi angehoben (erster echter End-to-End-Lauf): Mit dem alten Limit (6500Mi) lehnte Ollama den `generate`-Call für `llama3.1:8b` **immer** mit
  500 „model requires more system memory (6.1 GiB) than is available (6.0 GiB)“ ab, das Modell braucht schon mehr als das damalige Limit. 7 Gi
  passt noch unter die ~7,3 Gi Allocatable, bleibt aber knapp: Ein größeres oder weniger stark quantisiertes Modell braucht mehr RAM, als dieser
  Node hergibt (Hardware-Grenze, kein Config-Wert).

### pihole

DNS ist ein **NodePort**, damit der Host-dnsmasq (`ansible/roles/dnsmasq`) über `<network_static_ip>:<nodePort>` dorthin weiterleiten kann,
ohne den Router anzufassen. Der Port muss `pihole_dns_nodeport` in `ansible/group_vars/all.yml` entsprechen. Pi-hole v6/FTL braucht
kein separates dnsmasq im Container. Die Fritz!Box bleibt der eigentliche Resolver und ist DHCP-Server, Pi-hole filtert nur. Zu Root und Capabilities
siehe oben.

### semaphore

- Das Image ist auf ein Release gepinnt, um überraschende API-Brüche beim ArgoCD-Sync zu vermeiden: Upgrade = Release prüfen, Tag hier
  anheben, committen und pushen.
- `SEMAPHORE_SCHEDULE_TIMEZONE=Europe/Berlin`: Semaphore wertet Cron-Schedules standardmäßig in UTC aus, `0 6 * * *` feuert so um 06:00 Ortszeit
  (Sommerzeit-sicher). Die PVC hält die eingebettete BoltDB und die `config.json`.
- Das Secret `semaphore-bootstrap` füllt die Ansible-Rolle `semaphore_secrets`. Der Pod startet erst, wenn es existiert, das ist in Ordnung, weil die
  Rolle **vor** dem ArgoCD-Reconcile dieser Application läuft. Es wird als **Verzeichnis ohne `subPath`** gemountet (nur so greift `fsGroup`, mit
  `subPath` wäre die Datei `root:root` und für UID 1001 unlesbar). Es projiziert `ansible_vault_password` dorthin, und
  `ANSIBLE_VAULT_PASSWORD_FILE` zeigt auf die Datei, damit jeder Playbook-Lauf verschlüsselte Variablen entschlüsseln kann.
- Der zweite Ingress `semaphore-api.tech.homeserver` ist der Zugang für `semaphore_bootstrap` (siehe oben).

### uptime-kuma

- Zusätzlich zu den Root-Hinweisen: `NODE_EXTRA_CA_CERTS` bindet die interne Root-CA ein und ist nötig, damit HTTP(S)-Monitore gegen
  `*.homeserver` nicht mit `UNABLE_TO_VERIFY_LEAF_SIGNATURE` scheitern (Node.js vertraut sonst nur seinem eingebauten Root-Store).
- **Authentik-SSO** schützt nur den **internen Haupt-Host**, Zugriff für die Gruppe `admins` ([60070](60070-authentik-und-lldap.md)). Der
  **externe Status-Host bleibt bewusst unverändert** (eigener Ingress ohne ForwardAuth): Öffentlich erreichbar über die bestehende
  `*.pke-lab.de`-Wildcard-Route (kein Cloudflare-Umbau nötig, „Neuen Dienst freigeben“ in [e0010](../e-externe-erreichbarkeit/e0010-cloudflare-deploy.md)),
  mit „status“ statt „uptime-kuma“ im Namen. Nur die öffentliche Status-Page-API (`/api/status-page/…`) wird von der „Updates“-Seite der Firmenwebsite per
  Hintergrund-Request abgefragt (keine direkte Verlinkung, kein iframe), der Rest des Dashboards bleibt hinter dem Admin-Login.

### vaultwarden

- **Storage bewusst auf `local-path`** (Homeserver-System-SSD) belassen: Ein Umzug auf die NFS-Klasse `nas` wurde erwogen und verworfen, weil das
  NAS `all_squash` erzwingt und `chmod`/`chown`-lastige Container darunter leiden. Stattdessen spiegelt eine **tägliche Sicherung**
  (`backup-cronjob.yaml`) die Daten auf die NAS: schnelle lokale SSD im Betrieb, Redundanz auf dem NAS (und von dort per restic auf die
  externe USB-Platte, [20010](../2-betrieb-hardware/20010-nas-backup.md)).
- Die Sicherung läuft **vor** dem täglichen restic-Lauf des NAS (02:00 Uhr), damit dieser eine frische Kopie snapshotet. `db.sqlite3` läuft im
  WAL-Modus, eine einfache Dateikopie wäre inkonsistent, deshalb `sqlite3 .backup` (SQLites Online-Backup-API, sicher gegen einen parallel
  schreibenden Prozess). Die übrigen Dateien (`rsa_key.pem`, Attachments, Sends) gehen per `rsync`. Ziel ist eine eigene, kleine PVC.
- `domain` ist die öffentliche Basis-URL und wird für Links (E-Mails, Icons) und den U2F/WebAuthn-Origin-Check genutzt, sie muss zur
  extern erreichbaren Domain passen. Seit Vaultwarden 1.30 läuft der Websocket auf demselben Port wie die HTTP-API. Die Registrierung steht
  fest auf `false` (Anlage bleibt über `/admin` möglich, der Server ist im Internet nicht dauerhaft offen für neue Nutzer), die öffentliche
  Organisations-Registrierung ist deaktiviert. SMTP für Passwort-Reset- und Einladungsmails nutzt ein Postfach beim Hoster, das SMTP-Passwort kommt aus
  dem SealedSecret.

### zammad

- **Secrets:** `postgresql-pass` (App-Container) und `postgresql-password` (Bitnami-Sub-Chart) müssen **dasselbe** Passwort enthalten,
  `redis-password` gilt für den App-Container und den CloudPirates-Redis-Sub-Chart gemeinsam. **Redis ohne Passwort ist mit diesem Chart nicht
  nutzbar**: `REDIS_URL` wird immer als `redis://:$(REDIS_PASSWORD)@…` gebaut. Ohne definierte Variable landet der wörtliche String
  `$(REDIS_PASSWORD)` im Passwortfeld, und Zammad sendet ein `AUTH` an ein Redis ohne Auth.
- **Init-Job mit festem Namen:** Der Chart-Default (`randomName: true`) hängt `-{{uuidv4}}` an den Job-Namen. Damit entsteht bei **jedem** Helm-Render
  (jedem ArgoCD-Sync, auch No-Op-Syncs) ein „neuer“ Job, den ArgoCD anlegen will, während der alte noch existiert bzw. gepruned wird, und die
  Application zeigt dauerhaft „OutOfSync“. Der feste Name macht den Job wieder zu einem stabil vergleichbaren Objekt, `ttlSecondsAfterFinished` (Default
  300 s) räumt ihn vor dem nächsten echten Upgrade weg.
- **Elasticsearch ist deaktiviert** (Ressourcenersparnis): Zammad 7.x nutzt die PostgreSQL-Volltextsuche als Fallback, bei großem Ticketvolumen wäre ES
  zu aktivieren. `initialisation` ist standardmäßig `true`, **unabhängig von `enabled`**: Ohne diese Zeile versucht der `zammad-init`-Job trotzdem, ein
  nicht vorhandenes Elasticsearch zu initialisieren, und scheitert.
- **Dateiablage** liegt in der Datenbank (Attachments in PostgreSQL). Ein separates Volume bräuchte `ReadWriteMany`, auf Single-Node-k3s nicht Standard.
- **Speicher-Limits:** railsserver, scheduler und die Init-Jobs führen die volle Rails-App aus. Beim Scheduler reichten 512Mi bei Backlog-Verarbeitung nicht
  (viele `SearchIndexJob`s nach einem Neustart → OOMKilled), angeglichen auf 1Gi reichte ebenfalls nicht dauerhaft: Der Pod lief in eine OOM-Crash-Loop
  (529 Restarts in 18 Tagen), dabei gingen u. a. Mail-Jobs (Agent-Einladungsmails) mitten in der Verarbeitung verloren. Deshalb 1,5Gi. `postgresql-init`/`-post`
  haben dasselbe Limit wie railsserver (DB-Migrationen, Locale-Sync).
- **Postgres** lag auf `nas`, bis das NAS `all_squash` erzwang und der Bitnami-Entrypoint (`chmod` auf das Datenverzeichnis) dauerhaft mit „Operation not
  permitted“ scheiterte. Jetzt `local-path` mit `volumePermissions` (siehe oben). **Redis** liegt bewusst auf der NAS, damit kein Persistenzspeicher auf der
  Homeserver-SSD landet. Zum Feature-Gate-Problem `MaxUnavailableStatefulSet` siehe [60030](60030-argocd-und-bootstrap.md#ignoredifferences-im-applicationset-template).
- Der externe Host heißt bewusst `support`, nicht `zammad` (so lautet der öffentliche Hostname in cloudflared).

### Kleinere Charts

| Chart | Hinweis |
|---|---|
| kubeseal-webgui | `autoFetchCert` lässt die App den Public Key beim Start selbst holen, statt ein statisches Zertifikat einzubetten. `apiUrl` ist die URL, die der **Browser** für das API-Backend nutzt und muss zum Ingress-Hostnamen passen, sonst funktioniert die UI nicht. Alle Keys liegen unter `kubeseal-webgui:`, weil das der Dependency-Name ist. |
| sealed-secrets | Vorhersagbarer Service-Name, damit die `kubeseal`-CLI und kubeseal-webgui den Controller ohne zusätzliche Flags finden. |
| logging | Der Grafana-Sidecar im Namespace `monitoring` sucht per `searchNamespace: ALL` nach ConfigMaps mit dem Datasource-Label, darüber findet er die VictoriaLogs-Datasource. Der Collector hängt bei einer URL ohne Pfad automatisch `/insert/native` an. |
| immich-storage, nas-storage | Siehe „Speicher“ oben. |
| headlamp | Eigene HPA, siehe „HPA und `replicas: null`“. |
