# 002 ntfy ist öffentlich erreichbar und erlaubt per Default anonymes Lesen und Schreiben

- Severity: High
- Bereich: Extern
- Betroffen: `argocd/apps/tech/ntfy/values.yaml:65` (`auth-default-access: "read-write"`), Host `ntfy-tech.pke-lab.de` (Cloudflare-Tunnel)
- Status: Behoben am 2026-10-17 (Restpunkte: worker-1, Host-Skripte siehe 046)

## Beschreibung

ntfy läuft mit `auth-default-access: "read-write"` und ist über den Wildcard-Tunnel `*.pke-lab.de` im Internet erreichbar (`ntfy-tech.pke-lab.de`, Pfad `/`). Anonyme Clients dürfen damit auf allen Topics lesen und schreiben, für die keine explizite ACL das Gegenteil festlegt. Die Betriebsdoku sagt selbst, dass ein Topic öffentlich ist, solange dieser Wert gesetzt ist, und beschreibt `deny-all` als Zielzustand (`docs/1-benachrichtigungen/10010-ntfy.md`, Zeilen 78 und 138). Im Chart steht der Zielzustand nicht.

Ob für die produktiv genutzten Topics (`Home-Lab`, `Home-Lab-System`, `alerts`) explizite Deny-Regeln in `auth.db` existieren, lässt sich nur auf dem laufenden Pod bzw. per externem Test klären (Phase 2/3). Die Konfiguration im Repo erlaubt es.

## Nachweis

```
$ grep -n 'auth-default-access' argocd/apps/tech/ntfy/values.yaml
65:  auth-default-access: "read-write"

$ grep -n 'pke-lab.de' argocd/apps/tech/ntfy/values.yaml
46:    - host: ntfy-tech.pke-lab.de
60:  base-url: "https://ntfy-tech.pke-lab.de"

$ sed -n 78p docs/1-benachrichtigungen/10010-ntfy.md
> **Hinweis:** Das Topic ist öffentlich zugänglich solange `auth-default-access: read-write` gesetzt ist. [...]
```

## Phase-2-Nachweis (live, lesend)

Live auf dem Pod geprüft (nur Lesebefehl, keine Änderung):

```
$ kubectl -n ntfy exec deploy/ntfy -- ntfy user list
user * (role: anonymous, tier: none)
- no topic-specific permissions
- read-write access to all (other) topics (server config)
```
Es existieren **keine Benutzer, keine Tokens und keine Topic-ACLs**. Die im Betriebs-Doc beschriebenen Benutzer (`admin`, `publisher`) wurden nie angelegt. Jeder, der den Host erreicht, darf auf allen Topics lesen und schreiben. Der Nachweis von außen (Anonymer Publish über `ntfy-tech.pke-lab.de`) gehört in Phase 3.

## Risiko / Angriffsszenario

Ein Angreifer kann (a) mitlesen, was auf den Topics landet (Hostnamen, Dienstzustände, Alarmtexte aus dem Vereins-/Feuerwehrumfeld), (b) gefälschte Alarme oder Entwarnungen einspeisen, die die iOS-App und der Telefon-Alarm als echt darstellen, (c) über Anhänge (5 MB je Datei, 100 MB gesamt) Speicher füllen und (d) Topic-Namen erraten, da Topics bei diesem Modus de facto als Passwort dienen.

## Empfohlene Behebung

1. Nutzer und ACLs anlegen, bevor der Default geändert wird:
   ```
   kubectl -n ntfy exec -it deploy/ntfy -- ntfy user add --role=admin admin
   kubectl -n ntfy exec -it deploy/ntfy -- ntfy user add publisher
   kubectl -n ntfy exec -it deploy/ntfy -- ntfy user add reader
   kubectl -n ntfy exec -it deploy/ntfy -- ntfy access publisher 'Home-Lab*' write-only
   kubectl -n ntfy exec -it deploy/ntfy -- ntfy access reader 'Home-Lab*' read-only
   kubectl -n ntfy exec -it deploy/ntfy -- ntfy token add publisher
   kubectl -n ntfy exec -it deploy/ntfy -- ntfy token add reader
   ```
2. Tokens als SealedSecret ablegen (`printf '%s' "$WERT" | kubeseal --raw …`, nie Here-String) und in ntfy-bridge, Alertmanager-Webhook, n8n-Workflows und `carplay-api` (`NTFY_TOKEN`) eintragen.
3. Erst danach im Chart umstellen:
   ```diff
   -  auth-default-access: "read-write"
   +  auth-default-access: "deny-all"
   ```
4. Zusätzlich im Cloudflare-Dashboard für `ntfy-tech.pke-lab.de` eine Access-Policy oder WAF-Rate-Limit-Regel setzen (Incident 005). Die ntfy-Apps können mit Basic-Auth bzw. Token umgehen, einen Service Token für Maschinen-Clients einplanen.

## Rollback

`auth-default-access` zurück auf `"read-write"` stellen und ArgoCD synchronisieren. Die angelegten Nutzer und Tokens in `auth.db` bleiben bestehen und stören nicht.

## Verifikation

```
curl -s -o /dev/null -w '%{http_code}\n' -d 'audit-test' https://ntfy-tech.pke-lab.de/audit-test
curl -s -o /dev/null -w '%{http_code}\n' 'https://ntfy-tech.pke-lab.de/Home-Lab/json?poll=1'
```
beide müssen `401` oder `403` liefern. Mit Publisher-Token (`-H "Authorization: Bearer …"`) muss das Senden auf `Home-Lab` funktionieren, ein Test-Alarm bis zum Telefon-Alarm und zur iOS-App durchlaufen.

## Risiko der Behebung

Hoch: Alarmierung bricht still, wenn Publisher (Alertmanager/ntfy-bridge, Skripte, n8n) vor der Umstellung keinen Token bzw. keine Schreib-ACL haben.

## Behebung (2026-10-17)

**Fix in zwei Stufen** (der Default durfte erst umgestellt werden, nachdem alle Sender und Leser Zugangsdaten hatten):

1. **Stufe 1** (PR #449, Commit `e441b50`): Nutzer `publisher` (write-only) und `reader` (read-only) mit ACLs auf `Home-Lab*`, `Alarmmonitor`, `instagram`, `isc-news`, `isc-urkunden`, `whatsapp-relay` und `zammad*`, je ein Token. Die Tokens liegen als SealedSecret bei ntfy-bridge, alamos-apager und carplay-api, als Header-Auth-Credential „ntfy-publisher“ in n8n (11 Nodes in vier Workflows), als Vault-Variable `ntfy_publisher_token` mit Header-Datei `/etc/ntfy-publisher/auth-header` auf den Hosts. Ein Web-Admin wurde nicht angelegt (Verwaltung per `kubectl exec`). Der Default blieb `read-write`, die Sender sendeten mit Token.
2. **Stufe 2** (PR #451): `auth-default-access: "deny-all"` in `argocd/apps/tech/ntfy/values.yaml`. Das `checksum/config` startet den Pod neu.

**Nachweis** (nach der Umstellung, intern `ntfy.tech.homeserver` und extern `ntfy-tech.pke-lab.de`):

| Test | Ergebnis |
|---|---|
| Anonym senden an `Home-Lab-System` und an ein beliebiges Topic | `403` (vorher `200`) |
| Anonym lesen `Home-Lab/json?poll=1` | `403` (vorher `200`) |
| `publisher` sendet an `Home-Lab-System` | `200` |
| `publisher` liest | `403` (write-only) |
| `reader` liest `Home-Lab` | `200` |
| `reader` sendet | `403` (read-only) |
| Alertmanager-Bridge, Testalarm | durchgelaufen, Meldung in `Home-Lab` im Cache, Publisher-Token vom Bridge-Pod genutzt |
| n8n, ISC-News-Webhook mit leerem Body (Zweig „Eingaben ungültig“) | alle Nodes `ok`, Publisher-Token vom n8n-Pod genutzt |
| carplay-api `/health` | ntfy `ok`, Reader-Token vom carplay-api-Pod genutzt |
| ntfy-App und Uptime Kuma mit Benutzerdaten | Meldungen kommen an (vom Betreiber bestätigt) |

Ein falscher Token wird auch bei offenem Default mit `401` abgelehnt, sodass erfolgreiche Sendungen mit Token den Token bewiesen haben.

**Geänderte Dateien.**

- `argocd/apps/tech/ntfy/values.yaml`
- `argocd/apps/tech/ntfy-bridge/` (`values.yaml`, `templates/configmap.yaml`, `templates/deployment.yaml`, neu `templates/secret-ntfy-token.yaml`)
- `argocd/apps/tech/alamos-apager/` (`values.yaml`, `templates/configmap-script.yaml`, `templates/deployment.yaml`, neu `templates/secret-ntfy-token.yaml`)
- `argocd/apps/tech/carplay-api/values.yaml`
- `argocd/apps/tech/n8n/workflows/` (fünf Workflow-JSONs)
- `capulus-ansible/roles/ntfy_publisher/` (neu), `capulus-ansible/roles/{thermal_watchdog,resource_watchdog,cluster_power_manager,nightly_worker_wake}/files/*.sh`, sechs Playbooks, `capulus-ansible/group_vars/all.yml` (`ntfy_publisher_token` als Vault-Wert)
- `scripts/seal-ntfy-tokens.sh` (neu), `ops/token-register.yaml`
- Doku: `docs/1-benachrichtigungen/10010-ntfy.md`, `docs/3-apps-workloads/30070-n8n.md`, `docs/6-hintergruende/{60020,60040,60080,600a0}`, `docs/f-cicd-automatisierung/f0070-ci-lint.md`

**Rollback.** In `argocd/apps/tech/ntfy/values.yaml` `auth-default-access` zurück auf `"read-write"`, mergen, ArgoCD synchronisiert in wenigen Minuten. Nutzer und Tokens bleiben in `auth.db` erhalten und stören nicht. Zum Entfernen: `kubectl -n ntfy exec deploy/ntfy -- ntfy user del publisher` und `… user del reader`. Vor der Änderung wurde `auth.db` gesichert (Prüfsumme verglichen). Die Token-Änderungen in den Charts sind rückwärtskompatibel (`secrets.ntfyToken.enabled: false` sendet wieder anonym).

**Restpunkte.**

- worker-1 war ausgeschaltet. Dort fehlt die Header-Datei, bis `capulus-ansible/worker-1.yml --tags ntfy-publisher,thermal` gelaufen ist. Bis dahin würden seine Meldungen (sobald 046 behoben ist) mit `403` abgelehnt.
- alamos-apager sendet nur bei Stationsausfall und konnte live nicht getestet werden. Die gerenderte Skript-Funktion wurde lokal gegen einen Listener geprüft: Mit Token kommt `Authorization: Bearer …` an, ohne Token keiner.
- Dass keine weiteren anonymen Sender existieren, ließ sich nicht beweisen: ntfy protokolliert abgelehnte Anfragen im Standard-Loglevel nicht, der Cache hält nur 12 Stunden, Traefik schreibt kein Access-Log. Ein übersehener Sender fällt durch fehlende Meldungen auf.
- Neuer Befund 046: Die Host-Skripte senden wegen eines Redirects seit 2026-09-13 nichts an ntfy.
- Die Tokens laufen nicht ab (siehe 021). Cloudflare Access für `ntfy-tech.pke-lab.de` gehört zu 005.
- Der Publisher-Token stand im Chatverlauf der Bearbeitung und wurde als Vorsichtsmaßnahme zur Rotation nach dem Rollout vorgemerkt (Ablauf in 10010, „Zugangsdaten und Token-Rotation“).
