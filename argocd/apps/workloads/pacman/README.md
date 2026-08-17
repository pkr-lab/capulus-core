# pacman

Statisches HTML5-Pacman-Spiel, self-hosted für den öffentlichen Zugriff.
Vendored von [platzhersh/pacman-canvas](https://github.com/platzhersh/pacman-canvas)
(CC0-1.0) unter `src/` — Google Analytics/AdSense sowie die
AppsFuel/Google-Site-Verification-Artefakte des Originals wurden vor dem
Vendoring entfernt, es lädt zur Laufzeit nichts von Dritten nach.

## Ins Repo einbinden

Kein manuelles `kubectl apply` nötig: Sobald der Ordner `pacman/` unter
`argocd/apps/workloads/` committet und gepusht ist, entdeckt das
Workloads-ApplicationSet das neue Verzeichnis automatisch (innerhalb von
ca. 3 Minuten) und legt die Application **pacman** an — Namespace ist
dabei immer der Ordnername, hier also **`pacman`**.

## Image bauen

Kein CI-Workflow baut Images automatisch (siehe `.github/workflows/`,
das kümmert sich nur um Releases). Images werden manuell über das
`kaniko-build-push` Argo WorkflowTemplate gebaut, das bereits von
`argocd/apps/platform/argo-workflows/` installiert ist:

```bash
argo submit --from workflowtemplate/kaniko-build-push \
  -p repo=https://github.com/pkr-lab/capulus-core.git \
  -p revision=main \
  -p context=argocd/apps/workloads/pacman \
  -p dockerfile=Dockerfile \
  -p image=ghcr.io/<dein-gh-username>/pacman:v1
```

Danach `image.repository`/`image.tag` in `values.yaml` auf das gepushte
Image setzen (und ggf. einen `imagePullSecrets`-Eintrag, falls das
GHCR-Package privat ist).

## Extern erreichbar

`values.yaml` trägt bereits einen zweiten Ingress-Host
(`pacman-prod.pke-lab.de`) gemäß [docs/56-domain-tiers.md](../../../docs/56-domain-tiers.md)
— Tier **prod**, da Endnutzer-Content ohne eigenen Betriebs-/Admin-Zweck.
`cloudflared/values.yaml` muss dafür **nicht** angepasst werden (siehe
dortige Wildcard-Regel), Traefik matcht den Host direkt aus dieser
`ingress.hosts`-Liste.

## Bekannte Einschränkung

Das Original nutzt `data/db-handler.php` (PHP) für eine globale
Highscore-Liste. Diese PHP-Datei ist bewusst **nicht** mit ausgeliefert
(nginx-only-Image, kein PHP) — die Requests dorthin schlagen clientseitig
fehl (jQuery-`error`-Callback, kein Absturz), das "Highscore"-Menü bleibt
also leer. Das eigentliche Spiel (Bewegung, lokaler Score, Sound) läuft
davon unberührt komplett clientseitig.

## Sicherheits-Notizen

- Statischer Content, kein Server-Code außer nginx selbst — kleine
  Angriffsfläche.
- `nginxinc/nginx-unprivileged` läuft bereits als Non-Root, hört auf
  Port 8080 — passt zu `runAsNonRoot`/`readOnlyRootFilesystem` in
  `values.yaml` (nginx braucht dafür Schreibzugriff auf `/tmp` und
  `/var/cache/nginx`, beide als `emptyDir` gemountet).
- Keine externen Netzwerkaufrufe zur Laufzeit (kein Tracking, keine Ads,
  keine Highscore-API) — reines statisches Asset-Bundle.
