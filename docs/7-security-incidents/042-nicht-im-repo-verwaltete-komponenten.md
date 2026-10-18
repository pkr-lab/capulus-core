# 042 Nicht im Repo verwaltete Komponenten: MetalLB, PROD-Namespaces `mealie` und `tinyteller`, ENTW ohne Secrets-Verschlüsselung

- Severity: Info
- Bereich: Repo
- Betroffen: TECH: Namespace `metallb-system` (seit 2026-06-03); PROD: Namespaces `mealie`, `tinyteller`; ENTW: k3s-Konfiguration
- Status: Teilweise behoben am 2026-10-18 (Namespaces gelöscht, ENTW als Testumgebung akzeptiert; MetalLB-Übernahme vorbereitet, Ausführung durch dich)

## Beschreibung

Im laufenden Cluster existieren Bestandteile, die das Repo nicht beschreibt: **MetalLB** (Speaker, FRR-k8s, `statuscleaner`; `hostNetwork`, FRR-Container mit `SYS_ADMIN`, `NET_ADMIN`, `NET_RAW`; IPAddressPool `homelab-pool`) kommt im Repo nur in einem Nebensatz von `d0030-network-policies.md` vor. Auf prod-vm gibt es die Namespaces `mealie` und `tinyteller`, für die es unter `argocd/apps/prod/` keine App gibt (Mealie wurde laut Commit-Verlauf nach PROD migriert, `tinyteller` ist unbekannt). Auf entw-vm ist `secrets-encryption` nicht aktiv (`Disabled, no configuration file found`); die ENTW-Daten sind testweise, die Abweichung zu TECH/PROD ist aber undokumentiert. Dienste ohne Git-Beschreibung entziehen sich Review, Scans und Wiederherstellung.

## Nachweis

```
$ kubectl get ns metallb-system -o jsonpath='{.metadata.creationTimestamp}'
2026-06-03T19:24:42Z
$ git grep -il metallb -- . ':!*.tgz'
docs/d-sicherheit/d0030-network-policies.md
$ ssh prod-vm 'sudo k3s kubectl get ns' | grep -E 'mealie|tinyteller'
mealie  tinyteller
$ ssh entw-vm 'sudo k3s secrets-encrypt status | head -1'
Encryption Status: Disabled, no configuration file found
```

## Risiko / Angriffsszenario

Kein unmittelbares Risiko; unverwaltete Komponenten mit erhöhten Rechten (MetalLB-FRR) und verwaiste Namespaces mit eventuell weiterlaufenden Daten werden nicht gepflegt und fallen bei Wiederherstellung aus dem Cluster-Neuaufbau heraus.

## Empfohlene Behebung

1. MetalLB als App unter `argocd/apps/tech/metallb/` (oder Hub-verwaltetes Helm-Release) aufnehmen und dokumentieren.
2. `mealie` und `tinyteller` auf PROD prüfen: Daten sichern, App ins Repo aufnehmen oder Namespace löschen.
3. ENTW bewusst dokumentieren oder `secrets-encryption` auch dort aktivieren.

## Rollback

Nicht erforderlich.

## Verifikation

`kubectl get ns` und `git ls-files argocd/apps` enthalten dieselben Anwendungen; ArgoCD zeigt MetalLB als verwaltete Anwendung.

## Bearbeitung (2026-10-18)

**Dokumentiert.** Neu: `docs/b-kubernetes-gitops/b0060-metallb.md` mit dem Ist-Zustand von MetalLB (Helm-Release `metallb` 0.16.1 ohne eigene Values, Layer-2-Modus, Pool `192.168.178.200-210`, einzige genutzte Adresse `.200` für Traefik), den beiden Objekten als YAML, dem Neuaufbau und den Auffälligkeiten (FRR-Komponente im L2-Modus ungenutzt, Ursache des offenen Ports `2623` aus Incident 038, hohe Neustartzahlen). Im README-Index eingetragen.

**Geprüft.**

| Punkt | Befund |
|---|---|
| `mealie`, `tinyteller` auf prod-vm | beide Namespaces **leer** (`kubectl get deploy,sts,pods,svc,ingress,pvc,cronjob` liefert „No resources found“); es laufen keine Daten oder Dienste |
| ENTW `secrets-encryption` | `Disabled, no configuration file found` (TECH-Homeserver: `Enabled`, `reencrypt_finished`) |
| MetalLB | wie dokumentiert; kein Eintrag unter `argocd/apps/` |

**Nicht umgesetzt (deine Entscheidung).**

- **ENTW verschlüsseln oder als Testumgebung akzeptieren:** `sudo k3s secrets-encrypt enable` plus Neustart von k3s auf entw-vm (kurze Unterbrechung nur der Testumgebung). Ob die Abweichung bewusst ist, entscheidest du.

**Geänderte Dateien.** `docs/b-kubernetes-gitops/b0060-metallb.md` (neu), `README.md`

## Entscheidungen und Stand (2026-10-18)

- `mealie` und `tinyteller` (leer) hat der Betreiber gelöscht.
- **ENTW ohne `secrets-encryption`:** Testumgebung, **akzeptiert** (kein Produktivdatum, keine echten Zugangsdaten). Änderung nur nötig, wenn ENTW echte Daten bekommt.
- **MetalLB in GitOps:** Chart vorbereitet unter `argocd/pending/metallb-system/` mit abgeschaltetem FRR; Ablauf der Übernahme (Workloads löschen, nicht `helm uninstall`: die CRDs gehören zum Release; `make render-bootstrap`; Verzeichnis nach `argocd/apps/tech/` verschieben) steht in `docs/b-kubernetes-gitops/b0060-metallb.md`. Wegen unveränderlicher Selektoren ist ein direktes Überschreiben nicht möglich. `capulus-ansible/roles/argocd/templates/bootstrap-appprojects.yaml.j2` trägt `metallb-system` schon als festes Ziel ein; das generierte `argocd/bootstrap/projects.yaml` entsteht erst beim Render-Lauf.

