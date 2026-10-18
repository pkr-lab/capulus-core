# 043 Das öffentlich erreichbare Grafana kann über seinen ServiceAccount clusterweit alle Secrets lesen

- Severity: High
- Bereich: Repo
- Betroffen: `argocd/apps/tech/monitoring/values.yaml:205-220` (Grafana-Sidecars), ClusterRole `monitoring-grafana-clusterrole`, Host `grafana-tech.pke-lab.de`
- Status: Behoben am 2026-10-18 im Code (gestaged; wirkt nach Merge und ArgoCD-Sync, danach `kubectl auth can-i` prüfen)

## Beschreibung

Das Grafana-Subchart legt eine ClusterRole an, die `get`, `list` und `watch` auf **`configmaps` und `secrets` in allen Namespaces** erlaubt. Hintergrund sind die k8s-sidecars (`grafana-sc-dashboard`, `grafana-sc-datasources`) mit `RESOURCE=both` und `NAMESPACE=ALL`: Sie suchen Dashboards und Datasources auch in Secrets. Der Pod `monitoring-grafana` mountet das Token des ServiceAccounts `monitoring-grafana` automatisch (`automountServiceAccountToken` nicht deaktiviert), und zwar in alle drei Container, auch in den Grafana-Prozess selbst. Grafana ist über `grafana-tech.pke-lab.de` im Internet erreichbar (Incident 005).

Damit führt jede Schwachstelle, die im Grafana-Prozess Dateilesen oder Codeausführung erlaubt (Grafana hatte wiederholt unauthentifizierte Path-Traversal- und SSRF-Lücken), direkt zum Token und damit zum Lesezugriff auf alle Secrets des Clusters: den privaten Schlüssel des Sealed-Secrets-Controllers (damit lassen sich **alle SealedSecrets im öffentlichen Repo entschlüsseln**), die Tokens der ServiceAccounts, `argocd-secret` und die Datenbankpasswörter. Die Sidecars brauchen im Ist-Zustand keine Secrets: Es existiert kein Secret mit den Labels `grafana_dashboard=1` oder `grafana_datasource=1`.

## Nachweis

```
$ kubectl get clusterrole monitoring-grafana-clusterrole -o jsonpath='{range .rules[*]}{.apiGroups}{" "}{.resources}{" "}{.verbs}{"\n"}{end}'
[""] ["configmaps","secrets"] ["get","watch","list"]

$ kubectl auth can-i list secrets -n sealed-secrets --as=system:serviceaccount:monitoring:monitoring-grafana
yes
$ kubectl auth can-i get secrets --all-namespaces --as=system:serviceaccount:monitoring:monitoring-grafana
yes

$ kubectl -n monitoring get deploy monitoring-grafana -o jsonpath='{...containers[*].env}' (Auszug)
grafana-sc-dashboard:   LABEL=grafana_dashboard   RESOURCE=both   NAMESPACE=ALL
grafana-sc-datasources: LABEL=grafana_datasource  RESOURCE=both
$ kubectl -n monitoring get deploy monitoring-grafana -o jsonpath='{.spec.template.spec.automountServiceAccountToken}'
true

$ kubectl get secrets -A -l grafana_dashboard=1        → No resources found
$ kubectl get secrets -A -l grafana_datasource=1       → No resources found
$ kubectl get cm -A -l grafana_dashboard=1 | wc -l     → 72
```
Es wurde kein Secret gelesen; die Rechte wurden nur über `kubectl auth can-i` abgefragt.

## Risiko / Angriffsszenario

Angriffskette aus dem Internet: Grafana-Schwachstelle (Dateilesen/RCE) → ServiceAccount-Token aus `/var/run/secrets/kubernetes.io/serviceaccount/token` → `GET /api/v1/secrets` → Sealing-Key und alle Zugangsdaten → vollständige Übernahme des TECH-Clusters und Entschlüsselung aller im Repo versiegelten Geheimnisse. Das ist die kürzeste bekannte Kette von außen nach cluster-admin-äquivalenten Rechten in dieser Umgebung.

## Empfohlene Behebung

1. Sidecars auf ConfigMaps beschränken (Werte im Subchart `grafana` der `monitoring/values.yaml`):
   ```diff
        sidecar:
          datasources:
            enabled: true
   +        resource: configmap
            label: grafana_datasource
            labelValue: "1"
          dashboards:
            enabled: true
   +        resource: configmap
            label: grafana_dashboard
            labelValue: "1"
   ```
   Damit enthält die ClusterRole nur noch `configmaps`.
2. Dem Grafana-Hauptcontainer den Token entziehen, wenn möglich: eigener ServiceAccount nur für die Sidecars oder `automountServiceAccountToken: false` auf dem Pod und ein projiziertes Token nur in die Sidecar-Container.
3. `searchNamespace` auf die Namespaces mit Dashboards beschränken, statt `ALL`.
4. Grafana hinter Cloudflare Access legen (Incident 005) und auf eine unterstützte Version halten (aktuell `grafana/grafana:13.1.1`).
5. Nach der Änderung prüfen, ob irgendein anderer ServiceAccount mit Secrets-Lesezugriff aus dem Internet erreichbar ist (traefik, cert-manager, argocd-server haben ihn betriebsbedingt; Traefik ist die Eintrittsstelle selbst).

## Rollback

Die beiden `resource: configmap`-Zeilen entfernen und synchronisieren. Die Dashboards bleiben in ConfigMaps erhalten.

## Verifikation

```
kubectl get clusterrole monitoring-grafana-clusterrole -o jsonpath='{.rules[*].resources}'
kubectl auth can-i get secrets --all-namespaces --as=system:serviceaccount:monitoring:monitoring-grafana
```
Erwartung: nur `["configmaps"]` und `no`. In Grafana sind danach alle 72 Dashboards und die 3 Datasources weiterhin vorhanden.

## Risiko der Behebung

Niedrig: Es gibt keine Secrets mit Grafana-Labels; die Dashboards (72) und Datasources (3) liegen in ConfigMaps.

## Behebung (2026-10-18)

**Fix.**

- **Punkt 1, nur ConfigMaps:** `grafana.sidecar.datasources.resource` und `grafana.sidecar.dashboards.resource` stehen auf `configmap` (die Sidecars fragen keine Secrets mehr ab). Die vorgeschlagene Änderung allein hätte die ClusterRole nicht verkleinert: Das Grafana-Chart (in `victoria-metrics-k8s-stack` 0.91.2 gebündelt) schreibt `configmaps` **und** `secrets` in die ClusterRole, sobald irgendein Sidecar aktiv ist, unabhängig von `resource`. Deshalb zusätzlich `grafana.rbac.create: false` und eine eigene Rolle: `templates/rbac-grafana-sidecar.yaml` legt die ClusterRole `monitoring-grafana-sidecar` (nur `configmaps`: `get`, `list`, `watch`) und ihr Binding an den ServiceAccount `monitoring-grafana` an. Ein neues Binding statt `rbac.useExistingClusterRole`, weil die `roleRef` eines vorhandenen ClusterRoleBindings unveränderlich ist; das alte Paar (`monitoring-grafana-clusterrole`/`-clusterrolebinding`) entfernt ArgoCD per Prune.
- **Punkt 3, Namespaces:** `sidecar.dashboards.searchNamespace: monitoring,pacman` statt `ALL`. Dort liegen alle Dashboard-ConfigMaps (71 in `monitoring`, 1 in `pacman`; Datasource-ConfigMaps: 3 in `monitoring`). Es gibt kein Secret mit den Sidecar-Labels.

**Nachweis** (vor dem Merge).

| Test | Ergebnis |
|---|---|
| `helm template` des Monitoring-Charts | genau eine Grafana-ClusterRole `monitoring-grafana-sidecar` mit `configmaps` (`get`, `list`, `watch`), kein `secrets`; ServiceAccount `monitoring-grafana` unverändert; Sidecar-Env `RESOURCE=configmap`, `NAMESPACE=monitoring,pacman` |
| `kubectl apply --dry-run=server` der gerenderten Manifeste | keine Fehler |
| `kubectl get secrets -A -l grafana_dashboard=1` / `grafana_datasource=1`, `kubectl get cm -A -l grafana_dashboard=1` | keine Secrets betroffen; 72 ConfigMaps nur in `monitoring` und `pacman` |

**Geänderte Dateien.**

- `argocd/apps/tech/monitoring/values.yaml`, `argocd/apps/tech/monitoring/templates/rbac-grafana-sidecar.yaml` (neu)
- Doku: `docs/6-hintergruende/60060-monitoring-und-alerting.md`

**Rollback.** `git revert`; ArgoCD legt `monitoring-grafana-clusterrole` und das alte Binding wieder an.

**Offen.**

- **Nach dem Rollout prüfen (wichtig):**
  `kubectl auth can-i list secrets -n sealed-secrets --as=system:serviceaccount:monitoring:monitoring-grafana` → `no`,
  `kubectl auth can-i list configmaps -n monitoring --as=system:serviceaccount:monitoring:monitoring-grafana` → `yes`,
  und in Grafana müssen alle Dashboards und die Datasources weiter da sein (Pod `monitoring-grafana` neu gestartet, 3/3 Container `Running`).
- **Punkt 2 (Token nicht im Hauptcontainer):** Das Chart verteilt das ServiceAccount-Token an alle Container; ein getrennter ServiceAccount nur für die Sidecars ist mit diesem Chart nicht möglich. Das Token hat jetzt nur noch Lesezugriff auf ConfigMaps (die der Cluster ohnehin nicht geheim hält).
- **Punkt 4 (Cloudflare Access, aktuelle Grafana-Version):** siehe Incident 005 (zurückgestellt); die Version ist im Chart gepinnt.
