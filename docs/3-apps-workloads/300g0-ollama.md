# Ollama — lokales LLM, nur bei Bedarf hochgefahren

Ollama stellt ein lokal gehostetes LLM (`llama3.1:8b`, Q4-quantisiert) über
eine einfache HTTP-API bereit. Genutzt wird es aktuell ausschließlich vom
n8n-Workflow **„Zammad Externer KI-Lauf (täglich)“**
(siehe [30070-n8n.md](30070-n8n.md)), um Antwortentwürfe für Tickets in der
externen Zammad-Instanz `https://ticket.emue365.de` zu erzeugen.

---

## Architektur: Scale-to-Zero statt Dauerbetrieb

```
n8n (taeglich, 07:00 Uhr)
  1. POST carplay-api.prod.homeserver/api/power/wake  {"target":"worker-0"}
       -> weckt den Lenovo M90q per Wake-on-LAN
  2. PATCH kubernetes.default.svc/.../deployments/ollama/scale {"spec":{"replicas":1}}
       -> Ollama-Pod startet auf worker-0
  3. Wait (~150s)
  4. Sub-Workflow "Zammad Tickets verarbeiten"
       -> pro Ticket: POST ollama.ollama.svc.cluster.local:11434/api/generate
  5. PATCH .../deployments/ollama/scale {"spec":{"replicas":0}}
       -> Ollama-Pod wird wieder heruntergefahren
```

Das Deployment läuft **mit `replicas: 0` im Ruhezustand** — kein
dauerhafter Footprint, weder auf dem 24/7-Node (`homeserver`) noch auf
einem der WoL-Worker. Weder `homeserver` noch `worker-0` müssen also
dauerhaft Kapazität für ein LLM reservieren.

**Warum nicht der bestehende `cluster_power_manager`?** Der weckt Worker
nur reaktiv anhand der CPU/RAM-Last auf `homeserver`
(siehe [20020-cluster-power-manager.md](../2-betrieb-hardware/20020-cluster-power-manager.md))
— er beobachtet keine Pending-Pods. Ein an `worker-0` gepinnter Pod mit
`replicas: 1` würde also einfach `Pending` bleiben, bis zufällig genug
Last auf `homeserver` entsteht. Deshalb weckt der n8n-Workflow `worker-0`
**explizit** über den bereits vorhandenen `power-agent`-Endpoint (siehe
[300d0-carplay-api.md](300d0-carplay-api.md#power-agent)), bevor er
hochskaliert.

**Warum `replicas: 0` statt eines dauerhaft laufenden Pods mit
`OLLAMA_KEEP_ALIVE`?** Ausdrücklicher Wunsch: der Pod soll nur für die
Dauer des täglichen Laufs existieren, nicht nur das Modell zwischen
Anfragen aus dem RAM entladen.

---

## ArgoCD & Scale-Konflikt

ArgoCDs `selfHeal` würde das Deployment bei jedem Sync auf den in Git
hinterlegten Wert (`replicas: 0`) zurücksetzen — auch **während** n8n es
gerade auf 1 hochskaliert hat, für die Dauer eines laufenden KI-Laufs. Das
Deployment `ollama` ist deshalb in
`argocd/bootstrap/root-applicationset.yaml` (und im Quelltemplate
`ansible/roles/argocd/templates/bootstrap-applicationset.yaml.j2`) explizit
per `ignoreDifferences` auf `/spec/replicas` von der Sync-Prüfung
ausgenommen — analog zum bereits bestehenden Muster für die
HPA-gesteuerten `zammad-railsserver`/`zammad-nginx`-Deployments.

---

## RBAC: n8n darf NUR dieses eine Deployment skalieren

`argocd/apps/workloads/ollama/templates/role-n8n-scaler.yaml` gibt der
n8n-ServiceAccount (Namespace `n8n`) eine `Role` im Namespace `ollama`,
beschränkt auf:

```yaml
apiGroups: ["apps"]
resources: ["deployments/scale"]
resourceNames: ["ollama"]
verbs: ["get", "patch"]
```

Kein sonstiger Cluster-Zugriff. n8n authentifiziert sich dafür mit seinem
eigenen, automatisch gemounteten ServiceAccount-Token
(`/var/run/secrets/kubernetes.io/serviceaccount/token`, im Workflow per
Code-Node ausgelesen) direkt gegen `https://kubernetes.default.svc` — kein
zusätzliches Secret nötig.

---

## Netzwerk-Isolation

Ollama darf **weder ins Internet noch zu anderen Systemen** im Cluster
verbinden können — nur der n8n-Workflow darf es über Port 11434
ansprechen. Zwei `NetworkPolicy`-Ressourcen setzen das um:

- **`networkpolicy-default-deny.yaml`** — verbietet standardmäßig ALLES
  (Ingress UND Egress) im `ollama`-Namespace.
- **`networkpolicy-allow-n8n-ingress.yaml`** — einzige Ausnahme: die
  n8n-Pods (Namespace `n8n`, Label `app.kubernetes.io/name: n8n`) dürfen
  Port 11434 erreichen.

**Egress bleibt bewusst ohne jede Ausnahme.** Im Normalbetrieb (nur
HTTP-Antworten auf eingehende Anfragen) braucht Ollama weder DNS noch
sonstige ausgehende Verbindungen — "kein Internet, keine anderen Systeme"
ist damit die dauerhafte, in Git verankerte Grundeinstellung, nicht nur
eine Momentaufnahme.

**Wichtig — `ollama` muss von der generischen `tier-default-ingress`-Policy
ausgeschlossen sein** (`argocd_network_policy_excluded_apps` in
`ansible/roles/argocd/defaults/main.yml`, ausgewertet in
`ansible/roles/argocd/templates/bootstrap-networkpolicies.yaml.j2`). Ohne
diesen Ausschluss würde jeder Workload-Namespace automatisch zusätzlich
eine `tier-default-ingress`-Policy bekommen, die u. a. `kube-system`,
`monitoring` und `cloudflared` (und je nach Verfeinerungsstufe den ganzen
Workload-Tier) als Ingress-Quelle erlaubt — NetworkPolicy-Ingress-Regeln
mehrerer Policies auf denselben Pod werden per Union kombiniert, sodass
diese generische Regel die absichtlich enge "nur n8n"-Policy oben wieder
aufweichen würde. Gefunden und gefixt am 19.08.2026 beim ersten
tatsächlichen Rollout — `ollama` fehlte zunächst sowohl in
`argocd_workloads_apps` (AppProject-Destination, ArgoCD-Sync schlug mit
`InvalidSpecError` fehl) als auch in dieser Ausschlussliste.

> **Ob NetworkPolicy auf diesem Cluster tatsächlich durchgesetzt wird, ist
> nicht verifiziert.** k3s läuft mit Standard-Flannel + dem seit v1.21
> mitgelieferten, separaten kube-router-basierten NetworkPolicy-Controller
> (aktiv, sofern nicht per `--disable-network-policy` deaktiviert — hier
> nicht der Fall) — Flannel selbst setzt NetworkPolicy NICHT durch, der
> k3s-Controller schon. Im Repo gibt es aber noch keine einzige andere
> NetworkPolicy als Präzedenzfall. **Vor dem produktiven Einsatz zwingend
> empirisch testen** (siehe Verifikation unten) statt der Policy blind zu
> vertrauen. Zeigt der Test, dass sie nicht greift, ist das ein größerer,
> separater Architektur-Entscheid (CNI-Wechsel betrifft den gesamten
> Cluster) — kein Punkt, der hier nebenbei mitgelöst wird.

### Modell-Pull braucht eine bewusste, temporäre Ausnahme

`ollama pull` lädt vom Internet — mit Default-Deny-Egress geht das nicht
mehr automatisch. Deshalb für den (seltenen, manuellen) Pull-Vorgang kurz
eine temporäre Policy setzen und danach sofort wieder entfernen — diese
landet NIE im Git-Stand:

```bash
kubectl -n ollama apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ollama-temp-allow-egress-internet
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - {}
EOF

kubectl -n ollama exec deploy/ollama -- ollama pull llama3.1:8b

# Danach SOFORT wieder entfernen:
kubectl -n ollama delete networkpolicy ollama-temp-allow-egress-internet
```

---

## Ersteinrichtung

1. **Node-Kapazität prüfen**: `kubectl describe node worker-0` — die
   Resource-Requests/Limits in `values.yaml` sind ein Startwert, im Repo
   sind für den Lenovo M90q keine exakten CPU/RAM-Werte dokumentiert.
2. **Modell ziehen** (einmalig, Pod dafür kurz manuell hochskalieren, PLUS
   die temporäre Egress-Ausnahme aus dem Abschnitt „Netzwerk-Isolation“
   oben):
   ```bash
   kubectl -n ollama scale deploy/ollama --replicas=1
   # warten bis der Pod Ready ist, dann die temporaere Egress-Policy
   # anwenden (siehe oben), pullen, Policy wieder loeschen:
   kubectl -n ollama exec deploy/ollama -- ollama pull llama3.1:8b
   kubectl -n ollama scale deploy/ollama --replicas=0
   ```
   Das Modell bleibt auf der PVC erhalten, auch wenn der Pod auf 0
   skaliert wird — muss also nicht bei jedem täglichen Lauf neu gezogen
   werden (und braucht dann auch keine Egress-Ausnahme mehr).
3. **Direkt testen** (Pod kurz hochskaliert lassen):
   ```bash
   kubectl -n ollama port-forward deploy/ollama 11434:11434
   curl http://localhost:11434/api/generate -d '{"model":"llama3.1:8b","prompt":"Sag Hallo auf Deutsch.","stream":false}'
   ```
4. n8n-Workflows einrichten: siehe [30070-n8n.md](30070-n8n.md), Abschnitt
   „Zammad Externer KI-Lauf (täglich)“.
5. **Netzwerk-Isolation verifizieren** (zwingend vor dem produktiven
   Einsatz, siehe Warnhinweis im Abschnitt „Netzwerk-Isolation“ oben —
   NetworkPolicy-Durchsetzung ist auf diesem Cluster nicht vorab
   bestätigt):
   ```bash
   # (a) Ingress von fremdem Namespace MUSS blockiert sein:
   kubectl run netpol-test --rm -it --image=curlimages/curl -n default \
     -- curl -m 3 http://ollama.ollama.svc.cluster.local:11434/
   # Erwartung: Timeout/Fehler

   # (b) Ingress von n8n MUSS funktionieren:
   kubectl exec -n n8n deploy/n8n -- wget -qO- --timeout=3 \
     http://ollama.ollama.svc.cluster.local:11434/
   # Erwartung: 200, "Ollama is running"

   # (c) Egress vom Ollama-Pod MUSS blockiert sein:
   kubectl exec -n ollama deploy/ollama -- wget -qO- --timeout=3 https://1.1.1.1
   # Erwartung: Timeout/Fehler
   ```
   Weicht ein Ergebnis von der Erwartung ab, greift NetworkPolicy auf
   diesem Cluster nicht wie angenommen — das ist dann ein größerer,
   separater Architektur-Entscheid (CNI-Wechsel), keine Kleinigkeit, die
   sich nebenbei fixen lässt.

---

## Konfiguration (values.yaml)

| Key | Bedeutung | Default |
|---|---|---|
| `replicaCount` | Ruhezustand-Replicas — wird von n8n überschrieben, siehe oben | `0` |
| `image.tag` | Ollama-Image-Version | `0.3.14` |
| `nodeSelector` | Pinnt den Pod auf `worker-0` (Lenovo M90q) | `kubernetes.io/hostname: worker-0` |
| `resources` | CPU/RAM für ein 7-8B-Q4-Modell — vor Rollout gegen echte Node-Kapazität prüfen. `memory` am 27.08.2026 nach dem ersten echten End-to-End-Testlauf von 5Gi/6500Mi auf 6Gi/7Gi angehoben, da Ollama den `/api/generate`-Call für `llama3.1:8b` sonst mit `500 model requires more system memory (6.1 GiB) than is available` ablehnt — das Modell selbst braucht schon mehr als das alte Limit. 7Gi Limit passt noch knapp unter die ~7,3Gi Node-Allocatable von `worker-0`; ein größeres/weniger stark quantisiertes Modell würde mehr RAM brauchen, als dieser Node hergibt (Hardware-Grenze) | siehe `values.yaml` |
| `persistence.size` | Modell-Storage (NFS, `nas`-StorageClass) | `20Gi` |
| `n8nServiceAccountName` / `n8nNamespace` | Ziel-ServiceAccount für das Scale-RBAC | `n8n` / `n8n` |

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Pod bleibt `Pending` nach Scale-up | Ist `worker-0` überhaupt wach? `kubectl get nodes` — falls nicht, Wake-Schritt im n8n-Workflow prüfen (Credential/Token für `carplay-api` gültig?) |
| n8n bekommt `403` beim Scale-PATCH | RBAC prüfen: `kubectl -n ollama auth can-i patch deployments/scale --as=system:serviceaccount:n8n:n8n -n ollama` |
| n8n bekommt `401`/TLS-Fehler beim Scale-PATCH | Service-Account-Token im n8n-Pod noch vorhanden? (`automountServiceAccountToken` nicht deaktiviert) |
| Ollama antwortet nicht rechtzeitig | Wait-Node-Dauer im Haupt-Workflow zu knapp — Kaltstart (Node-Boot + Pod-Start + Modell-Laden) kann je nach Hardware länger als 150s dauern |
| Deployment bleibt dauerhaft `OutOfSync` in ArgoCD | `ignoreDifferences`-Eintrag für `ollama`/`/spec/replicas` in `argocd/bootstrap/root-applicationset.yaml` vorhanden? |
| `ollama pull` schlägt fehl (kein Internet) | Temporäre Egress-Ausnahme aus „Netzwerk-Isolation“ vergessen? Muss vor dem Pull gesetzt UND danach wieder gelöscht werden |
| n8n bekommt Timeout bei `/api/generate`, obwohl Ollama laut `kubectl get pods` läuft | `networkpolicy-allow-n8n-ingress.yaml` korrekt deployt? Label `app.kubernetes.io/name: n8n` bei den n8n-Pods vorhanden (`kubectl -n n8n get pods --show-labels`)? |
| Verifikationstest (Schritt 5 oben) zeigt, dass Ollama trotz Default-Deny von überall erreichbar bleibt | NetworkPolicy wird auf diesem Cluster nicht durchgesetzt (k3s-NetworkPolicy-Controller inaktiv?) — kein Workaround hier, sondern als Befund zurückmelden statt selbstständig CNI zu wechseln |
| `/api/generate` liefert `500 model requires more system memory (X GiB) than is available (Y GiB)` | `resources.limits.memory` in `values.yaml` zu knapp für das geladene Modell — anheben (siehe Kommentar dort), aber gegen `kubectl describe node worker-0` → Allocatable prüfen; ist die Node-Kapazität selbst der Flaschenhals, hilft nur mehr RAM oder ein kleineres/staerker quantisiertes Modell |
| Live-`kubectl patch`/`edit` auf dem `ollama`-Deployment wird nach Sekunden wieder zurückgesetzt | Erwartetes ArgoCD-`selfHeal`-Verhalten für JEDES Feld außer `/spec/replicas` (dafür existiert die `ignoreDifferences`-Ausnahme oben) — Änderungen an `resources`, `image` etc. gehören in `values.yaml`, nicht als Live-Patch |
