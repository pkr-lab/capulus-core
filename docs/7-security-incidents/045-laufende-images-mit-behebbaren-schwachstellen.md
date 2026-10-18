# 045 Laufende Container-Images mit behebbaren CRITICAL- und HIGH-Schwachstellen, darunter unmaintainte Bitnami-Legacy-Images

- Severity: Medium
- Bereich: Repo
- Betroffen: TECH-Cluster: `louislam/uptime-kuma` (öffentlich), `ghcr.io/zammad/zammad` (öffentlich), `bitnamilegacy/os-shell`, `bitnamilegacy/postgresql` (Zammad), `n8n-custom`, `lldap/lldap:stable`, `semaphoreui/semaphore`, `gcr.io/kaniko-project/executor:latest`, `nfs-subdir-external-provisioner`, `kubeseal-webgui`, `memcached`, `redis`, `metallb/speaker`, `grafana/grafana`
- Status: Teilweise behoben am 2026-10-18 (kaniko fixiert, Scan-Skript, Befund zu den Versionen; Zammad-Datenbank und Upstream-Basis-Images offen)

## Beschreibung

Ein Trivy-Scan der laufenden Container-Images des TECH-Clusters (Schweregrad CRITICAL und HIGH, nur Funde mit verfügbarem Fix, Datenbank vom 2026-10-16) meldet in 18 von 62 gescannten Images mindestens eine CRITICAL- und in 56 mindestens eine HIGH-Schwachstelle. Die höchsten Zahlen stammen aus Basis-Betriebssystem-Paketen von Images, die lange nicht aktualisiert wurden. Die höchste Zahl hat `louislam/uptime-kuma:2.5.6`, das über `status-prod.pke-lab.de` öffentlich erreichbar ist: Debian 12.14 mit mitgeliefertem Chromium (78 CRITICAL allein im Paket `chromium`), der Node.js-Laufzeit (3 CRITICAL) und einem eingebetteten `cloudflared`-Binary (1 CRITICAL, 30 HIGH). Besonders auffällig sind außerdem die Images unter `docker.io/bitnamilegacy/…`: Bitnami hat die kostenlose Pflege der Images im Docker-Hub-Namespace `bitnami` 2025 eingestellt, `bitnamilegacy` ist ein eingefrorenes Archiv ohne Updates. Das Zammad-Subchart nutzt daraus PostgreSQL (17.5.0) und `os-shell`.

Die meisten Funde in Basis-Paketen sind ohne Netzzugriff auf den jeweiligen Dienst nicht ausnutzbar (die Datenbank ist per NetworkPolicy nur aus dem eigenen Namespace erreichbar). Relevanter sind öffentlich erreichbare oder privilegierte Komponenten: Grafana (öffentlich), Semaphore (hält Vault-Passwort und SSH-Schlüssel), MetalLB-Speaker (`hostNetwork`). Für 2 Images brach der Scan ab (`ollama:0.35.1`, `minio:RELEASE.2024-12-18T13-15-44Z`): diese sind ungeprüft.

## Nachweis

```
$ kubectl get pods -A -o json | (eindeutige Images) → 64 Images
$ trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed <image>   (je Image)
| Image | CRITICAL | HIGH |
|---|---|---|
| `louislam/uptime-kuma:2.5.6` | 193 | 1911 |
| `docker.io/bitnamilegacy/os-shell:12-debian-12-r49` | 26 | 320 |
| `ghcr.io/zammad/zammad:7.1.1-0037` | 17 | 139 |
| `docker.io/bitnamilegacy/postgresql:17.5.0-debian-12-r20` | 16 | 84 |
| `ghcr.io/pkr-lab/n8n-custom:sha-6f3c34f` | 13 | 75 |
| `semaphoreui/semaphore:v2.19.16` | 6 | 170 |
| `gcr.io/kaniko-project/executor:latest` | 5 | 155 |
| `registry.k8s.io/sig-storage/nfs-subdir-external-provisioner:v4.0.2` | 5 | 112 |
| `lldap/lldap:stable` | 4 | 57 |
| `ghcr.io/jaydee94/kubeseal-webgui/api:4.10.1` | 4 | 50 |
| `docker.io/memcached:1.6.45@sha256:dc561d52bb8ad3c038867123ed…dbd526cd65cf39408cbd` | 3 | 57 |
| `docker.io/redis:8.8.0@sha256:234c902a2db49461a129e2d4aeff85b…4a67f6e50995fa713c7b` | 3 | 51 |
```
Abgebrochene Scans: `ollama/ollama:0.35.1`, `quay.io/minio/minio:RELEASE.2024-12-18T13-15-44Z`

## Risiko / Angriffsszenario

Ein Angreifer mit Zugriff auf einen dieser Dienste (öffentlich: Grafana, Zammad; intern: Semaphore) findet in veralteten Basis-Paketen zusätzliche Hebel für Rechteausweitung im Container. Ohne Pflege der Bitnami-Legacy-Images kommen keine weiteren Sicherheitskorrekturen mehr.

## Empfohlene Behebung

1. Zammad: PostgreSQL und `os-shell` auf gepflegte Images umstellen (z. B. das offizielle `postgres:17`-Image oder CloudNativePG) und dafür vorher ein Backup einplanen (Incident 037); die Chart-Werte `postgresql.image` bzw. `global.imageRegistry` anpassen.
2. Semaphore, nfs-subdir-external-provisioner, kubeseal-webgui, MetalLB und Grafana auf die jeweils aktuelle Release-Version heben (Renovate öffnet die PRs; `minimumReleaseAge` ergänzen, Incident 031).
3. `kaniko:latest` auf ein festes Tag setzen (Incident 023).
4. Den Image-Scan in die CI aufnehmen (`trivy image` gegen die selbst gebauten Images in `build-images.yml`, `trivy config` für die Charts) und wöchentlich gegen die laufenden Images ausführen.

## Rollback

Vorherige Image-Tags in den `values.yaml` wiederherstellen; bei der Datenbank das vorab angelegte Backup einspielen.

## Verifikation

```
trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed <image>
```
Die Zahl der CRITICAL-Funde sinkt auf 0; die Dienste starten und die Anwendungen funktionieren (Zammad-Login, Semaphore-Jobs).

## Risiko der Behebung

Mittel: Image-Wechsel bei Datenbanken (Zammad-PostgreSQL) erfordert Backup und gegebenenfalls Major-Upgrade; Semaphore und Argo Workflows sind Betriebswerkzeuge.

## Bearbeitung (2026-10-18)

**Geändert.**

- **Punkt 3, kaniko:** `argocd/apps/tech/argo-workflows/templates/workflowtemplates.yaml` nutzt `gcr.io/kaniko-project/executor:v1.24.0` statt `:latest`. `latest` und `v1.24.0` haben denselben Digest (`sha256:4e7a52dd…`), das Verhalten bleibt gleich. Das kaniko-Projekt ist archiviert (keine Updates mehr); Scan-Ergebnis des festen Tags: 5 CRITICAL, 157 HIGH.
- **Punkt 4, Scan:** Neu `scripts/scan-cluster-images.sh` (Trivy, lokal oder per Docker) liest alle Images der laufenden Pods und scannt sie; `--summary` liefert eine Zeile je Image. Beschrieben in `docs/f-cicd-automatisierung/f0070-ci-lint.md`. Einen CI-Job habe ich nicht angelegt, weil es eine Entscheidung braucht, ob Funde den Merge blockieren dürfen.

**Befund zu den genannten Images.** Die meisten Funde kommen aus den Basis-Paketen der Upstream-Images, nicht aus alten Tags: Das laufende `louislam/uptime-kuma:2.5.6` und `semaphoreui/semaphore:v2.19.16` sind laut Docker Hub jeweils das neueste Release, `lldap` steht seit Incident 023 auf `v0.6.3` (neueste 0.6-Version). Ein Version-Bump bringt dort nichts, ein Hersteller-Rebuild oder ein Image-Wechsel wäre nötig. Bei Grafana läuft 13.1.1 (Chart `victoria-metrics-k8s-stack`), aktuell ist 13.2.4; das Anheben gehört zum Chart-Update von Renovate.

**Nicht umgesetzt.**

- **Punkt 1, Zammad-PostgreSQL und `os-shell`:** Der Wechsel von `bitnamilegacy/postgresql:17.5.0` auf ein gepflegtes Image ist ein Datenbank-Eingriff (anderes Datenverzeichnis-Layout, Benutzer, Rechte). Das ist eine Datenmigration und braucht vorher ein getestetes Backup (Incident 037, offen); ohne dich nicht.
- **Punkt 2, Renovate-Bumps:** Image-Updates öffnet Renovate (Montag vor 6 Uhr, mit Karenzzeit aus Incident 031); manuelles Nachbauen ist laut `CLAUDE.md` nicht vorgesehen.
- **n8n-Image** (`n8n-custom`, 13 CRITICAL): baut auf `n8nio/n8n:2.42.3` auf; ein Basis-Update erzeugt über `build-images.yml` ein neues Image und startet den empfindlichen n8n-Pod neu.
- Die zwei abgebrochenen Scans (`ollama`, `minio`) sind weiter ungeprüft.

**Nachweis.**

| Test | Ergebnis |
|---|---|
| `helm template` argo-workflows | `image: gcr.io/kaniko-project/executor:v1.24.0` |
| Digest-Abgleich über die Registry-API | `latest` = `v1.24.0` |
| `./scripts/scan-cluster-images.sh --summary gcr.io/kaniko-project/executor:v1.24.0` | `5 157` |
| `bash -n scripts/scan-cluster-images.sh` | ok |

**Geänderte Dateien.**

- `argocd/apps/tech/argo-workflows/templates/workflowtemplates.yaml`, `scripts/scan-cluster-images.sh` (neu)
- Doku: `docs/f-cicd-automatisierung/f0070-ci-lint.md`, `docs/6-hintergruende/60040-helm-charts-tech.md`

**Rollback.** `git revert`.

**Offen (deine Entscheidung).** Zammad-Datenbank-Image (nach Backup-Konzept 037), ein Image-Scan-Job in der CI, ein Ersatz für kaniko, Wechsel von `uptime-kuma` auf ein schlankeres Image ohne eingebettetes Chromium.

## Umsetzung nach Rückfrage (2026-10-18, „deine Empfehlung“)

- **CI-Scan:** `.github/workflows/image-scan.yml`, wöchentlich und auf Abruf, nicht blockierend (Begründung in `f0070`). `scripts/scan-cluster-images.sh --charts` liest die Images aus `helm template` aller Charts (54 Images), `--summary` liefert die Tabelle.
- **Zammad-PostgreSQL:** Reihenfolge festgelegt: erst die verschlüsselte Sicherung (Incident 037: Zammad als nächster Dienst nach Vaultwarden, `pg_dump`), danach der Wechsel von `bitnamilegacy/postgresql` auf ein gepflegtes Image mit Restore-Probe auf ENTW. Nicht vorher.
- **kaniko:** Das WorkflowTemplate `kaniko-build-push` ist durch `build-images.yml` ersetzt (nur noch manuell nutzbar). Empfehlung: das Template entfernen, statt ein archiviertes Projekt zu pflegen; bis dahin bleibt es auf `v1.24.0` fixiert. Entfernen ist deine Entscheidung (Doku `f0000` beschreibt es noch).

