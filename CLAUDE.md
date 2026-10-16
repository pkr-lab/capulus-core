# CLAUDE.md — Arbeitsregeln für capulus-core

GitOps-Homelab: Ansible provisioniert Ubuntu-Hosts und drei k3s-Cluster (TECH, PROD, ENTW), ArgoCD rollt alles unter
`argocd/apps/<cluster>/` aus. Sprache im Repo ist **Deutsch** (Docs, Commit-Beschreibungen, PR-Texte).

---

## Harte Regeln

- **Keine Kommentare im Code.** Gilt für YAML, Helm-Templates, Ansible, Shell, Python, Go, TS, Swift, Workflows.
  Begründungen, Fallstricke und Vorfall-Regeln gehören im **selben PR** in das passende Doc unter
  `docs/6-hintergruende/` (Zuordnung Pfad → Doc: `docs/6-hintergruende/60000-uebersicht.md`, Tabelle „Von der Datei zum Eintrag“).
- **Jede Codeänderung bekommt Doku unter `docs/`.** Fach-Doc (was/wie) in der passenden Kategorie aktualisieren oder
  neu anlegen, Hintergrund (warum) in `6-hintergruende/`. Docs beschreiben den Ist-Zustand, außer `4-planung/`.
- **Vor dem Ändern einer Stelle den Eintrag in `6-hintergruende/` lesen.** Die meisten Eigenheiten existieren,
  weil der naheliegende Ansatz schon einmal gescheitert ist.
- **Niemals Klartext-Secrets committen.** Nur `SealedSecret` (je Cluster eigener Schlüssel). gitleaks läuft in der CI.
  Neue Tokens/Passwörter in `ops/token-register.yaml` eintragen (`stored_in` muss auf existierende Dateien zeigen).
- **`main` ist geschützt** (PR + grüne CI). Ein Merge nach `main` rollt sofort auf TECH/PROD aus.
- `argocd/bootstrap/*` ist **generiert** — nie von Hand ändern, sondern Template/Defaults in `ansible/roles/argocd/`
  anpassen und `make render-bootstrap` (braucht Vault-Passwort, im Container meist nicht möglich → dem Nutzer sagen).
- Vault-Dateien (`ansible/group_vars/all.yml`-Secrets, `user_inventory_vault.yml`) nicht anfassen.

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
| `ansible/` | `site.yml` (Homeserver/TECH), `worker-*.yml`, `prod.yml`, `entw.yml`, Kiosk-Playbooks, `roles/` |
| `scripts/` | Promotion, Doc-Link-Check, Token-Register-Check, Versiegel-Helfer (`reseal-for-prod.sh`, `seal-*.sh`), `bump-image-tag.py` |
| `.github/workflows/` | `ci.yml` (Pflicht-Gate), `build-images.yml`, Promotion-/Sync-Workflows, Renovate, Release |
| `docs/` | Doku, Schema in `docs/TEMPLATE.md` |
| `ios/` | SwiftUI-App, Backend ist `argocd/apps/tech/carplay-api` |

Eigener Code mit Tests: `argocd/apps/tech/carplay-api/src` und `argocd/apps/tech/pacman/server` (Go),
`argocd/apps/tech/isc-news-bot` (TypeScript/Node, Playwright).

---

## Neue App / App ändern

| Cluster | Zusätzlich nötig |
|---|---|
| TECH | Namespace in `argocd_platform_apps` bzw. `argocd_workloads_apps` (`ansible/roles/argocd/defaults/main.yml`), dann `make render-bootstrap` |
| PROD | Namespace in `argocd/bootstrap-prod/appproject.yaml`; reine Manifest-Ordner zusätzlich als Pfad in `argocd/bootstrap-prod/applicationset.yaml`; interner Host in `dnsmasq_prod_vm_hosts` |
| ENTW | nichts, nur auf Branch `entw` |

- Muster für Charts: bestehende App kopieren (z. B. `argocd/apps/tech/ntfy/`): `Chart.yaml`, `values.yaml`, `templates/` mit `_helpers.tpl`.
- Hostnamen immer im Tier-Schema: `<app>.tech.homeserver`, `<app>.prod.homeserver`, `<app>.dev.homeserver` (nie flach `<app>.homeserver`).
- Image-Tags in `values.yaml` unter `image.tag`; Renovate und `build-images.yml` bumpen sie. Selbst gebaute Images: `sha-<commit>`.
- Ressourcen mit Feldern, die ein Controller verändert (Replicas durch HPA etc.), brauchen ggf. einen `ignoreDifferences`-Eintrag im
  ApplicationSet-Template (Rolle `argocd`), siehe `docs/6-hintergruende/60030-argocd-und-bootstrap.md`.
- Versiegeln: `printf '%s' "$WERT" | kubeseal --raw …` — **kein** Here-String/`echo` (mitversiegeltes `\n` hat schon Ausfälle verursacht).

---

## Prüfen vor dem Commit

Die CI (`.github/workflows/ci.yml`) hat sechs Pflicht-Jobs. Lokal verfügbar sind meist nur Python, Go und Node:

```bash
python3 scripts/check-doc-links.py                                  # kaputte relative Links/Anker in Markdown
pip install -q pyyaml && python3 scripts/check-token-register.py    # ops/token-register.yaml
(cd argocd/apps/tech/pacman/server && go build ./... && go vet ./... && go test ./... && go mod tidy -diff)
(cd argocd/apps/tech/carplay-api/src && go build ./... && go vet ./... && go test ./... && go mod tidy -diff)
(cd argocd/apps/tech/isc-news-bot && npm ci && npm test)
```

Falls installierbar (`pip install yamllint ansible-lint`, Helm, kubeconform): `make lint` sowie
`helm template argocd/apps/<cluster>/<app> | kubeconform -strict -ignore-missing-schemas -summary`.
Nur die betroffenen Teile prüfen, nicht immer alles.

---

## Doku-Konventionen (Kurzfassung von `docs/TEMPLATE.md`)

- Dateiname `<id>-<slug>.md`, `<id>` = Kategorie-Zeichen + 4 Hex-Ziffern, neue IDs in Schritten von `0x10`.
  Kategorien: `a` OS, `b` Kubernetes/GitOps, `c` Netzwerk/DNS, `d` Sicherheit, `e` extern, `f` CI/CD,
  `1` Benachrichtigungen, `2` Betrieb/Hardware, `3` Apps, `4` Planung, `5` Incidents, `6` Hintergründe.
- Doc-Typen: A Setup/Runbook, B Konzept/Referenz, C Incident — Skelette in `docs/TEMPLATE.md`.
- Links innerhalb `docs/` relativ (`../c-netzwerk-dns/c0040-domain-tiers.md`), außerhalb repo-root-relativ (`docs/…`).
- Neue Docs auch im Index in `README.md` (Abschnitt „Dokumentation“) eintragen.
- Nur `##`/`###`, `---` zwischen Abschnitten, Tabellen für Konfiguration und Troubleshooting.

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

- Erst `docs/6-hintergruende/60000-uebersicht.md` → passendes Hintergrund-Doc → dann den Code. Das spart Fehlversuche.
- `README.md` ist groß (~50 KB): gezielt per `grep -n` springen statt ganz lesen.
- Charts unter `argocd/apps/*/*/charts/*.tgz` sind vendorte Abhängigkeiten — nicht durchsuchen oder ändern.
- `kubectl`/`ansible-playbook` gegen echte Hosts funktionieren aus der Cloud-Sandbox nicht (kein Zugriff aufs LAN/Tailnet).
  Solche Schritte als Befehl für den Nutzer formulieren statt sie zu versuchen.
