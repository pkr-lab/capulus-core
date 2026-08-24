# Prüfung: GitLab (self-hosted) + Proxmox als Hypervisor

Zwei unabhängige Fragen, gemeinsam geprüft, weil beide auf dieselbe knappe
Ressource zielen (RAM/CPU auf `homeserver`, 32 GB, siehe
[docs/a-betriebssystem/a0000-ubuntu-server-install.md](../a-betriebssystem/a0000-ubuntu-server-install.md)):

1. Kann/soll GitLab auf dem Homeserver deployt werden, oder frisst es zu
   viele Ressourcen?
2. Ist Proxmox als Hypervisor mittlerweile sinnvoll (mehrere Cluster,
   Datenbanken vom Cluster getrennt)?

**Ergebnis vorweg:** (1) GitLab CE ist — anders als GitHub — echt
selbst-hostbar (Open Source, kein Enterprise-Lizenzzwang), aber real
ressourcenhungrig: offiziell min. 8 GB RAM, in der Praxis eher 6–8 GB
dauerhaft gebunden. Das ist ein Viertel des gesamten `homeserver`-Budgets
für eine Dauerlast, kein elastischer Worker-Task — technisch machbar,
aber ein spürbarer Eingriff. Wenn nur Git-Hosting + einfache CI gebraucht
wird, ist Forgejo/Gitea (~200–300 MB) die deutlich günstigere Alternative;
GitLab lohnt sich, wenn der volle DevOps-Funktionsumfang (Registry,
eingebaute Pipelines, Security-Scans) wirklich gebraucht wird. (2)
Proxmox ist aktuell **nicht** sinnvoll — die bestehende
Bare-Metal-Architektur (inkl. WoL-Power-Management) verliert mehr an
Einfachheit, als der Hypervisor an Nutzen bringt, solange nur ein Cluster
mit diesem Zuschnitt läuft. Trigger, ab wann sich das ändert, stehen in
Teil 2.

---

## Teil 1: GitLab auf dem Homeserver

### 1.1 GitLab CE ist echt selbst-hostbar — anders als GitHub

Im Unterschied zu GitHub (das nur als kostenpflichtige, überdimensionierte
GitHub-Enterprise-Server-VM-Appliance selbst-hostbar ist) ist **GitLab
Community Edition (CE)** vollwertig Open Source (MIT-lizenziert) und für
Selbst-Hosting gebaut — inklusive Git-Hosting, Merge Requests, Issues,
Wiki, Container-Registry und eingebauten CI/CD-Pipelines. Nur ein Teil
der Zusatzfeatures (erweiterte Security-Scans, Approval-Workflows,
Compliance-Reporting) ist der kostenpflichtigen Enterprise Edition (EE)
vorbehalten — für ein Homelab/Kleinteam-Repo ist CE funktional
vollständig.

Zwei Deployment-Wege stehen zur Wahl:

| | Omnibus (Docker/VM, All-in-one) | Cloud-Native-Helm-Chart |
|---|---|---|
| Aufbau | Ein Container/eine VM bündelt nginx, Puma, Sidekiq, Gitaly, Redis, Postgres | ~15+ getrennte Pods (eigener Postgres-/Redis-Operator, Gitaly, Webservice, Sidekiq, Registry, KAS, …) |
| Für Homelab-Größe | passend — geringerer Overhead | von GitLab selbst für **größere** Installationen empfohlen; bei kleiner Nutzerzahl **mehr** Ressourcenbedarf als Omnibus, nicht weniger |
| Passt zum bestehenden Muster (`argocd/apps/workloads/`)? | als einzelner Helm-Chart mit einem Pod ja | nein — würde ~15 zusätzliche Pods in den ohnehin knappen Cluster bringen |

**Für dieses Setup ist Omnibus die einzig sinnvolle Option** — der
Cloud-Native-Chart ist für diese Cluster-Größe eine Fehlpassung.

### 1.2 Ressourcenbedarf konkret

| | GitLab CE (Omnibus) | Forgejo/Gitea | GitLab CE Cloud-Native-Chart |
|---|---|---|---|
| RAM | offiziell **min. 8 GB** empfohlen (in der Praxis mit reduzierter Puma-/Sidekiq-Worker-Zahl für Ein-Personen-Nutzung auch mit ~6 GB stabil, unter ~4 GB nicht mehr offiziell unterstützt) | ~150–300 MB im Leerlauf | 10+ GB (Summe aller Microservice-Pods) |
| CPU | 4 Cores empfohlen, 2 Cores mit reduzierter Worker-Zahl machbar | 1 Core reicht | mehrere Cores pro Pod-Gruppe |
| Storage | Basis-Installation wenige GB, wächst mit Repos/Registry/CI-Artefakten/Job-Logs | klein, wächst nur mit Repos | wie Omnibus + Overhead je Microservice |
| Datenbank | Postgres + Redis fest mitgeliefert (im selben Container/derselben VM) | SQLite (klein) oder Postgres, optional | eigener Postgres-/Redis-Operator, weitere Pods |
| CI | GitLab CI (eigene YAML-Syntax), GitLab Runner separat (on-demand skalierbar) | Forgejo/Gitea Actions (GitHub-Actions-Workflow-Syntax) | wie Omnibus |
| Läuft dauerhaft oder elastisch? | dauerhaft — Git-Zugriff soll jederzeit verfügbar sein, kein Kandidat für `cluster-power-manager`-Zu-/Abschalten | dauerhaft, aber wegen geringem Fußabdruck kaum spürbar | dauerhaft |

**Wichtig:** Die 8 GB sind kein Peak-Wert, den sich GitLab mit anderen
Apps teilt — Omnibus reserviert das dauerhaft für seine eingebauten
Prozesse (Puma-Worker, Sidekiq-Concurrency, Postgres-Shared-Buffers,
Gitaly), unabhängig davon, ob gerade jemand pusht oder nicht.

### 1.3 Einordnung gegen bestehendes Budget

`homeserver` hat 32 GB RAM insgesamt, und der Cluster ist bereits eng
bemessen — siehe die Immich-OOM-Erfahrung, die erst zur Einführung von
HPAs geführt hat
([docs/b-kubernetes-gitops/b0040-hpa-autoscaling.md](../b-kubernetes-gitops/b0040-hpa-autoscaling.md)).
8 GB dauerhaft für GitLab sind ein Viertel dieses Budgets — spürbar
größer als jede andere App aus `docs/3-apps-workloads/`. Es ist kein
Show-Stopper (die worker-0/1-Kapazität via WoL kann bei Bedarf
dazugeschaltet werden, siehe
[docs/2-betrieb-hardware/20020-cluster-power-manager.md](../2-betrieb-hardware/20020-cluster-power-manager.md)),
aber es verdrängt real anderen Workload, wenn GitLab auf `homeserver`
selbst läuft (das dauerhaft-an-Node, siehe Teil 2.1).

### 1.4 GitLab vs. Forgejo — welcher Zweck rechtfertigt welchen Aufwand

- **Nur Git-Hosting + einfache PR-/Issue-Workflows + leichte CI:**
  Forgejo reicht, GitLab wäre reines Ressourcen-Overkill für den Zweck.
- **Vollständige DevOps-Plattform als Lehrobjekt** (CI/CD-Pipelines,
  Container-Registry, Security-Scanning zum Anfassen) — analog zur
  Pacman-Doppelrolle aus
  [docs/3-apps-workloads/300f0-pacman-visitor-tracking.md](../3-apps-workloads/300f0-pacman-visitor-tracking.md)
  (öffentlicher Betrieb **und** Unterrichtsobjekt): GitLab CE ist hier
  didaktisch reichhaltiger, weil es Pipelines/Registry/Runner-Konzepte in
  einem Tool zeigt statt verteilt über GitHub + Forgejo-Actions. Kostet
  aber real 8 GB dauerhaft.
- **Vereins-IT-Code, der nicht auf github.com liegen soll:** Der
  Funktionsunterschied zu Forgejo ist hier nicht relevant — Forgejo
  deckt das mit einem Bruchteil des Ressourcenbedarfs ab.
- **Ersatz für github.com:** nicht empfohlen — GitHub Actions,
  Renovate-Integration
  ([renovate.json](../../renovate.json)), PR-Review-Tooling sind bereits etabliert; ein
  Wechsel wäre ein Reset ohne erkennbaren Vorteil für ein
  Ein-Personen-/Kleinteam-Repo.

### 1.5 Falls GitLab: konkrete Empfehlungen zur Ressourcen-Eindämmung

- **`gitlab.rb`-Tuning für Kleinbetrieb** statt Default-Werte:
  `puma['worker_processes'] = 0` (Single-Worker-Modus),
  `sidekiq['max_concurrency']` reduzieren, `postgresql['shared_buffers']`
  klein halten, Prometheus-Monitoring in Omnibus deaktivieren
  (`prometheus_monitoring['enable'] = false`) — GitLab selbst
  dokumentiert das als "Reducing memory usage" für kleine Instanzen.
- **`nodeSelector` auf `homeserver`**, analog zur Empfehlung für
  Datenbanken in Teil 2.3 — GitLab bringt seine eigene Postgres/Redis-
  Instanz mit und sollte aus demselben Grund (kein Worker-Drain-Ziel)
  nicht auf worker-0/1 landen.
- **GitLab Runner getrennt betrachten:** Runner können als Job-Pod
  on-demand über `cluster-power-manager` einen Worker aufwecken, statt
  dauerhaft mitzulaufen — hält die 8-GB-Dauerlast auf die
  GitLab-Instanz selbst begrenzt.

**Nächster Schritt, falls gewünscht:** Entscheidung Forgejo vs. GitLab
anhand des tatsächlichen Zwecks (1.4) treffen — das bestimmt, ob 200 MB
oder 8 GB dauerhaft reserviert werden.

---

## Teil 2: Proxmox als Hypervisor

### 2.1 Ist-Zustand

`homeserver`, `worker-0`, `worker-1` sind **drei physische Maschinen**,
bare metal, ohne Hypervisor — Ubuntu Server 26.04 LTS direkt auf der
Hardware, k3s direkt darauf (siehe
[docs/b-kubernetes-gitops/b0000-k3s.md](../b-kubernetes-gitops/b0000-k3s.md)). Das ist eine bewusste
Architekturentscheidung: "ein Ansible-Lauf, keine offenen Ports"
([docs/a-betriebssystem/a0010-overview.md](../a-betriebssystem/a0010-overview.md)).

Zentral für die Bewertung: `cluster-power-manager`
([docs/2-betrieb-hardware/20020-cluster-power-manager.md](../2-betrieb-hardware/20020-cluster-power-manager.md))
schaltet worker-0/1 per **Wake-on-LAN** (Magic Packet) an und per SSH
`poweroff` wieder aus, abhängig von der Last auf `homeserver`. Das
funktioniert, weil es echte, einzeln stromsparende Maschinen sind — eine
VM lässt sich zwar auch an-/ausschalten, aber dann nicht mehr per WoL
über den Netzwerk-NIC, sondern nur noch über die
Proxmox-API/den Proxmox-Host selbst (was den bewusst minimalen,
auf "nur poweroff"-beschränkten SSH-Key-Mechanismus ersetzen würde durch
Proxmox-API-Zugriff mit größerer Rechte-Oberfläche).

### 2.2 Warum aktuell nicht sinnvoll

- **RAM-Overhead schlägt doppelt zu.** Proxmox selbst reserviert RAM für
  Host/ZFS-ARC (üblich: mehrere GB), und VMs binden RAM **statisch**
  (auch mit Ballooning nur bedingt elastisch), während k8s-Pods RAM
  **dynamisch** untereinander teilen. Auf 32 GB, die schon mit
  Control-Plane + Apps eng sind (siehe die Immich-OOM-Erfahrung in
  [docs/b-kubernetes-gitops/b0040-hpa-autoscaling.md](../b-kubernetes-gitops/b0040-hpa-autoscaling.md)),
  ist das ein Rückschritt, kein Gewinn — erst recht, falls zusätzlich
  noch GitLab (8 GB, siehe Teil 1.3) dazukommt.
- **Kein aktueller Bedarf für "mehrere Cluster".** Es gibt genau einen
  Zweck (Homelab-Produktivbetrieb). Mehrere Cluster lohnen sich, wenn
  echte Isolation gebraucht wird — z. B. eine Trainings-/Unterrichts-Umgebung,
  die nichts mit dem Produktiv-Cluster teilen darf (siehe Pacman-Kontext
  in Teil 1.4). Diesen Bedarf gibt es laut aktuellem Stand noch nicht.
- **WoL-Power-Management müsste neu gebaut werden**, s. o. — nicht
  unmöglich, aber ein Umbau eines Systems, das laut
  [docs/2-betrieb-hardware/20020-cluster-power-manager.md](../2-betrieb-hardware/20020-cluster-power-manager.md)
  bereits bewusst minimal und auditierbar gehalten ist.
- **Migrationsrisiko ohne Not.** Alle drei Nodes müssten neu aufgesetzt
  werden (Proxmox drunter, k3s-Nodes als VMs drauf) — bei einem
  Ein-Personen-Homelab ohne Redundanz ist das ein realer
  Downtime-/Datenverlust-Risiko-Faktor für einen Umbau, der aktuell
  keinen messbaren Nutzen hat.

### 2.3 Datenbanken vom Cluster trennen — geht auch ohne Proxmox

Der Wunsch dahinter (Datenbanken nicht dem k8s-Pod-Scheduling/
GitOps-Reschedule/Node-Drain ausliefern) lässt sich günstiger lösen:

- **`nodeSelector`/Taint auf `homeserver` für stateful Workloads.**
  `homeserver` läuft laut `cluster-power-manager` ohnehin dauerhaft —
  DB-Pods (die 5 Workloads mit eigener Postgres/Redis-Instanz laut
  `argocd/apps/workloads/*/values.yaml`, plus GitLab selbst, falls
  umgesetzt) explizit dorthin pinnen schließt aus, dass
  `cluster-power-manager` sie beim Worker-Drain anfasst. Kostet keine
  neue Infrastruktur, nur Values-Änderungen.
- **Dedizierte kleine Bare-Metal-Box** statt Hypervisor, falls "getrennt"
  auch "auf eigener Hardware, nicht im k3s-Scheduler" bedeuten soll —
  ein Raspberry Pi/Mini-PC mit Postgres reicht für die aktuelle
  Datenmenge und bleibt im gleichen bare-metal/Ansible-Muster wie der
  Rest des Repos.

Beide Wege liefern die eigentlich gewünschte Trennung, ohne die
WoL-Architektur anzufassen oder RAM für einen Hypervisor zu reservieren.

### 2.4 Wann Proxmox sinnvoll wird

Proxmox lohnt sich, sobald **mindestens einer** dieser Punkte eintritt:

1. **Echter Bedarf an einem zweiten, isolierten Cluster** — z. B. eine
   Unterrichts-/Trainingsumgebung für die IT-Klasse, die absichtlich
   verwundbar/experimentierbar sein darf, ohne den Produktiv-Cluster zu
   gefährden (Fortführung des Pacman-Musters, aber als komplett
   getrenntes Cluster statt einer Flag innerhalb derselben App).
2. **Neue, dedizierte Hardware kommt dazu** (ein viertes Gerät) statt
   bestehende Nodes umzuwidmen — dann ist das WoL-Argument aus 2.1
   hinfällig, weil die bestehenden drei Nodes bare metal bleiben und nur
   die neue Maschine virtualisiert wird.
3. **RAM-Upgrade auf `homeserver`** auf ≥ 64 GB — dann ist genug Puffer
   für Hypervisor-Overhead + mehrere VMs vorhanden, ohne bestehende
   Workloads zu verdrängen.
4. **VM-Level-Snapshots/Rollback für Datenbanken werden explizit
   gebraucht** (z. B. vor riskanten Migrationen ein komplettes
   VM-Snapshot statt nur PVC-Backup) — aktuell deckt GitOps
   (Re-Apply aus Git) + NAS-Backup
   ([docs/2-betrieb-hardware/20010-nas-backup.md](../2-betrieb-hardware/20010-nas-backup.md)) den
   Bedarf ab.

Solange keiner dieser Punkte zutrifft, ist der Status quo (bare metal +
gezielte Node-Pinning für DBs, siehe 2.3) die einfachere und günstigere
Lösung.

---

## Empfehlung

- **Teil 1 (GitLab vs. Forgejo):** Zweck festlegen (1.4). Reicht
  Git-Hosting + einfache CI, Forgejo als normale Helm-App unter
  `argocd/apps/workloads/` deployen (~200–300 MB, unproblematisch). Wird
  der volle DevOps-Funktionsumfang als Lehrobjekt gebraucht, GitLab CE
  Omnibus mit reduzierter Worker-Konfiguration (1.5) und
  `nodeSelector` auf `homeserver` deployen — dann aber bewusst als
  8-GB-Dauerlast einplanen, nicht als "nebenbei mitlaufende" App.
- **Teil 2 (Proxmox):** aktuell nicht umsetzen. Für die eigentliche
  Motivation (DB-Trennung) stattdessen `nodeSelector` auf `homeserver`
  für die DB-tragenden Workloads (inkl. GitLab, falls gewählt) einplanen
  — deutlich kleinerer Eingriff, gleicher Effekt. Proxmox als Thema in
  [IdeasToDeploy.md](../../IdeasToDeploy.md) oder hier vermerkt lassen und erst bei
  Eintreten eines Triggers aus 2.4 erneut aufgreifen.

## Relevante Links

- [docs/b-kubernetes-gitops/b0000-k3s.md](../b-kubernetes-gitops/b0000-k3s.md) — Cluster-Topologie, StorageClasses
- [docs/2-betrieb-hardware/20020-cluster-power-manager.md](../2-betrieb-hardware/20020-cluster-power-manager.md) — WoL-Power-Management, Grund gegen Proxmox in 2.1–2.2
- [docs/2-betrieb-hardware/20010-nas-backup.md](../2-betrieb-hardware/20010-nas-backup.md) — bestehendes Backup-Konzept als Alternative zu VM-Snapshots
- [docs/b-kubernetes-gitops/b0040-hpa-autoscaling.md](../b-kubernetes-gitops/b0040-hpa-autoscaling.md) — Beleg für bestehenden RAM-Druck (Immich-OOM)
- [docs/3-apps-workloads/300f0-pacman-visitor-tracking.md](../3-apps-workloads/300f0-pacman-visitor-tracking.md) — Muster "Prod + IT-Unterrichtsobjekt", Vorbild für einen möglichen GitLab-/Forgejo-Zweck
- [docs/a-betriebssystem/a0010-overview.md](../a-betriebssystem/a0010-overview.md) — Architekturprinzipien (bare metal, ein Ansible-Lauf)
