# 013 ArgoCD-API per Klartext-HTTP (NodePort 30080) für LAN, Tailnet und WireGuard, CI-Token und Admin-Login unverschlüsselt

- Severity: Medium
- Bereich: Netzwerk
- Betroffen: `capulus-ansible/group_vars/all.yml:33` (`argocd_server_insecure: true`), `capulus-ansible/roles/common/tasks/main.yml:195-206`, `scripts/promote-chain.py:374`, `.github/workflows/promote-chain.yml` (`ARGOCD_*_URL` `http://192.168.178.94:30080`)
- Status: Behoben am 2026-10-17 (Hub und ENTW; `server.insecure` bewusst belassen, ACL Stufe 2 und Wiederinbetriebnahme der Promotion-Kette offen)

## Beschreibung

ArgoCD läuft mit `server.insecure: true`. Der NodePort 30080 liefert die API (inklusive `/api/v1/applications`, Admin-Login, CI-Token) unverschlüsselt. Die UFW gibt ihn für 192.168.178.0/24, 100.64.0.0/10 und 10.99.99.0/24 frei. Die Promotion-Kette ruft `http://192.168.178.94:30080` und `http://192.168.178.100:30080` mit Bearer-Token auf. Das Python-Skript baut für `https`-URLs einen TLS-Kontext **ohne Zertifikatsprüfung** (`ssl._create_unverified_context`), sobald jemand auf HTTPS umstellt. Die Entscheidung ist in der Roadmap (Phase 0) dokumentiert; im Audit bleibt sie ein Restrisiko.

## Nachweis

```
$ sed -n 33p capulus-ansible/group_vars/all.yml
argocd_server_insecure: true

$ sed -n 195,206p capulus-ansible/roles/common/tasks/main.yml
- name: Allow ArgoCD NodePort HTTP (port 30080) from LAN and Tailnet only
    port: "30080"
  loop:
    - "{{ local_subnet }}"
    - "100.64.0.0/10"
    - "10.99.99.0/24"

$ sed -n 374p scripts/promote-chain.py
    ctx = ssl._create_unverified_context() if url.startswith("https") else None  # noqa: SLF001 - internes Netz
```

## Phase-2-Nachweis (live, lesend)

Live-Stand: `admin.enabled: "true"`, `accounts.ci: apiKey` mit `policy.csv: g, ci, role:readonly` und `policy.default: ""` (gut: der CI-Token ist schreibgeschützt). Das Secret `argocd-initial-admin-secret` existiert seit 134 Tagen (Incident 041). NodePort 30080 ist vom LAN-Client erreichbar.

## Risiko / Angriffsszenario

Ein Angreifer im LAN schneidet Admin-Passwort bzw. API-Token von ArgoCD mit (Klartext). ArgoCD ist für alle Cluster cluster-admin-äquivalent: mit dem Token lassen sich beliebige Manifeste synchronisieren. Der Tailnet-Abschnitt ist durch WireGuard verschlüsselt, der letzte Hop über das Subnetz-Routing im LAN nicht.

## Empfohlene Behebung

1. ArgoCD-Server wieder mit TLS betreiben (`server.insecure: false`) und über Traefik/Ingress mit dem internen CA-Zertifikat erreichbar machen (`argocd.tech.homeserver` ist bereits im Gebrauch).
2. Promotion-Kette und CLI auf `https://argocd.tech.homeserver` umstellen, die interne Root-CA im Runner hinterlegen (`REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE`) und `_create_unverified_context` durch einen Kontext mit `cafile` ersetzen.
3. NodePort 30080 anschließend schließen.

## Rollback

`argocd_server_insecure: true` wiederherstellen, `make render-bootstrap`, Rolle `argocd` erneut anwenden. Die Quellen der Promotion-URLs zurücksetzen.

## Verifikation

```
curl -sI http://192.168.178.94:30080/api/version
curl -s --cacert homeserver-root-ca.pem https://argocd.tech.homeserver/api/version
```
Der erste Aufruf muss fehlschlagen, der zweite die Version liefern. `gh workflow run promote-chain.yml -f plan_only=true` muss durchlaufen.

## Risiko der Behebung

Mittel: Die Promotion-Kette (CI → ENTW/Hub) und alle ArgoCD-CLI-Nutzer müssen auf die neue URL umgestellt werden.

## Nachtrag zu 008 (2026-10-17)

Die UFW-Regeln für den NodePort `30080` (nur LAN, Tailnet, WireGuard) beschränken den Zugriff nicht: Der NodePort-Verkehr wird von `KUBE-ROUTER-FORWARD` und `KUBE-FORWARD` vor UFW angenommen, die Regeln hatten durchgehend 0 Treffer. Die Klartext-Admin-API von ArgoCD ist damit für jeden erreichbar, der die Node-IP erreicht. Die Behebung dieses Incidents (HTTPS) sollte deshalb nicht auf eine UFW-Beschränkung zählen. Details im Abschnitt „Behebung“ von 008.

## Behebung (2026-10-17)

**Fix.** Zwei Phasen (PR #472 und #474), damit die Promotion-Kette nie ohne Weg zu ArgoCD war.

- **Phase 1:** `promote-chain.py` prüft Zertifikate (`ssl.create_default_context(cafile=ARGOCD_CA_FILE)` statt `_create_unverified_context`). `promote-chain.yml` trägt `argocd.tech.homeserver` und `argocd.dev.homeserver` in `/etc/hosts` des Runners ein, kopiert `pki/homeserver-root-ca.pem` nach `$RUNNER_TEMP` und ruft `https://argocd.tech.homeserver` und `https://argocd.dev.homeserver` auf. `tailscale-poc.yml` und `create-argocd-ci-token.sh` nutzen dieselben HTTPS-Hosts. Die Rolle `argocd` rendert den Service wahlweise als `ClusterIP` (`argocd_server_nodeport_enabled`) und legt aus den Vault-Variablen `argocd_ingress_tls_crt` und `argocd_ingress_tls_key` das TLS-Secret `argocd-server-tls` an. ENTW bekam einen Ingress `argocd.dev.homeserver` mit einem von der Homeserver-Root-CA ausgestellten Zertifikat (365 Tage, Eintrag `entw-argocd-ingress-cert` in `ops/token-register.yaml`).
- **Phase 2:** `argocd_server_nodeport_enabled: false` in `host_vars/homeserver` und `host_vars/entw-vm`. Der Service `argocd-server` ist `ClusterIP`, die NodePorts 30080 und 30443 existieren nicht mehr. Die Rolle `common` löscht die früheren UFW-Freigaben für 30080.
- **Abweichung von Punkt 1:** `server.insecure` bleibt `true`. TLS endet im Traefik, der Hop zum Pod bleibt HTTP im Node. Mit `false` bräche die UI hinter dem Ingress. Das Risiko im Klartext (Admin-Login, CI-Token) ist durch den entfallenen NodePort beseitigt.
- **Abweichung von Punkt 3:** Die UFW-Regel allein hätte nichts bewirkt (siehe Nachtrag zu 008). Wirksam ist erst, dass der Port nicht mehr existiert.

**Nachweis** (live, 2026-10-17):

| Test | Ergebnis |
|---|---|
| `curl http://192.168.178.94:30080`, `http://192.168.178.100:30080`, beide `:30443` | Verbindung abgelehnt (vorher `200`) |
| `kubectl -n argocd get svc argocd-server` (Hub und ENTW) | `ClusterIP`, Ports `80/TCP,443/TCP` (vorher `NodePort 80:30080,443:30443`) |
| `https://argocd.tech.homeserver/api/version` und UI, mit Repo-CA geprüft | `200` |
| `https://argocd.dev.homeserver/api/version` und UI, mit Repo-CA geprüft | `200`, Zertifikat gültig bis 2027-10-17, SAN `argocd.dev.homeserver` |
| `promote-chain.py` gegen beide HTTPS-Hosts (Zertifikatsprüfung aktiv, absichtlich ungültiges Token) | TLS bestanden, `401` für das Token; falsche CA-Datei: Host gilt als nicht erreichbar |
| UFW homeserver | keine Regel für 30080 oder 30443, Loopback-Regel intakt |
| ArgoCD-Anwendungen | Hub alle `Synced`/`Healthy` außer den bereits vorher auffälligen `logging` und `ollama`; ENTW `demo-app`, `example-whoami`, `sealed-secrets` `Healthy` |
| Offene Verbindungen auf 30080 vor dem Umbau (conntrack, beide Hosts) | keine |

**Geänderte Dateien.**

- `scripts/promote-chain.py`, `scripts/create-argocd-ci-token.sh`
- `.github/workflows/promote-chain.yml`, `.github/workflows/tailscale-poc.yml`
- `capulus-ansible/roles/argocd/` (`defaults/main.yml`, `tasks/main.yml`, `templates/argocd-values.yaml.j2`), `capulus-ansible/roles/common/tasks/main.yml`, `capulus-ansible/site.yml`
- `capulus-ansible/host_vars/homeserver/vars.yml`, `capulus-ansible/host_vars/entw-vm/vars.yml` (Ingress, NodePort-Schalter, verschlüsseltes Zertifikat)
- `ops/token-register.yaml` (Eintrag `entw-argocd-ingress-cert`)
- Doku: `docs/6-hintergruende/60030-argocd-und-bootstrap.md`, `60020-ansible-rollen.md`, `600a0-ci-workflows-und-skripte.md`, `docs/b-kubernetes-gitops/b0010-argocd.md`, `b0050-entw-argocd.md`, `docs/f-cicd-automatisierung/f00a0-tailscale-runner-poc.md`, `f00b0-promotion-chain.md`, `docs/d-sicherheit/d0040-internal-tls.md`, `docs/c-netzwerk-dns/c0010-tailscale.md`, `c0011-wireguard-backup.md`, `c0030-port-uebersicht.md`, `docs/a-betriebssystem/a0010-overview.md`, `a0030-installation.md`, `README.md`

**Rollback.** `argocd_server_nodeport_enabled: true` in `host_vars/homeserver` und `host_vars/entw-vm`, dann `make argocd` bzw. `ansible-playbook … entw.yml --tags argocd`. Die UFW-Regeln für 30080 kommen nicht zurück (sie hatten nie gewirkt). Für die Kette `HUB_URL` und `ENTW_URL` über die Repo-Variablen `ARGOCD_HUB_URL` und `ARGOCD_ENTW_URL` auf die alten `http://…:30080`-Adressen setzen und die Tailscale-ACL wieder um `tcp:30080` ergänzen. Zertifikat ENTW: Variablen entfernen, der Ingress rendert dann ohne TLS.

**Offen.**

- **Tailscale-ACL Stufe 2:** `tcp:30080` aus dem `tag:ci`-Grant entfernen (`"ip": ["tcp:443", "tcp:80"]`). Der Port existiert nicht mehr, der Eintrag ist wirkungslos, aber unnötig offen.
- **Promotion-Kette:** `promote-chain.yml` ist manuell deaktiviert, und im Repo fehlen die Secrets `TS_OAUTH_CLIENT_ID` und `TS_AUDIENCE` bzw. früher `TS_OAUTH_SECRET` (nur `TAILSCALE_AUTHKEY` ist vorhanden; Anmeldung seit Incident 015 per Federated Identity). Der Workflow *Tailscale Runner PoC* bricht deshalb schon beim Tailnet-Beitritt ab. Der Runner-Weg per HTTPS ist daher nur lokal simuliert, nicht in GitHub bestätigt. Vor dem Wiedereinschalten OAuth-Client anlegen, PoC ausführen, dann `plan_only`.
- **ENTW-Zertifikat:** läuft am 2027-10-17 ab und wird von Hand erneuert (Ablauf in d0040, Abschnitt „Zertifikat für ArgoCD auf der ENTW-VM“).
- **ENTW-ArgoCD** wurde beim Playbook von `v3.5.3` auf `v3.5.5` angehoben, weil `argocd_version` leer ist.
- **CLI:** `argocd login argocd.tech.homeserver --grpc-web` ist in der Doku beschrieben, aber nicht mit der CLI getestet (CLI nicht installiert). Die API-Strecke über den Ingress ist per `curl` belegt.

