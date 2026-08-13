# 52 — Cluster-NetworkPolicies (Security-Härtung Phase 3)

Detail-Doku zu Phase 3 aus [docs/51-security-hardening-roadmap.md](51-security-hardening-roadmap.md):
grobe Default-Deny-NetworkPolicy je `security-tier`, damit ein
kompromittierter Pod (z. B. n8n) nicht mehr uneingeschränkt auf
Postgres/Redis/Services in fremden Namespaces zugreifen kann.

**Status (13.08.2026): Fertig.** Schritt 1 + Schritt 2 komplett live, alle
36 App-Namespaces auf die strikte Policy verfeinert (nur eigener Namespace
+ kube-system + monitoring + cloudflared + gezielte Extra-Ausnahmen, keine
pauschale Tier-Erlaubnis mehr). Verifiziert: ArgoCD weiterhin 35/36
`Healthy` (`monitoring` unverändert `Progressing`, vorbestehend),
HTTP-Stichproben lokal (`*.homeserver`) **und** extern über den
Cloudflare-Tunnel (`*.pke-lab.de`) erfolgreich, `cloudflared`-Logs sauber.
`argocd_apply_network_policies: true` ist dauerhafter Default in
[ansible/roles/argocd/defaults/main.yml](../ansible/roles/argocd/defaults/main.yml).

---

## Incident während des Rollouts: Cloudflare-Tunnel-Ausfall

**Was passiert ist:** Die grobe Tier-Policy aus Schritt 1 erlaubt Ingress
nur aus demselben `security-tier` (+ `kube-system` + `monitoring`).
Übersehen: der `cloudflared`-Pod (Namespace `cloudflared`, Tier
`platform`) ruft die Origin-Services für den öffentlichen Tunnel
(`*.pke-lab.de`) per ClusterIP **direkt** an — u. a. `wikijs`, `mealie`,
`vaultwarden`, `nextcloud`, `immich`, `paperless-ngx`, `zammad`
(`argocd/apps/platform/cloudflared/values.yaml`). Das ist Cross-Tier
(platform → workload) und wurde durch die grobe Policy sofort blockiert —
**ab dem Schritt-1-Rollout war der komplette externe Zugriff über den
Cloudflare-Tunnel für diese Apps down**, ohne dass es bei den lokalen
`*.homeserver`-Stichproben auffiel (die laufen über Traefik/`kube-system`,
nicht über `cloudflared`).

**Wie es gefunden wurde:** kein Nutzerreport, sondern ein systematischer
Nachscan (`grep -rn "svc.cluster.local" argocd/apps/`) direkt nach dem
`wiki-docs-sync`-Beinahe-Incident (siehe unten) — aus Vorsicht, um zu
prüfen, ob es noch mehr übersehene Cross-Namespace-Aufrufe gibt. Bestätigt
per `kubectl -n cloudflared logs`: laufende `connection refused`-Fehler
für echte externe Requests (`ip=198.41.192.167` = Cloudflare-Edge).

**Fix:** `cloudflared` als **generelle** Ingress-Ausnahme in jede
Namespace-Policy aufgenommen — genau wie `kube-system`/`monitoring`, weil
es faktisch ein zweiter Ingress-Controller ist. Betrifft beide Varianten
(grob und verfeinert), siehe Template. Verifiziert: letzter Fehler in den
cloudflared-Logs um 17:05:12 Uhr, danach keine weiteren mehr.

**Lektion:** Nach jedem Cross-Tier-Policy-Rollout nicht nur
`*.homeserver` (lokal, über Traefik) testen, sondern auch mindestens
einen externen Pfad über den Cloudflare-Tunnel (`*.pke-lab.de`) — beide
Ingress-Pfade sind unabhängig und ein Ausfall im einen ist im anderen
unsichtbar.

---

## Beinahe-Incident: wiki-docs-sync -> wikijs

Beim Verfeinern von `wikijs` (Schritt 2, Batch 2) übersehen: `wiki-docs-sync`
läuft als CronJob in einem **eigenen** Namespace und ruft `wikijs` per
ClusterIP direkt an (nicht über Traefik) — siehe
[Schritt 2](#schritt-2--verfeinerung-pro-namespace) unten für Details.
Rechtzeitig gefunden und gefixt, bevor der nächste `*/15min`-Lauf
scheiterte (manueller Testlauf danach: `Complete`, Sync erfolgreich).
Direkter Auslöser für den systematischen Cloudflared-Scan oben und für
den generalisierten `argocd_network_policy_extra_ingress`-Mechanismus.

---

## Vorfund beim Start dieser Phase

Bevor die Policies gebaut wurden, zwei Abweichungen vom in docs/51
angenommenen Zustand aufgefallen (Stand 13.08.2026):

1. **Die `security-tier`-Labels aus Phase 2 fehlten komplett** auf allen
   Namespaces (`kubectl get ns -L security-tier` zeigte nichts) — vermutlich
   durch den ApplicationSet-Incident verloren gegangen
   ([docs/50](50-incident-2026-08-12.md)): Namespaces wurden neu angelegt,
   das Label wird aber nur vom Ansible-`argocd`-Role-Lauf gesetzt, nicht von
   ArgoCD selbst nachgezogen. Ein erneuter `make argocd`-Lauf setzt sie
   wieder (idempotenter Task, bereits vorhanden).
2. **Namespaces außerhalb der beiden Tier-Listen gefunden:**
   - `cert-manager`, `metallb-system` — laufen aktiv, sind aber nie unter
     GitOps (`argocd/apps/platform/`) gewandert. Bleiben vorerst
     Cluster-Infrastruktur außerhalb der Tier-Policies (siehe unten,
     [Ausgeschlossene Namespaces](#ausgeschlossene-namespaces)) —
     Nachziehen unter GitOps ist ein separates Aufräum-Ticket, nicht Teil
     dieser Phase.
   - `cloudflare-tunnel` (CrashLoopBackOff, 10146 Restarts über 59 Tage,
     totes Leftover neben dem aktiven `cloudflared`-Namespace) sowie sechs
     leere Namespaces ohne laufende Pods (`glance`, `grocy`, `homepage`,
     `jellyfin`, `le-homeserver`, `paperless-ai`) — auf Nutzerentscheid
     gelöscht, siehe [Rollout](#rollout).

---

## Design

### Warum Ingress-only, kein Egress

Ziel ist, **laterale Bewegung zwischen Tiers zu blockieren**: ein
kompromittierter Pod in Namespace A soll Postgres/Redis in einem
fremden-Tier-Namespace B nicht erreichen können. Das lässt sich
vollständig über B's **Ingress**-Regel erzwingen — A's ausgehende
Verbindung wird an B's Namespace-Grenze abgewiesen, ganz ohne A's Egress
einzuschränken.

Egress-Policies zusätzlich einzuführen hätte ein deutlich höheres Risiko
(DNS zu `kube-system`, Internet-Zugriff für n8n/cloudflared/Renovate,
OIDC-Callbacks, NAS/NFS ist Host-Level und unbetroffen) für **keinen**
zusätzlichen Sicherheitsgewinn in diesem groben ersten Schritt — deshalb
bewusst nicht Teil dieser Iteration. Das ist auch, warum der in docs/51
genannte "klassische Fehler: fehlender DNS-Allow" hier strukturell nicht
auftreten kann: DNS-Auflösung ist ein Egress-Vorgang (Pod fragt CoreDNS),
und Egress bleibt vollständig unangetastet.

### Die erlaubten Ingress-Quellen je Namespace

Jede Policy (`tier-default-ingress`, eine pro App-Namespace) erlaubt
Ingress auf **alle Pods, alle Ports** aus:

1. **Namespaces mit demselben `security-tier`-Wert** (grobe Variante) bzw.
   **nur der eigene Namespace** (verfeinerte Variante, Schritt 2) — deckt
   Intra-App-Traffic ab (z. B. App → eigene Postgres). Cross-Tier-Traffic
   wird geblockt (grob), bzw. jeder fremde Namespace (verfeinert).
2. **`kube-system`** — Traefik (Ingress-Controller) läuft dort und muss
   jeden App-Pod erreichen können, sonst bricht der komplette externe
   Zugriff über `*.homeserver`.
3. **`monitoring`** — VictoriaMetrics' `vmagent` scraped Metriken aus
   jedem Namespace per Pull (Egress von `monitoring` aus) — muss auf der
   Ziel-Namespace-Seite als Ingress erlaubt sein, sonst verschwinden
   Metriken für alle Apps.
4. **`cloudflared`** — faktisch ein zweiter Ingress-Controller für den
   öffentlichen `*.pke-lab.de`-Zugriff, ruft Origin-Services ebenfalls per
   ClusterIP direkt an. **Nachträglich ergänzt** nach einem Incident
   während des Rollouts (siehe [Incident-Abschnitt](#incident-während-des-rollouts-cloudflare-tunnel-ausfall)
   oben) — ursprünglich übersehen, weil es beim lokalen `*.homeserver`-Test
   nicht auffällt.
5. **Gezielte Zusatz-Namespaces aus `argocd_network_policy_extra_ingress`**
   — für einzelne, im Repo gefundene legitime Cross-Namespace-Aufrufe
   (CronJobs, Workflows), die nicht unter 1–4 fallen.

Matching läuft über `kubernetes.io/metadata.name` (von Kubernetes seit
1.21 automatisch auf jedem Namespace gesetzt) für alle Namespace-genauen
Ausnahmen (2–5), und über das manuell gesetzte `security-tier`-Label nur
für die grobe Tier-Regel (1).

### Ausgeschlossene Namespaces

Nur Namespaces aus `argocd_platform_apps`/`argocd_workloads_apps`
([ansible/roles/argocd/defaults/main.yml](../ansible/roles/argocd/defaults/main.yml))
bekommen eine Policy. Bewusst **keine** Policy für: `kube-system`,
`argocd`, `cert-manager`, `metallb-system` — das sind Cluster-Grundlagen,
keine "Apps" im Tier-Sinn, und ein zu aggressiv geschnittener Ingress-Deny
dort könnte den ganzen Cluster lahmlegen statt nur eine App.

### Voraussetzung für Enforcement: k3s-Netzwerkrichtlinien-Controller

Verifiziert (13.08., `journalctl -u k3s`): k3s bringt den kube-router-
basierten Network-Policy-Controller **standardmäßig aktiv** mit (kein
`--disable-network-policy` in der Ansible-Config gesetzt) — Standard-
`NetworkPolicy`-Objekte werden also tatsächlich durchgesetzt, nicht nur
als No-Op-API-Objekte abgelegt wie es bei purem Flannel ohne diesen
Controller der Fall wäre.

---

## Rollout

**1. Backup vorher (kompletter Cluster-Datastore):**

```bash
# Läuft auf dem Control-Plane-Node (homeserver, 192.168.178.94), NICHT lokal —
# per SSH von der Workstation aus anstoßen:
ssh ubuntu@192.168.178.94 "sudo cp /var/lib/rancher/k3s/server/db/state.db /var/lib/rancher/k3s/server/db/state.db.pre-phase3-\$(date +%Y%m%d)"
```

Zusätzlich prüfen, dass der letzte nächtliche NAS/PVC-restic-Backup
([docs/36](36-nas-backup.md)) erfolgreich war (UGOS Task Scheduler → letzter
Lauf).

**2. Leftover-Namespaces löschen** (siehe [Vorfund](#vorfund-beim-start-dieser-phase)
— keine PVCs/Secrets mit Nutzdaten drin, keine ArgoCD-Application zeigt
darauf, gefahrlos):

```bash
kubectl delete namespace cloudflare-tunnel glance grocy homepage jellyfin le-homeserver paperless-ai
```

**3. `security-tier`-Labels neu setzen** (idempotenter Task, bereits im
`argocd`-Role vorhanden):

```bash
make argocd
kubectl get ns -L security-tier   # Kontrolle: alle 36 App-Namespaces müssen jetzt ein Tier zeigen
```

**4. Pilot auf zwei unkritischen Namespaces**, statt direkt alle 36 auf
einmal (Empfehlung aus docs/51, hier einen Schritt früher angewendet als
dort für Phase-3-Schritt-2 vorgesehen, aus Vorsicht):

```bash
# Policy nur für example-whoami und tinyteller einzeln erzeugen und anwenden:
for ns in example-whoami tinyteller; do
  kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: tier-default-ingress
  namespace: $ns
spec:
  podSelector: {}
  policyTypes: ["Ingress"]
  ingress:
    - from: [{namespaceSelector: {matchLabels: {security-tier: workload}}}]
    - from: [{namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}}]
    - from: [{namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: monitoring}}}]
EOF
done
```

**Validieren:** `https://whoami.homeserver` und `https://tinyteller.homeserver`
im Browser laden (Traefik-Zugriff über kube-system funktioniert noch?),
Grafana-Dashboard "Home Server Auslastung" prüfen, ob für beide Namespaces
weiterhin Metriken reinkommen (monitoring-Zugriff funktioniert noch?).

**5. Rollback-Kommando** falls Schritt 4 etwas kaputt macht:

```bash
kubectl delete networkpolicy tier-default-ingress -n example-whoami -n tinyteller
```

**6. Vollständiger Rollout**, erst nachdem Schritt 4 sauber verifiziert ist:

```bash
# make argocd reicht keine Extra-Vars durch, deshalb direkt ansible-playbook
# aufrufen (Inventory/Playbook-Pfade wie im Makefile-Target `argocd`):
ansible-playbook -i ansible/inventory/hosts.yml ansible/site.yml --tags argocd \
  --ask-vault-pass -e argocd_apply_network_policies=true
```

Danach `argocd_apply_network_policies: true` auch dauerhaft in
[ansible/roles/argocd/defaults/main.yml](../ansible/roles/argocd/defaults/main.yml)
setzen (committen), sonst rollt der nächste normale `make argocd`-Lauf die
Policies beim Re-Templaten wieder auf `false` zurück — genauer: er wendet
sie schlicht nicht mehr erneut an (bereits angewendete Policies bleiben im
Cluster bestehen, `-e` überschreibt nur diesen einen Lauf).

**7. Validieren (nach jeder Phase, wie gefordert):**

```bash
kubectl get applications -n argocd -o custom-columns='NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status'
kubectl get networkpolicy -A
```

Alle Apps weiterhin `Synced`/`Healthy`? Stichprobenhaft 3–4 Apps aus
unterschiedlichen Tiers im Browser aufrufen (mind. eine Platform-App wie
Authentik/Grafana, mind. zwei Workload-Apps). Grafana-Dashboard auf
lückenlose Metriken prüfen (ein plötzliches Metrik-Loch bei einer
bestimmten App = deren `monitoring`-Ingress-Regel greift nicht).
**Zusätzlich, seit dem Cloudflared-Incident (siehe oben) Pflicht:**
mindestens einen `*.pke-lab.de`-Pfad extern über den Cloudflare-Tunnel
testen, nicht nur `*.homeserver` lokal über Traefik — beide Ingress-Pfade
sind unabhängig.

**8. Rollback (voller Rollout)** falls nötig:

```bash
# Alle tier-default-ingress Policies wieder entfernen:
kubectl get networkpolicy -A -o json | \
  jq -r '.items[] | select(.metadata.name=="tier-default-ingress") | "\(.metadata.namespace) \(.metadata.name)"' | \
  while read -r ns name; do kubectl delete networkpolicy "$name" -n "$ns"; done
# Oder in defaults/main.yml wieder auf false setzen + make argocd erneut laufen lassen
# (entfernt bestehende Policies dabei NICHT automatisch, nur der obige Loop tut das).
```

---

## Schritt 2 — Verfeinerung pro Namespace

Ersetzt für einzelne, explizit freigegebene Namespaces die grobe
Tier-Regel (Ingress aus jedem Namespace desselben Tiers erlaubt) durch
eine strikte Regel (Ingress nur aus dem **eigenen** Namespace + weiterhin
`kube-system` + `monitoring`). Das schließt die eigentliche Lücke, die
Schritt 1 noch offen lässt: zwei Apps im selben Tier (z. B. zwei
Workload-Apps) konnten sich unter Schritt 1 immer noch gegenseitig
erreichen.

Gesteuert über eine einzige Liste,
[`argocd_network_policy_refined_namespaces`](../ansible/roles/argocd/defaults/main.yml) —
ein Namespace-Name in dieser Liste bekommt die strikte Variante, alle
anderen bleiben auf der groben Tier-Regel aus Schritt 1. So lässt sich
Namespace für Namespace migrieren, ohne die anderen 34 anzufassen —
`kubectl apply` ist idempotent, ein Re-Run des `argocd`-Roles ändert nur
die Policy-Objekte, deren Inhalt sich tatsächlich geändert hat.

**Reihenfolge** (aus docs/51): unkritische Apps zuerst, dann Apps mit
eigener DB, zuletzt Plattform-Namespaces.

**Batch 1 (13.08.2026, verifiziert):** `example-whoami`, `tinyteller` —
beide zustandslose Demo-Apps ohne Abhängigkeiten zu anderen Namespaces,
ideal zur Musterverifikation. HTTP-Check nach Rollout: beide `200`,
`podSelector: {}` in der Policy bestätigt, ArgoCD weiterhin `Healthy`.

**Batch 2 (13.08.2026, Rollout aussehend):** `wikijs`, `mealie`, `n8n` —
Apps mit eigener DB/eigenem State, komplett im selben Namespace (Postgres
bei wikijs, In-Pod-SQLite bei mealie/n8n), keine Cross-Namespace-
Abhängigkeit für den Normalbetrieb.

> **Beinahe-Incident während des Batch-2-Rollouts:** `wiki-docs-sync`
> läuft als CronJob (`*/15 * * * *`) in seinem **eigenen** Namespace und
> ruft `wikijs` per ClusterIP direkt an
> (`http://wikijs.wikijs.svc.cluster.local`, siehe
> `argocd/apps/workloads/wiki-docs-sync/values.yaml`) — nicht über
> Traefik. Das wurde beim ersten `wikijs`-Refinement übersehen (nur die
> Pods **innerhalb** von `wikijs` wurden auf Selbstständigkeit geprüft,
> nicht wer **von außen** reinruft). Der nächste Cron-Lauf nach dem
> Rollout wäre damit fehlgeschlagen. Gefixt, bevor er lief: neuer
> Mechanismus `argocd_network_policy_extra_ingress` (Template + defaults,
> siehe [ansible/roles/argocd/defaults/main.yml](../ansible/roles/argocd/defaults/main.yml))
> für gezielte Zusatz-Ausnahmen bei verfeinerten Namespaces — `wikijs`
> erlaubt jetzt explizit zusätzlich Ingress aus `wiki-docs-sync`.
>
> **Lektion für die restlichen Batches:** vor jeder Verfeinerung nicht nur
> prüfen, wer im Ziel-Namespace selbst läuft, sondern per
> `grep -rn "svc.cluster.local\|\.{{ '{{' }} .Release.Namespace" argocd/apps/`
> (oder gezielt nach dem Namespace-Namen) nach **eingehenden**
> Cross-Namespace-Referenzen aus anderen App-Ordnern suchen — CronJobs in
> fremden Namespaces sind der unauffälligste Fall, weil sie nicht wie ein
> Ingress/Traefik-Pfad sofort auffallen.

> **Proaktiv mitgefixt (derselbe Nachscan wie beim Cloudflared-Incident):**
> Der systematische `grep -rn "svc.cluster.local" argocd/apps/` nach dem
> `wiki-docs-sync`-Fund brachte drei weitere Cross-Tier-Aufrufe zutage, die
> von der groben Policy auf `ntfy`/`monitoring` blockiert würden:
> `carplay-api` → `ntfy` und → `monitoring` (Push-Benachrichtigungen bzw.
> VictoriaMetrics-Abfrage, beide aktiv genutzt, aber nur bedarfsgesteuert —
> daher in den bisherigen Logs nicht als Fehler sichtbar), `alamos-apager`
> → `ntfy` (Alarm-Benachrichtigung), und der bereits erwähnte n8n-Workflow
> → `monitoring` (aktuell `"active": false`). Statt abzuwarten, ob eines
> davon im Ernstfall lautlos fehlschlägt (genau das Muster, das beim
> Cloudflare-Tunnel schon passiert war), alle vier direkt über
> `argocd_network_policy_extra_ingress` freigegeben — der Mechanismus
> wurde dafür generalisiert: Zusatz-Ausnahmen wirken jetzt auch bei noch
> nicht verfeinerten (groben) Ziel-Namespaces, nicht nur bei bereits
> verfeinerten.

**Rollout für die beiden Piloten:**

```bash
# 1. Backup (wie bei jeder Phase/jedem Schritt) — Vortag bereits gemacht,
#    trotzdem ein frischer Snapshot vor der nächsten Cluster-Änderung:
ssh ubuntu@192.168.178.94 "sudo cp /var/lib/rancher/k3s/server/db/state.db /var/lib/rancher/k3s/server/db/state.db.pre-phase3-step2-\$(date +%Y%m%d)"

# 2. Anwenden (argocd_apply_network_policies ist schon dauerhaft true,
#    kein -e mehr nötig — Neu-Rendern reicht):
make argocd

# 3. Validieren
kubectl get networkpolicy -n example-whoami -n tinyteller -o yaml | grep -A3 "ingress:"
curl -sk -o /dev/null -w "whoami: %{http_code}\n" https://whoami.homeserver/
curl -sk -o /dev/null -w "tinyteller: %{http_code}\n" https://tinyteller.homeserver/
kubectl get applications -n argocd example-whoami tinyteller -o custom-columns='NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status'
```

**Rollback** (nur für diese beiden, falls etwas bricht): den jeweiligen
Namespace wieder aus `argocd_network_policy_refined_namespaces` entfernen
und `make argocd` erneut laufen lassen — die Policy fällt zurück auf die
grobe Tier-Regel.

**Batch 3 (13.08.2026):** alle restlichen 12 Workload-Namespaces
(`alamos-apager`, `carplay-api`, `github-release-watcher`, `immich`,
`mediamtx`, `nextcloud`, `paperless-ngx`, `uptime-kuma`, `vaultwarden`,
`wiki-docs-sync`, `xibosignage`, `zammad`) in einem Rutsch — nicht
schrittweise einzeln, weil vorher per systematischem Repo-Scan
(`grep -rln "\.<ns>\.svc\|<ns>\.svc\.cluster" argocd/apps/`, für jeden
Namespace einzeln) bereits geprüft war, dass keine eingehenden
Cross-Namespace-Aufrufe existieren außer den ohnehin generell erlaubten
(`cloudflared`) und einem einzigen Fall: `carplay-api` fragt `uptime-kuma`
per ClusterIP ab (workload→workload, war unter der groben Policy schon
durch Intra-Tier gedeckt, braucht jetzt eine explizite
`argocd_network_policy_extra_ingress`-Ausnahme). Damit sind **alle 17
Workload-Namespaces verfeinert** — übrig bleiben nur noch die 19
Plattform-Namespaces als letzter Batch.

**Batch 4 (13.08.2026): alle 19 Plattform-Namespaces — letzter Batch.**
Damit sind **alle 36 App-Namespaces verfeinert**, Schritt 2 ist komplett.
`coredns-custom`/`traefik-config` haben keine eigenen Pods (deployen nach
`kube-system`, siehe docs/49) — Policy dort ist ein wirkungsloses No-Op,
der Vollständigkeit halber trotzdem gesetzt.

Gefundene Platform-zu-Platform-Abhängigkeiten (alle bislang durch
Intra-Tier stillschweigend erlaubt, jetzt durch je eine gezielte
`argocd_network_policy_extra_ingress`-Ausnahme ersetzt):

| Ziel | Erlaubt zusätzlich aus | Grund |
|---|---|---|
| `authentik` | `semaphore`, `minio`, `gotify` | ExternalName-Services bzw. OIDC-Discovery, siehe jeweiliges `values.yaml`/`templates/authentik-svc.yaml` |
| `gotify` | `gotify-bridge` | `gotify-bridge/values.yaml` |
| `gotify-bridge` | `monitoring` | vmalertmanager-Webhook |
| `ntfy-bridge` | `monitoring` | vmalertmanager-Webhook |
| `ntfy` | (+ `ntfy-bridge`, zusätzlich zu `carplay-api`/`alamos-apager` aus Batch 3) | `ntfy-bridge/values.yaml` |
| `minio` | `argo-workflows` | Artifact-Storage-Endpoint in `argo-workflows/values.yaml` |
| `monitoring` | (+ `argo-workflows`, zusätzlich zu `carplay-api`/`n8n` aus Batch 3) | Alertmanager-URL in `maintenance-workflowtemplate.yaml` |

Alle per `grep -rln "\.<ns>\.svc\|<ns>\.svc\.cluster" argocd/apps/`
gefunden, kein Fall wurde durch Logs/Beobachtung entdeckt — nach dem
Cloudflared-Incident bewusst vollständig statisch durchsucht statt
abgewartet.

---

## Bekannte Lücken / Nachfolgearbeit

- **cert-manager, metallb-system** noch nicht unter GitOps — separates
  Aufräum-Ticket, nicht Teil dieser Phase. Solange sie außerhalb bleiben,
  sind sie auch außerhalb jeder NetworkPolicy — kein Sicherheitsrisiko
  (sie sind Infrastruktur ohne Nutzdaten), aber ein blinder Fleck für
  künftige, feinere Policies.
- **Egress bleibt komplett offen** — bewusste Entscheidung dieser
  Iteration, siehe [Design](#warum-ingress-only-kein-egress). Falls später
  gewünscht (z. B. um n8n explizit am Erreichen interner Postgres-Ports zu
  hindern statt nur andersrum), eigene, separate Folge-Iteration.
- **Schritt 2 ist abgeschlossen** (alle 36 Namespaces verfeinert, siehe
  oben) — bleibt aber laufende Pflege: eine künftige neue App mit einem
  echten Cross-Namespace-ClusterIP-Aufruf braucht denselben
  `argocd_network_policy_extra_ingress`-Mechanismus, sonst bricht sie beim
  ersten `make argocd`-Lauf lautlos, wie beim Cloudflared-Incident.
