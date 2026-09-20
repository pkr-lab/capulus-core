# CI — Pflicht-Gate für jeden PR

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) prüft jeden
Pull Request gegen `main` (und jeden Push auf `main` selbst), bevor eine
Änderung beim ArgoCD-Sync gegen den Live-Cluster landet. Die fünf Jobs sind
die **Pflicht-Checks** des Rulesets [„main: PR + CI“](f0090-branch-schutz-main.md):
ein PR lässt sich erst mergen, wenn alle grün sind.

Angelegt im Rahmen von
[docs/4-planung/40080-multi-cluster-entw-prod-tech.md](../4-planung/40080-multi-cluster-entw-prod-tech.md),
Baustein 6. Vorher existierte `make lint` nur lokal, und ein kaputtes Manifest
fiel erst beim Sync auf, nicht im PR.

Derselbe Workflow ist zugleich **wiederverwendbar** (`workflow_call` mit dem
Input `ref`): [`promote-entw.yml`](f0080-entw-promotion.md) ruft ihn gegen den
Branch `entw` auf, bevor ein PR nach `main` entsteht.

---

## Fünf parallele Jobs

| Job (= Check-Name) | Prüft | Tool |
|---|---|---|
| `make lint (yamllint, ansible-lint, helm lint)` | YAML-Syntax (`ansible/`, `argocd/`), Ansible-Best-Practices, `helm lint` je Chart | ruft schlicht `make lint` auf — dieselbe Prüfung wie lokal |
| `helm template \| kubeconform` | rendert jeden Chart und validiert die entstandenen Ressourcen gegen echte API-Schemas; prüft zusätzlich **reine Manifest-Ordner** (ohne `Chart.yaml`) und `argocd/bootstrap*` | [kubeconform](https://github.com/yannh/kubeconform) mit CRD-Katalog |
| `go build, vet, test, tidy` | jedes Go-Modul im Repo: `go mod tidy -diff`, `go build`, `go vet`, `go test` | Go (`stable`); Module per `git ls-files` gefunden |
| `docs links` | relative Links und Überschriften-Anker in allen `*.md` (Slug-Regeln wie auf GitHub); externe URLs werden nicht abgerufen | [`scripts/check-doc-links.py`](../../scripts/check-doc-links.py) |
| `gitleaks` | Plaintext-Secrets in PRs, bevor sie versiegelt werden | [gitleaks](https://github.com/gitleaks/gitleaks), Konfiguration siehe unten |

### Warum der CRD-Katalog

kubeconform kennt nur Kubernetes-Kernressourcen. Für alles andere
(`Application`, `ApplicationSet`, `AppProject`, `SealedSecret`,
cert-manager, VictoriaMetrics, …) übersprang die erste Fassung die Prüfung
(`-ignore-missing-schemas`) — auch die Manifeste, für die `ci.yml` eigentlich
gedacht war (das `spec.generators[0].template`-Problem aus
[b0020-argocd-projects.md](../b-kubernetes-gitops/b0020-argocd-projects.md)).
Der [CRDs-catalog](https://github.com/datreeio/CRDs-catalog) liefert Schemas für
diese Typen; ohne ihn waren beim Test 10 von 51 Ressourcen in den Manifest-Ordnern
„skipped“, mit ihm 0. `-ignore-missing-schemas` bleibt für CRDs, die auch der
Katalog nicht kennt. Die Schemas kommen bei jedem Lauf per HTTPS von
`raw.githubusercontent.com`; gegen gelegentliche Verbindungsabbrüche
(`connection reset`) wiederholt der Job den Aufruf bis zu dreimal, echte
Validierungsfehler sofort nicht.

### Was `manifest-validate` abdeckt

1. **Helm-Charts** (`argocd/apps/*/*/` mit `Chart.yaml`): `helm dependency build`,
   `helm template`, dann validieren. Ein fehlgeschlagenes `helm template` bricht den
   Job laut ab — früher reichte die Pipe die Fehlermeldung an kubeconform weiter, die
   als „0 Ressourcen“ durchging.
2. **Reine Manifest-Ordner** (`nas-storage`, `traefik-config`, `immich-storage`,
   `coredns-custom`): werden von ArgoCD direkt angewendet und waren bisher ungeprüft.
3. **Bootstrap** (`argocd/bootstrap`, `argocd/bootstrap-prod`, inkl. der
   Migrations-Jobs): Hub- und PROD-ApplicationSets, AppProjects.

### Warum `go-check`

Anlass: Ein Renovate-Merge (`geoip2-golang` v1 → v2, 2026-09-03) hat pacmans
`go.mod` beschädigt — die v1-Zeile wurde überschrieben, der Code importierte
weiter den v1-Pfad. Kein Workflow übersetzte den Go-Code vor dem Merge. Der
[Image-Build](f0060-build-images.md) lief drei Minuten nach dem Merge rot
(`no required module provides package github.com/oschwald/geoip2-golang`), aber
erst *nach* dem Merge und ohne Benachrichtigung — der Fehler blieb 16 Tage
unbemerkt (das laufende Image `v8` war nicht betroffen). Der Job hätte den PR
rot gemacht.
`go mod tidy -diff` fängt zusätzlich halb aktualisierte Abhängigkeiten
(überzählige `go.sum`-Zeilen, ungenutzte `require`-Einträge). Es gibt aktuell
keine `_test.go`-Dateien, `go test` meldet „no test files“ und schlägt bei neuen
Tests automatisch an.

Die Module werden nicht fest verdrahtet: der Job greift dadurch auch auf `entw`
(anderes Ordner-Layout) und für künftige Go-Dienste ohne Anpassung.

### Warum `docs links`

Nach dem Layout-Umzug (`platform`/`workloads` → `tech`) und dem Entfernen einzelner Docs zeigten **26 Links** ins
Leere (z. B. `../../../docs/…` in den READMEs unter `argocd/apps/tech/`, das jetzt eine Ebene tiefer liegt), dazu
Anker auf Überschriften, die es so nicht gibt. Alle sind repariert; der Job verhindert neue. Er nutzt bewusst kein
externes Tool: ein eigenes Skript mit den GitHub-Slug-Regeln (Sonderzeichen wie `/` und `&` entfallen, Umlaute
bleiben) ist ohne Netzzugriff und ohne Action-Version reproduzierbar. Codeblöcke und Inline-Code werden ignoriert.
Lokal: `python3 scripts/check-doc-links.py`.

### gitleaks-Konfiguration

- [`.gitleaks.toml`](../../.gitleaks.toml) erweitert die Standardregeln um **eine Ausnahme**: den Chiffretext von
  SealedSecrets (Base64, beginnt mit `Ag`, mindestens 200 Zeichen). Ohne sie meldete die Regel `generic-api-key` den
  verschlüsselten Wert von Feldern namens `token:` als Klartext-Token (der Lauf nach Commit `433afb3` wurde rot,
  und mit Pflicht-Checks hätte jeder PR mit einem neuen SealedSecret hier gehangen). Die Ausnahme hängt am **Wert**,
  nicht am Dateipfad: ein versehentlich im Klartext eingetragenes Token in einer `sealedsecret*.yaml` wird weiter
  gemeldet (getestet).
- [`.gitleaksignore`](../../.gitleaksignore) führt **7 Altfunde in der Git-Historie** auf. Ohne die Liste scheitert
  jeder Lauf, der die ganze Historie scannt (Cron/`workflow_call` der [ENTW-Promotion](f0080-entw-promotion.md)),
  dauerhaft. Fünf sind harmlos (Platzhalter in alten Doku-Beispielen, eine öffentliche UUID im pacman-Manifest).
  **Zwei sind echte Altlasten und gelten als kompromittiert**, weil das Repo öffentlich ist: ein OpenSSH-Private-Key
  der Banana Pis (Commit vom 2026-08-10, in `8625d54` entfernt) und ein `clientSecret` in einer alten MinIO-`values.yaml`
  (Klartext, im aktuellen Stand nicht mehr vorhanden). Zugehörige Zugangsdaten rotieren, sofern noch in Benutzung
  (Schlüssel aus den `authorized_keys` der Pis entfernen; MinIO-Client in Authentik neu erzeugen). Die Datei nennt das
  bei den Einträgen.

---

## Was der Workflow NICHT tut

- **Kein Deploy, kein Zugriff auf den Cluster** — reine Statik-Prüfung,
  `permissions: contents: read`.
- **Kein Ersatz für `helm dependency update`** bei vendorisierten
  Subcharts — `Chart.lock`/`charts/*.tgz` werden weiterhin manuell
  gepflegt (siehe `renovate.json`, dieselbe Ausnahme gilt hier).
- **Kein Ansible-Lauf gegen echte Hosts** — `ansible-lint` prüft nur
  Syntax/Best-Practices der Playbooks/Rollen selbst.
- **Kein Bau der Container-Images** — das macht
  [`build-images.yml`](f0060-build-images.md) (ohne Push auch auf PRs).

## Unterschiede zwischen lokal und CI

Die Runner nutzen die jeweils neueste Helm-Version (`azure/setup-helm`, aktuell
Helm 4). Lokal mit Helm 3 zeigt kubeconform bei `zammad` einen Fehlalarm:
`updateStrategy.rollingUpdate.maxUnavailable: null` (in den Values absichtlich
gesetzt) rendert Helm 3 als leeres Feld, Helm 4 lässt es weg. Für den Cluster
ist das folgenlos (leer heißt „nicht gesetzt“). Maßgeblich ist der CI-Lauf.

---

## Historie: der erste Lauf (2026-09-18)

`.yamllint` (Repo-Root) existierte vorher nicht, obwohl `make lint` es
referenziert (`yamllint -c .yamllint ...`) — wurde zusammen mit dem Workflow
ergänzt.

Der erste echte CI-Lauf ist prompt fehlgeschlagen — und hat damit genau den
Zweck erfüllt, für den `ci.yml` gebaut wurde: einen vorher nie aufgefallenen
Bug in `make lint` selbst aufgedeckt. `yamllint` versuchte, **Helm-Templates als
rohes YAML zu parsen** — Go-Template-Ausdrücke wie `{{- include "x.labels" . |
nindent 4 }}` sind vor dem Rendern kein gültiges YAML
(`argocd/apps/*/*/templates/**/*.yaml`, ausnahmslos alle Charts). Fix:
`.yamllint` ignoriert `templates/` komplett — die Syntax dort prüfen weiterhin
`helm lint` und `helm template` (Job `manifest-validate`).

Seitdem ist CI auf `main` durchgehend grün (bestätigt an den Läufen vom
2026-09-19). Ausnahme war ein einzelner abgebrochener Lauf durch die
`concurrency`-Regel (`cancel-in-progress`, ein neuerer Push ersetzte ihn).
