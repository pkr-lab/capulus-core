# Helm-Charts im TECH-Cluster — Hintergründe

Begründungen zu `argocd/apps/tech/*/values.yaml`, zu den Chart-Templates und den Dockerfiles der TECH-Apps. Bedienung der Apps steht in
den Docs unter `3-apps-workloads/`. Themen mit eigenem Doc: Monitoring in [60060](60060-monitoring-und-alerting.md), lldap in
[60070](60070-lldap.md), carplay-api in [60080](60080-carplay-api-und-ios-app.md), pacman in
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
| vaultwarden | Das offizielle Image läuft als root (kein `USER`), anders als n8n. |
| pihole | FTL braucht root plus Capabilities (`NET_ADMIN`/`NET_RAW` laut Upstream-Doku, auch ohne DHCP), um Port 53 zu binden. Kein `drop: ALL` mehr: Der Entrypoint braucht das normale Docker-Default-Set (u. a. `CHOWN`, `SETGID`, `SETUID`, `FOWNER`), um auf den internen `pihole`-User zu wechseln und Volume-Dateien zu `chown`en. Mit `drop: ALL` brach der Start mit einer Kette von „Operation not permitted“ ab. Da der Container ohnehin als root läuft (Single-Tenant-Node), bringt selektives Droppen hier keinen relevanten Gewinn. |
| pacman | Distroless-Image: Das Basis-Image `:nonroot` hat bereits die numerische UID 65532. `USER nonroot` (symbolisch) im Dockerfile würde einen nicht-numerischen User in die OCI-Config schreiben, den die `runAsNonRoot`-Prüfung des kubelet ablehnt („image has non-numeric user (nonroot)“). |

Die Dockerfiles von carplay-api und pacman sind Multi-Stage-Builds: Ein statisches Go-Binary kommt auf ein Distroless-Image ohne Shell,
Paketmanager und libc — nichts, was ein Angreifer im kompromittierten Container nutzen könnte, und nichts zu patchen. Beim carplay-api ist
die im Image gesetzte UID nur der Image-Default, das `securityContext` des Deployments (`runAsUser: 1000`) überschreibt sie.

### Images und Build

- Tags sind zur Reproduzierbarkeit **gepinnt**. Selbst gebaute Images (pacman, carplay-api, n8n, isc-news-bot, alert-caller) baut
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
  Universal-SSL deckt nur eine Label-Ebene ab), z. B. `wiki-prod.pke-lab.de`. Zwei Namen weichen bewusst vom App-Namen ab: `status`
  statt `uptime-kuma` (damit die eingesetzte Software nicht aus der URL erkennbar ist) und `support` statt `zammad` (so lautet der
  öffentliche Hostname in cloudflared).
- **Kein zentrales SSO:** Authentik-ForwardAuth ist im Oktober 2026 entfernt worden, jede App sichert sich mit ihrem eigenen Login. Das war für
  Vaultwarden (die Bitwarden-Apps und Browser-Erweiterungen sprechen die API direkt, Master-Passwort und eigenes 2FA sichern sie, ein Redirect würde
  Login/Sync brechen), Grafana (keine wichtigen Daten dahinter, Nutzerentscheidung 22.08.2026), den externen Status-Host von Uptime Kuma, Xibo (nur das
  CMS-Login), mediamtx (eigene interne Auth, siehe unten) und lldap (nur intern) schon vorher so.
- **Zweite Ingresses:** Bei Semaphore als `semaphore-api.tech.homeserver`, weil die Rolle `semaphore_bootstrap` die REST-API ohne
  Browser-Session-Cookie anspricht. Uptime Kuma hat weiterhin den `-native`-Ingress aus der Authentik-Zeit, der ohne SSO nur ein zweiter Host auf
  dieselbe App ist. Alle vom `*.homeserver`-Wildcard automatisch aufgelöst.
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

### Benachrichtigungen: ntfy, ntfy-bridge

- **ntfy `base-url` muss der extern erreichbare HTTPS-Host sein**, nicht der interne `.tech.homeserver`-Name. Für iOS relayt ntfy.sh nur einen
  stillen „Wake-up“-Push, den Nachrichtentext holt das Handy danach über die Notification-Service-Extension per GET auf `${base-url}/…`. Ist
  die `base-url` ein LAN-only-Name (außerhalb WLAN/Tailscale nicht auflösbar) oder reines HTTP (von iOS App Transport Security geblockt),
  scheitert der Abruf still: Die Benachrichtigung kommt an (der APNs-Relay-Teil funktioniert), aber **ohne Inhalt**, und in der App wird nichts nachgeladen.
  Live bestätigt am 2026-09-15 (Tausende `messages_published`, `base-url` stand noch auf dem internen Host).
- `auth-default-access: deny-all` heißt: Ohne Token oder Login geht weder Publizieren noch Abonnieren, auch nicht von außen über `ntfy-tech.pke-lab.de`. Der Default stand zuvor auf
  `read-write` (jeder durfte alles) und darf nur auf `deny-all` stehen, wenn **alle** Sender und Leser Zugangsdaten haben ([10010](../1-benachrichtigungen/10010-ntfy.md#authentifizierung-und-zugangsdaten)).
  Der Default gilt auch für Aufrufe aus dem Cluster (`http://ntfy.ntfy.svc.cluster.local`): ntfy-bridge, alamos-apager, n8n und carplay-api brauchen deshalb alle einen
  Token, ein Sender ohne Token verstummt mit `403`, ohne dass ein Pod ausfällt. Die Token-Umgebungsvariable `NTFY_TOKEN` ist in den Charts optional
  (`secrets.ntfyToken.enabled`), ohne Token sendet das Skript wie bisher anonym, damit die Reihenfolge Chart → Umstellung nicht an einem Deploy-Zeitpunkt hängt.
- Nutzer, ACLs und Tokens liegen in `auth.db` im Daten-PVC (`local-path`, ein Node). Geht das PVC verloren, sind sie weg und mit `deny-all` kommt nichts mehr an.
  Vor jeder Änderung `auth.db` aus dem Pod sichern.
- **Anhänge sind nur mit `attachment-cache-dir` erlaubt.** Ohne den Eintrag lehnt ntfy jeden PUT mit Datei ab (`invalid request: attachments not allowed`). Das traf am
  11.10.2026 den Fehler-Screenshot des ISC-News-Workflows. Das Verzeichnis liegt auf dem Daten-PVC (1 Gi), deshalb sind Datei- und Gesamtgröße begrenzt (5 MB, 100 MB). Ein Anhang
  hat Ablaufzeit, ntfy räumt ihn selbst auf.
- **ntfy-bridge** bekommt die Basis-URL **ohne Topic**, z. B. `http://ntfy.ntfy.svc.cluster.local`.

### alert-caller

Telefon-Alarm im Cluster, Bedienung in [10020](../1-benachrichtigungen/10020-telefon-alarm.md). Der Anrufer wurde zuerst für eine externe VM gebaut ([60020](60020-ansible-rollen.md#alert_caller)), läuft aber vorerst als Pod,
weil ein Ausfall des Clusters (und damit kein Anruf) bewusst in Kauf genommen wird.

- **`hostNetwork: true`, `dnsPolicy: ClusterFirstWithHostNet`, `strategy: Recreate`, `nodeSelector` auf `homeserver`.** baresip handelt mit ICE und STUN eine Adresse für den Medienstrom aus. Im Pod-Netzwerk maskiert Flannel jeden neuen Fluss mit
  `MASQUERADE --random-fully` und wählt den Quellport zufällig, die per STUN gesehene Adresse und der Port zur Gegenstelle können dann auseinanderfallen (Überlegung aus den iptables-Regeln des Homeservers, nicht mit Linphone gemessen). Im Host-Netzwerk benutzt baresip den
  Port des Hosts, die Zuordnung übernimmt dann nur noch der Heimrouter (üblicherweise unabhängig vom Ziel, nicht geprüft). Folgen: Zwei Pods würden um Port 9310 und 10000–10100 streiten (deshalb `Recreate` statt Rolling), der Pod gehört auf den `homeserver` (Worker schlafen, dort gäbe es den Pod nicht),
  und `NetworkPolicy`s gelten für Pods im Host-Netzwerk nicht. Deshalb hat das Chart keine eigenen Policies. Den Port 9310 erreichen Pods über den Service, von außen blockiert UFW ihn (nur der Pod-CIDR ist erlaubt).
  Der Webhook hat keine Authentifizierung: Jeder Pod im Cluster könnte einen Anruf auslösen. Das ist wegen des Aufwands für einen Angreifer und des geringen Schadens (ein Anruf) in Kauf genommen. Ändert sich das, bekommt der Webhook ein Bearer-Token (`http_config.authorization` im Alertmanager).
- **`caller.py` liegt im Chart (`src/caller.py`) und kommt per ConfigMap in den Pod** (`.Files.Get`), nicht ins Image. So braucht eine Änderung am Skript keinen Image-Build, nur einen Merge: Die Prüfsumme der ConfigMap (`checksum/script`) startet den Pod neu. Das Image enthält die Werkzeuge,
  die sich selten ändern: `baresip` 4.12.0 (selbst gebaut, siehe 60020 für den Grund), Piper samt Stimme und sox. Das Dockerfile und `.dockerignore` sind die einzigen Pfade, die `build-images.yml` auslösen. Dieselbe `caller.py` benutzt die Ansible-Rolle für die VM.
- **`libre` wird gepatcht** (`patches/libre-sips-route.patch`, `patch -p1` im Dockerfile). Linphone antwortet mit `Record-Route: <sips:sip11.linphone.org:5061;lr>`, `libre` kennt in Routen nur `sip:` und liefert `ENOSYS`: Der ACK wird nicht gesendet und der Anruf direkt nach dem Abheben beendet. Der Patch akzeptiert `sips:` (mit TLS). Er gehört zu `re` v4.12.0, bei einem Versionssprung prüfen, ob `sip_request_alloc` in `src/sip/request.c` noch passt oder inzwischen selbst `sips` kennt. `.dockerignore` lässt deshalb `patches/` durch, und Änderungen dort lösen den Image-Build aus.
- **`baresip` wird ebenfalls gepatcht** (`patches/baresip-srtp-no-gcm.patch`): Wechselt die Gegenstelle mitten im Gespräch die SRTP-Suite, setzt baresip nur die Empfangsseite zurück und sendet mit der alten Suite weiter, das iPhone hört dann Stille. Der Patch nimmt die GCM-Suiten nicht an, damit Linphones re-INVITE (GCM zuerst) bei `AES_CM_128_HMAC_SHA1_80` bleibt. Wer GCM will, muss stattdessen in `modules/srtp/srtp.c` auch `srtp_tx` zurücksetzen und gründlich gegen Linphone testen. Auch hier bei einem baresip-Update prüfen, ob die Stelle noch passt.
- **ICE bleibt ungepatcht, bewusst:** `libre` arbeitet die Prüfliste kettenartig ab und wartet auf alle toten Kandidatenpaare des iPhones, deshalb beginnt die Ansage 16 bis 24 s nach dem Abheben. Schnellere Patches (Takt alle 20 ms, 4 statt 7 Wiederholungen) liefen am 2026-10-11 in ein Rennen: Prüfungen liefen in den Timeout, bevor das iPhone antwortete, das Paar wurde danach gültig, blieb aber im Status `Failed` (`icecomp: set_selected: invalid state 'Failed'`), und die Ansage kam nur manchmal. Deshalb wieder entfernt, Details in 10020. Das Dockerfile wendet alle Dateien `patches/libre-*.patch` und `patches/baresip-*.patch` der Reihe nach an.
- **Das Dockerfile baut zweistufig** (Build-Stage mit Compiler, Laufzeit-Stage nur mit Bibliotheken) und kopiert `/opt/baresip` und `/opt/piper` (venv samt Stimme) herüber. Beides hängt an absoluten Pfaden, deshalb müssen beide Stages dieselbe Basis (`ubuntu:24.04`, Python 3.12) haben.
  `CMAKE_INSTALL_RPATH` ist nötig, sonst findet `baresip` seine Bibliotheken in `/opt/baresip/lib` nicht. Das Image läuft als Nutzer 1000 mit schreibgeschütztem Dateisystem. Beschreibbar sind nur `emptyDir`s: `/var/lib/alert-caller` (Ansage, Aufnahme), `/run/alert-caller` (Konfiguration von baresip, das in sein Verzeichnis schreibt) und `/tmp`.
- **Das SIP-Konto entsteht aus Umgebungsvariablen** (`SIP_USER`, `SIP_DOMAIN`, `SIP_PASSWORD`, …). Im Secret steht deshalb nur das Passwort statt einer ganzen Kontozeile, die man von Hand versiegeln müsste. Das Passwort darf kein `;`, `"` oder Leerzeichen enthalten, der Caller prüft das beim Start.
- **STUN:** `config.sip.stunServer` zeigt auf `stun.cloudflare.com:3478`, nicht auf den STUN-Server von Linphone: Der antwortet mit veralteten RFC-3489-Attributen, baresip lehnt das ab und die ICE-Sammlung scheitert (gesehen beim ersten Testanruf am 2026-10-11, Details in 10020).
- **Probes sind `tcpSocket`.** Der Webhook-Server hat keinen eigenen Health-Pfad.
- **`HC_PING_URL` ist ein optionaler Schlüssel** (`secretKeyRef.optional: true`): Ohne ihn läuft der Caller ohne healthchecks.io.
- Der Pod findet VictoriaMetrics über den Service-Namen (`config.vmUrl`), die Kontext-Abfragen der Paging-Regeln laufen also nur, solange VictoriaMetrics läuft.
- Registrierung: `alert-caller` steht in `argocd_platform_apps` und `argocd_network_policy_refined_namespaces` (`ansible/roles/argocd/defaults/main.yml`), `argocd/bootstrap/projects.yaml` wird mit `make render-bootstrap` erzeugt. Die Tier-Policy aus `make argocd` greift nicht auf den Pod, weil er im Host-Netzwerk läuft.
- **`caller.py` kommt über die ConfigMap, nicht über das Image** (`.Files.Get "src/caller.py"` mit `checksum/script` am Deployment). Eine Code-Änderung braucht deshalb nur einen Merge, keinen Image-Build.
- **Zugriffsschutz:** `ALERT_CALLER_TOKEN` kommt aus dem SealedSecret `alert-caller-secrets` (`optional: true`, der Pod startet auch ohne Schlüssel), `ALERT_CALLER_AUTH_MODE` aus `config.auth.mode` (`log` oder `enforce`). Ablauf und Gründe:
  [10020](../1-benachrichtigungen/10020-telefon-alarm.md#zugriffsschutz-token). `hostNetwork` bleibt: SIP/ICE und der RTP-Bereich `10000`–`10100` laufen direkt auf dem Host, und eine NetworkPolicy greift dort nicht.

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
- **Webhook-Authentifizierung und Absicherung (Incident 012, 2026-10-17)** ([30070](../3-apps-workloads/30070-n8n.md#webhook-authentifizierung)):
  - **Header Auth mit `Authorization: Bearer`.** Alertmanager setzt diesen Header nativ (`http_config.authorization`, wie beim alert-caller), und alamos-relay sowie das Shell-Skript brauchen
    keinen eigenen Headernamen. Je Sender ein eigenes Credential, damit eine Rotation nur einen Sender trifft.
  - **Reihenfolge beim Einschalten: erst die Sender, dann n8n.** Ein Webhook mit Header Auth lehnt Anfragen ohne Header mit `403` ab. Würde n8n zuerst umgestellt, gingen Einsatzalarme (Relay)
    und Banana-Pi-Meldungen (Alertmanager) verloren, bis die Sender nachgezogen haben. Die Sender schicken den Header vorher schon mit, n8n ignoriert ihn solange.
  - **Der Relay reicht den Header selbst an.** Er kennt das Token aus dem Schlüssel `n8nToken` desselben SealedSecret wie das Pfad-Token. Alamos selbst kann keinen Header setzen und ruft weiter nur die
    geheime Relay-URL.
  - **Nightly-Wake: `https://` statt `http://` und `curl --fail`.** Traefik leitet HTTP mit `301` auf HTTPS um, curl folgt nicht, der Bericht kam mit der alten URL nicht an und die Journal-Warnung
    erschien nur bei Verbindungsfehlern. Mit `--fail` löst jetzt auch ein `403` oder `301` die Warnung aus.
  - **`N8N_PROTOCOL` bleibt `http`.** Der Pod-Listener spricht HTTP, TLS endet an Traefik, Liveness- und Readiness-Probe sind HTTP. Ein `https` würde n8n ohne eigenes Zertifikat nicht sinnvoll bedienen
    und ein ausgefallenes n8n verliert Einsatzalarme. Die Links in Oberfläche und Webhook-URLs kommen aus `WEBHOOK_URL` und `N8N_EDITOR_BASE_URL`, beide auf HTTPS.
  - **`N8N_SECURE_COOKIE: "true"`.** Die Oberfläche ist per `301` ohnehin nur über HTTPS erreichbar. `N8N_BASIC_AUTH_ACTIVE` ist seit n8n 1.0 wirkungslos und wurde entfernt, die Anmeldung läuft über die Benutzerverwaltung.
  - **`child_process` und Execute Command bleiben bewusst.** Der WhatsApp-Sendeprozess (siehe oben), die Aufräumjobs von Xibo und Instagram (`find -delete`, `rm`) und der KI-Lauf (liest das ServiceAccount-Token zum Skalieren von Ollama) brauchen sie. Ersatz
    durch CronJobs würde laufende Workflows umbauen und eigene Rechte für NFS und Ollama verlangen. Das Restrisiko (Codeausführung durch jeden, der Workflows bearbeiten darf) wird durch 2FA am Owner-Konto begrenzt.
  - **`/webhook/isc-news` ist nicht abgesichert.** Aufrufer ist eine externe Website, deren Fähigkeit zum Senden eines Headers (und Geheimhaltung des Tokens) offen ist. Ein Token im Browser-Code wäre öffentlich.
- **Instagram-Bilder** (`instagram.*` in der `values.yaml`, Workflow `instagram-post-per-mail.json`, [300l0](../3-apps-workloads/300l0-instagram-post-per-mail.md)):
  - **Öffentlicher Pfad statt Upload.** Die Graph API nimmt für Bilder nur eine `image_url`, die Meta selbst abruft. Deshalb beantwortet n8n für genau diesen
    Zweck Anfragen aus dem Internet. Das ist die einzige Abweichung vom Grundsatz „n8n bleibt unerreichbar“ (siehe alamos-relay unten). Ein eigener Relay-Dienst
    wurde bewusst nicht gebaut: Er bräuchte Image, Chart, NetworkPolicy und einen Upload von n8n dorthin, für Dateien, die nach Sekunden wieder gelöscht werden.
  - **Zweiter Ingress mit `pathType: Exact`.** Der bestehende Ingress `n8n.prod.homeserver` bleibt unverändert. Der neue Host `instagram-bilder-prod.pke-lab.de` routet
    nur `/webhook/instagram-bild`, alles andere auf diesem Host hat keine Regel und endet bei Traefik mit 404. Mit `Prefix` würde jeder spätere Webhook, dessen Pfad so
    beginnt, mitveröffentlicht. Der Wildcard `*.pke-lab.de` zeigt schon auf den TECH-Tunnel, deshalb ist kein DNS-Eintrag nötig.
  - **`emptyDir` statt PVC.** Die Bilder sind kurzlebig und dürfen einen Pod-Neustart nicht überleben. Auf dem NFS-PVC lägen öffentlich abrufbare Dateien neben der n8n-
    Datenbank. Der Mount stellt zugleich sicher, dass der Ordner existiert und für uid 1000 beschreibbar ist (`fsGroup`), ohne dass der Workflow sich darum kümmern muss.
  - **`N8N_RESTRICT_FILE_ACCESS_TO`** enthält jetzt `/data/instagram-bilder`. Die Variable ersetzt den n8n-Standard (`~/.n8n-files`), nicht ergänzt ihn: Wer sie setzt, muss alle
    erlaubten Ordner aufzählen. Der Lese-Node im öffentlichen Zweig kann damit nichts außerhalb des Bilderordners lesen, auch wenn der Pfadcheck im Code-Node versagte.
  - **Token statt Dateiname.** Die Datei heißt `<32 Hex-Zeichen>-<Nr>.jpg`. Der Code-Node lässt nur dieses Muster zu und baut den Pfad selbst, nie aus der Anfrage. Ein
    erratbarer Name (Zähler, Zeitstempel) wäre öffentlich lesbar.
  - **Wait-Node mit POST.** Der n8n-Wait-Node nimmt den Fortsetzungs-Aufruf standardmäßig per GET an, der ntfy-Button `method=POST` sendet aber POST und bekäme `404`. Der Node
    „Warten auf Freigabe“ steht deshalb auf `httpMethod: POST`, in `instagram-post-per-mail.json` und in `isc-news-veroeffentlichen.json` (dort am 11.10.2026 nachgezogen, vorher
    lief der Button ins Leere).
  - **Zuschnitt rechnet in der EXIF-ausgerichteten Ansicht.** Edit Image dreht ein EXIF-gedrehtes JPEG vor dem Zuschnitt. Rechnet man den Zuschnitt im ungedrehten Raum, wird ein
    Hochkantfoto falsch beschnitten (beobachtet mit n8n `2.42.3`).
  - **Zuschnitt mit Sicherheitsabstand** (`0,805` statt `0,8`, `1,905` statt `1,91`): Nach dem Skalieren rundet das Bild auf ganze Pixel und könnte sonst knapp außerhalb
    von 4:5 bis 1,91:1 landen, was Meta ablehnt.
  - **Gleiche JSON-Datei wie beim ISC-Workflow.** Der Power-Automate-Flow liefert den Anhang Base64-kodiert und mit deutschen Feldnamen (`titel`). „Mail lesen“ dekodiert deshalb bei Bedarf, „Beitrag pruefen“ kennt `titel` und `untertitel`. Ohne das endete der erste Lauf mit „JSON-Anhang ist nicht lesbar“ (gleicher Fehler wie beim ISC-Workflow am 11.10.2026).
  - **Betreff `INSTAGRAM` ohne `1002011`.** Die Postfachregel für ISC-News verschiebt jeden Betreff mit `1002011` in `ISC-News`. Ein Betreff mit dieser Zahl landete dort und
    der Instagram-Trigger sähe ihn nie.
- **ISC-Urkunden melden** (Bot `src/isc/urkunden.ts`, Workflow `isc-urkunden-melden.json`, [300m0](../3-apps-workloads/300m0-isc-urkunden-melden.md)):
  - **Liste über `dlrg_DoPost` statt über HTML oder curl.** Die Tabelle der Urkunden-App wird per JavaScript nachgeladen, im HTML steht sie nicht. Ein eigener POST an `/apps/urkunden?page=service` müsste das Anfrageformat und den CSRF-Schutz der Seite nachbauen. Der Bot ruft deshalb im Browser dieselbe Funktion wie die Oberfläche auf und bekommt die Liste als JSON.
  - **Filter nach PO-Nummer, nicht nach Namen.** Die Bezeichnungen im ISC sind lang und ändern sich gelegentlich („Deutsches Schwimmabzeichen Bronze (Freischwimmer)“), die PO-Nummern 111, 121–123, 141 nicht. Fehlt `poNr` in einem Eintrag, helfen Ausbildungs-ID und die Zahl in Klammern im Namen.
  - **Stand in n8n, nicht im Bot.** Der Bot ist zustandslos (Dateisystem schreibgeschützt, eine Replica, Neustart jederzeit). n8n hält die gesehenen UIDs im Static Data des Workflows, zusammen mit dem Datum. So beginnt jeder Donnerstag mit einem frischen Stand und Urkunden vom Nachmittag lösen keine Mail aus.
  - **Erster Lauf um 17:25 ohne Mail.** Gemeldet werden soll nur, was im Fenster ab 17:30 dazukommt. Der Lauf um 17:25 nimmt den Stand auf, damit schon der Lauf um 17:30 eine neue Urkunde erkennt.
  - **Zeitfenster doppelt geprüft.** Cron im Trigger und Uhrzeitprüfung im Node „Konfiguration“. Ein manueller Start oder ein versehentlich geänderter Trigger schickt so außerhalb des Fensters nichts, außer im Testmodus.
- **ISC-News-Mail kommt aus Power Automate** (Workflow `isc-news-veroeffentlichen.json`, Node „Mail lesen“, [300k0](../3-apps-workloads/300k0-isc-news-bot.md#n8n-workflow-einrichten)):
  - **Base64-JSON wird akzeptiert.** Der Anhang `homepage.json` kam beim ersten echten Lauf (11.10.2026) Base64-kodiert an (`eyJ0aXRlbCI6…`), vermutlich doppelt kodiert.
    `JSON.parse` scheiterte und der Lauf endete mit „JSON-Anhang ist nicht lesbar“. Der Node versucht erst Klartext-JSON, dann Base64. So funktionieren beide Absenderseiten, auch
    wenn der Flow in Power Automate später korrigiert wird.
  - **Deutsche Feldnamen `titel`, `untertitel`, `kategorien`.** Der Power-Automate-Flow liefert sie klein und deutsch. Ohne die zusätzlichen Namen fehlte nach der Dekodierung die
    Überschrift. Weitere Felder aus dem Flow (`autor`, `freigegebenVon`, `datum`, `bilder`) werden ignoriert, der Autor kommt aus `DEFAULT_AUTHOR` des Dienstes.
  - **HTML wird bereinigt.** Outlook hängt `<attachment id="…"></attachment>` an und füllt leere Zeilen mit `<p>&nbsp;</p>`. Beides fliegt raus, bevor der Text in den
    ISC-Editor geht. Der Mail-Text selbst taugt nicht als Quelle: Er enthält dasselbe JSON mit rohen Zeilenumbrüchen in einem String und ist damit ungültig.
  - **Schlagwort-Feld im ISC ist jQuery tokenInput mit Theme `facebook`.** Der erste echte Lauf (11.10.2026) scheiterte im Bot mit `FORM_CHANGED` am Selektor `input.token-input-input-token`, der nur im Mock
    existierte. Im echten HTML heißt das sichtbare Feld `#token-input-mainUploadUploadKeywordTk` (Klassen tragen das Suffix `-facebook`), der Wert landet im versteckten `#mainUploadUploadKeywordTk`.
    Der Mock bildet das jetzt so nach. Der Dropzone-Datei-Input (`input.dz-hidden-input`) hängt Dropzone an `body`, nicht in `#mainUpload`: Der Bot nimmt deshalb den Fallback über den Dateidialog (Klick auf die Dropzone).
  - **Mail ohne `mode` veröffentlicht.** Der Power-Automate-Flow liefert kein `mode`, schickt die Mail aber erst nach der Freigabe (`freigegebenVon`). Mit Standard `draft` blieb die News nach dem ersten echten Lauf (11.10.2026, News 142386) gesperrt.
    Für Mails gilt deshalb `publish`, außer das JSON sagt `draft` oder `entwurf`. Formular und Webhook behalten `draft`.
  - **Die Mail wird nach dem ersten Lesen nicht wiederholt.** Der IMAP-Trigger filtert auf `UNSEEN` und markiert gelesen. Nach einem Fehlschlag muss die Mail neu gesendet werden.

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

Update-Strategie und Readiness (seit dem Vorfall [50020](../5-incidents/50020-pihole-update-dns-deadlock.md)):

- **`RollingUpdate` mit `maxSurge: 1` / `maxUnavailable: 0`** statt `Recreate`. Pi-hole ist der einzige Upstream von dnsmasq, und darüber
  lösen auch der homeserver selbst (containerd/Image-Pulls, ArgoCD) und die PROD-VM auf. Mit `Recreate` war bei jedem Update das DNS weg,
  bevor das neue Image gezogen war, und der Pull scheiterte genau daran. Jetzt läuft der alte Pod weiter, bis der neue bereit ist.
- **Gemeinsame PVC während des Überlappens:** Die `local-path`-PVC ist `ReadWriteOnce`. RWO erlaubt mehrere Pods auf demselben Node, und
  ein `local-path`-PV ist per Node-Affinity an genau diesen Node gebunden, also landet der neue Pod immer neben dem alten. Für die
  wenigen Sekunden, in denen beide laufen, greifen zwei FTL-Instanzen auf dieselben SQLite-Dateien zu. SQLite regelt das über
  Dateisperren auf demselben Kernel. Die PID-Datei liegt unter `/run` und ist nicht geteilt.
- **Readiness-Probe per `dig @127.0.0.1 pi.hole`** statt TCP-Check auf Port 53. Das ist derselbe Befehl wie der `HEALTHCHECK` im
  Upstream-Image (`bind-tools` ist enthalten). `pi.hole` beantwortet FTL lokal, die Probe hängt also nicht an der Fritz!Box. Ein offener
  TCP-Port hieße nur, dass FTL lauscht, nicht dass es antwortet. Erst wenn diese Probe grün ist und `minReadySeconds: 10` abgelaufen sind,
  beendet Kubernetes den alten Pod.
- `replicaCount` bleibt `1`. Zwei dauerhaft laufende Instanzen auf derselben PVC wären nicht sauber (Query-Log, Gravity-Updates),
  zwei getrennte PVCs bräuchten eine Synchronisation der Listen.

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
- Der interne Haupt-Host hängt nicht mehr hinter Authentik-SSO (im Oktober 2026 entfernt), es gilt der eigene Login von Uptime Kuma. Der
  **externe Status-Host** hat einen eigenen Ingress: Öffentlich erreichbar über die bestehende
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
- **`/admin` ist auf dem öffentlichen Host gesperrt** (`adminRestriction`, Ingress `vaultwarden-admin` plus Middleware `vaultwarden-admin-nur-intern`). Der Admin-Token ist der einzige Schutz
  der Oberfläche, und Vaultwarden hat für `/admin` kein eigenes Lockout. Der Pfad `/admin` am Host `vault-tech.pke-lab.de` ist länger als `/` und gewinnt deshalb die Router-Priorität, der
  interne Host `vault.tech.homeserver` bleibt unverändert. Traefik matcht `Prefix` als reinen String-Präfix, gesperrt ist also alles unter `/admin…` (auch `/administrator`), in Vaultwarden liegt dort keine Route. Die Middleware nutzt die Quelladresse des Verbindungsaufbaus (kein `ipStrategy.depth`): `X-Forwarded-For` kann der Client selbst setzen
  und würde die Sperre aushebeln. Anfragen durch den Cloudflare-Tunnel kommen von der cloudflared-Pod-IP und sind damit nie im erlaubten Bereich. **Fehlerbild:** Fehlt die Middleware oder stimmt
  der Name in der Annotation nicht, verwirft Traefik den Router stillschweigend, und `/admin` ist wieder offen (fail-open), nach jeder Änderung deshalb von außen testen.
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
