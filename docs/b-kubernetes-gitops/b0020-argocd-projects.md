# ArgoCD-Projects — ein Projekt je Cluster (tech / prod / entw)

Jeder der drei Cluster hat genau ein ArgoCD-`AppProject` und einen festen Ordner
im Repo. Das Projekt begrenzt, **woher** (nur dieses Repo) und **wohin** (nur die
Namespaces des Clusters) eine Application deployen darf.

| Cluster | Wer synchronisiert | Ordner | Branch | AppProject | ApplicationSet |
|---|---|---|---|---|---|
| **TECH** (`homeserver`, `.94`) | ArgoCD-Hub auf TECH | `argocd/apps/tech/<app>/` | `main` | `tech` | `home-server-apps-tech` |
| **PROD** (`prod-vm`, `.99`) | **derselbe Hub**, PROD ist dort als Cluster `prod` registriert | `argocd/apps/prod/<app>/` | `main` | `prod` | `home-server-apps-prod` + `home-server-apps-prod-charts` |
| **ENTW** (`entw-vm`, `.100`) | eigene, isolierte ArgoCD-Instanz auf ENTW | `argocd/apps/entw/<app>/` | `entw` | `entw` | `home-server-apps-entw` |

Der Hintergrund der Cluster-Aufteilung steht in
[40080](../4-planung/40080-multi-cluster-entw-prod-tech.md), die ENTW-Details in
[b0050](b0050-entw-argocd.md), die Versionsübernahme zwischen den Ordnern in
[f00b0](../f-cicd-automatisierung/f00b0-promotion-chain.md).

> **Historie:** Bis zum 19.09.2026 gab es auf dem einen Cluster zwei Projekte
> (`platform` / `workloads`) mit den Ordnern `argocd/apps/platform/` und
> `argocd/apps/workloads/`. Mit der Multi-Cluster-Umstellung wurden beide zu
> `tech` zusammengelegt; die umgezogenen Apps liegen seitdem unter `prod/`. Die
> Trennung `platform`/`workloads` lebt nur noch in den **Listen**
> `argocd_platform_apps` / `argocd_workloads_apps` weiter (siehe
> [Was die Listen noch steuern](#was-die-listen-noch-steuern)).

---

## Warum Projects

Im ArgoCD-`default`-Project darf jede Application aus jedem Repo in jeden
Namespace deployen. Ein Tippfehler oder ein kompromittierter Commit könnte eine
App dann z. B. in den `monitoring`- oder `pihole`-Namespace schreiben. Die
Projects grenzen das ein:

- **`sourceRepos`**: nur dieses Repo, keine Application kann auf ein fremdes Git-Repo zeigen.
- **`destinations`**: nur die Namespaces, die der Cluster kennt (TECH und PROD als
  ausdrückliche Liste, ENTW mit `*`, siehe unten).
- **`clusterResourceWhitelist` / `namespaceResourceWhitelist`**: **bewusst nicht
  eingeschränkt** (so offen wie das `default`-Project). Mehrere Apps installieren eigene
  CRDs (victoria-metrics-operator, sealed-secrets, cert-manager); Ressourcentypen ohne
  vorherige Beobachtung der echten Nutzung einzuschränken riskiert kaputte Syncs. Das ist
  eine spätere, eigene Verschärfung, kein Versehen.

Wichtig: **Jede App behält ihren eigenen Namespace** (`destination.namespace` = Ordnername,
z. B. `vaultwarden` oder `semaphore`). Es gibt keinen gemeinsamen Namespace pro Tier.

---

## TECH — generiert aus dem Ansible-Template

Das Projekt `tech` und das ApplicationSet `home-server-apps-tech` werden nicht von Hand
gepflegt, sondern aus zwei Vorlagen der `argocd`-Rolle **generiert** und committet:

| Vorlage | Ergebnis (committet) |
|---|---|
| [`bootstrap-applicationset.yaml.j2`](../../ansible/roles/argocd/templates/bootstrap-applicationset.yaml.j2) | [`argocd/bootstrap/root-applicationset.yaml`](../../argocd/bootstrap/root-applicationset.yaml) |
| [`bootstrap-appprojects.yaml.j2`](../../ansible/roles/argocd/templates/bootstrap-appprojects.yaml.j2) | [`argocd/bootstrap/projects.yaml`](../../argocd/bootstrap/projects.yaml) |

Nach jeder Änderung an einer Vorlage oder an den Listen `argocd_platform_apps` /
`argocd_workloads_apps` läuft `make render-bootstrap`; die Kopien in `argocd/bootstrap/`
nie von Hand editieren. Beim nächsten `make argocd` wendet die Rolle **zuerst** die
AppProjects an und **danach** das ApplicationSet, denn eine Application mit einem noch
nicht existierenden Projekt schlägt beim Sync fehl.

Das Hub-ApplicationSet:

- scannt `argocd/apps/tech/*` auf `main` (Git-Directory-Generator), jeder Unterordner wird eine Application;
- Application-Name und Ziel-Namespace = Ordnername;
- deployt in den lokalen Cluster (`https://kubernetes.default.svc`);
- synct automatisch mit `prune`, `selfHeal`, `CreateNamespace`, `ServerSideApply`;
- trägt zentral die `ignoreDifferences` für bekannte Dauerdiffs (HPA-`replicas`, ollama-`replicas`,
  SealedSecret-Status, victoria-metrics-operator-Webhook), jeweils mit Begründung im Kommentar der Vorlage.

Das Projekt `tech` listet als `destinations` die Vereinigung aus `argocd_platform_apps` und
`argocd_workloads_apps` plus die Namespaces `kube-system` (dorthin deployen `traefik-config`
und `coredns-custom`) und `cert-manager` (Cluster-Infrastruktur, bewusst nicht in den Listen).

> **Zwei verworfene Ansätze für das ApplicationSet, damit sie niemand nochmal versucht:**
> 1. *Ein* ApplicationSet mit mehreren Git-Generatoren, die je einen
>    `template.spec.project`-Override tragen. `spec.generators[].template` existiert auf der
>    installierten CRD nicht außerhalb von `matrix`/`merge`-Generatoren, `kubectl apply` wurde mit
>    `unknown field spec.generators[0].template` abgelehnt (strict decoding, kein Teil-Apply).
> 2. *Ein* ApplicationSet, das `spec.project` per Go-Template aus dem Pfad ableitet
>    (`splitList`/`index` auf `.path.path`). Nie gegen den echten Controller verifiziert, nicht das
>    Risiko wert, wenn getrennte ApplicationSets mit festem `project:`-Wert ohne unsichere
>    Templating-Features auskommen.

---

## PROD — handgeschrieben, vom TECH-Hub verwaltet

PROD hat **keine eigene ArgoCD-Instanz**. Die Manifeste liegen in
[`argocd/bootstrap-prod/`](../../argocd/bootstrap-prod/README.md), sind **nicht** generiert und
gehören **nicht** zum `argocd`-Rollenlauf. Sie werden einmalig im TECH-Cluster angewendet, nachdem
der Cluster `prod` im Hub registriert ist (Secret `cluster-prod`, Anleitung im README dort):

```bash
kubectl apply -f argocd/bootstrap-prod/appproject.yaml
kubectl apply -f argocd/bootstrap-prod/applicationset.yaml
```

Das Projekt `prod` erlaubt als Ziel nur den Cluster `prod` und eine feste Namespace-Liste. **Ein
neuer PROD-Namespace muss dort eingetragen werden**, sonst schlägt der Sync mit
`application destination … is not permitted in project 'prod'` fehl.

Es gibt **zwei** ApplicationSets, weil `helm.releaseName` ArgoCD in den Helm-Modus zwingt und bei
Ordnern ohne `Chart.yaml` scheitert:

| ApplicationSet | Findet | Wie |
|---|---|---|
| `home-server-apps-prod` | reine Manifest-Ordner (kein `Chart.yaml`), heute `nas-storage`, `immich-storage`, `traefik-config` | **explizit gelistet**, ein neuer Manifest-Ordner braucht einen `path`-Eintrag |
| `home-server-apps-prod-charts` | jeden Ordner mit `Chart.yaml` unter `argocd/apps/prod/` | automatisch, Helm-Release-Name = Ordnername |

Application-Namen tragen das Präfix **`prod-`** (`prod-nextcloud`, `prod-sealed-secrets`), damit sie
nicht mit den gleichnamigen TECH-Applications kollidieren (beide leben im selben ArgoCD-Namespace
des Hubs). Namespace und Helm-Release heißen dagegen genau wie der Ordner, damit Secrets, PVCs
und namensgebundene SealedSecrets in PROD und TECH gleich heißen.

Ein Ordner mit `Chart.yaml` darf **nicht** zusätzlich im ersten Set gelistet sein (doppelte
Applications).

---

## ENTW — eigene Instanz

Auf ENTW läuft eine eigene ArgoCD-Installation, die mit `argocd_entw_layout: true`
(`host_vars/entw-vm/vars.yml`) ein einziges Projekt `entw` und das ApplicationSet
`home-server-apps-entw` bekommt. Das Projekt erlaubt jeden Namespace, ENTW ist die absichtlich
verwundbare Trainingsumgebung; Schutz kommt aus der Isolation des Clusters. Alles Weitere in
[b0050](b0050-entw-argocd.md).

---

## Eine neue App hinzufügen

| Ziel | Vorgehen |
|---|---|
| **TECH** | Ordner `argocd/apps/tech/<name>/` anlegen (Manifeste, `kustomization.yaml` oder Helm-Chart). Den Namen in `argocd_platform_apps` **oder** `argocd_workloads_apps` (`ansible/roles/argocd/defaults/main.yml`) ergänzen — sonst fehlt der `destinations`-Eintrag im Projekt `tech`. Dann `make render-bootstrap`, committen, per PR nach `main`. |
| **PROD** | Ordner `argocd/apps/prod/<name>/` anlegen. Namespace in `argocd/bootstrap-prod/appproject.yaml` ergänzen und diese Datei per `kubectl apply` im TECH-Hub anwenden. Bei einem reinen Manifest-Ordner zusätzlich den `path` in `argocd/bootstrap-prod/applicationset.yaml` eintragen (und ebenfalls anwenden). Hosts unter `*.prod.homeserver` brauchen außerdem einen Eintrag in `dnsmasq_prod_vm_hosts` (siehe [c0040](../c-netzwerk-dns/c0040-domain-tiers.md#dns-tier-und-cluster-sind-zwei-verschiedene-dinge)). |
| **ENTW** | Ordner `argocd/apps/entw/<name>/` auf dem Branch `entw` anlegen, sonst nichts. Keine Liste, kein Projekt, kein Ansible-Lauf. |

Der komplette Ablauf mit Beispielen: [b0010](b0010-argocd.md#neue-application-hinzufügen).

Ein fehlender Namespace-Eintrag zeigt sich beim Sync so:
`application destination namespace X is not permitted in project Y`. Das ist das Projekt, das wie
vorgesehen einen nicht vorgesehenen Namespace blockiert.

---

## Was die Listen noch steuern

`argocd_platform_apps` und `argocd_workloads_apps` (`ansible/roles/argocd/defaults/main.yml`) sind
weiterhin die **Quelle der Wahrheit für die TECH-Namespaces**. Sie steuern

1. die `destinations` des Projekts `tech` (Vereinigung beider Listen),
2. das Namespace-Label `security-tier=platform` bzw. `security-tier=workload`, das die `argocd`-Rolle
   nach dem ApplicationSet-Apply setzt,
3. daran hängend die Default-Deny-`NetworkPolicy` je Tier
   (siehe [d0030](../d-sicherheit/d0030-network-policies.md); `argocd_apply_network_policies: true`).

`platform` steht dabei für Infrastruktur (Identity, Secrets, Netzwerk, Monitoring, Speicher, CI/CD),
`workloads` für Betriebs- und Anwendungsdienste, die im TECH-Cluster geblieben sind (`n8n`,
`zammad`, `vaultwarden`, `mediamtx`, `alamos-*`, `carplay-api`, …).

> **Hinweis PROD:** Diese Rolle läuft nur gegen den Hub (und gegen ENTW für dessen drei
> Bestands-Namespaces). Für die Namespaces im PROD-Cluster wird dadurch **kein**
> `security-tier`-Label und keine Tier-`NetworkPolicy` gesetzt; PROD-Apps bringen ihre
> NetworkPolicies bei Bedarf selbst mit (Beispiel: `xibosignage`).

---

## Rollout-Hinweis

Gilt bei jeder Änderung am ApplicationSet oder am Ordner-Layout. Umstrukturierungen an den Generator-Pfaden sind riskanter, als sie aussehen:
**ArgoCD liest die Pfade immer von `revision: main`, nicht vom lokal ausgecheckten Branch.**
Wer einen Ordner umbenennt und das ApplicationSet umstellt, lässt ArgoCD sonst alte Pfade als
„gelöscht" werten und **prunen**. Der Vorfall vom 12.08.2026
([d0000](../d-sicherheit/d0000-incident-2026-08-12.md)) ist genau so entstanden.

1. **Erst mergen, dann anwenden.** Die neuen Ordner müssen auf `main` liegen, bevor das neue
   ApplicationSet angewendet wird. Vorher findet der Generator nichts.
2. **Altes und neues ApplicationSet nebeneinander laufen lassen**, bis alle Applications im neuen
   Projekt `Synced`/`Healthy` sind
   (`kubectl get applications -n argocd -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.project}{"\n"}{end}'`).
3. **Erst danach das alte ApplicationSet löschen** (`kubectl -n argocd delete applicationset <alt>`).
4. Wurde die Reihenfolge vertauscht: nicht in Panik geraten. Die von ArgoCD verwalteten Ressourcen
   (Deployments, Services, PVCs) hängen nicht per `ownerReference` an der Application, ein
   kurzzeitig fehlendes Application-Objekt löscht keine laufenden Pods. `make argocd` erneut
   laufen lassen stellt die Applications wieder her.
