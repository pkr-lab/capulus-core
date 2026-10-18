# 022 Pod-Härtung unvollständig: kein Pod Security Admission, fehlendes Seccomp/ReadOnlyRootFS, privilegierte Init-Container, fehlende Limits

- Severity: Low
- Bereich: Repo
- Betroffen: `argocd/apps/*/*` (gerenderte Workloads), `argocd/apps/tech/zammad` (Subchart), `argocd/apps/tech/pihole`, `argocd/apps/tech/pacman/Dockerfile`, `argocd/apps/tech/n8n/image/Dockerfile`
- Status: Teilweise behoben am 2026-10-18 (Punkte 2 bis 4 für die eigenen gehärteten Charts im Code, gestaged, wirkt nach Merge; Pod-Security-Labels, übrige Charts und CPU-Limits offen)

## Beschreibung

Der Trivy-Misconfig-Scan der Charts (351 Ziele, ohne die nicht renderbaren Subcharts) meldet 8 CRITICAL, 120 HIGH, 235 MEDIUM und 483 LOW. Die meisten Funde sind erwartbar (DaemonSets für Metriken/Logs mit Host-Zugriff, Operator-RBAC, Pi-hole mit `NET_ADMIN`/`NET_RAW`). Relevant für die Härtung:

- Es gibt im Repo keine Pod-Security-Admission-Labels (`pod-security.kubernetes.io/*`) auf den Namespaces.
- 59 Container ohne `seccompProfile: RuntimeDefault`, 51 ohne `readOnlyRootFilesystem`, 45 ohne `drop: ALL`, 43 ohne CPU-Limit.
- Zammad: 6 Workloads mit privilegiertem Init-Container `zammad-volume-permissions` (`privileged: true`).
- `alert-caller` nutzt `hostNetwork` (Incident 010), der Node-Exporter `hostNetwork`/`hostPID`/`hostPath` (üblich für Exporter).
- `pacman/Dockerfile` und `n8n/image/Dockerfile` enthalten kein `USER`; das Basis-Image läuft dennoch als Nicht-root (`distroless:nonroot`, `n8nio/n8n`), explizit ist es nicht.
- Eigene Charts (carplay-api, mediamtx, n8n, isc-news-bot) sind vorbildlich: `runAsNonRoot`, `readOnlyRootFilesystem`, `drop: ALL`.

## Nachweis

```
$ trivy fs --scanners misconfig argocd/apps
KSV-0014 Root file system is not read-only   x51
KSV-0104 Seccomp policies disabled           x59
KSV-0017 Privileged                          x6   (zammad-volume-permissions)
KSV-0011 CPU not limited                     x43
KSV-0118 Default security context configured x47

$ grep -rn 'pod-security.kubernetes.io' ansible argocd --include=*.yaml --include=*.yml --include=*.j2 | grep -v charts
(keine Treffer)
```

## Phase-2-Nachweis (live, lesend)

Live-Stand TECH (109 Pods, 64 verschiedene Images):

- `privileged`: 5 Zammad-Pods (`zammad-volume-permissions`).
- `hostNetwork`: `alert-caller`, 3× MetalLB-FRR, 3× MetalLB-Speaker, MetalLB-statuscleaner, 3× node-exporter. `hostPID` und `hostPath` (`/`, `/proc`, `/sys`): node-exporter. `hostPath` (`/var/lib`, `/var/log`): VictoriaLogs-Collector.
- Zusätzliche Capabilities: MetalLB-FRR `NET_ADMIN`, `NET_RAW`, `SYS_ADMIN`, svclb `NET_ADMIN`, Pi-hole `NET_ADMIN`/`NET_RAW`.
- 122 Container ohne `runAsNonRoot` oder mit UID 0, 123 ohne Resource-Limits (hoher Anteil davon Argo-Workflow-Pods und MetalLB).
- PROD und ENTW: keine privilegierten Pods, kein `hostNetwork`, kein `hostPath`.

## Risiko / Angriffsszenario

Nach einer App-Kompromittierung erleichtern fehlendes Seccomp und beschreibbares Root-Dateisystem Persistenz und Container-Ausbrüche; der privilegierte Zammad-Init-Container ist ein ungewöhnlich weiter Hebel, solange er Teil des Pod-Spec ist.

## Empfohlene Behebung

1. Namespaces mit Pod-Security-Labels versehen, zunächst im Warnmodus:
   ```
   kubectl label ns zammad pod-security.kubernetes.io/warn=restricted pod-security.kubernetes.io/audit=restricted
   ```
2. In den eigenen Charts `securityContext.seccompProfile.type: RuntimeDefault` ergänzen.
3. Zammad: `volumePermissions`-Init-Container nur mit `runAsUser: 0` und spezifischen Capabilities statt `privileged` betreiben (Chart-Wert prüfen) oder durch `fsGroup` ersetzen.
4. `USER 65532:65532` explizit in die Dockerfiles aufnehmen.
5. CPU-Limits für die 43 Container setzen oder bewusst dokumentieren.

## Rollback

Labels entfernen (`kubectl label ns … pod-security.kubernetes.io/warn-`), SecurityContext-Änderungen revertieren.

## Verifikation

```
kubectl get ns -L pod-security.kubernetes.io/warn
trivy config argocd/apps --severity HIGH,CRITICAL
```
Die Warnungen sinken je App, der `privileged`-Fund (`KSV-0017`) verschwindet für Zammad.

## Risiko der Behebung

Mittel: Strengere Security-Contexts können Container-Starts verhindern, wenn die App Root oder Schreibzugriff erwartet. Pro App testen.

## Behebung (2026-10-18)

**Fix.**

- **Seccomp (Punkt 2):** `seccompProfile: RuntimeDefault` im Container-`securityContext` von alamos-apager, alamos-relay, carplay-api, cloudflared (TECH und PROD), github-release-watcher, mediamtx, ntfy-bridge und wiki-docs-sync. Das sind die Charts, die bereits `readOnlyRootFilesystem` und `drop: ALL` haben. alert-caller, isc-news-bot und pacman hatten es schon.
- **Zammad (Punkt 3):** Der Init-Container `zammad-volume-permissions` läuft nicht mehr `privileged` (`privileged: false`, `allowPrivilegeEscalation: false`). Im gerenderten Chart gibt es kein `privileged: true` mehr (vorher 7).
- **Dockerfile (Punkt 4):** `pacman` setzt `USER 65532:65532` explizit (numerisch, siehe Hintergrunddoc). Das n8n-Image bleibt bewusst ohne Änderung, ein Rebuild würde den empfindlichen n8n-Pod neu starten und der Basis-Container läuft ohnehin als `node`.

**Nachweis** (vor dem Merge):

| Test | Ergebnis |
|---|---|
| `helm template` der neun Charts | je ein `type: RuntimeDefault` im gerenderten Deployment/CronJob |
| Images lokal gestartet unter Dockers Standard-Seccomp (`seccomp=builtin`), Nicht-root, `--read-only`, `--cap-drop ALL`, `no-new-privileges` | `python:3.14-alpine` und `python:3.14-slim` (Import von ssl, http.server, subprocess) ok, `cloudflared version` ok, mediamtx 1.21.2 startet und öffnet alle Listener |
| Zammad: `chmod 770` unter `--user 0 --cap-drop ALL --read-only` auf einer `tmpfs` mit Modus `1777` | Modus `770`, Eigentümer root |
| `helm template` Zammad | `privileged: true` 0 mal (vorher 7), Init-Container mit `privileged: false` |
| `kubectl apply --dry-run=server` der Zammad-Manifeste | keine Fehler |

**Geänderte Dateien.**

- `argocd/apps/tech/{alamos-apager,alamos-relay,carplay-api,cloudflared,github-release-watcher,mediamtx,ntfy-bridge}/values.yaml`, `argocd/apps/prod/{cloudflared,wiki-docs-sync}/values.yaml`
- `argocd/apps/tech/zammad/values.yaml`, `argocd/apps/tech/pacman/Dockerfile`
- Doku: `docs/6-hintergruende/60040-helm-charts-tech.md`

**Rollback.** `git revert`. Für einen einzelnen Chart den Eintrag `seccompProfile` aus `values.yaml` entfernen; bei Zammad `privileged: true` wiederherstellen (Chart-Default).

**Offen.**

- **Übrige Charts:** Seccomp, `readOnlyRootFilesystem` und `drop: ALL` für Fremd-Charts und Root-Container (Zammad, Monitoring, Argo Workflows, Semaphore, MinIO, n8n, Nextcloud, Immich) lassen sich nur je App mit Test einführen.
- **CPU-Limits (Punkt 5):** nicht gesetzt. Fehlende CPU-Limits sind bei diesen Workloads eine bewusste Wahl (kein Throttling bei Lastspitzen); sie werden hier nicht verändert.
- **Zammad-Rollout:** Die Änderung am Init-Container erzeugt neue Pod-Templates, ArgoCD startet die Zammad-Workloads nach dem Merge neu. Das Ticketsystem ist dabei kurz nicht erreichbar.
