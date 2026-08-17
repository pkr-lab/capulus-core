# pacman

HTML5-Pacman-Spiel, self-hosted für den öffentlichen Zugriff. Ausgeliefert
über einen kleinen Go-Server (`server/`), der die statischen Assets
serviert **und** pro Request eine strukturierte JSON-Zugriffszeile loggt
(Client-IP inkl. IPv6, User-Agent, optional GeoIP-Standort) — für die
Schulung, die zeigt, was ein Webserver über einen Besucher herausfindet.
Details/Setup der GeoIP-Anreicherung: [docs/57-pacman-visitor-tracking.md](../../../docs/57-pacman-visitor-tracking.md).

Das Spiel selbst (`src/`) ist vendored von
[platzhersh/pacman-canvas](https://github.com/platzhersh/pacman-canvas)
(CC0-1.0) — Google Analytics/AdSense sowie die
AppsFuel/Google-Site-Verification-Artefakte des Originals wurden vor dem
Vendoring entfernt, das Spiel selbst lädt zur Laufzeit nichts von Dritten
nach (siehe [Bekannte Einschränkung](#bekannte-einschränkung) unten).

## Ins Repo einbinden

Kein manuelles `kubectl apply` nötig: Sobald der Ordner `pacman/` unter
`argocd/apps/workloads/` committet und gepusht ist, entdeckt das
Workloads-ApplicationSet das neue Verzeichnis automatisch (innerhalb von
ca. 3 Minuten) und legt die Application **pacman** an — Namespace ist
dabei immer der Ordnername, hier also **`pacman`**.

Damit `pacman` als eigenes AppProject-Ziel erlaubt ist, muss der Namespace
zusätzlich in `argocd_workloads_apps` (`ansible/roles/argocd/defaults/main.yml`)
stehen und `make render-bootstrap` gelaufen sein (für dieses Chart bereits
erledigt) — **und** `make argocd` einmal gegen den Cluster gelaufen sein,
damit die AppProject-Änderung tatsächlich angewendet wird (die
ApplicationSet-Erkennung neuer Ordner ist automatisch, das AppProject
selbst aktualisiert sich nicht von allein aus Git).

## Image bauen

Kein CI-Workflow baut Images automatisch (siehe `.github/workflows/`,
das kümmert sich nur um Releases). Images werden manuell über das
`kaniko-build-push` Argo WorkflowTemplate gebaut, das bereits von
`argocd/apps/platform/argo-workflows/` installiert ist:

```bash
export ARGO_SERVER=argo-workflows.tech.homeserver:80
export ARGO_HTTP1=true
export ARGO_SECURE=false
export ARGO_TOKEN="Bearer $(kubectl -n argo-workflows create token argo-workflow)"

argo submit -n argo-workflows --from workflowtemplate/kaniko-build-push \
  -p repo=https://github.com/pkr-lab/capulus-core.git \
  -p revision=main \
  -p context=argocd/apps/workloads/pacman \
  -p dockerfile=Dockerfile \
  -p image=ghcr.io/pkr-lab/pacman:v1
```

Danach `image.repository`/`image.tag` in `values.yaml` auf das gepushte
Image setzen.

**Tags sind mutable, `pullPolicy: IfNotPresent` cached lokal:** Wird ein
bereits verwendeter Tag (z. B. `v1`) neu gebaut und gepusht, ohne den Tag
zu ändern, pullt ein Node mit lokal gecachtem Image den neuen Inhalt
**nicht** automatisch nach — der Pod läuft dann weiter mit dem alten,
möglicherweise fehlerhaften Bild-Inhalt. Für Fixes daher immer einen
**neuen** Tag vergeben (`v2`, `v3`, …) statt einen bestehenden Tag
wiederzuverwenden; das erzwingt sowohl den Neu-Pull als auch macht in
`values.yaml`/`git log` sichtbar, welcher Chart-Stand welches Image nutzt.

**GHCR-Package-Sichtbarkeit:** frisch gepushte GHCR-Packages sind
standardmäßig **privat** — der Pod scheitert dann mit
`ImagePullBackOff`/"trying and failing to pull image", obwohl der Build
selbst fehlerfrei durchlief. Da dieses Spiel ohnehin öffentlich unter
`pacman-prod.pke-lab.de` erreichbar sein soll, ist der einfachste Fix, das
Package öffentlich zu stellen: GitHub → `pkr-lab` → Packages → `pacman` →
Package settings → Change visibility → Public. Danach ggf.
`kubectl -n pacman rollout restart deployment/pacman`, um den nächsten
Pull sofort statt erst beim Backoff-Retry auszulösen. (Alternative, falls
das Image privat bleiben soll: `imagePullSecrets`-Eintrag + Secret wie bei
`carplay-api` — dort aktuell nicht als Chart-Wert vorgesehen, müsste
ergänzt werden.)

Lokal bauen/testen (z. B. um den Server vorab zu prüfen):

```bash
docker build -t pacman-local .
docker run --rm --read-only --user 65532:65532 -p 8080:8080 pacman-local
```

## Extern erreichbar

`values.yaml` trägt bereits einen zweiten Ingress-Host
(`pacman-prod.pke-lab.de`) gemäß [docs/56-domain-tiers.md](../../../docs/56-domain-tiers.md)
— Tier **prod**, da Endnutzer-Content ohne eigenen Betriebs-/Admin-Zweck.
`cloudflared/values.yaml` muss dafür **nicht** angepasst werden (siehe
dortige Wildcard-Regel), Traefik matcht den Host direkt aus dieser
`ingress.hosts`-Liste.

## GeoIP-Anreicherung

Standardmäßig an (`geoip.enabled: true`) — das ist der eigentliche Zweck
dieser App (Schulungs-Demo, siehe docs/57). Bei Bedarf abschaltbar:

```yaml
geoip:
  enabled: false
```

`pacman-server` loggt dann nur die rohe Client-IP, ohne Standort. Quelle
ist [DB-IP City Lite](https://db-ip.com/db/lite.php) (CC BY 4.0) —
**komplett kostenlos, kein Account, kein License-Key, kein Sealed-Secret
nötig**, bewusst gewählt statt MaxMind GeoLite2 (das einen Account +
License-Key verlangt).

Ein initContainer (`curlimages/curl`) lädt die aktuelle DB-IP-City-Lite-DB
(monatlicher Direct-Download, kein Auth) bei jedem Pod-Start neu in ein
gemeinsames `emptyDir`. Schlägt der Download fehl, läuft der Pod trotzdem
an — `pacman-server` erkennt die fehlende `.mmdb`-Datei und loggt dann nur
die rohe IP (siehe `openGeoIP()` in `server/cmd/server/main.go`), kein
CrashLoop. Details/Datenschutz-Kontext: docs/57.

**`curlimages/curl` braucht eine explizite numerische UID/GID:** Das Image
setzt `USER curl_user` (symbolisch, UID 100 / GID 101), nicht numerisch —
gleiches Problem wie ursprünglich beim `pacman-server`-Image (siehe
Dockerfile-Kommentar). Zusammen mit `runAsNonRoot: true` verweigert der
kubelet den Container sonst mit `CreateContainerConfigError: container has
runAsNonRoot and image has non-numeric user`. Deshalb pinnt der
`geoip-update`-initContainer in `templates/deployment.yaml` explizit
`runAsUser: 100` / `runAsGroup: 101` (gegen das `curlimages/curl:8.11.0`-
Image-Config verifiziert).

**Attribution (CC BY 4.0):** IP-Geolocation-Daten von
[DB-IP](https://db-ip.com).

## Bekannte Einschränkung

Das Original nutzt `data/db-handler.php` (PHP) für eine globale
Highscore-Liste. Diese PHP-Datei ist bewusst **nicht** mit ausgeliefert
(reiner Go-Server, kein PHP) — die Requests dorthin schlagen clientseitig
fehl (jQuery-`error`-Callback, kein Absturz), das "Highscore"-Menü bleibt
also leer. Das eigentliche Spiel (Bewegung, lokaler Score, Sound) läuft
davon unberührt komplett clientseitig.

## Sicherheits-Notizen

- `server/` ist ein minimaler, abhängigkeitsarmer Go-Server (nur
  `oschwald/geoip2-golang` für den optionalen GeoIP-Lookup) auf
  `gcr.io/distroless/static-debian12:nonroot` — kein Shell, kein
  Package-Manager, statisch gelinkt, läuft bereits als Non-Root. Passt zu
  `runAsNonRoot`/`readOnlyRootFilesystem` in `values.yaml`, braucht dafür
  keinerlei Schreibzugriff (kein `/tmp`-Mount nötig, anders als bei nginx).
- Keine externen Netzwerkaufrufe des Spiels selbst zur Laufzeit (kein
  Tracking, keine Ads, keine Highscore-API) — nur der optionale
  initContainer lädt (einmal pro Pod-Start) die DB-IP-Lite-DB per
  Direct-Download, ohne Auth/Account.
- Die Zugriffslogs (inkl. IP/GeoIP bei aktivierter Anreicherung) landen im
  zentralen Logging-Stack (`argocd/apps/platform/logging/`,
  VictoriaLogs) — Aufbewahrung/Zweckbindung siehe docs/57.

## Autoscaling

`autoscaling.enabled: true` per Default (min 1 / max 3 Replicas, CPU-Ziel
70 %) — reines CPU-Autoscaling, da `pacman-server` zustandslos ist und kein
RAM-lastiges Verhalten hat. Kein `ReadWriteOnce`-Storage im Spiel, also
auch keine Notwendigkeit für erzwungene Node-Co-Location per
`podAffinity` (anders als z. B. immich/nextcloud). Details/Konventionen:
[docs/39-hpa-autoscaling.md](../../../docs/39-hpa-autoscaling.md).
