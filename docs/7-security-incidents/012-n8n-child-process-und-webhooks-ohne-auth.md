# 012 n8n: `child_process` freigegeben, mehrere Webhooks ohne Authentifizierung, wirkungslose Basic-Auth-Variable, Secure-Cookie aus

- Severity: Medium
- Bereich: Repo
- Betroffen: `argocd/apps/tech/n8n/values.yaml:55-65`, `argocd/apps/tech/n8n/workflows/*.json`
- Status: Teilweise behoben am 2026-10-17 (Punkt 3 bewusst nicht umgesetzt, `isc-news`-Webhook offen, Rollenlauf `make nightly-worker-wake` steht aus)

## Beschreibung

Vier Beobachtungen am n8n-Chart:

1. `NODE_FUNCTION_ALLOW_BUILTIN: "child_process"` erlaubt jeder Code-Node, beliebige Betriebssystembefehle im Pod auszuführen. Wer Workflows bearbeiten darf (n8n-Konto), hat damit Codeausführung im Container und Zugriff auf die NFS-Mounts (`xibosignage-inbox`, `-display`) sowie die Credentials im n8n-Store. Mehrere Workflows nutzen `executeCommand` bewusst (`find … -delete`).
2. Die Webhooks `alamos-einsatz` (GET und POST), `banana-pi-down`, `nightly-worker-update` haben keine Authentifizierung (`authentication` leer) und keine Header-Prüfung im Workflow. `isc-news` prüft einen Bearer-Header. Über `n8n.prod.homeserver` sind sie aus dem gesamten LAN erreichbar und lösen Zammad-Tickets und Benachrichtigungen aus.
3. `N8N_BASIC_AUTH_ACTIVE: "true"` ist seit n8n 1.0 wirkungslos. Die tatsächliche Anmeldung läuft über die eingebaute Benutzerverwaltung; die Variable vermittelt einen Schutz, der nicht existiert.
4. `N8N_SECURE_COOKIE: "false"` und `N8N_PROTOCOL: http`: Session-Cookies tragen kein `Secure`-Flag.

Positiv: Der einzige öffentliche Pfad (`/webhook/instagram-bild`) ist per Exact-Match und strenger Eingabeprüfung (`^[0-9a-f]{32}$`) abgesichert, der Dateipfad lässt sich nicht manipulieren.

## Nachweis

```
$ grep -n -E 'N8N_PROTOCOL|N8N_SECURE_COOKIE|N8N_BASIC_AUTH_ACTIVE|NODE_FUNCTION_ALLOW_BUILTIN' argocd/apps/tech/n8n/values.yaml
57:  N8N_PROTOCOL: "http"
59:  N8N_SECURE_COOKIE: "false"
62:  N8N_BASIC_AUTH_ACTIVE: "true"
64:  NODE_FUNCTION_ALLOW_BUILTIN: "child_process"

$ Webhook-Nodes (Auszug)
alamos-einsatz-to-zammad.json   Webhook (GET/POST)     authentication: –
banana-pi-down-to-zammad.json   Alertmanager Webhook   authentication: –
nightly-worker-update-to-zammad.json  Webhook          authentication: –
isc-news-veroeffentlichen.json  Webhook                Header-Prüfung vorhanden
```

## Risiko / Angriffsszenario

Ein LAN-Gerät kann gefälschte Einsatz-Tickets, Banana-Pi-Ausfall- und Update-Meldungen erzeugen (Alarmrauschen, Ablenkung), mit Zugriff auf die n8n-Oberfläche wird `child_process` zum Sprungbrett auf NFS und Cluster-Credentials. Die Cookie-Konfiguration schwächt Session-Schutz bei gemischtem HTTP/HTTPS-Zugriff.

## Empfohlene Behebung

1. Webhook-Nodes auf `authentication: headerAuth` mit einem Credential umstellen; Quellen (Alamos-Relay, Alertmanager, Skripte) senden den Header.
2. `N8N_SECURE_COOKIE` auf `"true"`, `N8N_PROTOCOL` auf `https` und `WEBHOOK_URL` auf die HTTPS-URL setzen; `N8N_BASIC_AUTH_ACTIVE` entfernen.
3. `child_process` nur lassen, wenn die `executeCommand`-Workflows nötig sind. Sonst `NODES_EXCLUDE` um `n8n-nodes-base.executeCommand` erweitern und die Aufräumjobs durch Kubernetes-CronJobs ersetzen.
4. Owner-Konto in n8n mit starkem Passwort und 2FA (n8n unterstützt TOTP) betreiben.

## Rollback

Env-Werte zurücksetzen, Workflows aus dem Repo erneut importieren (Authentifizierung wieder auf `none`).

## Verifikation

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://n8n.prod.homeserver/webhook/alamos-einsatz -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "X-Webhook-Token: $TOKEN" https://n8n.prod.homeserver/webhook/alamos-einsatz -d '{}'
```
Erwartung: ohne Header `403`, mit Header `200`; Cookie im Browser trägt `Secure`.

## Risiko der Behebung

Niedrig bis mittel: Quellen der Webhooks (Alamos-Relay, Alertmanager, Worker-Skripte) müssen den Header mitsenden, sonst bleiben Tickets/Alarme aus.

## Behebung (2026-10-17)

**Fix.**

- **Webhook-Authentifizierung (Punkt 1):** `alamos-einsatz` (GET und POST), `banana-pi-down` und `nightly-worker-update` stehen auf *Header Auth* (`Authorization: Bearer`). Je Webhook ein eigenes n8n-Credential (`Webhook alamos-einsatz`, `Webhook banana-pi-down`, `Webhook nightly-worker-update`), je ein eigenes 48-stelliges Hex-Token. Sender: alamos-relay (Schlüssel `n8nToken` im SealedSecret `alamos-relay-secrets`), Alertmanager (SealedSecret `n8n-webhook-token` im Namespace `monitoring`, `http_config.authorization`), `nightly-worker-wake.sh` (Header-Datei `/etc/nightly-worker-wake/n8n-auth-header` aus der Vault-Variable `vault_n8n_nightly_webhook_token`). Reihenfolge beim Einschalten: erst die Sender (PR #471), dann n8n, damit kein Alarm verloren geht.
- **Umgebung (Punkt 2):** `N8N_SECURE_COOKIE: "true"`, `WEBHOOK_URL` und neu `N8N_EDITOR_BASE_URL` auf `https://n8n.prod.homeserver`, `N8N_BASIC_AUTH_ACTIVE` entfernt. `N8N_PROTOCOL` bleibt bewusst `http`: Der Pod-Listener spricht HTTP, TLS endet an Traefik, die Probes sind HTTP. Ein `https` hätte den Start und damit den Einsatzalarm riskiert.
- **Nightly-Wake zusätzlich:** URL auf `https://`, `curl --fail`. Mit `http://` lief der Bericht auf das `301` von Traefik und kam nie an, ohne Warnung im Journal.
- **`child_process` (Punkt 3) bewusst belassen:** Der WhatsApp-Sendeprozess braucht `child_process`, drei Workflows nutzen Execute Command (Aufräumen bei Xibo und Instagram, Ollama-Skalierung im KI-Lauf). Ein Umbau auf CronJobs würde laufende Workflows ändern. Restrisiko begrenzt durch 2FA.
- **2FA (Punkt 4):** am Owner-Konto eingerichtet (vom Betreiber bestätigt).
- **Nicht abgesichert:** `/webhook/isc-news` (Aufrufer ist eine externe Website, Header-Fähigkeit offen; ein Token im Browser wäre öffentlich) und `/webhook/instagram-bild` (bewusst öffentlich).

**Nachweis** (live):

| Test | Ergebnis |
|---|---|
| `alamos-einsatz` POST und GET ohne Header | `403` (vorher `200`) |
| `alamos-einsatz` falscher Header, Token einer anderen Quelle | `403` |
| `alamos-einsatz` POST und GET mit dem Relay-Token | `200` (leere Payload, kein Ticket) |
| `banana-pi-down`, `nightly-worker-update` ohne Header und mit falschem Header | `403` |
| Relay-Pod → n8n (POST und GET über `localhost:8080/relay/<Token>`) | `200`, der Relay sendet den Header selbst |
| Alertmanager | Konfiguration geladen, gemountete Token-Datei hat denselben SHA-256 wie die Quelle des n8n-Credentials |
| `instagram-bild` | weiter erreichbar (unbekannte ID `404`) |
| n8n nach dem Rollout | 11 von 14 Workflows aktiv wie vorher, Webhook-Antwortzeit unter 0,2 s, Env im Deployment wie in `values.yaml` |

Positivtests für `banana-pi-down` und `nightly-worker-update` wurden nicht ausgeführt, weil sie echte Zammad-Tickets (mit Mail an `alamos@andernach.dlrg.de`) erzeugen. Der Nachweis kommt vom ersten echten Alertmanager-Aufruf und vom Lauf um 01:00 Uhr.

**Geänderte Dateien.**

- `argocd/apps/tech/n8n/values.yaml`, `argocd/apps/tech/n8n/workflows/alamos-einsatz-to-zammad.json`, `banana-pi-down-to-zammad.json`, `nightly-worker-update-to-zammad.json`
- `argocd/apps/tech/alamos-relay/` (`templates/configmap-script.yaml`, `deployment.yaml`, `sealedsecret.yaml`, `values.yaml`)
- `argocd/apps/tech/monitoring/` (`values.yaml`, `templates/sealedsecret-n8n-webhook-token.yaml`)
- `ansible/roles/nightly_worker_wake/` (`files/nightly-worker-wake.sh`, `defaults/main.yml`, `tasks/main.yml`), `ansible/group_vars/all.yml` (nur die Vault-Variable)
- `ops/token-register.yaml` (drei neue Einträge)
- Doku: `docs/3-apps-workloads/30070-n8n.md`, `300h0-alamos-einsatz-zammad.md`, `300i0-alamos-relay.md`, `30020-vereinsheim-alarmmonitor.md`, `docs/2-betrieb-hardware/20030-nightly-worker-update.md`, `docs/6-hintergruende/60040-helm-charts-tech.md`

**Rollback.** Live: Webhook-Nodes der drei Workflows in n8n wieder auf *Authentication: None* stellen (oder die Workflows aus dem Export vor der Änderung wiederherstellen). Repo: PR #471 revertieren; ArgoCD stellt Relay, Alertmanager und n8n-Env zurück, die Credentials in n8n bleiben unbenutzt stehen und können gelöscht werden. Nightly-Wake: Rollenlauf `make nightly-worker-wake` nach dem Revert. Die Exporte der drei Workflows vom 2026-10-17 liegen nur im Scratchpad der Sitzung.

**Offen.**

- **Rollenlauf:** `make nightly-worker-wake` bringt Skript, `https://`-URL und Header-Datei auf den homeserver. Bis dahin antwortet n8n dem Bericht von 01:00 Uhr mit `403` (nur das Ticket fehlt, der Zyklus läuft normal).
- **`isc-news`-Webhook** ohne Authentifizierung (externer Aufrufer). Lösungsansatz offen: Absender prüfen oder den Weg über einen kleinen Relay mit Pfad-Token wie bei alamos-relay führen.
- **Cookie-Flag** nur über die Umgebungsvariable belegt, ein Blick im Browser (Entwicklerwerkzeuge, Cookie `n8n-auth`) bestätigt `Secure`.
- **Beobachtung:** Nach dem Neustart meldet n8n wiederholt „Database ping failed: Database connection timed out“ (SQLite auf dem NAS-PVC), Webhooks und API antworten dennoch, die Readiness flackert zeitweise. Ursache nicht untersucht, ein Zusammenhang mit der Umgebungsänderung ist unwahrscheinlich, der Zustand davor ist nicht protokolliert.
