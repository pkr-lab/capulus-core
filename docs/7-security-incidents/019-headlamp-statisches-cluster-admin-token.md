# 019 Headlamp: ServiceAccount mit `cluster-admin` und nicht ablaufendem Token im Secret

- Severity: Medium
- Bereich: Repo
- Betroffen: `argocd/apps/tech/headlamp/templates/token-secret.yaml:9`, `templates/clusterrolebinding.yaml`, Subchart-ClusterRoleBinding `headlamp-admin`, `scripts/show-headlamp-token.sh`
- Status: Im Code behoben am 2026-10-18 (gestaged, wirkt nach Merge und ArgoCD-Sync; Altlast in `kube-system` und Gegenprobe offen)

## Beschreibung

Headlamp bekommt über zwei ClusterRoleBindings (`headlamp-cluster-admin` im Wrapper-Chart, `headlamp-admin` im Subchart) die Rolle `cluster-admin`. Für den ServiceAccount existiert ein Secret vom Typ `kubernetes.io/service-account-token`, das niemals abläuft. Das Skript `scripts/show-headlamp-token.sh` liest es aus und zeigt es an; die Anmeldung an der Oberfläche läuft mit diesem Token. Die Oberfläche ist nur intern erreichbar (`headlamp.tech.homeserver`).

## Nachweis

```
$ sed -n 9p argocd/apps/tech/headlamp/templates/token-secret.yaml
type: kubernetes.io/service-account-token

$ sed -n 9,12p argocd/apps/tech/headlamp/templates/clusterrolebinding.yaml
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin

$ trivy fs argocd/apps/tech/headlamp
KSV-0111  ClusterRoleBinding 'headlamp-admin' / 'headlamp-cluster-admin' should not bind to roles with admin access
```

## Phase-2-Nachweis (live, lesend)

Live-Stand: Zwei Secrets vom Typ `kubernetes.io/service-account-token` existieren: `headlamp/headlamp-admin-token` (SA `headlamp`, seit 2026-08-12) und `kube-system/headlamp-admin-token` (SA `headlamp-admin`, seit 2026-06-14). Die ClusterRoleBindings `headlamp-admin` und `headlamp-cluster-admin` binden den SA `headlamp/headlamp` an `cluster-admin`. Für `kube-system/headlamp-admin` existiert kein cluster-admin-Binding: ein Überbleibsel, aber ein gültiges Secret, das aufgeräumt werden sollte.

## Risiko / Angriffsszenario

Wer das Token einmal gesehen hat (Shell-Verlauf, Screenshot, Backup, Sicherung der Secrets), hat dauerhaft cluster-admin ohne Ablauf. Die Oberfläche wird zum Hochwertziel: Login-Seite plus statisches Token.

## Empfohlene Behebung

1. Kurzlebige Tokens verwenden:
   ```
   kubectl -n headlamp create token headlamp --duration=1h
   ```
   und `scripts/show-headlamp-token.sh` darauf umstellen. Das Secret `headlamp-admin-token` danach löschen (Manifest aus dem Chart entfernen).
2. Rolle reduzieren: `view` als Standard, eine eigene ClusterRole mit den Schreibrechten, die tatsächlich gebraucht werden.
3. Alternativ OIDC-Anmeldung (lldap/Authentik) statt statischem Token.

## Rollback

Secret-Manifest und `cluster-admin`-Binding wiederherstellen, synchronisieren. Das ursprüngliche Token wird vom Controller neu befüllt.

## Verifikation

```
kubectl -n headlamp get secret headlamp-admin-token
kubectl auth can-i '*' '*' --as=system:serviceaccount:headlamp:headlamp
```
Das Secret existiert nicht mehr, die zweite Abfrage liefert `no`. Anmeldung mit einem frisch erzeugten Token funktioniert.

## Risiko der Behebung

Niedrig: Die Weboberfläche verliert Schreibrechte, falls der Token-Mechanismus geändert wird. Notfall-Zugang über `kubectl` bleibt.

## Behebung (2026-10-18)

**Fix.**

- Das Secret `headlamp-admin-token` (Typ `kubernetes.io/service-account-token`) und das Wrapper-ClusterRoleBinding `headlamp-cluster-admin` sind aus dem Chart entfernt. Das Subchart legt sein ClusterRoleBinding `headlamp-admin` nicht mehr an (`headlamp.clusterRoleBinding.create: false`). Der Pod-ServiceAccount `headlamp` hat damit keine zusätzlichen Rechte mehr, Headlamp reicht im Token-Modus das eingegebene Token an die API weiter.
- Neu: ServiceAccount `headlamp-viewer` mit ClusterRoleBinding auf die Standardrolle `view` (`templates/login-viewer.yaml`), ohne dauerhaftes Token. `scripts/show-headlamp-token.sh` erzeugt per `kubectl create token` ein Token mit einer Stunde Gültigkeit.
- Ein zweites Login-Konto mit `cluster-admin` und kurzer Laufzeit wurde bewusst nicht angelegt. Schreibrechte in der Oberfläche gibt es damit nicht mehr; sie gehören bei Bedarf in eine eigene ClusterRole mit den tatsächlich gebrauchten Verben.

**Nachweis** (vor dem Merge, lokal und per Server-Dry-Run):

| Test | Ergebnis |
|---|---|
| `helm template argocd/apps/tech/headlamp` | enthält ServiceAccounts `headlamp` und `headlamp-viewer`, genau ein ClusterRoleBinding (`headlamp-viewer` auf `view`), kein Secret vom Typ `service-account-token`, kein `cluster-admin` |
| `kubectl apply --dry-run=server` der gerenderten Manifeste | alle Objekte akzeptiert, nichts geändert |
| `bash -n scripts/show-headlamp-token.sh` | ok |
| Doc-Link-Check | 0 kaputte Links |

**Geänderte Dateien.**

- `argocd/apps/tech/headlamp/templates/login-viewer.yaml` (neu), `templates/token-secret.yaml` und `templates/clusterrolebinding.yaml` (entfernt), `values.yaml`
- `scripts/show-headlamp-token.sh`
- Doku: `docs/3-apps-workloads/300n0-headlamp.md` (neu), `docs/6-hintergruende/60040-helm-charts-tech.md`, `README.md`

**Rollback.** Commit zurücknehmen (`git revert`), ArgoCD legt Secret und beide ClusterRoleBindings wieder an, der Controller füllt das Token neu. Das alte Token geht dabei verloren und wird neu erzeugt; Notfall-Zugang bleibt `kubectl`.

**Offen.**

- **Nach dem Merge prüfen:** `kubectl -n headlamp get secret headlamp-admin-token` (soll nicht mehr existieren), `kubectl auth can-i '*' '*' --as=system:serviceaccount:headlamp:headlamp` (soll `no` liefern), `./scripts/show-headlamp-token.sh` und Anmeldung an `https://headlamp.tech.homeserver`.
- **Altlast entfernen (Freigabe nötig, Löschen):** `kubectl -n kube-system delete secret headlamp-admin-token && kubectl -n kube-system delete sa headlamp-admin`. Der ServiceAccount hat kein Binding, das Secret bleibt aber ein gültiges Token.
