# CI-Workflows, Skripte und Lint — Hintergründe

Begründungen zu `.github/workflows/`, `scripts/`, `Makefile`, `.ansible-lint` und `.yamllint`. Beschreibung, Einrichtung und Betrieb:
[f0020](../f-cicd-automatisierung/f0020-renovate.md), [f0060](../f-cicd-automatisierung/f0060-build-images.md), [f0070](../f-cicd-automatisierung/f0070-ci-lint.md),
[f0080](../f-cicd-automatisierung/f0080-entw-promotion.md), [f0090](../f-cicd-automatisierung/f0090-branch-schutz-main.md),
[f00a0](../f-cicd-automatisierung/f00a0-tailscale-runner-poc.md), [f00b0](../f-cicd-automatisierung/f00b0-promotion-chain.md).
Übersicht dieser Kategorie: [60000](60000-uebersicht.md).

**Immer wiederkehrender Grund für ein PAT:** PRs, Pushes und Merges mit dem Standard-`GITHUB_TOKEN` lösen keine weiteren Workflows aus. Ohne PAT bliebe die CI auf einem vom Workflow geöffneten
PR aus, und der Pflicht-Check würde ewig auf „pending“ stehen. Deshalb brauchen `build-images`, `promote-entw`, `sync-entw` und die Promotion-Kette ein PAT (Repo-Secret `PROMOTE_TOKEN`, ersatzweise
`RENOVATE_TOKEN`, jeweils mit Contents / Pull requests / Issues / Workflows = Read and write). Ein `workflow_dispatch` mit dem Standard-Token ist dagegen erlaubt und löst andere Workflows aus.

---

## Workflows

| Workflow | Hintergrund |
|---|---|
| `ci.yml` | Pflicht-Gate auf jedem PR gegen `main` (die vier Jobs sind die „Required checks“ des `main`-Rulesets, [f0090](../f-cicd-automatisierung/f0090-branch-schutz-main.md)) und Nachkontrolle bei jedem Push nach `main`. Zusätzlich wiederverwendbar (`workflow_call`): `promote-entw.yml` ruft ihn mit `ref: entw` auf, um den Branch `entw` mit denselben Prüfungen freizugeben, bevor ein PR nach `main` entsteht. **Historie:** `make lint` existierte lange nur lokal, ein kaputtes Manifest fiel erst beim ArgoCD-Sync gegen den Live-Cluster auf ([40080](../4-planung/40080-multi-cluster-entw-prod-tech.md), Baustein 6). `inputs.ref` steht in der Concurrency-Gruppe: Der Aufruf aus `promote-entw.yml` (Branch `entw`) darf einen laufenden CI-Lauf auf `main` weder abbrechen noch blockieren. Go-Module werden per `git ls-files` gefunden statt fest verdrahtet, damit der Job auch auf dem Branch `entw` (anderes Ordner-Layout) und für künftige Go-Dienste ohne Änderung greift. Anlass: Ein Renovate-Merge (`geoip2-golang` v1 → v2) machte pacmans `go.mod` kaputt, ohne dass irgendetwas den Go-Code vor dem Image-Build übersetzte. |
| `build-images.yml` | Baut und pusht die drei selbst gebauten Workload-Images (pacman, carplay-api, n8n) nach GHCR, sobald sich ihr Build-Kontext auf `main` ändert. Ersetzt den früheren manuellen Schritt `argo submit --from workflowtemplate/kaniko-build-push`. **Auf PRs läuft derselbe Build ohne Push:** Dockerfile und Go-Code müssen vor dem Merge bauen, ein kaputter Renovate-Bump fiel sonst erst nach dem Merge im Image-Build auf. Kein Required-Check, weil der Pfadfilter den Workflow bei PRs ohne Image-Änderung gar nicht startet. Nach dem Push öffnet der Lauf einen PR, der `image.tag` in der `values.yaml` der App setzt (`scripts/bump-image-tag.py`, Branch `bump/<app>-image`). Es wird **nichts direkt auf `main` committet**: Der PR läuft durch die Pflicht-Checks und wird von Hand gemergt (Merge = Rollout in TECH). Ohne PAT bleibt es beim Hinweis im Job-Summary und der Tag wird von Hand eingetragen. Concurrency: Ein Push auf `main` wird **nie abgebrochen** (ein halb gepushtes Image wäre schlimmer), bei einem PR macht ein neuer Push den alten Probebuild überflüssig. **Gate je App:** Der `paths`-Filter auf Workflow-Ebene entscheidet nur, ob der Lauf überhaupt stattfindet, nicht welche der drei Matrix-Apps sich geändert hat. Ohne das Gate würde das Ändern nur von pacmans Dockerfile auch carplay-api und n8n neu bauen. |
| `release.yml` | Jeder Push auf `main` (jeder gemergte PR) wird von semantic-release analysiert. Rechtfertigen die Commits seit dem letzten Tag ein Release (`feat`/`fix`/`BREAKING CHANGE` nach Conventional Commits), vergibt er die neue Version und veröffentlicht ein GitHub-Release mit generierten Notes, sonst passiert nichts. |
| `renovate.yml` | **Fallback** unabhängig von der Renovate-GitHub-App. Die App-basierte Einrichtung ([f0020](../f-cicd-automatisierung/f0020-renovate.md)) hört still auf, PRs zu öffnen, sobald ihre Installation den Zugriff auf das Repo verliert (meist nach einem Wechsel des Repos zwischen persönlichem Konto und Organisation, weil die App im neuen Scope neu installiert werden muss). Der Workflow führt dieselbe `renovate.json` per `renovatebot/github-action` mit einem PAT aus, damit Updates weiterlaufen. Einrichtung: fine-grained PAT nur für dieses Repo (Contents / Pull requests / Issues / Workflows = Read and write) als Repo-Secret `RENOVATE_TOKEN`, sonst ist nichts zu konfigurieren. Der Cron läuft montags 05:00 UTC, vor dem Zeitplan „montags vor 6 Uhr Berliner Zeit“ in `renovate.json`. |
| `mirror-gitlab.yml` | Vollspiegelung (alle Branches und Tags, inklusive der semantic-release-Versionstags) auf ein GitLab-Remote, rein zur Redundanz ([f0050](../f-cicd-automatisierung/f0050-gitlab-mirror.md)). GitLab ist ein **passives** Backup-Ziel: Nichts wird je von GitLab zurückgepusht, und der Workflow überschreibt die Refs des GitLab-Projekts bei **jedem** Lauf per Force-Push, damit sie GitHub entsprechen. Die GitLab-Seite darf deshalb nie von Hand verändert werden. Zusätzlich läuft alle 6 Stunden ein Cron als Sicherheitsnetz, falls ein Push-Lauf verpasst wurde. |
| `promote-entw.yml` | Übergibt Änderungen vom Branch `entw` (Quelle des ENTW-Clusters) als PR an `main`, aber erst, wenn die CI auf `entw` grün ist ([f0080](../f-cicd-automatisierung/f0080-entw-promotion.md)). Ablauf: **detect** (gibt es `entw`-Commits, die seit dem Tag `entw-promoted` noch nicht an `main` übergeben wurden?) → **ci** (dieselben Prüfungen wie auf PRs, aber gegen `ref=entw`) → **promote** (Cherry-Pick der neuen Commits auf `promote/entw-<sha>` ab `main`, PR öffnen, Tag `entw-promoted` auf den geprüften Stand umlegen). Es ist ein **Cron statt `on: push: entw`**, weil ein `push`-Workflow mit der Workflow-Datei des gepushten Branches läuft: `entw` hat ein eigenes (älteres) Layout mit eigener `ci.yml`. Der Cron auf `main` ist davon unabhängig. |
| `entw-trigger.yml` | Startet die Promotion sofort, wenn auf `entw` gepusht wird, statt auf den Cron zu warten: GitHub drosselt Schedules (im Test lief der 15-Minuten-Cron nur ca. alle 2–5 Stunden). Ein `push`-Workflow läuft mit der Datei **des gepushten Branches**, diese Datei wirkt also erst, wenn sie auf `entw` liegt (kommt mit dem nächsten Merge `main` → `entw`). Der Job tut selbst nichts außer einem `workflow_dispatch` auf `main`, die Arbeit macht weiter `promote-entw.yml` mit den aktuellen Workflows von `main`. |
| `sync-entw.yml` | Hält `entw` auf dem Stand von `main`: Nach jedem Push auf `main` wird `main` in `entw` gemergt, **außer** `entw` hat eigene, noch nicht übergebene Commits (dort wird gerade etwas getestet). Dann bleibt `entw` unverändert, bis die Promotion die Commits nach `main` übergeben hat oder der Test-Branch aufgeräumt ist. **Pause per Hand:** Repo-Variable `ENTW_SYNC_PAUSED=true` (Settings → Variables). `entw` ist per Ruleset geschützt (PR-Pflicht, kein Bypass), der Workflow öffnet deshalb einen PR `main` → `entw` und aktiviert Auto-Merge (`gh pr merge --auto`). Die Repo-Einstellung „Allow auto-merge“ muss aktiv sein, und das PAT ist nötig, weil `entw-trigger.yml` sonst stumm bliebe. Ein stündlicher Cron (Minute 17) dient als Fallback, falls ein Push-Lauf ausgefallen ist. |
| `promote-chain.yml` | Übernimmt Versionen (`image.tag`, Chart-Abhängigkeiten) entlang ENTW → TECH → PROD, sobald sie das Gesundheits-Gate bestehen (≥ 24 h gesund auf ENTW, danach ≥ 2 h gesund auf TECH, [60030](60030-argocd-und-bootstrap.md#promotion-argocdpromotionyaml)). Ergebnis sind PRs nach `main` (TECH: optional Auto-Merge, PROD: **immer** manuelles Review). Logik in `scripts/promote-chain.py`, Konfiguration in `argocd/promotion.yaml`. Der Runner tritt per Tailscale dem Tailnet bei und fragt beide ArgoCD-Instanzen ab (ENTW: eigene Instanz auf `entw-vm` über die Subnet-Route des Homeservers, TECH/PROD: Hub-ArgoCD). **Solange die Secrets `ARGOCD_ENTW_TOKEN`/`ARGOCD_HUB_TOKEN` fehlen, macht der Lauf nichts.** Beide Instanzen werden über das LAN-Subnetz (Subnet-Route des Homeservers) erreicht, ein einziger ACL-Grant auf `192.168.178.94` und `.100` (Port 30080) genügt. |
| `tailscale-poc.yml` | Diagnose für die Promotion-Kette, nur manuell startbar: Erreicht ein GitHub-Runner über Tailscale die beiden ArgoCD-Instanzen und die ENTW-Apps? Der Lauf testet jeden Weg einzeln, gibt eine Tabelle aus und schlägt erst am Ende fehl, wenn ein für die Promotion nötiger Weg nicht funktioniert. Wege (ArgoCD lauscht per NodePort 30080 im Klartext, `server.insecure`, 30443 ist zurückgesetzt): `hub-lan` (Hub über das LAN-Subnetz, Grant auf `192.168.178.94:30080`, nötig), `entw` (ENTW-ArgoCD, nur per Subnet-Route, Grant auf `192.168.178.100:30080`, nötig), `smoke` (ENTW-Ingress mit Host `whoami.dev.homeserver` für Smoke-Tests, Grant auf `192.168.178.100:80`, optional), `hub` (Hub über die Tailnet-Adresse, Grant auf `tag:tech-node:30080`, nur Diagnose). |

**Tailscale-Action:** Der Workflow meldet sich mit einem **OAuth-Client** an (`TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET`, Tag `tag:ci`). Die Action erzeugt pro Lauf einen frischen, kurzlebigen Key. Ein Auth-Key
wäre einmalig oder läuft ab (max. 90 Tage) und ließ den Beitritt still scheitern. Die Action nimmt **Subnet-Routen selbst an** (`--accept-routes`): Das LAN-Subnetz `192.168.178.0/24` (u. a. ENTW-VM) kommt vom
Homeserver. **Kein zusätzliches `args: --accept-routes` setzen:** Ein doppeltes Flag bricht `tailscale up` mit „flag provided multiple times“ ab, ohne dass die Action fehlschlägt. Der Schritt wird grün und
der Beitritt fehlt ([f00a0](../f-cicd-automatisierung/f00a0-tailscale-runner-poc.md)).

---

## Skripte

### `promote-entw.sh` und `sync-entw.sh`

Beide sind die Logik hinter den gleichnamigen Workflows und kennen `DRY_RUN=1` (überspringt alle `gh`-Aufrufe bzw. öffnet keinen PR, für lokale Tests).

**`promote-entw.sh`** hat drei Teilbefehle: `detect` (gibt `head`, `base` und `changed` aus, in `GITHUB_OUTPUT`, sonst stdout), `promote` (Cherry-Pick der neuen `entw`-Commits auf einen Branch ab `main`, PR öffnen, dann
den Tag umlegen) und `report-ci-failure` (meldet ein rotes CI auf `entw` als Issue).

- **Der Tag `entw-promoted`** ist die Marke „bis hierhin wurde `entw` an `main` übergeben“. Er wandert erst nach erfolgreich geöffnetem PR (oder nach „nichts zu übergeben“) auf den neuen `entw`-Stand und existiert erst
  nach der ersten Promotion. „Neue Commits“ ist alles zwischen Tag und `entw`-Spitze, das nicht schon in `main` ist. Ohne Tag (erster Lauf) gilt der Merge-Base von `main` und `entw`.
- Die Reihenfolge ist alt → neu, **ohne Merge-Commits** und ohne alles, was `main` schon hat (z. B. kommen nach einem Merge `main` → `entw` die `main`-Commits nicht doppelt zurück).
- **Nicht übernommen** wird ein Commit, wenn er `[entw-only]` trägt **oder** ausschließlich `argocd/apps/entw/` ändert. Solche Änderungen gehen über die Promotion-Kette (Versionen nach 24 h Gesundheit als PR nach
  tech/prod), ein Cherry-Pick des ENTW-Ordners nach `main` wäre nur Rauschen (TECH und PROD lesen ihn nie).
- **Konflikt nur in `argocd/apps/entw/`** (typisch: Ein Vorgänger-Commit im ENTW-Ordner wurde übersprungen): Der ENTW-Anteil wird verworfen, der Rest des Commits übernommen. Neue Dateien im **alten Layout**
  (platform/workloads) haben auf `main` keinen Platz mehr (tech/prod): Cherry-Pick erkennt Umzüge bestehender Dateien, aber keine Neuanlagen.
- Ein offenes Issue mit der Kurz-SHA im Titel bedeutet: Für diesen `entw`-Stand ist bereits Bescheid gegeben (Konflikt oder rotes CI), es wird nicht erneut versucht. So prüft der Cron nicht denselben Stand alle 15 Minuten neu.

**`sync-entw.sh`** hält `entw` auf dem Stand von `main`, solange `entw` keine eigenen Commits hat.

- **Eigene Commits** sind Nicht-Merge-Commits auf `entw`, die `main` inhaltlich nicht hat (`git cherry`, also nach Patch-ID: Ein nach `main` übergebener Cherry-Pick zählt nicht) und die noch nicht mit dem Tag
  `entw-promoted` übergeben wurden. `entw` hat eigene Commits (es wird gerade dort getestet) → nichts tun. `entw` enthält schon alles aus `main` → nichts tun. Sonst wird `main` in `entw` gemergt.
- Das Ruleset auf `entw` verlangt Pull Requests (keine Bypass-Actors). Statt direkt zu pushen, wird ein PR `main` → `entw` geöffnet und per **Auto-Merge mit Merge-Commit** (kein Squash) gemergt, damit `main` danach
  Vorfahre von `entw` bleibt. `--auto` wartet auf die Pflicht-Checks. Sind keine (mehr) offen, lehnt `gh` das mit „clean status“ ab, dann wird direkt gemergt. Ein Merge-Konflikt bricht mit Fehler ab, der Lauf wird
  rot und `entw` bleibt unverändert.

### Weitere Skripte

| Skript | Hintergrund |
|---|---|
| `promote-chain.py` | Die Feldliste für die ArgoCD-API wurde gegen die echte API getestet: `items.status.health` liefert `health` komplett, für `sync` müssen die Unterfelder **einzeln** genannt werden (`items.status.sync` allein liefert nichts). |
| `promotelib.py` | Versionen sind exakte Chart-/Image-Versionen, keine Bereichsausdrücke. |
| `setup-main-ruleset.sh` | Legt das Ruleset „main: PR + CI“ an bzw. aktualisiert es: `main` nur per Pull Request, dazu die CI-Jobs aus `ci.yml` als Pflicht-Checks (`--dry-run` zeigt das JSON, `gh` muss als Admin angemeldet sein). **Erst ausführen, wenn `ci.yml` mit den vier Jobs schon auf `main` liegt**, sonst verlangt das Ruleset Checks, die es nirgends gibt, und jeder PR bleibt ewig auf „pending“. Die Namen im Skript müssen dem `name:` der Jobs in `ci.yml` entsprechen. Danach gibt es keinen Direkt-Push auf `main` mehr, auch nicht für den Admin. **Notausgang:** Als Repo-Admin kann ein PR trotz roter oder fehlender Checks gemergt werden (`bypass_mode: pull_request`), gedacht für den Fall, dass die CI selbst kaputt ist. |
| `create-argocd-ci-token.sh`, `reseal-for-prod.sh`, `seal-github-token.sh` | Siehe [60030](60030-argocd-und-bootstrap.md). |
| `check-doc-links.py` | Prüft relative Links und Anker in allen Markdown-Dateien ([f0070](../f-cicd-automatisierung/f0070-ci-lint.md)). |

---

## Lint-Konfiguration

**`.ansible-lint`** passt den Linter an bestehende, absichtliche Repo-Konventionen an, statt hunderte etablierte Tasks und Variablen umzuschreiben:

- **Task-Namen sind durchgehend deutsch und kleingeschrieben** („ethtool installieren“ statt „Install ethtool“), etablierter Stil im ganzen Repo und keine versehentliche Inkonsistenz.
- **Mehrere zusammengehörige Rollen teilen sich bewusst denselben Variablen-Präfix** statt je einen eigenen Rollen-Präfix zu tragen (z. B. `semaphore_bootstrap`, `semaphore_secrets` und `semaphore_targets` teilen sich `semaphore_*`, weil
  sie dieselben Werte querlesen). ansible-lints Default erwartet einen Präfix pro Rolle, das passt nicht zum tatsächlichen Design.
- Einzelne Task-Namen haben ein **Jinja-Fragment in der Mitte** statt am Ende (z. B. „Assert inventory '{{ x }}' exists in project {{ y }}“), lesbarer so und kein Fehler.
- **Echte (wenn auch kleine) Findings wurden direkt behoben** statt geskippt: `no-changed-when` (`banana_pi_kiosk`, `cups_print_server`), `risky-shell-pipe` (`semaphore_secrets`), `no-handler` (`worker_apt_update`).

**`.yamllint`:**

- Helm-Templates (`argocd/apps/*/*/templates/`) und vendorte `charts/` sind **ausgenommen**: Sie enthalten Go-Template-Ausdrücke (`{{ … }}`), die yamllint teils als `truthy`-/`comments`-Verstoß wertet. Die Regeln sind
  hier bewusst entspannt, echte Fehler fängt `helm lint`/`helm template`. Alles andere unter `ansible/` und `argocd/` wird gelintet, auch die Authentik-Blueprints unter `argocd/apps/tech/authentik/blueprints/`.
- `comments-indentation: false` ist **nicht optional**: ansible-lint verlangt diese Mindesteinstellungen von jeder eigenen yamllint-Config, sonst verweigert es seine YAML-Prüfung komplett („Found incompatible custom yamllint
  configuration“).
- Die Regel `empty-lines` gilt weiter: Eine YAML-Datei endet mit **genau einem** Zeilenumbruch, eine Leerzeile am Dateiende ist ein Fehler.
