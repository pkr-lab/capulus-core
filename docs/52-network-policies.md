# 52 — Cluster-NetworkPolicies (Security-Härtung Phase 3)

Detail-Doku zu Phase 3 aus [docs/51-security-hardening-roadmap.md](51-security-hardening-roadmap.md):
grobe Default-Deny-NetworkPolicy je `security-tier`, damit ein
kompromittierter Pod (z. B. n8n) nicht mehr uneingeschränkt auf
Postgres/Redis/Services in fremden Namespaces zugreifen kann.

**Status: Schritt 1 (grobe Tier-Policy) live seit 13.08.2026.** Rollout
komplett durchgelaufen (Backup, Namespace-Bereinigung, Relabeling, Pilot,
voller Rollout), validiert: alle 36 App-Namespaces tragen
`tier-default-ingress`, ArgoCD zeigt weiterhin 35/36 `Healthy` (`monitoring`
unverändert `Progressing`, siehe [Bekannte Lücken](#bekannte-lücken--nachfolgearbeit)),
HTTP-Stichproben über Traefik (`wiki`, `n8n`, `vaultwarden`, `authentik`,
`nextcloud`, `example-whoami`, `tinyteller`) erfolgreich. `argocd_apply_network_policies: true`
ist jetzt der dauerhafte Default in
[ansible/roles/argocd/defaults/main.yml](../ansible/roles/argocd/defaults/main.yml).
Schritt 2 (Verfeinerung pro Namespace) ist noch nicht begonnen.

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

### Die drei erlaubten Ingress-Quellen je Namespace

Jede Policy (`tier-default-ingress`, eine pro App-Namespace) erlaubt
Ingress auf **alle Pods, alle Ports** aus:

1. **Namespaces mit demselben `security-tier`-Wert** — deckt auch den
   eigenen Namespace ab (der trägt ja ebenfalls sein eigenes Tier-Label),
   Intra-App- (z. B. App → eigene Postgres) und Intra-Tier-Traffic bleibt
   also komplett uneingeschränkt. Cross-Tier-Traffic (Workload →
   Platform-Namespace, Platform → Workload-Namespace) wird geblockt.
2. **`kube-system`** — Traefik (Ingress-Controller) läuft dort und muss
   jeden App-Pod erreichen können, sonst bricht der komplette externe
   Zugriff über `*.homeserver`.
3. **`monitoring`** — VictoriaMetrics' `vmagent` scraped Metriken aus
   jedem Namespace per Pull (Egress von `monitoring` aus) — muss auf der
   Ziel-Namespace-Seite als Ingress erlaubt sein, sonst verschwinden
   Metriken für alle Apps.

Matching läuft über `kubernetes.io/metadata.name` (von Kubernetes seit
1.21 automatisch auf jedem Namespace gesetzt) für `kube-system`/
`monitoring`, und über das manuell gesetzte `security-tier`-Label für die
Tier-Regel.

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
- **Schritt 2 aus docs/51** (feinere Policies pro Namespace statt nur
  pro Tier) ist noch nicht begonnen — diese Doku deckt nur den groben
  Tier-Schnitt ab.
