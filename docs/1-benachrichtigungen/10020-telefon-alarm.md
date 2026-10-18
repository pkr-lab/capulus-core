# Telefon-Alarm — Anruf mit Sprachansage bei schweren Ausfällen

Bei wenigen, wirklich schweren Ausfällen ruft der Cluster auf dem iPhone an. Die deutsche Ansage sagt, **was** kaputt ist, **warum** alarmiert wurde und **seit wann**. Der Anruf läuft per SIP über
`sip.linphone.org` an die Linphone-App, die per Push wie ein echter Anruf klingelt. Gotify gibt es nicht mehr, ntfy bleibt wie es ist ([10010](10010-ntfy.md)).

> **Betriebsart heute: im TECH-Cluster.** Der Anrufer läuft als Pod `alert-caller` auf dem `homeserver`. Fällt der Cluster oder der Homeserver aus, **ruft nichts an**, auch nicht bei Strom- oder Internetausfall im Haus.
> Das ist bewusst so entschieden. Wer das später abdecken will, nimmt die externe VM ([Später: externe VM](#später-externe-vm)). Als billige Absicherung gibt es healthchecks.io ([unten](#optional-healthchecksio)): Es meldet einen toten Cluster per Push und E-Mail.

> **Cluster:** TECH · Ordner `argocd/apps/tech/alert-caller/` (Anrufer), `argocd/apps/tech/monitoring/` (Routen und Regeln) · Namespace `alert-caller` · Service `alert-caller:9310`
> `kubectl`-Befehle in diesem Doc gelten für diesen Cluster
> (Zugriff je Cluster: [a0010](../a-betriebssystem/a0010-overview.md#kubectl-zugriff-je-cluster)).
> Begründungen zu den Entscheidungen: [60040](../6-hintergruende/60040-helm-charts-tech.md#alert-caller), [60020](../6-hintergruende/60020-ansible-rollen.md#alert_caller), [60060](../6-hintergruende/60060-monitoring-und-alerting.md#telefon-alarm).

---

## Architektur

```
Alertmanager (monitoring)
   │
   ├─ page="true" ─────────► POST http://alert-caller.alert-caller.svc.cluster.local:9310/alert
   │                           Ansage bauen ─► Piper (Stimme thorsten-high) ─► sox ─► baresip
   │                                                                                    │ SIP über TLS (5061), RTP über UDP
   │                                                                                    ▼
   │                                                                  sip.linphone.org ─Push─► Linphone auf dem iPhone
   │
   └─ Watchdog (alle 1 min) ─► POST …:9310/watchdog
                                 ├─ Zeitpunkt merken
                                 ├─ optional: Ping weiterleiten an https://hc-ping.com/<UUID>
                                 └─ länger als 10 min kein Watchdog ─► Anruf „Der Cluster meldet sich nicht mehr“
```

Der Watchdog-Anruf deckt also den Fall ab, dass **Alertmanager oder vmalert** ausfallen, während der Caller noch lebt. Fällt der ganze Cluster aus, lebt der Caller nicht mehr.

| Komponente | Läuft | Aufgabe |
|---|---|---|
| Alertmanager | TECH, Namespace `monitoring` | Routen `watchdog` und `phone` in `argocd/apps/tech/monitoring/values.yaml` |
| VMRule `paging` | TECH, `argocd/apps/tech/monitoring/templates/vmrule-paging.yaml` | Die Regeln mit `page: "true"` |
| Pod `alert-caller` | TECH, `homeserver`, Host-Netzwerk | `caller.py` (Webhook-Server, Ansage, Anruf, Watchdog-Schleife), baresip, Piper, sox |
| Image `ghcr.io/pkr-lab/alert-caller` | gebaut von `build-images.yml` | baresip 4.12.0 (selbst gebaut), Piper 1.8.0 samt Stimme, sox, Python. **Kein** App-Code: `caller.py` kommt per ConfigMap |
| healthchecks.io | extern (Gratis-Plan), optional | meldet einen toten Cluster |

---

## Was ruft an

Nur Alarme mit dem Label `page="true"` und der Watchdog-Ausfall. Alles andere läuft unverändert über ntfy. Die Paging-Alarme tragen zusätzlich `severity: critical` und gehen deshalb **auch** an ntfy
(die Route `phone` hat `continue: true`).

| Alarm | Bedingung | Ansage (Beispiel) |
|---|---|---|
| `NodeDownPaging` | `up` des Node-Exporters von `homeserver`, `prod-vm` oder `ugreen-nas` ist 5 min lang 0 | „Produktiv VM ist nicht erreichbar, seit 7 Minuten. Grund: … Die höchste gemessene Temperatur der letzten 30 Minuten war 61 Grad.“ |
| `PodCrashLoopPaging` | Container im Namespace `vaultwarden` 10 min lang in `CrashLoopBackOff`, der Abbruchgrund wird als Label `reason` übernommen | „vaultwarden im Bereich vaultwarden startet dauernd neu, seit 12 Minuten. Grund: Arbeitsspeicher voll.“ |
| `DiskFailurePaging` | `smartctl_device_smart_status == 0` oder `smartctl_device_critical_warning > 0`, 10 min lang | „Die Festplatte nvme0 in homeserver meldet einen Defekt …“ |
| `KubeApiDownPaging` | kein einziges `up{job="apiserver"} == 1` mehr, 5 min lang | „Die Kubernetes A P I antwortet nicht …“ |
| Watchdog-Ausfall | länger als `WATCHDOG_TIMEOUT` (600 s) kein Watchdog am Caller | „Der Cluster meldet sich seit über 10 Minuten nicht mehr.“ |

`NodeDownPaging` erfasst bewusst nur die immer laufenden Rechner. Die Worker (`worker-0`, `worker-1`), `entw-vm` und `infotafel` stehen im Normalbetrieb auf `up == 0` (sie schlafen oder sind
Kiosk-Geräte) und würden sonst jede Nacht anrufen. Der Vereinsheim-Alarmmonitor hat seinen eigenen Weg ([30020](../3-apps-workloads/30020-vereinsheim-alarmmonitor.md)). Mit dem Caller im Cluster sind
`NodeDownPaging` für `homeserver` und `KubeApiDownPaging` nur sinnvoll, wenn der Homeserver noch läuft, etwa bei einem Ausfall allein des Exporters oder der API.

### Wie die Ansage entsteht

- Einleitung „Achtung, Cluster Alarm.“, bei mehreren Alarmen zusätzlich „N Probleme.“. Höchstens 3 Alarme werden vorgelesen (älteste zuerst), dann „Und N weitere, Details in der Push Nachricht.“
- Pro Alarm: Annotation `ansage` (Rückfall `summary`, dann `alertname`), „seit X Minuten/Stunden/Tagen“ aus `startsAt`, „Grund: …“ aus `grund`, optional der Kontext.
- **Aussprache:** `:port` wird entfernt, bekannte Hostnamen und IPs werden ersetzt (`worker-0` und `192.168.178.95` → „Worker null“, `ugreen-nas` → „NAS“, `vereinsheim-alarmmonitor` → „Alarmmonitor im Vereinsheim“),
  `-` und `_` zwischen Wörtern werden zu Leerzeichen. Abbruchgründe werden übersetzt (`OOMKilled` → „Arbeitsspeicher voll“, `Error` → „Programmfehler“, `ContainerCannotRun` → „Container startet nicht“).
  Die Tabellen `SPOKEN_NAMES` und `SPOKEN_REASONS` stehen oben in `argocd/apps/tech/alert-caller/src/caller.py`.
- **Kontext:** Hat der Alarm die Annotation `kontext` (eine PromQL-Abfrage mit genau einem Ergebnis), fragt der Caller `VM_URL/api/v1/query` mit 3 s Timeout ab und ersetzt `{}` in `kontext_text` durch den gerundeten Wert.
  Im Cluster zeigt `VM_URL` auf den VictoriaMetrics-Service (`config.vmUrl`). Bei **jedem** Fehler (kein `VM_URL`, Timeout, leeres Ergebnis) fällt der Satz still weg, die Ansage kommt immer.
- „Seit wann“ zählt ab `startsAt`, also ab dem Moment, in dem der Alarm **feuert**. Die `for`-Wartezeit der Regel (5 bis 10 min) ist darin nicht enthalten.

### Ablauf eines Anrufs

1. Der Webhook wird sofort mit 200 beantwortet, alles Weitere läuft in einem eigenen Thread (Alertmanager bricht Webhooks nach 10 s ab).
2. **Pause pro `groupKey`:** Eine Alarm-Gruppe ruft frühestens nach `CALL_COOLDOWN` (900 s, abzüglich 30 s Toleranz für den Takt von Alertmanager) erneut an. Kommt ein **neuer** Alarm in dieselbe Gruppe, gilt die Pause nicht.
   Die Pausen stehen im Arbeitsspeicher: Startet der Pod neu, ruft ein noch aktiver Alarm bei der nächsten Wiederholung sofort wieder an.
3. Anrufe laufen nacheinander (ein Lock über Synthese und Anruf). Wartende Anrufe bauen ihre Ansage erst, wenn sie dran sind.
4. Die Ziele aus `CALL_TARGETS` werden der Reihe nach angerufen (Eskalation). Für jedes Ziel startet der Caller einen eigenen baresip-Prozess, wartet auf die Registrierung (höchstens `REGISTER_TIMEOUT`, 15 s) und wählt erst dann.
   Klingelt ein Ziel länger als `CALL_RING_TIMEOUT` (45 s), kommt das nächste dran. Nimmt eines an, ist Schluss: Der Caller legt nach der Länge der Ansage plus 3 s selbst auf.
5. Schlägt die Sprachsynthese fehl, ruft der Caller trotzdem an und spielt einen Warnton statt der Ansage.

---

## Quittieren

Mit einer Alertmanager-Silence. Ohne Silence ruft der Caller erneut an, solange der Alarm aktiv ist (`repeat_interval: 15m`).

```bash
kubectl -n monitoring exec vmalertmanager-monitoring-victoria-metrics-k8s-stack-0 -c alertmanager -- \
  amtool --alertmanager.url=http://localhost:9093 silence add alertname=NodeDownPaging --duration=2h --author=peter --comment="Quittiert"
```

Alternativ in der Alertmanager-Oberfläche (`kubectl -n monitoring port-forward vmalertmanager-monitoring-victoria-metrics-k8s-stack-0 9093`, dann `http://localhost:9093`). Das Tastenmenü im Anruf
(1 wiederholen, 2 Details, 9 Silence 2 h) und eine Zusammenfassung der Logs per Ollama sind **nicht** umgesetzt.

---

## Einrichtung

Reihenfolge einhalten. Ohne versiegeltes Passwort startet der Pod nicht (`CreateContainerConfigError`), ohne gebautes Image nicht (`ImagePullBackOff`). Solange der Pod fehlt, schlägt die Zustellung der Webhooks fehl
(Warnung `AlertmanagerFailedToSendAlerts`, wird nirgends zugestellt).

### 1. Linphone-Konten

Auf `https://subscribe.linphone.org/` zwei Konten anlegen:

| Konto | Zweck |
|---|---|
| `capulus-core` | Der Cluster. Ruft an. Das Passwort darf kein `;`, kein `"` und kein Leerzeichen enthalten (der Caller bricht sonst ab), am einfachsten alphanumerisch und lang. |
| persönliches Konto | Wird angerufen. Seine SIP-Adresse `sip:<name>@sip.linphone.org` kommt in `config.callTargets`. |

### 2. Linphone-App auf dem iPhone

- Mit dem **persönlichen** Konto anmelden. Benachrichtigungen und Mikrofon erlauben, die App einmal geöffnet lassen, bis die Registrierung steht (nur dann kennt der Push-Server das Gerät).
- Fokus-Modus: In „Nicht stören“ (und jedem Schlaf-Fokus) Linphone als erlaubte App und Anrufe von `capulus-core` zulassen, sonst klingelt der Alarm nachts nicht. Die Menünamen unterscheiden sich je nach iOS-Version.
- Test ohne Cluster: Mit dem zweiten Konto (`capulus-core`) von einer zweiten Linphone-Installation anrufen. Das iPhone muss bei gesperrtem Bildschirm und geschlossener App klingeln.

### 3. Secrets anlegen und versiegeln

Im Secret `alert-caller-secrets` steht `SIP_PASSWORD`. Das Skript fragt das Passwort ohne Anzeige ab, versiegelt es für Namespace `alert-caller` und Name `alert-caller-secrets` und trägt das Ergebnis in `argocd/apps/tech/alert-caller/values.yaml` ein (ersetzt den Platzhalter
`REPLACE_ME_WITH_KUBESEAL_OUTPUT` oder einen früheren Wert). Klartext gibt es nur als Eingabe, nie in der Shell-History und nie im Repo:

```bash
scripts/seal-alert-caller.sh
```

Das Skript lehnt Passwörter mit `;`, `"` oder Leerzeichen ab. Den Wert prüft der Controller auf Wunsch, ohne das Passwort zu kennen (er stimmt nur, wenn Namespace und Name passen):
`helm template alert-caller argocd/apps/tech/alert-caller -n alert-caller --show-only templates/sealedsecret.yaml | kubeseal --validate --controller-namespace sealed-secrets --controller-name sealed-secrets-controller`.
Ob das **Passwort** stimmt, zeigt erst der erste Registrierungsversuch (Log `403 Forbidden` heißt: falsch).

Der Eintrag `alert-caller-sip-password` in [`ops/token-register.yaml`](../../ops/token-register.yaml) führt Rotationsdatum und Verantwortlichen.
Rotation: Passwort bei Linphone ändern, dann das Skript erneut ausführen. Der Pod startet durch die Prüfsumme von selbst neu.

### 4. Ziel eintragen

In `argocd/apps/tech/alert-caller/values.yaml` unter `config.callTargets` den Platzhalter `sip:EINTRAGEN@sip.linphone.org` durch deine SIP-Adresse ersetzen. Mehrere Ziele, durch Komma getrennt, werden der Reihe nach angerufen.

### 5. Mergen, Image bauen, Tag setzen

1. Nach dem Merge nach `main` baut [`build-images.yml`](../../.github/workflows/build-images.yml) das Image (`ghcr.io/pkr-lab/alert-caller:sha-<commit>`, einige Minuten, weil `baresip` kompiliert wird) und öffnet einen PR, der `image.tag` in `values.yaml` setzt. Siehe
   [f0060](../f-cicd-automatisierung/f0060-build-images.md).
2. Den PR mergen, danach rollt ArgoCD den Pod aus. Neue GHCR-Pakete sind zunächst privat: Entweder das Paket `alert-caller` auf GitHub öffentlich stellen (es enthält nur Open-Source-Software und eine öffentliche Stimme)
   oder im Namespace das Pull-Secret `ghcr-pull` anlegen (`values.yaml`, `imagePullSecrets`).

### 6. Prüfen

```bash
kubectl -n alert-caller get pods -o wide
kubectl -n alert-caller logs deploy/alert-caller --tail=20
kubectl -n alert-caller port-forward svc/alert-caller 9310:9310 &
curl -s -X POST http://127.0.0.1:9310/alert -d '{}'
```

Erwartet wird `listening on :9310, targets=[…]` und die Antwort `ok`. Danach der Testplan unten.

### Optional: healthchecks.io

Der Caller leitet jeden Watchdog-Ping an healthchecks.io weiter. Bleibt er aus, weil der Cluster tot ist, meldet sich healthchecks.io per Push und E-Mail. Das ersetzt den Anruf nicht, aber ein toter Cluster fällt auf.

1. Gratis-Konto, ein Check `capulus-alert-caller` mit **Period 5 Minuten** und **Grace 10 Minuten**.
2. Integrationen: **ntfy** mit dem öffentlichen Server `https://ntfy.sh` und einem langen, zufälligen Topic (in der ntfy-App dieses Topic auf dem Server `ntfy.sh` abonnieren), dazu **E-Mail**.
   Der eigene ntfy-Server ([10010](10010-ntfy.md)) taugt hier nicht, er läuft im Cluster.
3. Die Ping-URL `https://hc-ping.com/<UUID>` versiegeln (Befehl aus Schritt 3, `--name alert-caller-secrets`) und in `values.yaml` als zweiten Schlüssel `secrets.encryptedData.HC_PING_URL` eintragen. Ohne den Schlüssel ist die Funktion aus.
4. Im Token-Register einen zweiten Eintrag (`alert-caller-hc-ping-url`, Art `api-token`) ergänzen.

---

## Konfiguration

Alles in `argocd/apps/tech/alert-caller/values.yaml`:

| Schlüssel | Default | Bedeutung |
|---|---|---|
| `config.callTargets` | `sip:EINTRAGEN@sip.linphone.org` (Pflicht) | SIP-Adressen, in dieser Reihenfolge angerufen |
| `config.sip.user` / `domain` | `capulus-core` / `sip.linphone.org` | Absenderkonto, das Passwort kommt aus dem Secret |
| `config.sip.stunServer` | `stun.cloudflare.com:3478` | STUN-Server für ICE. Der von Linphone (`stun.linphone.org`) funktioniert mit baresip nicht, siehe „Geprüft und offen“ |
| `config.sip.mediaEncryption` | `srtp-mand` | hängt `;mediaenc=…` an die Kontozeile. `srtp-mand` verlangt SRTP (Linphone lehnte unverschlüsselt mit 488 ab), `srtp` bietet es nur optional an, leer = unverschlüsselt |
| `config.watchdogTimeout` | `600` | Sekunden ohne Watchdog bis zum Anruf |
| `config.callCooldown` | `900` | Pause je Alarm-Gruppe zwischen zwei Anrufen |
| `config.callRingTimeout` | `45` | Sekunden, die ein Ziel klingeln darf, bevor das nächste drankommt |
| `config.registerTimeout` | `15` | Sekunden, die der Caller auf die SIP-Registrierung wartet, bevor er trotzdem wählt |
| `config.iceTimeout` | `40` | Sekunden, die der Caller nach dem Abheben auf den Medienstart (ICE) wartet, bevor er aufgibt |
| `config.vmUrl` | VictoriaMetrics-Service im Cluster | Basis-URL für den Kontext. Leer = Kontext aus |
| `config.rtpPortMin` / `rtpPortMax` | `10000` / `10100` | RTP-Portbereich von baresip |
| `hostNetwork` | `true` | Pod im Host-Netzwerk (Begründung: [60040](../6-hintergruende/60040-helm-charts-tech.md#alert-caller)) |
| `image.tag` | vom Bump-PR gesetzt | Image-Tag |
| `secrets.encryptedData` | `SIP_PASSWORD`, optional `HC_PING_URL` | versiegelte Werte |

---

## Neue Paging-Regel schreiben

Eine Regel in `argocd/apps/tech/monitoring/templates/vmrule-paging.yaml` (Vorbild: die vorhandenen vier). Pflicht sind die Labels `severity: critical` und `page: "true"`, dazu die Annotationen:

| Annotation | Pflicht | Inhalt |
|---|---|---|
| `summary` | ja | Kurztext für Push und Logs. Rückfall für die Ansage |
| `ansage` | empfohlen | Was kaputt ist, als gesprochener Satz ohne Punkt am Ende |
| `grund` | empfohlen | Warum alarmiert wurde. Wird mit „Grund:“ vorgelesen |
| `kontext` | nein | PromQL mit genau **einem** Ergebnis (z. B. `max(…)`) |
| `kontext_text` | nein | Satz mit `{}` an der Stelle, an der der gerundete Wert stehen soll |

```yaml
        - alert: BeispielPaging
          expr: up{job="mein-job"} == 0
          for: 5m
          labels:
            severity: critical
            page: "true"
          annotations:
            summary: "{{`{{ $labels.instance }}`}} antwortet nicht"
            ansage: "{{`{{ $labels.instance }}`}} antwortet nicht"
            grund: "Keine Metriken seit 5 Minuten"
            kontext: 'max(max_over_time(node_hwmon_temp_celsius{host="{{`{{ $labels.host }}`}}"}[30m]))'
            kontext_text: "Die höchste gemessene Temperatur war {} Grad"
```

- **Helm-Falle:** vmalert-Platzhalter (`{{ $labels.x }}`) müssen in `templates/` als `{{`{{ $labels.x }}`}}` geschrieben werden, sonst versucht Helm sie selbst zu rendern.
- **Namen aussprechbar machen:** Neue Hosts oder Dienste, die Piper falsch liest, kommen in `SPOKEN_NAMES` (Hostname und IP), neue Abbruchgründe in `SPOKEN_REASONS` in `caller.py`. Eine Änderung an `caller.py` braucht **keinen** Image-Build, die ConfigMap
  ändert sich und der Pod startet neu.
- **Metriken gegen den Bestand prüfen**, bevor die Regel ausgerollt wird: Job-Namen weichen ab. Statische Scrapes tragen den `jobName` (`prod-vm-node-exporter`), das Label `host` ist dagegen einheitlich und eignet sich zum Filtern.
- **Rechner, die schlafen**, dürfen nicht in eine Paging-Regel (siehe `NodeDownPaging`).

---

## Zugriffsschutz (Token)

`POST /alert` löst einen Anruf aus, `POST /watchdog` setzt den Totmann-Timer zurück. Beide verlangen ein gemeinsames Geheimnis im Header `Authorization: Bearer <Token>`, verglichen mit `hmac.compare_digest`. Eine negative oder unlesbare `Content-Length`
beantwortet der Caller mit `400`, der Body wird erst nach der Prüfung gelesen. Ohne Prüfung konnte jeder Pod im Cluster und jedes Tailnet-Gerät Anrufe auslösen oder den Totmann stumm halten, die Firewall hilft dafür nicht (Pods dürfen zum Host,
Tailscale nimmt den Tailnet-Verkehr vor UFW an).

| Stelle | Wo der Token liegt |
|---|---|
| Caller-Pod (`alert-caller`) | SealedSecret `alert-caller-secrets`, Schlüssel `ALERT_CALLER_TOKEN`, Env `ALERT_CALLER_TOKEN` (optional) |
| Alertmanager (sendet an Pod **und** Pi) | SealedSecret `alert-caller-token` im Namespace `monitoring`, gemountet nach `/etc/vm/secrets/alert-caller-token/token`, `http_config.authorization.credentials_file` an den drei Webhooks `watchdog` (Pod), `watchdog` (Pi) und `phone` |
| Notfall-Caller auf dem Pi | Vault-Variable `vault_alert_caller_token`, Rollen-Variable `alert_caller_token`, Datei `/etc/alert-caller/alert-caller.env` (Modus `0600`) |

**Zwei Stufen** über `ALERT_CALLER_AUTH_MODE` (`config.auth.mode` im Chart, `alert_caller_auth_mode` in der Rolle):

1. `log` (Ausgangslage der Einführung): Aufrufe ohne gültigen Token werden angenommen und als `unauthenticated request <Pfad> from <IP>` protokolliert. So fällt kein Alarm aus, falls ein Sender den Token noch nicht mitschickt.
2. `enforce`: Aufrufe ohne gültigen Token bekommen `401`. Der Dienst startet im Modus `enforce` nicht ohne Token.

### Erstanlage

```bash
scripts/seal-alert-caller-token.sh
ansible-vault encrypt_string --name vault_alert_caller_token "$(sed -n 's/^alert_caller_token=//p' ~/alert-caller-token-2026-10-17.txt)"
ansible-playbook -i capulus-ansible/inventory/hosts.yml capulus-ansible/alert-caller.yml --limit vereinsheim-alarmmonitor --tags alert-caller --ask-vault-pass
```

Das Skript erzeugt aus der Datei `~/alert-caller-token-2026-10-17.txt` (Modus `0600`, außerhalb des Repos) die beiden SealedSecrets und trägt sie ein. Die Ausgabe von `ansible-vault encrypt_string` kommt in `capulus-ansible/group_vars/all.yml`. Vor dem Commit
prüfen, dass dort kein Klartext steht. Der Alertmanager-Pod wartet auf das Secret `alert-caller-token`: Existiert es nicht, bleibt er in `ContainerCreating` und **alle** Alarme fehlen. Das SealedSecret gehört deshalb in denselben PR wie die Mount-Konfiguration.

### Von `log` auf `enforce`

1. Im Log prüfen, dass nichts Unauthentifiziertes mehr eintrifft:
   `kubectl -n alert-caller logs deploy/alert-caller --since=30m | grep unauthenticated` und `ssh alarm-monitor 'sudo journalctl -u alert-caller --since -30min | grep unauthenticated'`. Alertmanager meldet sich jede Minute mit `/watchdog`.
2. `config.auth.mode: enforce` im Chart, `alert_caller_auth_mode: enforce` in `capulus-ansible/group_vars/alert_caller_pi.yml`, PR, Rollenlauf für den Pi.
3. Prüfen: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://<caller>:9310/watchdog` liefert `401`, mit `-H "Authorization: Bearer $TOKEN"` `200`. Danach Testplan 3 (echter Anruf).

**Fehlerbild bei falschem Token im Modus `enforce`:** Alertmanager bekommt `401` auf `/watchdog`, nach `WATCHDOG_TIMEOUT` (10 Minuten) ruft der Caller selbst an („Der Cluster meldet sich seit über 10 Minuten nicht mehr“). Ein stiller Ausfall ist damit nicht möglich.

**Rotation:** Neuen Token erzeugen, `scripts/seal-alert-caller-token.sh` ausführen, den Vault-Wert ersetzen, PR mergen und Pi-Lauf. Es gibt keine Überlappung: Zwischen Pod-Neustart und Alertmanager-Neustart kann es kurz `401` geben, deshalb die Rotation im Modus `log` durchführen und danach auf `enforce` zurückstellen. `ops/token-register.yaml` aktualisieren.

---

## Testplan

| # | Test | Erwartung |
|---|---|---|
| 0 | Schritt 6 oben | Pod läuft, `listening on :9310`, `ok` auf den leeren Webhook |
| 1 | Manueller Anruf bei gesperrtem iPhone und geschlossener Linphone-App (Schritt 2) | iPhone klingelt |
| 2 | Webhook direkt, bei laufendem `port-forward`: `curl -X POST http://127.0.0.1:9310/alert -d '{"groupKey":"t","alerts":[{"status":"firing","labels":{"alertname":"Test"},"annotations":{"ansage":"Das ist ein Test","grund":"Manuell"},"startsAt":"2026-01-01T00:00:00Z"}]}'` | Anruf mit der Ansage. Im Log `answered` und `rx.wav peak` |
| 3 | `kubectl -n monitoring exec vmalertmanager-monitoring-victoria-metrics-k8s-stack-0 -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 alert add alertname=Test page=true severity=critical summary="Testanruf" ansage="Das ist ein Test" grund="Manuell ausgelöst"` | Nach rund 35 s (Gruppenwartezeit 30 s) Anruf mit dieser Ansage. `amtool` macht aus `key=value` **Labels**, der Caller liest `ansage`, `grund` und `summary` deshalb auch aus den Labels. In echten Regeln sind es Annotationen |
| 4 | Watchdog-Ausfall: Alertmanager anhalten. Operator und `selfHeal` von ArgoCD setzen ein einfaches `scale … --replicas=0` zurück, dafür zuerst den Operator anhalten: `kubectl -n monitoring patch vmalertmanager monitoring-victoria-metrics-k8s-stack --type merge -p '{"spec":{"paused":true}}'`, dann `kubectl -n monitoring scale statefulset vmalertmanager-monitoring-victoria-metrics-k8s-stack --replicas=0`. Danach beides zurücknehmen (`replicas=1`, `"paused":false`) | Nach rund 10 min Anruf „Der Cluster meldet sich seit über 10 Minuten nicht mehr.“ Nach der Rücknahme im Log `watchdog received again`. **Nicht ausprobiert**: ob ArgoCD das gesetzte `paused` zurücksetzt, mit `kubectl -n monitoring get sts` beobachten. Währenddessen fließen keine Alarme an ntfy, nur im Wartungsfenster |
| 5 | Silence setzen (siehe „Quittieren“) | Kein weiterer Anruf nach 15 min |
| 6 | Mit healthchecks.io: in der Integration „Send test notification“ | Push über ntfy.sh und E-Mail kommen an |
| 7 | `make lint`, `python3 scripts/check-doc-links.py`, `python3 scripts/check-token-register.py` | grün |
| 8 | Token-Prüfung ([Zugriffsschutz](#zugriffsschutz-token)): `POST /watchdog` ohne und mit Token | `log`: beide `200`, ohne Token steht `unauthenticated` im Log. `enforce`: ohne Token `401`, mit Token `200` |

---

## Geprüft und offen

Stand 2026-10-11. „Lokal“ heißt: Entwicklungsrechner und Docker-Container (amd64), ohne Linphone-Konto und ohne Rollout in den Cluster. Was ein echtes Konto oder den Cluster braucht, ist **nicht** geprüft.

| Punkt | Ergebnis |
|---|---|
| Wählt `baresip -e "/dial …"` direkt nach dem Start, auch vor der Registrierung? | **Nein.** Bei einem Konto mit Domain (`sip.linphone.org`) scheitert der Anruf vor der Registrierung mit `failed to create socket for media 'audio' (Cannot assign requested address)`: Die Adressfamilie des Medien-Sockets steht erst nach der ersten erfolgreichen Registrierung fest (`reg->af` in baresip). Deshalb startet der Caller baresip ohne `-e`, gibt ihm eine Pipe als stdin, wartet auf die Registrierung und sendet dann `/dial …`. Mit einem Konto, das eine IP statt einer Domain trägt (Loopback-Test), geht auch `-e`. **Mit dem echten Konto geprüft am 2026-10-11:** Die Registrierung läuft durch (`200 Registration successful`), das Passwort stimmt. Der Caller erkennt sie an der Logzeile `{0/TLS/v4} 200 Registration successful` (die erste Fassung erwartete `IPv4` aus dem Quelltext und wartete deshalb jedes Mal die vollen 15 s). Bleibt die Bestätigung aus, wählt er nach 15 s trotzdem. `pjsua` war als Ausweg vorgesehen und wurde nicht gebraucht. |
| STUN-Server | **`stun.linphone.org` geht mit baresip 4.12 nicht.** Er antwortet mit veralteten RFC-3489-Attributen (`SOURCE-ADDRESS`, `CHANGED-ADDRESS`, Software `oRTP 0.99`), libre lehnt solche Antworten nach RFC 5389 ab (`ice: STUN Request failed: Protocol error [71]`, `gather error`), und der erste echte Testanruf am 2026-10-11 scheiterte daran. Deshalb ist `stun.cloudflare.com:3478` eingetragen (`config.sip.stunServer`). Im Pod geprüft: ICE sammelt Kandidaten mit der öffentlichen Adresse des Heimrouters, der INVITE erreicht Linphone (`404 Not Found` für einen erfundenen Benutzer, es klingelte nichts). Cloudflare und Google antworten beide mit nur `XOR-MAPPED-ADDRESS`. Das Linphone-iPhone braucht davon nichts, es nutzt seinen eigenen STUN. |
| `sips:` im Record-Route von Linphone | **Gefunden und gepatcht (2026-10-11).** Nach dem Abheben schickt Linphone `Record-Route: <sips:sip11.linphone.org:5061;lr>`. `libre` (v4.12.0, auch in `main`) akzeptiert in `sip_request_alloc` nur das Schema `sip` und liefert für `sips` `ENOSYS`: Der ACK wird nie gesendet, im Log steht `Call answered`, `stream: update 'audio'` und dann `session closed: Function not implemented [38]`, nach der Annahme wird einfach aufgelegt. Der Patch `argocd/apps/tech/alert-caller/patches/libre-sips-route.patch` (12 Zeilen) lässt `sips` zu und nimmt dafür TLS. Mit ihm im Pod getestet: ACK geht raus, `Call established`, ICE-Prüfung abgeschlossen, SRTP aktiv (`AES_CM_128_HMAC_SHA1_80`, danach `AEAD_AES_128_GCM`), die Ansage ist zu hören. Das Image und die Ansible-Rolle wenden den Patch beim Bauen an. Fällt der Patch bei einem `re`-Update weg (neue Version), taucht derselbe Fehler wieder auf. |
| Stille nach dem Abheben (SRTP-Suitenwechsel) | **Gefunden und gepatcht (2026-10-11).** Der erste Austausch einigt sich auf `AES_CM_128_HMAC_SHA1_80`. Kurz darauf schickt Linphone ein eigenes re-INVITE mit `AEAD_AES_128_GCM` an erster Stelle, baresip wählt GCM und meldet es in der Antwort. Beim Wechsel der Suite setzt `modules/srtp/srtp.c` aber nur den **Empfangs**-Zustand zurück, `start_srtp` legt den Sende-Zustand nur an, wenn es noch keinen gibt: Der Caller sendet weiter mit AES-CM, sagt aber „GCM“. Das iPhone kann nichts entschlüsseln und gibt Stille aus, im Log stehen `srtp: failed to decrypt RTP packet with 182 bytes` und `SRTP is Enabled (cryptosuite=AEAD_AES_128_GCM)`. Der Patch `patches/baresip-srtp-no-gcm.patch` lässt baresip die GCM-Suiten nicht annehmen, die Suite bleibt `AES_CM_128_HMAC_SHA1_80`. |
| Ansage beginnt erst nach rund 16 bis 24 s | **Bekannt, bewusst nicht „beschleunigt“ (2026-10-11).** Die Audiozähler stehen nach dem Abheben bis Sekunde 16 bis 21 auf `0/0`, die Ansage startet erst, wenn die ICE-Prüfung (`connectivity check is complete`) durch ist. Ursache: Das iPhone nennt rund 12 Adressen, baresip bildet mit seinen 9 Schnittstellen etwa 90 Kandidatenpaare, die vielen nicht erreichbaren (Gastnetz, Mobilfunk-IPv6, Relay) müssen erst auslaufen. Schon nach 1 s ist das erste Paar gültig (über das Tailnet, die Medien kommen von `100.105.126.15`). **Versuch und Rückzug:** Zwei Patches an `libre` (alle 20 ms eine neue Prüfung statt kettenartig, und 4 statt 7 Wiederholungen) brachten ICE auf 3,3 s, machten die Ansage aber **unzuverlässig**: Das iPhone antwortet erst einige Sekunden nach dem Abheben auf die Prüfungen, das Paar lief vorher in den Timeout (`Failed`) und wurde später doch noch gültig und nominiert (`icecomp: set_selected: invalid state 'Failed'`). Mal kam die Ansage, mal nicht. Beide Patches sind wieder entfernt. Der Caller richtet sein Auflegen nach dem Medienstart (Ansagelänge plus 3 s) und wartet höchstens `ICE_TIMEOUT` (40 s). Eine Verkürzung ginge nur über weniger Kandidaten (`net_interface` schränkt auf eine Schnittstelle ein, dann hängt der Weg vom Tailnet des iPhones ab) oder eine saubere Korrektur der Statusübergänge in `libre`. |
| Auflegen im Pod | **Gefunden und behoben (2026-10-11).** Im Pod darf ein Prozess seinen eigenen Kindprozessen keine Signale schicken (`PermissionError` bei `terminate()` und `kill()`, AppArmor-Profil `cri-containerd.apparmor.d`). Der Caller konnte baresip nach der Ansage deshalb nicht beenden und brach mit `Permission denied` ab. `stop_process` beendet baresip jetzt über dessen eigene Befehle (`/hangup`, `/quit` per stdin) und versucht Signale nur noch als abgesichertes Notfallmittel. Mit dem vollständigen Pfad im Pod getestet: Ansage, Auflegen, kein hängender Prozess. |
| Verlangt Linphone Medienverschlüsselung? | **Ja.** Der erste Anruf am 2026-10-11 klingelte (Push, ICE und Registrierung liefen), das iPhone lehnte das Angebot danach mit `488 Not acceptable here` ab, die Ansage wurde nie gespielt. Deshalb ist `config.sip.mediaEncryption: srtp-mand` gesetzt (baresip bietet `RTP/SAVP` mit `a=crypto` an, `srtp` allein wäre nur optional verschlüsselt). SRTP und ICE zwischen zwei baresip-Instanzen funktionieren lokal. **Ob `srtp-mand` das iPhone zufriedenstellt, zeigt der nächste Testanruf.** Hilft es nicht, kommen Codec (der Anruf bietet PCMU, PCMA und Opus an) oder die Linphone-Einstellung „Medienverschlüsselung“ in Frage. |
| Kommt das Audio an? | **Lokal ja**: Die Ansage kommt über PCMU am Ziel an (Spitzenwert 32124 von 32767), auch im fertigen Image als Nutzer 1000 mit schreibgeschütztem Dateisystem. Der Caller loggt nach jedem Anruf `rx.wav peak`, das ist der Spitzenwert dessen, was **vom Telefon** zurückkam (Hintergrundgeräusche). 0 heißt: nichts empfangen. **Mit Linphone und über das Heimnetz-NAT offen** (siehe nächste Zeile). |
| NAT aus dem Heimnetz | **Offen.** Der Pod läuft im Host-Netzwerk, damit baresip die Ports des Hosts benutzt. Im Pod-Netzwerk maskiert Flannel jeden neuen Fluss mit `MASQUERADE --random-fully` (gesehen in `iptables -t nat -S FLANNEL-POSTRTG`) und würfelt dabei den Quellport. Die per STUN ermittelte Adresse für ICE passte dann vermutlich nicht mehr zum tatsächlichen Port zur Gegenstelle (Überlegung, nicht gemessen). Ob es mit Linphone über das Heimnetz sauber klappt, zeigt erst der erste echte Anruf, `rx.wav peak` im Log. Schlägt es fehl, ist ein TURN-Server oder die externe VM ([unten](#später-externe-vm)) der Ausweg. |
| Erreicht Alertmanager den Caller? | **Nach dem Rollout zu prüfen.** Der Service `alert-caller.alert-caller.svc.cluster.local:9310` zeigt auf den Host-Port des Pods, der Weg Pod → Host-IP ist getestet (ein POST aus dem Alertmanager-Pod an `192.168.178.94:9310` kam am 2026-10-11 an, UFW lässt den Pod-CIDR durch). |
| Erreicht der Caller VictoriaMetrics (`vmUrl`)? | **Ja**: Der Service-Name `vmsingle-monitoring-victoria-metrics-k8s-stack.monitoring.svc.cluster.local:8428` antwortet aus dem Alertmanager-Pod. Aus einem Pod im Host-Netzwerk (`dnsPolicy: ClusterFirstWithHostNet`) ist es nicht probiert. Die Abfragen in den Regeln wurden gegen den Live-Cluster geprüft. |
| Piper-CLI-Flags | **Geprüft** mit `piper-tts` 1.8.0: `python -m piper -m de_DE-thorsten-high --data-dir /opt/piper -f raw.wav -- "<text>"` stimmt. Die Stimme lädt `python -m piper.download_voices`. |
| Distribution-baresip | **Unbrauchbar**: Das Ubuntu-Paket 1.1.0 (26.04) kann sich bei `sip.linphone.org` nicht anmelden (`Function not implemented`), die Version 1.0.0 aus 22.04/24.04 hat denselben `libre`-Stand von 2021 und wurde nicht getestet. Siehe [60020](../6-hintergruende/60020-ansible-rollen.md#alert_caller). Deshalb ist baresip 4.12.0 im Image selbst gebaut. Mit 4.12 antwortet der Server auf einen erfundenen Benutzer mit `403 Forbidden`, TLS samt Zertifikatsprüfung funktioniert. |
| Image | **Geprüft**: baut lokal (730 MB), startet als Nutzer 1000 mit `--read-only`, `--cap-drop ALL` und tmpfs-Verzeichnissen. Dort liefen Webhook, echte Piper-Ansage, ein vollständiger Anruf zwischen zwei Instanzen und der Registrierungsversuch bei Linphone (Konto aus Umgebungsvariablen). **Nicht geprüft**: der CI-Build selbst, ARM (der Homeserver ist amd64), der Pod im Cluster. |
| Chart | **Geprüft**: `helm lint`, `helm template`, `yamllint`, Token-Register, `render-bootstrap` ohne Drift. **Nicht geprüft**: Sync in ArgoCD, `hostNetwork` im Cluster. |

---

## Fehlersuche

| Symptom | Hinweis |
|---|---|
| Pod `ImagePullBackOff` | Image noch nicht gebaut oder `image.tag` steht auf `sha-pending` (Schritt 5), oder das GHCR-Paket ist privat |
| Pod `CreateContainerConfigError` | Das Secret `alert-caller-secrets` fehlt: `SIP_PASSWORD` in `values.yaml` ist noch der Platzhalter (Schritt 3). `kubectl -n alert-caller describe sealedsecret alert-caller-secrets` zeigt Entschlüsselungsfehler |
| Pod bleibt `Pending` | Der `homeserver` ist nicht schedulable oder Port 9310 ist belegt (Host-Netzwerk): `kubectl -n alert-caller describe pod` |
| Kein Anruf, Alertmanager meldet `Notify attempt failed` | Service ohne Endpoint (Pod läuft nicht): `kubectl -n alert-caller get endpoints alert-caller` |
| Log `group … in cooldown, no call` | Die Gruppe hat in den letzten 15 min schon angerufen. Neue Alarme in der Gruppe umgehen die Pause. Zum Test den Pod neu starten (`kubectl -n alert-caller rollout restart deploy/alert-caller`) |
| Log `not answered: … reg: … 403 Forbidden` | SIP-Passwort falsch oder Konto unbekannt (`config.sip.user`, versiegelter Wert). Der Caller bricht dann nach wenigen Sekunden ab, statt zu klingeln |
| Log `registration not confirmed in time, dialing anyway` | Die Registrierung kam nicht innerhalb von `registerTimeout`. Ausgehendes TCP 5061 und DNS prüfen. Folgt `failed to create socket for media`, ist der Caller nicht registriert |
| Log `SIP_USER is empty or SIP_PASSWORD contains …` | Das Passwort enthält `;`, `"` oder ein Leerzeichen, oder `config.sip.user` ist leer. Das Passwort bei Linphone ändern und neu versiegeln |
| Log `ice: … STUN Request failed: Protocol error [71]` oder `medianat 'ice' failed` | Der STUN-Server antwortet nicht RFC-5389-konform (so der von Linphone) oder ist nicht erreichbar (ausgehend UDP 3478). `config.sip.stunServer` prüfen |
| Das iPhone nimmt an, aber es ist nur Stille zu hören, im Log `failed to decrypt RTP packet` | SRTP-Suite wurde mitten im Gespräch gewechselt (Linphones re-INVITE mit GCM). Der Patch `patches/baresip-srtp-no-gcm.patch` fehlt im gebauten Image |
| Log `call to … failed: [Errno 13] Permission denied` nach der Ansage | Das Beenden von baresip per Signal ist im Pod nicht erlaubt (AppArmor). Die Fassung von `stop_process`, die `/hangup` und `/quit` schickt, fehlt oder ist nicht ausgerollt |
| Log `Call answered`, dann `session closed: Function not implemented [38]` | Der ACK konnte nicht gesendet werden, weil `libre` das `sips:`-Schema in Linphones Record-Route nicht kennt. Der Patch `patches/libre-sips-route.patch` fehlt im gebauten Image (Dockerfile, Abschnitt `patch -p1`) oder wurde bei einem `re`-Update nicht mehr angewendet |
| Log `session closed: 488 Not acceptable here` | Das iPhone lehnt das Medienangebot ab. Medienverschlüsselung prüfen (`config.sip.mediaEncryption`, Standard `srtp-mand`), danach Codec und die Einstellung „Medienverschlüsselung“ in Linphone |
| Es klingelt, aber das Telefon hört nichts | NAT/ICE (siehe „Geprüft und offen“). `rx.wav peak: 0` bestätigt, dass nichts vom Telefon ankommt |
| iPhone klingelt bei gesperrtem Bildschirm nicht | Linphone muss einmal registriert gewesen sein (Push-Token), Benachrichtigungen erlaubt, Fokus-Modus lässt die App durch |
| Log `could not prepare announcement` oder `speech synthesis failed` | Piper oder sox laufen nicht: `kubectl -n alert-caller exec deploy/alert-caller -- /opt/piper/venv/bin/python -m piper --help`. Der Caller ruft in dem Fall mit einem Warnton an |
| Ansage spricht einen Namen falsch aus | Eintrag in `SPOKEN_NAMES` oder `SPOKEN_REASONS` in `caller.py`, mergen, der Pod startet neu |
| Anruf „Cluster meldet sich nicht“, obwohl der Cluster läuft | Alertmanager erreicht den Caller nicht (siehe oben), oder der Watchdog fehlt: `amtool alert query alertname=Watchdog` im Alertmanager-Pod |
| healthchecks.io meldet sich, obwohl alles läuft | Pings kommen nicht an: Log auf `healthcheck ping failed` prüfen, ausgehendes HTTPS, versiegelte URL |

---

## Notfall-Caller auf dem Vereinsheim-Pi (ausgerollt, Anruf vom Pi noch nicht getestet)

Fällt der Cluster oder der Homeserver aus, ruft der Caller im Cluster nicht mehr an. Deshalb gibt es eine zweite, kleine Instanz auf dem Vereinsheim-Pi (`vereinsheim-alarmmonitor`, anderer Standort, hängt nur am Tailnet). Sie bekommt den Watchdog und ruft an, wenn er 10 Minuten ausbleibt.
Das deckt auch einen Strom- oder Internetausfall im Haus ab. Fällt umgekehrt der Pi aus, kann der Cluster-Caller anrufen (siehe unten, noch nicht eingestellt).

| Eigenschaft | Pi | Cluster |
|---|---|---|
| Hardware | Banana Pi M2 Ultra, **armv7l (32 Bit)**, 2 GB RAM, 4 Kerne, 9 GB frei (Stand 2026-10-11, aus den Metriken) | `homeserver` |
| Ansage | **feste WAV** `capulus-ansible/roles/alert_caller/files/cluster-down.wav` („Achtung, Cluster Alarm. Der Cluster meldet sich seit über 10 Minuten nicht mehr.“, 4,6 s, 16 kHz mono) | Piper, dynamisch je Alarm |
| Piper | nicht installiert: `onnxruntime` hat für 32-Bit-ARM keine Pakete | im Image |
| Webhooks | nur `/watchdog` (`/alert` liefert 404, es gäbe sonst die falsche feste Ansage) | `/alert` und `/watchdog` |
| Firewall | Rolle fasst sie nicht an (`alert_caller_manage_firewall: false`, der Pi hat bisher keine UFW-Konfiguration aus Ansible) | Rolle bzw. UFW des Hosts |
| Konto | dasselbe Linphone-Konto `capulus-core` (mehrere Registrierungen gleichzeitig sind erlaubt) | |

**Die WAV neu erzeugen** (z. B. bei geändertem Text), im Pod des Callers mit derselben Stimme:

```bash
kubectl -n alert-caller exec deploy/alert-caller -- sh -c 'cd /tmp && /opt/piper/venv/bin/python -m piper -m de_DE-thorsten-high --data-dir /opt/piper -f /tmp/cd-raw.wav -- "Achtung, Cluster Alarm. Der Cluster meldet sich seit über 10 Minuten nicht mehr." && sox /tmp/cd-raw.wav -r 16000 -c 1 -b 16 /tmp/cd.wav norm -3'
kubectl -n alert-caller cp $(kubectl -n alert-caller get pod -o jsonpath='{.items[0].metadata.name}'):/tmp/cd.wav capulus-ansible/roles/alert_caller/files/cluster-down.wav
```

Der Text muss zur Watchdog-Ansage in `caller.py` passen (`über {minutes} Minuten`, hier 10).

**Ausrollen** (von einem Rechner, der den Pi per Tailscale erreicht):

1. Das Passwort von `capulus-core` in den Vault: `ansible-vault encrypt_string --ask-vault-pass --name vault_alert_caller_sip_password '<Passwort>'`, Ausgabe in `capulus-ansible/group_vars/all.yml` einfügen (dieselbe Variable wie für die VM-Variante).
2. `make alert-caller-pi-check`, dann `make alert-caller-pi`. Gruppe `alert_caller_pi`, Variablen in `capulus-ansible/group_vars/alert_caller_pi.yml`. Der erste Lauf **baut baresip auf dem Pi aus den Quellen** (2 parallele Jobs, wegen 2 GB RAM und laufendem Kiosk), das dauert deutlich länger als auf einem x86-Rechner.
3. Auf dem Pi prüfen: `journalctl -u alert-caller -n 20` zeigt `listening on :9310 … static announcement /opt/alert-caller/cluster-down.wav`.

**Stand 2026-10-11:** Die Rolle ist auf dem Pi ausgerollt (`make alert-caller-pi`). Die Tailscale-ACL hat eine Regel `tag:tech-node → 100.123.214.4:9310` (`tcp:9310`, nur dieser Port). Der Test aus dem Alertmanager-Pod lieferte `ok` auf `/watchdog` und `404` auf `/alert` (statischer Modus). Die zweite URL ist im Receiver `watchdog` eingetragen (siehe unten).
**Noch offen:** ein echter Anruf vom Pi. Test: auf dem Pi `sudo iptables -I INPUT -p tcp --dport 9310 -j DROP` setzen, dann bleibt der Watchdog aus, und nach rund 11 Minuten muss das Telefon mit der festen Ansage klingeln. Danach die Regel wieder entfernen (`sudo iptables -D INPUT -p tcp --dport 9310 -j DROP`). Im Log des Pi (`journalctl -u alert-caller`) steht `no watchdog for …, calling`.

**Der Alertmanager wurde erst nach dem Test umgestellt (Reihenfolge einhalten).** Voraussetzung ist, dass der Alertmanager-Pod den Pi erreicht: Pod-Verkehr kommt am Pi als `homeserver` (100.74.0.59, Tag `tagged-devices`) an. Vom Homeserver aus antworten die Ports 22 und 9100 des Pi aber nicht (2026-10-11), die ACL lässt ihn
offenbar nicht durch. Dann in der Tailscale-ACL den Homeserver auf `vereinsheim-alarmmonitor:9310` zulassen und prüfen:

```bash
kubectl -n monitoring exec vmalertmanager-monitoring-victoria-metrics-k8s-stack-0 -c alertmanager -- \
  wget -T 5 -qO- --post-data='{}' http://100.123.214.4:9310/watchdog
```

Die Antwort `ok` heißt, der Weg steht. Dann in `argocd/apps/tech/monitoring/values.yaml` beim Receiver `watchdog` eine **zweite** Zeile ergänzen (die erste, den Cluster-Caller, behalten):

```yaml
        - name: watchdog
          webhook_configs:
            - url: 'http://alert-caller.alert-caller.svc.cluster.local:9310/watchdog'
              send_resolved: false
            - url: 'http://100.123.214.4:9310/watchdog'
              send_resolved: false
```

Fällt der Alertmanager aus, während der Cluster läuft, rufen dann beide Caller an (zwei Anrufe). Das ist bewusst in Kauf genommen, solange der Pi-Weg nicht erprobt ist.

**Pi ausgefallen → Cluster ruft an:** Die Regel `BananaPiAlarmmonitorDown` (`vmrule-banana-pi.yaml`, 10 min ohne Metriken, löst bisher ntfy und das Zammad-Ticket aus) bekommt dafür das Label `page: "true"`. Das ist **nicht eingestellt**: Mit der Route `phone` würde der Cluster-Caller dann bei jedem Pi-Ausfall alle 15 Minuten anrufen, bis eine Silence gesetzt ist.

**Offen:** Die Rolle ist gelintet und syntaxgeprüft, der statische Modus im Pod ohne Anruf getestet. Der Build von baresip auf armv7, die Registrierung vom Pi aus und ein echter Anruf vom Pi sind **nicht** geprüft. Der Pi hatte am 27.09. einen mehrtägigen Ausfall (Tailscale antwortete nicht), als Notfall-Caller ist er nur so verlässlich wie er selbst.

---

## Später: externe VM

Soll der Anruf auch bei Ausfall des Clusters, des Homeservers, des Stroms oder des Internets im Haus kommen, muss der Anrufer **außerhalb** laufen (Oracle Cloud Always Free, öffentliche IP, per Tailscale im Tailnet).
Dafür gibt es die Ansible-Rolle `capulus-ansible/roles/alert_caller` (Playbook `capulus-ansible/alert-caller.yml`, Gruppe `alert_callers`, `make alert-caller-check` und `make alert-caller`). Sie benutzt dieselbe `caller.py` wie das Chart
(`argocd/apps/tech/alert-caller/src/caller.py`), baut `baresip` aus den Quellen und installiert Piper. Begründungen: [60020](../6-hintergruende/60020-ansible-rollen.md#alert_caller). Die Rolle wurde in einem Ubuntu-24.04-Container mit systemd geprüft (läuft durch, idempotent, Dienst
als `DynamicUser`, Watchdog nach 600 s), **nicht** auf ARM und nicht in Oracle.

Schritte, wenn es so weit ist:

1. **VM:** Shape `VM.Standard.A1.Flex`, Ubuntu 24.04, öffentliche IP, Benutzer `ubuntu`. Piper braucht rund 250 MB Arbeitsspeicher und etwa 12 CPU-Sekunden je Ansage. In der Security List `UDP 10000-10100` aus `0.0.0.0/0` (Ingress) öffnen.
2. **Secrets:** `ansible-vault encrypt_string --ask-vault-pass --name vault_alert_caller_sip_password '<Passwort>'` und `--name vault_alert_caller_hc_uuid '<UUID>'`, die Ausgaben in `capulus-ansible/group_vars/all.yml` einfügen.
   `capulus-ansible/group_vars/alert_callers.yml`: die SIP-Adresse eintragen (Platzhalter `sip:EINTRAGEN@…` lässt die Rolle abbrechen). `capulus-ansible/inventory/hosts.yml`: `ansible_host` von `alert-caller-vm` setzen.
3. **Tailscale-ACL:** Der Alertmanager-Pod erreicht das Tailnet über die Maskierung des Homeservers und kommt bei der VM als **`homeserver` (100.74.0.59, Tag `tagged-devices`)** an. Die ACL muss diese Quelle auf `<vm>:9310` zulassen.
   Das Netzwerk dahin ist geprüft: Ein SYN aus dem Alertmanager-Pod verlässt den Homeserver auf `tailscale0` mit der Absenderadresse `100.74.0.59` (mit `tcpdump` gesehen). Ob die ACL die Verbindung zur VM erlaubt, lässt sich erst mit der VM prüfen.
4. **Ausrollen:** `make alert-caller-check`, dann `make alert-caller`. Danach `tailscale ip -4` auf der VM, und aus dem Alertmanager-Pod prüfen:
   `kubectl -n monitoring exec vmalertmanager-monitoring-victoria-metrics-k8s-stack-0 -c alertmanager -- wget -T 5 -qO- --post-data='{}' http://<tailscale-ip>:9310/alert` (Antwort `ok`).
5. **Alertmanager umstellen:** In `argocd/apps/tech/monitoring/values.yaml` die beiden Webhook-URLs von `http://alert-caller.alert-caller.svc.cluster.local:9310` auf `http://<tailscale-ip>:9310` ändern. Den Pod im Cluster danach abschalten
   (`replicaCount: 0`), sonst gibt es zwei Caller. Die Kontext-Abfragen (`kontext`) brauchen dann einen lesenden Zugang der VM zu VictoriaMetrics, den es nicht gibt (`vm-write` erlaubt nur Schreiben): `alert_caller_vm_url` bleibt leer, der Kontext fällt weg.
6. **healthchecks.io:** Die Rolle liest `vault_alert_caller_hc_uuid` und bildet daraus `HC_PING_URL`. Der Check hat dasselbe Verhalten wie oben beschrieben.

Weitere Variablen der Rolle: `capulus-ansible/roles/alert_caller/defaults/main.yml` (`alert_caller_*`, entsprechen den Schlüsseln aus „Konfiguration“).
