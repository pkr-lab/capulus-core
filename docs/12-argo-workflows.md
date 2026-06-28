# Argo Workflows (private CI/CD)

[Argo Workflows](https://argo-workflows.readthedocs.io) läuft als
ArgoCD-verwaltete App (`argocd/apps/argo-workflows/`) und ist die private
CI-Engine des Home-Servers. Es ist mit einer kleinen MinIO-Instanz
(`argocd/apps/minio/`) gekoppelt, die als S3-kompatibles Artifact-Repository
und Log-Archiv dient.

Aufgabenteilung:

```
Argo Workflows  =  CI   (clonen, testen, linten, Images bauen)
ArgoCD          =  CD   (argocd/apps/* in den Cluster deployen)
```

- **Trigger:** manuell über die UI oder `argo submit`, plus
  `CronWorkflow`-Schedules. Es gibt keinen öffentlichen Ingress, Git-Webhooks
  sind daher außerhalb des Scopes.
- **Auth:** Server-Auth-Mode — kein Login, offen im LAN/Tailnet (gleiches
  Trust-Modell wie Grafana/Headlamp/Semaphore). Nur über Tailnet/LAN
  erreichbar.
- **Image-Builds:** Kaniko baut und pusht nach GHCR (`ghcr.io/pke/...`)
  mittels eines versiegelten Docker-Config-Secrets. Keine In-Cluster-Registry.

| Dienst         | URL                               | Hinweise                    |
|----------------|------------------------------------|------------------------------|
| Argo Workflows | http://argo-workflows.homeserver  | UI + API (Server-Auth-Mode) |
| MinIO-Konsole  | http://minio.homeserver           | Objekt-Browser              |

---

## 1. Einmalige Secrets (kubeseal)

Die beiden Apps liefern `SealedSecret`-Manifeste mit Platzhalter-Werten
(`REPLACE_ME_SEALED_*`). Diese müssen gegen den Sealed-Secrets-Controller des
Clusters versiegelt werden, bevor die Apps gesund werden. `kubeseal` von
einer Maschine mit Cluster-Zugriff ausführen (z.B. per SSH auf dem Server),
gerichtet auf den Controller `sealed-secrets-controller` im Namespace
`sealed-secrets`.

Ein wiederverwendbarer Helper:

```bash
seal() {  # seal <namespace> <secret-name> <value-on-stdin>
  kubeseal --raw --namespace "$1" --name "$2" \
    --controller-name sealed-secrets-controller \
    --controller-namespace sealed-secrets \
    --from-file=/dev/stdin
}
```

### 1.1 MinIO-Root-Credentials (Namespace `minio`)

User/Passwort wählen, beide versiegeln, in `argocd/apps/minio/values.yaml`
einfügen (`rootCreds.encryptedRootUser` / `encryptedRootPassword`):

```bash
printf 'argo'                | seal minio minio-root   # -> encryptedRootUser
printf 'CHANGE-ME-strong-pw' | seal minio minio-root   # -> encryptedRootPassword
```

### 1.2 Argo-Artifact-S3-Zugriff (Namespace `argo-workflows`)

**Dieselben Werte** wie die MinIO-Root-Credentials — einfügen in
`argocd/apps/argo-workflows/values.yaml`
(`artifactSecret.encryptedAccessKey` / `encryptedSecretKey`):

```bash
printf 'argo'                | seal argo-workflows argo-artifacts-s3  # -> encryptedAccessKey
printf 'CHANGE-ME-strong-pw' | seal argo-workflows argo-artifacts-s3  # -> encryptedSecretKey
```

### 1.3 GHCR-Push-Credentials (Namespace `argo-workflows`)

Einen GitHub-PAT mit `write:packages` erstellen, ein Docker-Config-JSON
bauen, dann unter dem Key `.dockerconfigjson` versiegeln. Einfügen in
`ghcrSecret.encryptedDockerConfigJson`:

```bash
GHCR_USER=pke
GHCR_PAT=ghp_xxx           # PAT mit write:packages
AUTH=$(printf '%s:%s' "$GHCR_USER" "$GHCR_PAT" | base64 -w0)
printf '{"auths":{"ghcr.io":{"auth":"%s"}}}' "$AUTH" \
  | seal argo-workflows ghcr-push
```

Wenn Image-Builds noch nicht benötigt werden, stattdessen
`ghcrSecret.enabled: false` setzen.

Nach dem Einfügen aller Werte: committen + pushen. ArgoCD synct innerhalb von
~3 Minuten; der Sealed-Secrets-Controller entschlüsselt die SealedSecrets zu
echten Secrets und die MinIO- + Argo-Pods starten.

---

## 2. Verifizieren

```bash
SSH="ssh -i ~/.ssh/id_ed25519 ubuntu@192.168.178.94"
$SSH 'sudo kubectl -n argocd get application minio argo-workflows'
$SSH 'sudo kubectl -n minio get pods'
$SSH 'sudo kubectl -n argo-workflows get pods'
```

`http://argo-workflows.homeserver` öffnen — die Workflows-UI sollte laden
und die WorkflowTemplates `git-ci` und `kaniko-build-push` auflisten.

---

## 3. Pipelines ausführen

Die `argo`-CLI spricht mit dem Server; sie auf dem Host oder einer beliebigen
Tailnet-Maschine mit `ARGO_SERVER=argo-workflows.homeserver:80` und
`ARGO_HTTP1=true` ausführen, oder einfach über die UI submitten.

### 3.1 Test-/Lint-Job (`git-ci`)

```bash
argo submit -n argo-workflows --from workflowtemplate/git-ci \
  -p repo=https://github.com/PKE-Tech/capulus-core.git \
  -p revision=main \
  -p image=alpine:3.20 \
  -p cmd="ls -la && cat README.md | head"
```

Das Git-Repo wird als Input-Artifact unter `/work` ausgecheckt; Step-Logs
werden nach MinIO archiviert (Bucket `argo-artifacts`). Ein `Succeeded`-Status
mit sichtbaren archivierten Logs bestätigt, dass das Artifact-Repository
korrekt verdrahtet ist.

### 3.2 Image-Build (`kaniko-build-push`)

```bash
argo submit -n argo-workflows --from workflowtemplate/kaniko-build-push \
  -p repo=https://github.com/pke/<repo-mit-Dockerfile>.git \
  -p revision=main \
  -p context=. \
  -p dockerfile=Dockerfile \
  -p image=ghcr.io/pke/<image>:latest
```

Das Image erscheint unter `ghcr.io/pke/...`. ArgoCD kann es dann wie gewohnt
deployen (CD bleibt bei ArgoCD).

### 3.3 Geplante Runs (`CronWorkflow`)

`nightly-home-server-lint` liefert **suspendiert** aus. `cmd` auf einen
echten Lint-Befehl in
`argocd/apps/argo-workflows/templates/cronworkflow.yaml` anpassen, dann
fortsetzen:

```bash
argo cron resume -n argo-workflows nightly-home-server-lint
```

---

## 4. Troubleshooting

- **App hängt in `Progressing` / Pods mit `CreateContainerConfigError`** —
  die SealedSecrets sind noch Platzhalter oder der Controller konnte sie
  nicht entschlüsseln. §1 erneut prüfen, mit `kubectl -n <ns> get secret
  <name>` verifizieren, dass das Secret existiert.
- **`git-ci` läuft erfolgreich durch, aber Logs werden nicht archiviert** —
  die Werte des `argo-artifacts-s3`-Secrets stimmen nicht mit den
  MinIO-Root-Credentials überein, oder MinIO ist nicht erreichbar.
  `kubectl -n minio logs deploy/minio` prüfen und sicherstellen, dass der
  Bucket `argo-artifacts` existiert.
- **Kaniko liefert `UNAUTHORIZED` beim Push nach GHCR** — dem PAT fehlt
  `write:packages` oder das Secret `ghcr-push` ist fehlerhaft. Den
  Auth-String im Docker-Config-JSON verifizieren.
- **CRDs beim ersten Sync nicht gefunden** — die WorkflowTemplate-/
  CronWorkflow-Custom-Resources und die Argo-CRDs landen im selben Sync. Das
  ApplicationSet setzt bereits `SkipDryRunOnMissingResource=true` + Retry,
  sodass es beim nächsten Reconcile konvergiert; keine manuelle Aktion nötig.
- **GHCR vom Cluster aus nicht erreichbar** — abhängig von der
  Egress-Policy. Falls Outbound nach `ghcr.io` blockiert ist, brauchen
  Image-Builds statt dessen eine lokale Registry (separate Änderung: eine
  `registry:2`-App + Containerd-Mirror-Konfiguration in der `k3s`-Rolle).
