# 39 — Horizontale Autoskalierung (HPA)

Auslöser: Immich stürzte bei vielen/großen Uploads ab (OOMKilled), und
Kubernetes hat nicht automatisch mehr Pods gestartet — schlicht weil
nirgends ein `HorizontalPodAutoscaler` (HPA) existierte. Dieses Dokument
beschreibt, welche Apps in diesem Repo einen HPA bekommen haben, mit
welchen Schwellenwerten, und — genauso wichtig — welche Apps **bewusst
keinen** bekommen haben und warum.

---

## Kurzfassung: was ein HPA hier lösen kann und was nicht

Ein HPA reagiert auf **viele gleichzeitige** Anfragen/Jobs, indem er
weitere Pods startet, sobald der CPU-/RAM-Verbrauch der laufenden Pods
einen Schwellenwert überschreitet. Er hilft **nicht** dabei, dass eine
**einzelne** schwere Anfrage (z. B. ein einzelnes sehr großes Video) mehr
RAM bekommt, als der Container-`resources.limits` erlaubt — dafür muss
das Limit selbst erhöht werden. Für Immich konkret: viele parallele
Uploads verteilen sich jetzt auf mehrere `immich-server`-Pods, ein
einzelnes 4K-Video, das für sich allein schon >4Gi RAM braucht, crasht
trotzdem (siehe `server.resources.limits` in
[argocd/apps/immich/values.yaml](../argocd/apps/immich/values.yaml)).

---

## Zwei technische Voraussetzungen, die überall gleich gelöst wurden

### 1. ArgoCD `selfHeal` vs. HPA — das `replicas`-Problem

Das Root-ApplicationSet
([argocd/bootstrap/root-applicationset.yaml](../argocd/bootstrap/root-applicationset.yaml))
läuft mit `syncPolicy.automated.selfHeal: true` **und**
`syncOptions: [ServerSideApply=true]`. Ohne Gegenmaßnahme würde ArgoCD bei
jedem Sync die von git/Helm vorgegebene, statische `replicas`-Zahl wieder
herstellen und damit den HPA sofort zurückdrehen, sobald er hochskaliert.

Zwei Varianten, je nachdem, ob wir das Deployment-Template selbst
besitzen:

- **Eigene (hand-geschriebene) Chart-Templates** (immich, cloudflared,
  nextcloud, wikijs, example-whoami, gotify-bridge, ntfy-bridge,
  mediamtx): `replicas:` wird im Template komplett weggelassen, sobald
  Autoscaling aktiv ist:
  ```yaml
  spec:
    {{- if not .Values.autoscaling.enabled }}
    replicas: {{ .Values.replicaCount }}
    {{- end }}
  ```
  Da das Feld dann in keinem von ArgoCD angewendeten Manifest mehr
  auftaucht, beansprucht ArgoCDs Server-Side-Apply-Field-Manager dafür nie
  die Owner­schaft — der vom HPA gesetzte Wert bleibt unangetastet.

- **Fremde Chart-Abhängigkeiten ohne eigenes Template**
  (headlamp, kubeseal-webgui, zammad `nginx`/`railsserver`): Hier
  rendert das Upstream-Template unconditional `replicas: {{ .Values.replicaCount }}`.
  Statt den Wert zu entfernen (nicht möglich, fremdes Template), wird er
  auf `null` gesetzt:
  ```yaml
  replicaCount: null   # bzw. zammadConfig.<component>.replicas: null
  ```
  Das rendert zu `replicas:` (leer). Unter Server-Side-Apply bedeutet ein
  explizit auf `null` gesetztes Feld "ich gebe die Ownership für dieses
  Feld ab", nicht "setze es auf null" — der vom HPA verwaltete Wert bleibt
  dadurch ebenfalls unangetastet. (Ohne `ServerSideApply=true` würde dieser
  Trick nicht zuverlässig funktionieren — mit reinem Client-Side-Apply
  hätte man stattdessen `ignoreDifferences: [{jsonPointers: ["/spec/replicas"]}]`
  auf Application-Ebene gebraucht.)

**Bekannte Ausnahme:** `zammad-websocket` hat **keinen** HPA bekommen —
siehe [Ausgeschlossene Apps](#ausgeschlossene-apps-kein-hpa) unten. Der
Upstream-Chart kodiert dort `replicas: 1` fest als Literal (nicht über
einen Values-Key steuerbar), es gibt also nichts, das man auf `null`
setzen könnte.

### 2. ReadWriteOnce-Storage + mehrere Replicas → erzwungene Co-Location

Mehrere Apps mounten ihre Foto-/Datei-Bibliothek als
`ReadWriteOnce`-PVC (NFS) — RWO heißt: gleichzeitig mountbar auf **einem**
Node, nicht auf mehreren. Skaliert der HPA auf >1 Replica hoch und der
Scheduler setzt eine neue Replica auf einen anderen Node als die
bestehende, bliebe der Pod im `ContainerCreating` hängen
(Multi-Attach-Fehler).

Betroffene Apps (immich `server`/`machine-learning`, nextcloud) bekamen
deshalb eine zusätzliche, fest verdrahtete `podAffinity`, die alle
Replicas zwingend auf denselben Node wie bereits laufende Pods derselben
Komponente setzt:

```yaml
affinity:
  podAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels: { <selector-labels der Komponente> }
        topologyKey: kubernetes.io/hostname
```

Der bisher konfigurierbare `*.affinity`-Values-Key wurde für diese
Komponenten entfernt (war überall ohnehin leer `{}`), um zu verhindern,
dass eine spätere manuelle Konfiguration diese Pflicht-Regel
versehentlich überschreibt.

Bei Nextcloud ist das nur sicher, weil die App bereits ein eigenes Redis
für verteiltes Datei-Locking nutzt (siehe
[33-nextcloud.md](33-nextcloud.md)) — geteilter Storage + mehrere
App-Pods funktioniert bei Nextcloud nur, wenn das Locking nicht auch noch
lokal im Dateisystem passiert.

Wiki.js, die Bridges und die Test-Apps brauchen diese Affinity nicht —
sie haben schlicht kein PVC (Wiki.js speichert alles in PostgreSQL).

---

## Apps mit aktivem HPA

| App | Komponente | Replicas | Trigger | Besonderheit |
|---|---|---|---|---|
| [immich](35-immich.md) | `server` | 1–3 | CPU 75% / RAM 80% | podAffinity (RWO-Library) |
| immich | `machine-learning` | 1–2 | CPU 75% / RAM 80% | podAffinity (RWO-Model-Cache); niedrigeres Max, da jede Inferenz-Instanz bis zu 4 Kerne/4Gi allein beansprucht |
| [nextcloud](33-nextcloud.md) | App-Tier | 1–2 | CPU 75% / RAM 80% | podAffinity (RWO `html`/`data`); sicher dank Redis-Locking |
| [wikijs](20-wikijs.md) | App-Tier | 1–3 | CPU 75% / RAM 80% | kein PVC, kein Affinity-Trick nötig |
| [authentik](13-sso-authentik.md) | `server` | 1–3 | CPU 75% / RAM 80% | natives HPA-Template des Upstream-Charts, nur Values-Flag |
| authentik | `worker` | 1–2 | CPU 75% / RAM 80% | Background-/Celery-Tasks, kein Leader-Election-Singleton |
| [cloudflared](23-cloudflare-deploy.md) | — | 2–4 | CPU 70% | Minimum bleibt 2 (zwei unabhängige Edge-Verbindungen) |
| example-whoami | — | 1–3 | CPU 70% | Test-App |
| gotify-bridge, ntfy-bridge | — | 1–3 | CPU 75% | stateless Webhook-Übersetzer |
| [mediamtx](24-mediamtx.md) | — | 1–2 | CPU 75% | hilft nur bei neuen Verbindungen — ein laufender RTMP/RTSP-Stream bleibt am ursprünglichen Pod hängen (kein Rebalancing) |
| headlamp | — | 1–3 | CPU 75% | hand-geschriebener HPA, Upstream-Chart hat kein natives Autoscaling |
| kubeseal-webgui | — | 1–2 | CPU 75% | hand-geschriebener HPA |
| [zammad](17-zammad.md) | `nginx` | 1–3 | CPU 70% | hand-geschriebener HPA |
| zammad | `railsserver` | 1–3 | CPU 75% / RAM 80% | hand-geschriebener HPA |

Alle Schwellenwerte sind bewusst konservativ gewählt (CPU 70–75%, RAM 80%)
— lieber eine Replica zu früh dazu als spät, da Homeserver aktuell der
einzige durchgehend laufende Node ist (siehe
[37-cluster-power-manager.md](37-cluster-power-manager.md)).

---

## Ausgeschlossene Apps (kein HPA)

**SQLite/embedded Datenbank auf RWO-Storage** — mehrere Pods würden sich
dieselbe DB-Datei zerschießen:

- grocy, mealie, n8n, paperless-ngx, vaultwarden (alle explizit SQLite,
  siehe jeweilige Doku)
- ntfy, gotify (Cache-/Auth-Datei auf der PVC)
- uptime-kuma (zusätzlich hart auf den Homeserver-Node gepinnt)
- semaphore (embedded BoltDB)
- monitoring/Grafana — läuft mit `persistence.type: pvc` (RWO,
  `local-path`) und ohne externe DB-Anbindung, also embedded SQLite;
  der Grafana-Subchart hat zwar natives `autoscaling.*`, das würde hier
  aber dieselbe Klasse von Problem erzeugen wie bei Vaultwarden/Grocy

**Single-Writer/Standalone-Datenspeicher:**

- minio (Standalone-Mode ignoriert `replicas` laut Chart-Kommentar —
  echte HA bräuchte "distributed mode", nicht HPA)
- alle internen `postgresql`/`redis`-Deployments (immich, nextcloud,
  wikijs, authentik (StatefulSet), zammad) — Single-Writer-Datenbanken,
  teils zusätzlich per `nodeAffinity` auf `local-path`-Storage gepinnt

**Vom Upstream-Chart selbst als nicht skalierbar markiert:**

- zammad `scheduler` — Background-Job-Runner, doppelte Ausführung würde
  Jobs duplizieren
- zammad `websocket` — der Chart kodiert `replicas: 1 # Not scalable,
  may only run once per cluster.` fest, vermutlich weil Echtzeit-Events
  intern ohne gemeinsamen Broker zwischen mehreren Prozessen verteilt
  werden. Kein Values-Key vorhanden, den man auf `null` setzen könnte —
  selbst wenn man einen HPA hinzufügt, würde ArgoCDs `selfHeal` die
  Replica-Zahl bei jedem Sync auf 1 zurücksetzen, UND die App könnte
  funktional kaputtgehen.

**Monitoring-Komponenten, die einzeln laufen müssen:**

- vmsingle (nicht-geclusterte TSDB), vmagent/vmalert (VM-Operator-CRDs —
  doppelte Replicas ohne Sharding würden Scrapes/Alerts duplizieren),
  Alertmanager

---

## Neue/geänderte Vendoring-Artefakte

`kubeseal-webgui` und `zammad` hatten bisher keine vendorten
Chart-Abhängigkeiten (`Chart.lock`/`charts/*.tgz`) — ArgoCD hat die beim
Sync live vom Upstream-Repo/OCI-Registry gezogen. Beim Validieren der
HPA-Änderungen (`helm dependency build`) wurden diese Artefakte erzeugt
und committet, analog zum bereits bestehenden Vorgehen bei `authentik`,
`headlamp` und `monitoring`. Funktional ändert sich dadurch nichts (die
gepinnte Version in `Chart.yaml` war schon vorher exakt fixiert) — nur
künftige Versions-Bumps in `Chart.yaml` brauchen danach zusätzlich
`helm dependency update`, sonst schlägt der Sync wegen einer
Lock-Datei-Inkonsistenz fehl.

---

## Verifizieren

```bash
kubectl -n <namespace> get hpa
kubectl -n <namespace> describe hpa <name>
```

`TARGETS` zeigt aktuelle vs. Ziel-Auslastung; `REPLICAS` die aktuell
laufende Anzahl. Voraussetzung ist ein laufender `metrics-server` im
Cluster (bereits vorhanden, siehe `kubectl top pod/node`).
