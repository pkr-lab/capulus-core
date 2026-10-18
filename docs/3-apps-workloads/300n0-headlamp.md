# Headlamp — Kubernetes-Dashboard im Browser

Weboberfläche zum Ansehen des TECH-Clusters (Pods, Logs, Events). Die Anmeldung läuft mit einem kurzlebigen Token, das nur Leserechte hat.

> **Cluster:** TECH · Ordner `argocd/apps/tech/headlamp/` · URL `https://headlamp.tech.homeserver`, nur intern. `kubectl`-Befehle in diesem Doc gelten für den TECH-Cluster ([Zugriff je Cluster](../a-betriebssystem/a0010-overview.md#kubectl-zugriff-je-cluster)).

---

## Anmeldung

```bash
./scripts/show-headlamp-token.sh
```

Das Skript erzeugt per `kubectl create token` ein Token für den ServiceAccount `headlamp-viewer` (Rolle `view`, gültig 1 Stunde, Option `--duration`). Das Token in die Anmeldemaske einfügen. Läuft es ab, einfach ein neues erzeugen.

Die Rolle `view` darf keine Secrets lesen und nichts ändern. Änderungen am Cluster laufen über `kubectl` oder GitOps.

---

## Aufbau

| Objekt | Zweck |
|---|---|
| ServiceAccount `headlamp` | Identität des Pods, ohne zusätzliche Rechte (das Subchart legt kein ClusterRoleBinding mehr an) |
| ServiceAccount `headlamp-viewer` + ClusterRoleBinding `headlamp-viewer` | Anmelde-Identität mit der Rolle `view`, ohne dauerhaftes Token |

Hintergründe: [60040](../6-hintergruende/60040-helm-charts-tech.md#headlamp).

---

## Fehlersuche

| Symptom | Prüfen |
|---|---|
| Anmeldung mit dem Token schlägt fehl | Token abgelaufen? Neu erzeugen. `kubectl -n headlamp get sa headlamp-viewer` muss existieren |
| Oberfläche zeigt „Forbidden“ bei Secrets oder beim Bearbeiten | Erwartet, die Rolle `view` erlaubt das nicht |
| Skript meldet `serviceaccounts "headlamp-viewer" not found` | ArgoCD-Sync von `headlamp` abwarten (ca. 80 s nach dem Merge) |
