# CLAUDE.md — Arbeitsregeln für capulus-core

GitOps-Homelab: ArgoCD rollt alles unter `argocd/apps/<cluster>/` auf drei k3s-Clustern (TECH, PROD, ENTW) aus. Die Hosts und Cluster
provisioniert [capulus-ansible](https://github.com/pkr-lab/capulus-ansible), die iOS-App liegt in
[capulus-ios](https://github.com/pkr-lab/capulus-ios) (beides eigene Repos, nicht mehr hier). Sprache im Repo ist **Deutsch** (Docs, Commit-Beschreibungen, PR-Texte).

---

## Harte Regeln

- **Keine Kommentare im Code.** Gilt für YAML, Helm-Templates, Ansible, Shell, Python, Go, TS, Workflows.
  Einzige Ausnahme: der Versions-Kommentar `# vX.Y.Z` hinter der Commit-SHA in `uses:`-Zeilen der Workflows (Renovate und Dependabot lesen ihn).
  Begründungen, Fallstricke und Vorfall-Regeln gehören in das passende Doc unter `capulus-core/6-hintergruende/` im Repo
  [pkr-lab-docs](https://github.com/pkr-lab/pkr-lab-docs) (Zuordnung Pfad → Doc: `60000-uebersicht.md`, Tabelle „Von der Datei zum Eintrag“).
- **Doku liegt nicht in diesem Repo, sondern in [pkr-lab-docs](https://github.com/pkr-lab/pkr-lab-docs).** Jede Codeänderung bekommt
  dort einen PR: Fach-Doc (was/wie) in der passenden Kategorie unter `capulus-core/` aktualisieren oder neu anlegen, Hintergrund
  (warum) in `6-hintergruende/`. Konventionen stehen in der `CLAUDE.md` von pkr-lab-docs. wiki-docs-sync spiegelt dieses Repo nach Wiki.js.
- **Vor dem Ändern einer Stelle den Eintrag in `capulus-core/6-hintergruende/` (pkr-lab-docs) lesen.** Die meisten Eigenheiten existieren,
  weil der naheliegende Ansatz schon einmal gescheitert ist.
- **Niemals Klartext-Secrets committen.** Nur `SealedSecret` (je Cluster eigener Schlüssel). gitleaks läuft in der CI.
  Neue Tokens/Passwörter in `ops/token-register.yaml` eintragen (`stored_in` muss auf existierende Dateien zeigen).
- **`main` ist geschützt** (PR + grüne CI). Ein Merge nach `main` rollt sofort auf TECH/PROD aus.
- `argocd/bootstrap/*` ist **generiert** — nie von Hand ändern, sondern Template/Defaults in `roles/argocd/` von
  capulus-ansible anpassen und dort `make render-bootstrap CORE_DIR=<Pfad zu diesem Repo>` ausführen (im Container meist nicht
  möglich → dem Nutzer sagen).
- Die Vault-Dateien liegen in capulus-ansible (`group_vars/all.yml`, `user_inventory_vault.yml`) und werden nie angefasst.

---

## Wo was liegt

| Pfad | Inhalt |
|---|---|
| `argocd/apps/tech/<app>/` | TECH-Cluster (Infrastruktur, Monitoring, Zammad, n8n, …), Branch `main`, Projekt `tech` |
| `argocd/apps/prod/<app>/` | PROD-Cluster (Nextcloud, Immich, Paperless, Wiki.js, Xibo), vom TECH-Hub verwaltet, Application heißt `prod-<app>` |
| `argocd/apps/entw/<app>/` | ENTW-Cluster, eigene ArgoCD, liest **Branch `entw`** |
| `argocd/bootstrap/` | Hub-ApplicationSet + AppProjects (generiert) |
| `argocd/bootstrap-prod/` | PROD-AppProject + ApplicationSets (handgeschrieben), `migrations/` |
| `argocd/promotion.yaml` | Gates und Smoke-Checks der Promotion ENTW → TECH → PROD |
| `pki/` | Root-CA `homeserver-root-ca.pem` (Quelle der Wahrheit, Kopien in capulus-ansible und capulus-ios) |
| `scripts/` | Promotion, Doc-Link-Check, Token-Register-Check, Versiegel-Helfer (`reseal-for-prod.sh`, `seal-*.sh`), `bump-image-tag.py` |
| `.github/workflows/` | `ci.yml` (Pflicht-Gate), `build-images.yml`, Promotion-/Sync-Workflows, Renovate, Release |

Eigener Code mit Tests: `argocd/apps/tech/carplay-api/src` und `argocd/apps/tech/pacman/server` (Go),
`argocd/apps/tech/isc-news-bot` (TypeScript/Node, Playwright).

---

## Neue App / App ändern

| Cluster | Zusätzlich nötig |
|---|---|
| TECH | Namespace in `argocd_platform_apps` bzw. `argocd_workloads_apps` (`roles/argocd/defaults/main.yml` in capulus-ansible), dann dort `make render-bootstrap CORE_DIR=…` |
| PROD | Namespace in `argocd/bootstrap-prod/appproject.yaml`; reine Manifest-Ordner zusätzlich als Pfad in `argocd/bootstrap-prod/applicationset.yaml`; interner Host in `dnsmasq_prod_vm_hosts` (capulus-ansible) |
| ENTW | nichts, nur auf Branch `entw` |

- Muster für Charts: bestehende App kopieren (z. B. `argocd/apps/tech/ntfy/`): `Chart.yaml`, `values.yaml`, `templates/` mit `_helpers.tpl`.
- Hostnamen immer im Tier-Schema: `<app>.tech.homeserver`, `<app>.prod.homeserver`, `<app>.dev.homeserver` (nie flach `<app>.homeserver`).
- Image-Tags in `values.yaml` unter `image.tag`; Renovate und `build-images.yml` bumpen sie. Selbst gebaute Images: `sha-<commit>`.
- Ressourcen mit Feldern, die ein Controller verändert (Replicas durch HPA etc.), brauchen ggf. einen `ignoreDifferences`-Eintrag im
  ApplicationSet-Template (Rolle `argocd`), siehe `capulus-core/6-hintergruende/60030-argocd-und-bootstrap.md` in pkr-lab-docs.
- Versiegeln: `printf '%s' "$WERT" | kubeseal --raw …` — **kein** Here-String/`echo` (mitversiegeltes `\n` hat schon Ausfälle verursacht).

---

## Prüfen vor dem Commit

Die CI (`.github/workflows/ci.yml`) hat fünf Pflicht-Jobs. Lokal verfügbar sind meist nur Python, Go und Node:

```bash
pip install -q pyyaml && python3 scripts/check-token-register.py    # ops/token-register.yaml
(cd argocd/apps/tech/pacman/server && go build ./... && go vet ./... && go test ./... && go mod tidy -diff)
(cd argocd/apps/tech/carplay-api/src && go build ./... && go vet ./... && go test ./... && go mod tidy -diff)
(cd argocd/apps/tech/isc-news-bot && npm ci && npm test)
```

Falls installierbar (`pip install yamllint`, Helm, kubeconform): `make lint` sowie
`helm template argocd/apps/<cluster>/<app> | kubeconform -strict -ignore-missing-schemas -summary`.
Nur die betroffenen Teile prüfen, nicht immer alles.

---

## Doku-Konventionen

Siehe `CLAUDE.md` in [pkr-lab-docs](https://github.com/pkr-lab/pkr-lab-docs): Dateinamen mit Hex-ID und Kategorie, Doc-Typen, Link-Regeln.

---

## Code-Stil

- Ansible-Task-Namen deutsch und kleingeschrieben („ethtool installieren“), FQCN-Module (`ansible.builtin.…`).
- YAML-Dateien enden mit genau einem Zeilenumbruch, keine Leerzeile am Ende (yamllint `empty-lines`).
- Helm-Templates und `charts/` sind von yamllint ausgenommen, dort fangen `helm lint`/`kubeconform` Fehler.

---

## Commits und PRs

- **Claude committet und pusht nicht.** Commits, Pushes und PRs macht ausschließlich der Nutzer. Änderungen nur im
  Arbeitsverzeichnis vorbereiten, am Ende kurz zusammenfassen und einen passenden Commit-Text vorschlagen.
  Ausnahme nur, wenn der Nutzer es in der jeweiligen Anfrage ausdrücklich verlangt.
- Conventional Commits mit Scope = App/Bereich, Beschreibung auf Deutsch:
  `feat(isc-news-bot): …`, `fix(monitoring): …`, `chore(<app>): image.tag auf sha-…`, `docs(…): …`.
  `feat`/`fix` lösen über semantic-release ein Release aus.
- Ein PR = eine Änderung inkl. zugehöriger Doku. Renovate-/Bump-PRs nicht manuell nachbauen.

---

## Effizient arbeiten

- Erst `capulus-core/6-hintergruende/60000-uebersicht.md` in pkr-lab-docs → passendes Hintergrund-Doc → dann den Code. Das spart Fehlversuche.
- Charts unter `argocd/apps/*/*/charts/*.tgz` sind vendorte Abhängigkeiten — nicht durchsuchen oder ändern.
- `kubectl` gegen echte Cluster funktioniert aus der Cloud-Sandbox nicht (kein Zugriff aufs LAN/Tailnet).
  Solche Schritte als Befehl für den Nutzer formulieren statt sie zu versuchen.
