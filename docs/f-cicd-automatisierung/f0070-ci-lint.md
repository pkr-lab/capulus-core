# CI — Lint-/Validierungs-Gate auf jedem PR

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) prüft jeden
Pull Request gegen `main` (und jeden Push auf `main` selbst), bevor eine
Änderung überhaupt beim ArgoCD-Sync gegen den Live-Cluster landet. Vorher
existierte `make lint` bereits lokal, lief aber in **keinem** der
bisherigen vier Workflows (`build-images.yml`, `mirror-gitlab.yml`,
`release.yml`, `renovate.yml`) — ein kaputtes Manifest fiel erst beim
Sync auf, nicht im PR. Angelegt im Rahmen von
[docs/4-planung/40080-multi-cluster-entw-prod-tech.md](../4-planung/40080-multi-cluster-entw-prod-tech.md),
Baustein 6 (Voraussetzung für ein vertrauenswürdiges Promotion-Gate).

---

## Drei parallele Jobs

| Job | Prüft | Tool |
|---|---|---|
| `lint` | YAML-Syntax (`ansible/`, `argocd/`), Ansible-Best-Practices, `helm lint` je Chart | ruft schlicht `make lint` auf — dieselbe Prüfung, die lokal schon existierte |
| `manifest-validate` | Rendert jeden Chart (`helm template`) und validiert die entstandenen Kubernetes-Ressourcen strukturell gegen echte API-Schemas | [kubeconform](https://github.com/yannh/kubeconform) — geht über `helm lint` hinaus, hätte z. B. das `spec.generators[0].template`-Problem aus [b0020-argocd-projects.md](../b-kubernetes-gitops/b0020-argocd-projects.md) schon vor dem `kubectl apply` gegen den Live-Cluster gefunden |
| `secret-scan` | Verhindert, dass ein Plaintext-Secret versehentlich in einer PR landet, bevor es überhaupt zum Versiegeln kommt | [gitleaks](https://github.com/gitleaks/gitleaks) |

**`manifest-validate` läuft mit `-ignore-missing-schemas`:** Viele hier
genutzte CRDs (`SealedSecret`, VictoriaMetrics-Typen, cert-manager
`Certificate`, …) haben kein öffentliches JSON-Schema bei kubeconform
hinterlegt — die Strukturprüfung bleibt für alles mit bekanntem Schema
aktiv (Deployment, Service, Ingress, PVC, CronJob, …), CRDs ohne Schema
werden übersprungen statt fälschlich als Fehler gemeldet.

---

## Was der Workflow NICHT tut

- **Kein Deploy, kein Zugriff auf den Cluster** — reine Statik-Prüfung
  gegen den PR-Branch, `permissions: contents: read`.
- **Kein Ersatz für `helm dependency update`** bei vendorisierten
  Subcharts — `Chart.lock`/`charts/*.tgz` werden weiterhin manuell
  gepflegt (siehe `renovate.json`, dieselbe Ausnahme gilt hier).
- **Kein Ansible-Lauf gegen echte Hosts** — `ansible-lint` prüft nur
  Syntax/Best-Practices der Playbooks/Rollen selbst, nichts wird
  ausgeführt.

## Voraussetzung für einen ersten grünen Lauf

`.yamllint` (Repo-Root) existierte vorher nicht, obwohl `make lint` es
referenziert (`yamllint -c .yamllint ...`) — wurde zusammen mit diesem
Workflow ergänzt.

**Erster echter CI-Lauf (2026-09-18) ist prompt fehlgeschlagen** — und
hat damit genau den Zweck erfüllt, für den `ci.yml` gebaut wurde: einen
echten, vorher nie aufgefallenen Bug in `make lint` selbst aufgedeckt.
`yamllint` versuchte, **gerenderte Helm-Templates als rohes YAML zu
parsen** — Go-Template-Ausdrücke wie `{{- include "x.labels" . | nindent
4 }}` sind aber kein gültiges YAML, bevor Helm sie rendert
(`argocd/apps/*/*/templates/**/*.yaml`, ausnahmslos alle Charts
betroffen). Das ist kein neuer Fehler durch `ci.yml` — `make lint` konnte
das nie vorher testen, weil `.yamllint` schlicht fehlte. Fix: `.yamllint`
ignoriert jetzt `argocd/apps/*/*/templates/` komplett — die Go-Template-
Syntax dort wird stattdessen weiterhin korrekt von `helm lint`/
`helm template` geprüft (Job `manifest-validate`), das kann mit
Templating umgehen, `yamllint` nicht.

**Noch offen:** ein weiterer CI-Lauf mit dem gefixten `.yamllint`, um zu
bestätigen, dass jetzt wirklich alles grün ist (`ansible-lint` und
`helm lint` selbst wurden durch diesen ersten Fehlschlag noch gar nicht
erreicht).
