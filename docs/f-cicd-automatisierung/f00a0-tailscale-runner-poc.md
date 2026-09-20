# Tailscale-Runner-PoC — erreicht ein GitHub-Runner ArgoCD und ENTW?

[`.github/workflows/tailscale-poc.yml`](../../.github/workflows/tailscale-poc.yml) ist die Diagnose für die
[Promotion-Kette](f00b0-promotion-chain.md) (Phase 0, Schritt 0.8 in
[40080](../4-planung/40080-multi-cluster-entw-prod-tech.md)): Kann ein GitHub-Actions-Cloud-Runner per Tailscale dem
Tailnet beitreten und die nicht öffentlich erreichbaren ArgoCD-Instanzen ansprechen? Das Gate der Kette
(24 h gesund auf ENTW, 2 h auf TECH) braucht genau diese Verbindung. Der Workflow läuft nur manuell.

## Ergebnis des ersten Laufs (2026-09-20) und was daraus folgt

Der erste Lauf mit der ursprünglichen Fassung schlug im Schritt „Reach ArgoCD“ mit `HTTP 000` fehl. Der
Beitritt ins Tailnet selbst klappte: der Runner erschien als Gerät des Benutzers (nicht getaggt) und sah
`homeserver`, `worker-1` und die übrigen Geräte. Die Untersuchung danach ergab zwei Ursachen und eine offene Frage:

| Befund | Beleg |
|---|---|
| Der PoC sprach das **falsche Ziel** an. ArgoCD läuft per NodePort im **Klartext** (`server.insecure`), `https://…:30443` wird zurückgesetzt, auch direkt im LAN. Richtig ist `http://…:30080`. | `curl` vom Arbeitsplatz: `https://192.168.178.94:30443` → Verbindung zurückgesetzt, `http://192.168.178.94:30080` → 200 |
| Der Homeserver bewirbt das LAN-Subnetz `192.168.178.0/24` ins Tailnet. Damit sind **beide** ArgoCD-Instanzen (`192.168.178.94:30080`, ENTW `192.168.178.100:30080`) über eine Route erreichbar, ohne Änderung an worker-1. | `tailscale status --json` auf dem Homeserver: `PrimaryRoutes: 192.168.178.0/24` |
| **Offen:** ob die ACL dem Runner die Verbindung erlaubt. Die Grants (40080) erlauben Mitgliedern nur `tcp:443` auf die Cluster-Knoten. Vom Arbeitsplatz aus liefen alle Ports der Tailnet-Adresse des Homeservers in ein Timeout (auch 22 und 443), das LAN dagegen antwortete, ein Rückschluss auf den Runner ist daher nicht möglich. | Portprobe `100.74.0.59`, `100.124.213.94` |

Die neue Fassung des Workflows testet deshalb **jeden Weg einzeln** und gibt eine Tabelle aus. Sie schlägt erst am Ende
fehl, und nur dann, wenn ein für die Kette nötiger Weg fehlt.

## Was der Workflow prüft

| Weg | Ziel | Nötig? | Nötiger Grant |
|---|---|---|---|
| `hub-lan` | Hub-ArgoCD `192.168.178.94:30080`, `/api/version` | ja | `192.168.178.94`, `tcp:30080` |
| `entw` | ENTW-ArgoCD `192.168.178.100:30080`, `/api/version` | ja | `192.168.178.100`, `tcp:30080` |
| `smoke` | ENTW-Ingress `192.168.178.100:80` mit Host `whoami.dev.homeserver` | optional (Smoke-Checks) | `192.168.178.100`, `tcp:80` |
| `hub` | Hub über die Tailnet-Adresse des Homeservers | nur Diagnose | `tag:tech-node`, `tcp:30080` |

Der Runner tritt mit `--accept-routes` bei, sonst nutzt er die Subnet-Route nicht. `/api/version` ist bei ArgoCD
ohne Anmeldung erreichbar.

## Voraussetzungen

| Was | Wo |
|---|---|
| Repo-Secret `TAILSCALE_AUTHKEY` | GitHub → Settings → Secrets (gesetzt am 2026-09-18). Für wechselnde Runner passt ein *reusable*, *ephemeral* Key. Die Voreinstellungen für Server-Keys (single-use, nicht ephemeral) in [c0010](../c-netzwerk-dns/c0010-tailscale.md#auth-key-besorgen) gelten hier nicht. |
| ACL-Grant für den Runner | siehe [Promotion-Kette → Netzweg](f00b0-promotion-chain.md#netzweg-und-zugriff): empfohlen ein Tag `tag:ci` mit Grant auf die beiden LAN-Adressen; Grundlagen in [c0010 → ACL-Konfiguration](../c-netzwerk-dns/c0010-tailscale.md#acl-konfiguration) |
| Freigegebene Subnet-Route `192.168.178.0/24` des Homeservers | Tailscale-Admin-Panel (ist freigegeben) |

## Ausführen und Ergebnis

GitHub → Actions → „Tailscale Runner PoC“ → *Run workflow*. Ausgabe der Probe, lokal vom Arbeitsplatz im LAN
ausgeführt (dort gilt keine Runner-ACL, die Tailnet-Adresse filtert aber trotzdem):

```
hub       100.74.0.59:30080                  TCP zu/gefiltert  HTTP 000  (nur Diagnose)
hub-lan   192.168.178.94:30080               TCP offen         HTTP 200  "Version":"v3.5.3"
entw      192.168.178.100:30080              TCP offen         HTTP 200  "Version":"v3.5.3"
smoke     192.168.178.100:80 (whoami.dev)    TCP offen         HTTP 200  (Smoke-Tests, optional)

OK: hub-lan und entw erreichbar - die Promotion-Kette kann die Gates auswerten.
```

`OK` = die Kette kann die Gates auswerten; Schritt 0.8 in 40080 ist erledigt. Die Skriptlogik ist lokal
geprüft; **die Fassung wurde noch nicht auf GitHub ausgeführt** (der GitHub-Lauf nutzt die Datei auf `main`), der
Netzweg des Runners ist also weiter unbestätigt.

## Troubleshooting

| Symptom | Ursache / Lösung |
|---|---|
| Schritt „Connect runner to tailnet“ scheitert mit Auth-Fehler | Key abgelaufen, nicht reusable oder falsch kopiert: neuen Key erzeugen, Secret ersetzen. |
| `hub-lan`/`entw`: `TCP zu/gefiltert` (Timeout) | ACL erlaubt den Runner nicht: Grant auf die LAN-Adresse und den Port ergänzen. Ein Timeout (statt sofortiger Ablehnung) ist typisch für gefilterten Verkehr. |
| `hub-lan`/`entw`: sofort abgelehnt | Die Route kommt an, aber der Dienst antwortet nicht: läuft ArgoCD (`server.insecure`, NodePort 30080)? Bei ENTW: `ssh ubuntu@192.168.178.96 'sudo virsh list --all'`, VM muss `running` sein. |
| Route nicht sichtbar (Fehler „no route“) | `--accept-routes` fehlt oder die Subnet-Route ist im Admin-Panel nicht freigegeben. |
| `hub` (Tailnet-Adresse) filtert, `hub-lan` geht | erwartbar, wenn nur das Subnetz freigegeben ist. Die Kette nutzt `hub-lan`. |
| Workflow bricht mit „FEHLGESCHLAGEN“ ab | Meldung des letzten Schritts: mindestens `hub-lan` oder `entw` ist nicht erreichbar, siehe die Zeilen darüber. |
