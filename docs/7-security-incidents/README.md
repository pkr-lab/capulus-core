# Security-Audit: Incidents

Stand: 2026-10-16. Dieses Verzeichnis enthält die Findings des Security-Audits der eigenen Infrastruktur. Jedes Finding liegt in einer eigenen Datei `NNN-slug.md`, diese Seite sortiert sie nach Severity.

---

## Zusammenfassung

**Offene Handgriffe:** [TODO.md](TODO.md) sammelt alles, was nach der Behebung noch bei dir liegt.

**Bearbeitungsstand.** Phase 1 (Repository) und Phase 2 (Hosts und Cluster, **ausschließlich lesend**) sind durchgeführt. Phase 2 deckt den homeserver, worker-1, prod-vm und entw-vm per SSH sowie den TECH-Cluster per `kubectl` ab. **worker-0** war ausgeschaltet („No route to host“) und ist ungeprüft; er wurde bewusst nicht geweckt. `lynis` ist auf den Hosts nicht installiert und wurde nicht nachinstalliert (Rückfrage offen). Phase 3 (externe Angriffsfläche) und Phase 3b (Logins) sind **nicht Teil dieses Laufs**: Der Nutzer gibt sie an Claude Code online ab, die Übergabe steht in [phase-3-uebergabe.md](phase-3-uebergabe.md). Ein Portscan wurde nicht ausgeführt, Verbindungstests liefen nur zu bekannten Ports im LAN. Was nur von außen prüfbar ist, steht in den Incidents als „Phase 3“.

**Behebungsstand.** Die Behebung läuft seit 2026-10-17 in Nummernfolge, eine Nummer pro Durchgang. Behoben: [001](001-privater-ssh-schluessel-in-git-historie.md) (Schlüssel auf keinem erreichbaren Host autorisiert, Restpunkt worker-0). [002](002-ntfy-oeffentlich-mit-anonymem-schreibzugriff.md) (ntfy mit `deny-all`, Restpunkt worker-1). [004](004-vaultwarden-admin-oberflaeche-oeffentlich.md) (`/admin` auf dem öffentlichen Host gesperrt). [005](005-wildcard-tunnel-ohne-vorgelagerte-zugangskontrolle.md) zurückgestellt (Wildcard bleibt vorerst, Maßnahmen in der Datei). [006](006-netzwerkrichtlinien-prod-und-egress-fehlen.md) teilweise (Ingress-Default-Deny in sechs PROD-Namespaces, Egress offen). [007](007-k3s-kubeconfig-weltlesbar.md) (Kubeconfig auf `0600`, drei Hosts, ohne k3s-Neustart). [008](008-ufw-lan-tailnet-voll-vertraut-und-offene-clusterports.md) teilweise (offene Cluster-Ports auf vier Hosts geschlossen, LAN-Pauschale nur auf dem homeserver ersetzt; Befund: UFW wirkt nicht auf NodePorts). [009](009-ssh-haertung-nicht-verwaltet.md) (alle sieben Hosts schlüsselbasiert). [010](010-alert-caller-ohne-authentifizierung.md) Stufe 1 live (Token im Modus `log`, Pi und `enforce` offen). [011](011-power-agent-und-wol-agent-klartext-root.md) (Agenten gehärtet, power-agent nur noch über die Pod-Bridge erreichbar, WoL-Agent nur am Tailnet). [012](012-n8n-child-process-und-webhooks-ohne-auth.md) teilweise (drei Webhooks mit Header-Auth, Cookie `Secure`, HTTPS-URLs; `child_process` bewusst belassen, `isc-news`-Webhook offen, Rollenlauf `make nightly-worker-wake` steht aus). [013](013-argocd-api-klartext-http.md) (NodePort 30080/30443 entfernt, API und CI nur über HTTPS-Ingress, Zertifikatsprüfung in der Promotion-Kette; `server.insecure` bleibt, ACL Stufe 2 offen). [014](014-github-security-funktionen-deaktiviert.md) (Secret Scanning, Push Protection, Dependabot-Alerts und -Fixes an; Non-Provider-Patterns nicht aktivierbar, Workflow `security-issues.yml` bewusst deaktiviert). [015](015-ci-actions-nicht-gepinnt-tailscale-latest.md) teilweise (alle Actions auf Commit-SHAs, Tailscale-Client fest, Renovate-Pinning; OAuth-Client-Scope ist ein Handgriff im Admin-Panel). [016](016-carplay-api-go-abhaengigkeiten-verwundbar.md) (Go-Abhängigkeiten angehoben, `govulncheck` sauber, ausgerollt, 0 Dependabot-Alerts). [017](017-ansible-installer-ohne-integritaetspruefung.md) (Installer und Archive mit Prüfsumme bzw. Fingerprint, k3s-Installer auf Commit gepinnt, Helm per Tarball, CrowdSec ohne Skript; wirkt beim nächsten Rollenlauf). [018](018-ios-app-klartext-http-mit-bearer-token.md) (App spricht `https://` mit `carplay-api` und WoL-Agent, ATS-Ausnahme entfernt, Agent-Zertifikat im Token-Register; WoL-Token rotiert; Gerätetest, neues Token in der App und Rollenlauf auf dem Pi offen, Pinning nicht umgesetzt). [019](019-headlamp-statisches-cluster-admin-token.md) Headlamp ohne `cluster-admin` und ohne statisches Token, Anmeldung mit Stunden-Token der Rolle `view`; nach dem Merge zu prüfen, Altlast in `kube-system` offen. [020](020-mediamtx-hashes-im-repo-und-api-ohne-auth.md) MediaMTX-API und passwortloser Benutzer `any` entfernt, Readiness per TCP; Zugangsdaten (argon2/SealedSecret, Rotation) und RTMPS/RTSPS offen. [021](021-tokens-ohne-ablauf-manuelle-rotation.md) Fristprüfung (`max_age_days` Pflicht, überfällige Rotation und abgelaufene Daten brechen die CI); Anlegedaten und Rotationen offen. [022](022-pod-haertung-unvollstaendig.md) Seccomp `RuntimeDefault` in neun eigenen Charts, Zammad-Init-Container ohne `privileged`, pacman mit explizitem `USER`; Pod-Security-Labels und Fremd-Charts offen. [023](023-image-tags-nicht-fixiert.md) `lldap` und quickchart auf konkrete Versionen (gleicher Digest), Renovate pinnt Digests (außer eigene Images). [024](024-carplay-api-ratelimit-und-allowlist-hinter-proxy.md) Token Pflicht (fail closed), `/metrics` hinter Token, `trustedProxies` auf Pod-CIDR; nach dem Rollout `client_ip` im Log prüfen. [026](026-alamos-relay-einthreadiger-server-token-im-pfad.md) Relay mit `ThreadingHTTPServer`, Socket-Timeout, Body-Grenze und Token-Maskierung im Log; Token im Pfad und Cloudflare-WAF offen. [027](027-pacman-server-ohne-timeouts-und-ratelimit.md) Timeouts, Rate-Limit (429) und vertrauenswürdige Proxys für Client-IP; go.mod bereinigt; nach Rollout Besucher-IPs im Log prüfen. [028](028-cloudflared-zu-traefik-ohne-tls-pruefung.md) cloudflared prüft das Traefik-Zertifikat mit der Root-CA (`caPool`, `originServerName`); nach dem Rollout öffentlichen Aufruf und Logs prüfen. [029](029-ansible-host-key-checking-aus.md) Host-Key-Prüfung an (`accept-new`), Fact-Cache nach `~/.cache`, Vaultwarden-Restore prüft Zertifikat; nach dem Merge ersten Semaphore-Lauf beobachten. [032](032-gitignore-ohne-secret-muster.md) `.gitignore` blockt Schlüssel, `.env`, Kubeconfigs, Vault-Passwortdateien; öffentliche Root-CA ausgenommen. [031](031-build-und-update-lieferkette.md) alert-caller-Build auf Commit-SHA und `--require-hashes` gepinnt (Build getestet), Karenzzeit 3 Tage in Renovate und Dependabot; Renovate-Sicherheits-PRs bewusst aus. [033](033-appproject-cluster-wildcard-und-ruleset.md) PROD-AppProject mit Ressourcen-Whitelist statt `*/*`, CODEOWNERS; Anwenden im Hub, TECH/ENTW-Projekte und Ruleset offen. [034](034-oeffentliches-repo-legt-interne-topologie-offen.md) Private Adresse aus der Doku entfernt; Entscheidung „akzeptieren oder auslagern“ offen. [039](039-journal-upload-ausgefallen.md) Journal-Upload auf allen vier Hosts repariert (Cursor-Backlog, falscher hosts-Eintrag auf den Pis), Neustart-Drop-in und Alarm `JournalUploadFailed`. [043](043-grafana-serviceaccount-liest-alle-secrets.md) Grafana-ServiceAccount liest nur noch ConfigMaps in `monitoring` und `pacman` (eigene ClusterRole statt Chart-Rolle mit Secrets); nach Rollout `can-i` prüfen. [044](044-verwaiste-clusterrolebindings-argo-workflows.md) Verwaiste ClusterRoleBindings entfernt (`clusterWorkflowTemplates` aus, nicht genutzt); ArgoCD prunt beim Sync. [046](046-host-skripte-senden-wegen-redirect-nicht-an-ntfy.md) ntfy-Meldungen der vier Host-Skripte per HTTPS mit Root-CA (Weg auf dem homeserver getestet); Ausrollen auf die Hosts per Rollenlauf offen. [045](045-laufende-images-mit-behebbaren-schwachstellen.md) kaniko auf festes Tag, Scan-Skript für laufende Images, Befund: Funde stammen aus Upstream-Basis-Paketen; Zammad-DB-Image und CI-Scan offen. Incident 003 entfällt (vom Betreiber verworfen, Datei entfernt). Neu aufgefallen und offen: [046](046-host-skripte-senden-wegen-redirect-nicht-an-ntfy.md), wird bewusst als letzter Incident bearbeitet.

**Der Audit selbst hat nichts verändert.** Außer diesem Verzeichnis `docs/incidents/` wurde keine Datei im Repo angefasst. Auf den Hosts und in den Clustern liefen nur lesende Befehle (`ss`, `ufw status`, `sshd -T`, `stat`, `kubectl get`, `k3s secrets-encrypt status`, `tailscale debug netmap`); dazu ein lesender Aufruf im ntfy-Pod (`kubectl exec … ntfy user list`). Es wurden keine Secrets gelesen oder ausgegeben, kein `POST` an Dienste gesendet, nichts committet oder gepusht.

**Veröffentlichung.** Das Repo `pkr-lab/capulus-core` ist **öffentlich**, und `wiki-docs-sync` spiegelt `docs/` nach Wiki.js. Diese Dateien beschreiben **noch offene** Schwachstellen mit Fundstelle. Bis die High-Findings behoben sind, sollten sie nicht gepusht werden (lokal halten oder erst nach der Behebung einchecken). Der README-Index im Repo-Root verweist bewusst nicht auf dieses Verzeichnis.

**Abweichung von der Repo-Konvention.** `CLAUDE.md` sieht Incidents unter `docs/5-incidents/5xxxx-slug.md` vor. Wie im Auftrag verlangt liegen sie unter `docs/incidents/NNN-slug.md`. Falls sie bleiben sollen, können sie vor dem Commit in die Konvention überführt werden.

### Anzahl je Severity

| Severity | Anzahl |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 22 |
| Low | 18 |
| Info | 2 |
| **Gesamt** | **45** |

### Top-5-Risiken

1. **ntfy erlaubt anonymes Lesen und Schreiben und ist öffentlich** ([002](002-ntfy-oeffentlich-mit-anonymem-schreibzugriff.md)). Live bestätigt: Es gibt keine Benutzer und keine Topic-ACLs, nur den anonymen Standardzugang. Gefälschte Alarme und Mitlesen sind ohne Anmeldung möglich.
2. **Der ServiceAccount des öffentlichen Grafana liest clusterweit alle Secrets** ([043](043-grafana-serviceaccount-liest-alle-secrets.md)). Eine Grafana-Schwachstelle führt damit zum Sealing-Key und zu allen Zugangsdaten; die Sidecars brauchen im Ist-Zustand keine Secrets.
3. **Unverschlüsselter privater SSH-Schlüssel in der öffentlichen Git-Historie** ([001](001-privater-ssh-schluessel-in-git-historie.md)), dazu Tailscale-Vollzugriff der Kiosk-Geräte auf den homeserver ([036](036-tailscale-acl-vollzugriff-fuer-kiosk-und-altgeraete.md)). Auf den geprüften Servern ist der Schlüssel nicht autorisiert, auf den Banana Pis ungeprüft.
4. **Öffentliche Admin-nahe Oberflächen ohne zweite Schicht** ([004](004-vaultwarden-admin-oberflaeche-oeffentlich.md), [005](005-wildcard-tunnel-ohne-vorgelagerte-zugangskontrolle.md)). Vaultwarden-Admin, Grafana, Zammad, Xibo-CMS und weitere hängen allein am App-Login; der Wildcard-Tunnel veröffentlicht jeden neuen `pke-lab.de`-Host automatisch.
5. **Flaches Vertrauensmodell und fehlende Host-Härtung** ([006](006-netzwerkrichtlinien-prod-und-egress-fehlen.md), [008](008-ufw-lan-tailnet-voll-vertraut-und-offene-clusterports.md), [009](009-ssh-haertung-nicht-verwaltet.md), [035](035-worker-1-host-firewall-nicht-aktiv.md)). LAN und Tailnet haben vollen Zugriff, PROD hat live **keine** NetworkPolicies, SSH erlaubt Passwort-Login auf homeserver und worker-1, auf worker-1 ist die Firewall gar nicht aktiv.


### Vorschlag zur Reihenfolge

1. **Sofort, ohne Betriebsrisiko:** [043](043-grafana-serviceaccount-liest-alle-secrets.md) (Grafana-Sidecars auf ConfigMaps), [014](014-github-security-funktionen-deaktiviert.md) (GitHub Secret Scanning, Push Protection, Dependabot), [032](032-gitignore-ohne-secret-muster.md) (`.gitignore`), [016](016-carplay-api-go-abhaengigkeiten-verwundbar.md) (Go-Abhängigkeiten), [015](015-ci-actions-nicht-gepinnt-tailscale-latest.md) (Renovate-Preset, Pinning).
2. **Zugangsdaten und Geheimnisse:** [001](001-privater-ssh-schluessel-in-git-historie.md) (Schlüssel auf den Pis prüfen und rotieren), [030](030-minio-oidc-secret-in-git-historie.md), [021](021-tokens-ohne-ablauf-manuelle-rotation.md).
3. **Öffentliche Fläche:** [004](004-vaultwarden-admin-oberflaeche-oeffentlich.md) (`/admin` sperren), [005](005-wildcard-tunnel-ohne-vorgelagerte-zugangskontrolle.md) (Cloudflare Access/WAF, Header), [002](002-ntfy-oeffentlich-mit-anonymem-schreibzugriff.md) (ntfy, **gestuft**, siehe unten).
4. **Mit Wartungsfenster und zweiter SSH-Session:** [009](009-ssh-haertung-nicht-verwaltet.md) (zuerst nur Schlüssel-Login prüfen), [035](035-worker-1-host-firewall-nicht-aktiv.md) (SSH- und Bridge-Regel vor dem Einschalten), [008](008-ufw-lan-tailnet-voll-vertraut-und-offene-clusterports.md), [007](007-k3s-kubeconfig-weltlesbar.md), danach [006](006-netzwerkrichtlinien-prod-und-egress-fehlen.md) und [013](013-argocd-api-klartext-http.md); [036](036-tailscale-acl-vollzugriff-fuer-kiosk-und-altgeraete.md) (Tailscale-ACL) nach Erhebung der Gerätebedarfe.
5. **Dienste härten:** [010](010-alert-caller-ohne-authentifizierung.md), [011](011-power-agent-und-wol-agent-klartext-root.md), [012](012-n8n-child-process-und-webhooks-ohne-auth.md), [018](018-ios-app-klartext-http-mit-bearer-token.md), [019](019-headlamp-statisches-cluster-admin-token.md), [020](020-mediamtx-hashes-im-repo-und-api-ohne-auth.md), [025](025-vm-write-und-logs-write-ohne-authentifizierung.md).
6. **Backups und Betrieb:** [037](037-backups-unverschluesselt-und-luecken.md) (Backups verschlüsseln und versionieren), [045](045-laufende-images-mit-behebbaren-schwachstellen.md) (Image-Updates), [039](039-journal-upload-ausgefallen.md) (Journal-Upload), [040](040-patchstand-worker-und-entw-reboot.md) (Patchstand), [041](041-argocd-initial-admin-secret-vorhanden.md) (ArgoCD-Initial-Secret). **Rest (Low/Info)** nach Bedarf; [033](033-appproject-cluster-wildcard-und-ruleset.md), [034](034-oeffentliches-repo-legt-interne-topologie-offen.md) und [042](042-nicht-im-repo-verwaltete-komponenten.md) sind Design-Entscheidungen.

### Riskante Fixes

Diese Maßnahmen können aussperren, Ausfälle verursachen oder Alarmwege unterbrechen. Vor der Umsetzung gibt es jeweils eine Einzelabsprache.

| ID | Maßnahme | Gefahr |
|---|---|---|
| [001](001-privater-ssh-schluessel-in-git-historie.md) | Schlüssel auf den Banana Pis ersetzen | Mittel: Lockout der Kiosk-Geräte, falls der neue Schlüssel nicht vor dem Entfernen des alten verteilt ist. |
| [002](002-ntfy-oeffentlich-mit-anonymem-schreibzugriff.md) | ntfy auf `deny-all` umstellen | Hoch: Alarmierung bricht still, wenn Publisher (Alertmanager/ntfy-bridge, Skripte, n8n) vor der Umstellung keinen Token bzw. keine Schreib-ACL haben. |
| [005](005-wildcard-tunnel-ohne-vorgelagerte-zugangskontrolle.md) | Cloudflare Access/WAF einführen, Wildcard-Regel ersetzen | Mittel: Cloudflare-Access-Policies können mobile Clients (Immich, Nextcloud, ntfy, Xibo-Player) aussperren, wenn Bypass- bzw. Service-Token-Regeln fehlen. |
| [006](006-netzwerkrichtlinien-prod-und-egress-fehlen.md) | NetworkPolicies für PROD und Egress ausrollen | Hoch: Eine fehlerhafte Policy trennt Traefik/cloudflared von den Apps. Beim Rollout 2026-08-13 ist genau das schon einmal passiert (`docs/d-sicherheit/d0030-network-policies.md`, Cloudflare-Tunnel-Ausfall). |
| [007](007-k3s-kubeconfig-weltlesbar.md) | Kubeconfig-Modus `0600`, k3s-Neustart | Niedrig bis mittel: Ein k3s-Neustart ist nötig, damit die Datei neu geschrieben wird. Nicht-root-Nutzer und Tools, die `/etc/rancher/k3s/k3s.yaml` direkt lesen, verlieren den Zugriff. |
| [008](008-ufw-lan-tailnet-voll-vertraut-und-offene-clusterports.md) | UFW-Regeln einschränken | Hoch: Fehler in Firewall-Regeln können SSH und den Cluster aussperren. Zweite SSH-Session offen halten, `ufw` mit `--dry-run` bzw. Regeln erst hinzufügen, dann Blanket-Regeln entfernen. |
| [009](009-ssh-haertung-nicht-verwaltet.md) | sshd-Härtung ausrollen | Hoch: Fehlerhafte `sshd`-Einstellungen sperren den Zugang aus. Immer zweite SSH-Session offen halten, `sshd -t` vor dem Reload, nach dem Reload mit neuer Session testen. |
| [010](010-alert-caller-ohne-authentifizierung.md) | alert-caller: Token-Pflicht einführen | Mittel: Der Telefon-Alarm fällt still aus, wenn Alertmanager oder die Watchdog-Quelle den Token nicht mitsenden. Stufenweise einführen (erst protokollieren, dann erzwingen). |
| [011](011-power-agent-und-wol-agent-klartext-root.md) | power-agent: Firewall, HTTPS, Härtung | Mittel: Wake/Shutdown/Helligkeit in der iOS-App fallen aus, wenn die Quellfreigabe in der Firewall falsch ist. |
| [012](012-n8n-child-process-und-webhooks-ohne-auth.md) | n8n: Webhook-Authentifizierung, Cookie-Flags | Niedrig bis mittel: Quellen der Webhooks (Alamos-Relay, Alertmanager, Worker-Skripte) müssen den Header mitsenden, sonst bleiben Tickets/Alarme aus. |
| [013](013-argocd-api-klartext-http.md) | ArgoCD auf HTTPS umstellen | Mittel: Die Promotion-Kette (CI → ENTW/Hub) und alle ArgoCD-CLI-Nutzer müssen auf die neue URL umgestellt werden. |
| [018](018-ios-app-klartext-http-mit-bearer-token.md) | iOS-App und carplay-api auf HTTPS umstellen | Mittel: Die App funktioniert erst wieder, wenn die interne Root-CA auf dem iPhone installiert und der Hostname im Zertifikat enthalten ist. |
| [020](020-mediamtx-hashes-im-repo-und-api-ohne-auth.md) | MediaMTX: Zugangsdaten rotieren, API einschränken | Niedrig bis mittel: Der Readiness-Probe-Zugriff und das Monitoring dürfen durch die IP-Beschränkung nicht ausgesperrt werden; Streamer müssen neue Zugangsdaten bekommen. |
| [022](022-pod-haertung-unvollstaendig.md) | Pod-Security-Labels und Security-Contexts | Mittel: Strengere Security-Contexts können Container-Starts verhindern, wenn die App Root oder Schreibzugriff erwartet. Pro App testen. |
| [025](025-vm-write-und-logs-write-ohne-authentifizierung.md) | vm-write/logs-write absichern | Niedrig bis mittel: vmagent und `systemd-journal-upload` auf allen Hosts brauchen die neuen Zugangsdaten. |
| [035](035-worker-1-host-firewall-nicht-aktiv.md) | worker-1: UFW einschalten (SSH und VM-Bridge zuerst freigeben) | Hoch: worker-1 betreibt die ENTW-VM über die Bridge `br0` und zwei weitere Netze (Flannel, Tailscale). Eine aktivierte Firewall mit `deny routed` trennt die VM vom LAN, wenn die Weiterleitungsregel auf `br0` fehlt. SSH-Lockout möglich. |
| [036](036-tailscale-acl-vollzugriff-fuer-kiosk-und-altgeraete.md) | Tailscale-ACL verengen | Mittel: Eine zu enge Regel trennt Geräte (Alarmmonitor, Infotafel) von Diensten und lässt Alarmierung oder Anzeige ausfallen. Vorher je Gerät die benötigten Ziele und Ports erheben. |
| [038](038-unnoetige-netzwerkdienste-auf-den-hosts.md) | CUPS/SANE/NFS-Hilfsdienste einschränken | Niedrig bis mittel: CUPS und SANE werden von der Rolle `cups_print_server` bzw. `scanner` bewusst betrieben; ein Abschalten setzt Drucker und Scanner außer Betrieb. |
| [045](045-laufende-images-mit-behebbaren-schwachstellen.md) | Images aktualisieren, Bitnami-Legacy ersetzen | Mittel: Image-Wechsel bei Datenbanken (Zammad-PostgreSQL) erfordert Backup und gegebenenfalls Major-Upgrade; Semaphore und Argo Workflows sind Betriebswerkzeuge. |

---

## Übersicht aller Findings

Sortiert nach Severity, innerhalb nach ID.

| ID | Titel | Severity | Bereich | Status | Phase 2 |
|---|---|---|---|---|---|
| [001](001-privater-ssh-schluessel-in-git-historie.md) | Privater SSH-Schlüssel der Banana Pis im öffentlichen Git-Verlauf | High | Repo | Behoben 2026-10-17 (worker-0 offen) | live bestätigt |
| [002](002-ntfy-oeffentlich-mit-anonymem-schreibzugriff.md) | ntfy ist öffentlich erreichbar und erlaubt per Default anonymes Lesen und Schreiben | High | Extern | Behoben 2026-10-17 | live bestätigt |
| [043](043-grafana-serviceaccount-liest-alle-secrets.md) | Das öffentlich erreichbare Grafana kann über seinen ServiceAccount clusterweit alle Secrets lesen | High | Repo | Behoben 2026-10-18 | neu in Phase 2 |
| [004](004-vaultwarden-admin-oberflaeche-oeffentlich.md) | Vaultwarden: Admin-Oberfläche `/admin` über das Internet erreichbar | Medium | Extern | Behoben 2026-10-17 | nur Repo |
| [005](005-wildcard-tunnel-ohne-vorgelagerte-zugangskontrolle.md) | Wildcard-Tunnel `*.pke-lab.de`: 13 Hosts ohne vorgelagerte Zugangskontrolle, WAF-Regeln oder Security-Header | Medium | Extern | Zurückgestellt 2026-10-17 | live bestätigt |
| [006](006-netzwerkrichtlinien-prod-und-egress-fehlen.md) | Keine NetworkPolicies im PROD- und ENTW-Cluster, im TECH-Cluster nur Ingress-Regeln | Medium | Repo | Teilweise behoben 2026-10-17 | live bestätigt |
| [007](007-k3s-kubeconfig-weltlesbar.md) | k3s-Kubeconfig (cluster-admin) wird mit Modus 0644 geschrieben | Medium | Repo | Behoben 2026-10-17 | live bestätigt |
| [008](008-ufw-lan-tailnet-voll-vertraut-und-offene-clusterports.md) | UFW: LAN und gesamtes Tailnet haben vollen Zugriff, `6443`, `10250` und `8472/udp` ohne Quelleinschränkung | Medium | Netzwerk | Teilweise behoben 2026-10-17 | live bestätigt |
| [009](009-ssh-haertung-nicht-verwaltet.md) | SSH-Härtung wird nicht per Ansible verwaltet, Port 22 ist in der Firewall für alle Quellen offen | Medium | Repo | Behoben 2026-10-17 | live bestätigt |
| [010](010-alert-caller-ohne-authentifizierung.md) | alert-caller: `/alert` und `/watchdog` ohne Authentifizierung, Pod nutzt `hostNetwork` | Medium | Repo | Teilweise behoben 2026-10-17 | live bestätigt |
| [011](011-power-agent-und-wol-agent-klartext-root.md) | power-agent und Banana-Pi-WoL-Agent: Bearer-Token über Klartext-HTTP auf `0.0.0.0`, power-agent als ungehärteter root-Dienst | Medium | Repo | Behoben 2026-10-17 | live bestätigt |
| [012](012-n8n-child-process-und-webhooks-ohne-auth.md) | n8n: `child_process` freigegeben, mehrere Webhooks ohne Authentifizierung, wirkungslose Basic-Auth-Variable, Secure-Cookie aus | Medium | Repo | Teilweise behoben 2026-10-17 | live bestätigt |
| [013](013-argocd-api-klartext-http.md) | ArgoCD-API per Klartext-HTTP (NodePort 30080) für LAN, Tailnet und WireGuard, CI-Token und Admin-Login unverschlüsselt | Medium | Netzwerk | Behoben 2026-10-17 | live bestätigt |
| [014](014-github-security-funktionen-deaktiviert.md) | GitHub-Sicherheitsfunktionen im öffentlichen Repo deaktiviert (Secret Scanning, Push Protection, Dependabot Security Updates) | Medium | Repo | Behoben 2026-10-17 | live bestätigt |
| [015](015-ci-actions-nicht-gepinnt-tailscale-latest.md) | CI/CD: Third-Party-Actions mit Secrets nur per Tag referenziert, Tailscale-Client `latest`, PoC-Workflow bleibt aktiv | Medium | Repo | Teilweise behoben 2026-10-17 | nur Repo |
| [016](016-carplay-api-go-abhaengigkeiten-verwundbar.md) | carplay-api: Go-Abhängigkeiten mit bekannten Schwachstellen (x/crypto, x/net, x/text, quic-go) | Medium | Repo | Behoben 2026-10-17 | nur Repo |
| [017](017-ansible-installer-ohne-integritaetspruefung.md) | Ansible lädt Installer ohne Integritätsprüfung und führt sie als root aus (k3s, Helm von `main`, CrowdSec, Cloud-Image, vmutils) | Medium | Repo | Behoben 2026-10-17 | nur Repo |
| [018](018-ios-app-klartext-http-mit-bearer-token.md) | iOS-App: Klartext-HTTP mit Bearer-Token zu `carplay-api` und WoL-Agent, ATS-Ausnahme für `homeserver` | Medium | Repo | Behoben 2026-10-18 | nur Repo |
| [019](019-headlamp-statisches-cluster-admin-token.md) | Headlamp: ServiceAccount mit `cluster-admin` und nicht ablaufendem Token im Secret | Medium | Repo | Im Code behoben 2026-10-18 | live bestätigt |
| [020](020-mediamtx-hashes-im-repo-und-api-ohne-auth.md) | MediaMTX: ungesalzene SHA-256-Zugangsdaten im öffentlichen Repo, API/Metrics ohne Authentifizierung für alle Quell-IPs, RTMP/RTSP im Klartext | Medium | Repo | Teilweise behoben 2026-10-18 | nur Repo |
| [035](035-worker-1-host-firewall-nicht-aktiv.md) | worker-1: Host-Firewall ist nicht aktiv, Dienste lauschen auf allen Schnittstellen | Medium | worker1 | Offen | neu in Phase 2 |
| [036](036-tailscale-acl-vollzugriff-fuer-kiosk-und-altgeraete.md) | Tailscale-ACL: Kiosk-Geräte und ein alter Runner haben Vollzugriff auf den homeserver, fremde Konten erreichen Port 443 | Medium | Netzwerk | Offen | neu in Phase 2 |
| [037](037-backups-unverschluesselt-und-luecken.md) | Backups: Vaultwarden-Spiegel ohne Verschlüsselung und Versionierung, DB-Dumps nur für Immich, übrige Dienste nicht belegt | Medium | Repo | Offen | neu in Phase 2 |
| [045](045-laufende-images-mit-behebbaren-schwachstellen.md) | Laufende Container-Images mit behebbaren CRITICAL- und HIGH-Schwachstellen, darunter unmaintainte Bitnami-Legacy-Images | Medium | Repo | Teilweise behoben 2026-10-18 | neu in Phase 2 |
| [046](046-host-skripte-senden-wegen-redirect-nicht-an-ntfy.md) | Host-Skripte melden seit 2026-09-13 nichts mehr an ntfy: der HTTP-Aufruf wird per 308 umgeleitet und nicht verfolgt | Medium | Repo | Im Code behoben 2026-10-18 | neu bei der Behebung von 002 |
| [021](021-tokens-ohne-ablauf-manuelle-rotation.md) | Alle 35 Einträge im Token-Register ohne Ablaufdatum, 31 davon mit manueller Rotation | Low | Repo | Teilweise behoben 2026-10-18 | nur Repo |
| [022](022-pod-haertung-unvollstaendig.md) | Pod-Härtung unvollständig: kein Pod Security Admission, fehlendes Seccomp/ReadOnlyRootFS, privilegierte Init-Container, fehlende Limits | Low | Repo | Teilweise behoben 2026-10-18 | live bestätigt |
| [023](023-image-tags-nicht-fixiert.md) | Image-Tags nicht fixiert: `latest`, `stable`, ohne Tag; nur 2 von 54 Images per Digest gepinnt | Low | Repo | Behoben 2026-10-18 | nur Repo |
| [024](024-carplay-api-ratelimit-und-allowlist-hinter-proxy.md) | carplay-api: Rate-Limit und IP-Allowlist greifen hinter Traefik auf die Proxy-IP, Authentifizierung ist optional, `/metrics` offen | Low | Repo | Behoben 2026-10-18 | nur Repo |
| [025](025-vm-write-und-logs-write-ohne-authentifizierung.md) | `vm-write` und `logs-write`: Schreibzugriff auf Metriken und Logs ohne Authentifizierung aus dem LAN | Low | Netzwerk | Offen | nur Repo |
| [026](026-alamos-relay-einthreadiger-server-token-im-pfad.md) | alamos-relay (öffentlich): einthreadiger HTTP-Server ohne Socket-Timeout, Token im URL-Pfad | Low | Extern | Teilweise behoben 2026-10-18 | nur Repo |
| [027](027-pacman-server-ohne-timeouts-und-ratelimit.md) | pacman-Server: keine HTTP-Timeouts, ungebremster Log-Endpunkt `/api/fingerprint`, vertraut `CF-Connecting-IP` ungeprüft | Low | Extern | Behoben 2026-10-18 | nur Repo |
| [028](028-cloudflared-zu-traefik-ohne-tls-pruefung.md) | cloudflared → Traefik mit `noTLSVerify: true` | Low | Netzwerk | Behoben 2026-10-18 | nur Repo |
| [029](029-ansible-host-key-checking-aus.md) | Ansible: `host_key_checking = False`, Fact-Cache in `/tmp`, `validate_certs: false` im Vaultwarden-Restore | Low | Repo | Behoben 2026-10-18 | nur Repo |
| [030](030-minio-oidc-secret-in-git-historie.md) | MinIO-OIDC-`clientSecret` im Klartext in der Git-Historie des öffentlichen Repos | Low | Repo | Behoben 2026-10-18 | nur Repo |
| [031](031-build-und-update-lieferkette.md) | Lieferkette von Builds und Updates: alert-caller-Dockerfile ohne Pinning, Renovate ohne Sicherheits-Alerts und ohne `minimumReleaseAge` | Low | Repo | Teilweise behoben 2026-10-18 | nur Repo |
| [032](032-gitignore-ohne-secret-muster.md) | `.gitignore` ohne Muster für Schlüssel, `.env`, Kubeconfigs und Vault-Passwörter | Low | Repo | Behoben 2026-10-18 | nur Repo |
| [033](033-appproject-cluster-wildcard-und-ruleset.md) | ArgoCD-AppProjects erlauben alle Cluster-Ressourcen, der `main`-Ruleset verlangt keine Reviews | Low | Repo | Teilweise behoben 2026-10-18 | nur Repo |
| [038](038-unnoetige-netzwerkdienste-auf-den-hosts.md) | Unnötige oder ungesicherte Netzwerkdienste auf homeserver und worker-1 (CUPS, SANE, rpcbind, Avahi, FRR-mgmtd, Exporter ohne Auth) | Low | Netzwerk | Teilweise behoben 2026-10-18 | neu in Phase 2 |
| [039](039-journal-upload-ausgefallen.md) | systemd-journal-upload ist auf homeserver und worker-1 ausgefallen, Host-Logs erreichen VictoriaLogs nicht | Low | worker1 | Behoben 2026-10-18 | neu in Phase 2 |
| [040](040-patchstand-worker-und-entw-reboot.md) | Patchstand: worker-1 mit 61 offenen Updates und älterem Kernel, entw-vm wartet auf Reboot | Low | worker1 | Behoben 2026-10-18 | neu in Phase 2 |
| [041](041-argocd-initial-admin-secret-vorhanden.md) | ArgoCD: Initial-Admin-Secret seit 134 Tagen vorhanden, lokales Admin-Konto aktiv | Low | Repo | Offen | neu in Phase 2 |
| [044](044-verwaiste-clusterrolebindings-argo-workflows.md) | Argo Workflows: zwei ClusterRoleBindings zeigen auf nicht vorhandene ClusterRoles | Low | Repo | Behoben 2026-10-18 | neu in Phase 2 |
| [034](034-oeffentliches-repo-legt-interne-topologie-offen.md) | Das öffentliche Repo legt interne Topologie und Kontaktdaten offen | Info | Repo | Teilweise behoben 2026-10-18 | nur Repo |
| [042](042-nicht-im-repo-verwaltete-komponenten.md) | Nicht im Repo verwaltete Komponenten: MetalLB, PROD-Namespaces `mealie` und `tinyteller`, ENTW ohne Secrets-Verschlüsselung | Info | Repo | Teilweise behoben 2026-10-18 | neu in Phase 2 |

---

## Angreifbarkeit der Logins

**Vorläufig, nicht getestet.** Phase 3b (Login-Tests) wurde nicht durchgeführt; sie gehört zur Übergabe an Claude Code online. Die Tabelle ist aus Repo-Konfiguration, Doku und den lesenden Phase-2-Prüfungen abgeleitet. „ungetestet“ heißt: Das Merkmal (2FA, Lockout, Default-Zugang) ist ohne Login-Versuche nicht prüfbar. Die Gesamtbewertung ist nur dort belegt, wo die Konfiguration die Antwort vorgibt.

| Anwendung | Erreichbarkeit | 2FA | Brute-Force-Schutz | Default-Creds | Gesamtbewertung |
|---|---|---|---|---|---|
| Nextcloud (`nextcloud-prod.pke-lab.de`) | Internet, LAN | ungetestet | ungetestet | ungetestet | ungetestet. Nur App-Login (Incident 005). |
| Immich (`immich-prod.pke-lab.de`) | Internet, LAN | ungetestet | ungetestet | ungetestet | ungetestet. Nur App-Login (Incident 005). |
| Wiki.js (`wiki-prod.pke-lab.de`) | Internet, LAN | ungetestet | ungetestet | ungetestet | ungetestet. Nur App-Login (Incident 005). |
| Xibo CMS (`xibo-prod.pke-lab.de`) | Internet, LAN | ungetestet | ungetestet | ungetestet | ungetestet. Admin-CMS öffentlich (Incident 005). |
| Vaultwarden (`vault-tech.pke-lab.de`) | Internet, LAN | ungetestet | ungetestet | ungetestet | ungetestet. `/admin` öffentlich, Token-Form unbekannt (Incident 004). |
| Grafana (`grafana-tech.pke-lab.de`) | Internet, LAN | ungetestet | ungetestet | ungetestet | ungetestet. Admin-Passwort aus Secret `grafana-admin`; Einbruch liefert clusterweiten Secret-Lesezugriff (Incidents 005, 043). |
| Zammad (`support-tech.pke-lab.de`) | Internet, LAN | ungetestet | ungetestet | ungetestet | ungetestet. Agenten-UI öffentlich (Incident 005). |
| Uptime Kuma (`status-prod.pke-lab.de`) | Internet (Status), LAN (Admin) | ungetestet | ungetestet | ungetestet | ungetestet. Pfad `/` öffentlich, Login-Seite erreichbar. |
| ntfy (`ntfy-tech.pke-lab.de`) | Internet, LAN | nicht vorhanden | nicht anwendbar (Default: kein Login nötig) | nicht anwendbar | **leicht.** Live bestätigt: keine Benutzer, keine ACLs, anonymes `read-write` (Incident 002). |
| MediaMTX (`stream-prod.pke-lab.de`) | Internet (HLS), LAN (RTMP/RTSP) | nicht vorhanden | ungetestet | ungetestet | mittel (vorläufig). Ungesalzene SHA-256-Hashes im Repo (Incident 020). |
| alamos-relay (`alamos-relay-prod.pke-lab.de`) | Internet | nicht vorhanden | ungetestet | nicht anwendbar | mittel (vorläufig). Token im Pfad, Länge nicht prüfbar (Incident 026). |
| pacman (`pacman-prod.pke-lab.de`) | Internet | nicht anwendbar | nicht anwendbar | nicht anwendbar | kein Login. Siehe Incident 027. |
| n8n (`n8n.prod.homeserver`) | LAN; ein Webhook öffentlich | ungetestet (n8n bietet TOTP) | ungetestet | ungetestet | ungetestet. Mehrere Webhooks **ohne** Auth: leicht (Incident 012). |
| Paperless-ngx (`paperless.prod.homeserver`) | LAN | ungetestet | ungetestet | ungetestet | ungetestet. |
| Pi-hole (`pihole.tech.homeserver`) | LAN | nicht vorhanden | ungetestet | ungetestet | ungetestet. Passwort aus Secret `pihole-webpassword`. |
| Headlamp (`headlamp.tech.homeserver`) | LAN | nicht vorhanden | ungetestet | nicht anwendbar | mittel (vorläufig). Statisches `cluster-admin`-Token (Incident 019). |
| ArgoCD (`argocd.tech.homeserver`, NodePort 30080) | LAN, Tailnet, WireGuard | ungetestet | ungetestet | ungetestet (Initial-Secret noch vorhanden) | mittel (vorläufig). Klartext-HTTP, Admin-Konto aktiv (Incidents 013, 041). |
| Semaphore (`semaphore.tech.homeserver`) | LAN | ungetestet | ungetestet | ungetestet | ungetestet. Hält Vault-Passwort und SSH-Keys. |
| kubeseal-webgui (`kubeseal-webgui.tech.homeserver`) | LAN | nicht vorhanden | nicht anwendbar | nicht anwendbar | ungetestet. Nimmt Klartext entgegen, verschlüsselt mit öffentlichem Zertifikat. |
| lldap (`lldap.tech.homeserver`) | LAN | ungetestet | ungetestet | ungetestet | ungetestet. Verzeichnisdienst-Verwaltung. |
| carplay-api (`carplay-api.prod.homeserver`) | LAN, Tailnet | nicht vorhanden | Rate-Limit global statt je Client (Incident 024) | nicht anwendbar | mittel (vorläufig). Bearer-Token über Klartext-HTTP (Incident 018). |
| power-agent (`:9101`) | LAN, Tailnet | nicht vorhanden | keiner | nicht anwendbar | mittel (vorläufig). 256-Bit-Token, aber Klartext und ganzes LAN (Incident 011). |
| Banana-Pi-WoL-Agent (`:9102`) | LAN, Tailnet | nicht vorhanden | keiner | nicht anwendbar | mittel (vorläufig). Wie power-agent. |
| alert-caller (`:9310`, hostNetwork) | LAN, Tailnet | nicht vorhanden | keiner | nicht anwendbar | **leicht.** Keine Authentifizierung (Incident 010). |
| vm-write / logs-write | LAN | nicht vorhanden | keiner | nicht anwendbar | **leicht.** Schreiben ohne Auth (Incident 025). |
| SSH homeserver, worker-1 (Port 22) | LAN, Tailnet; IPv4/IPv6-WAN: Phase 3 | nein (nur Schlüssel oder Passwort) | homeserver: CrowdSec aktiv; worker-1: keiner | ungetestet | **mittel.** Passwort-Login live aktiv, `ubuntu` mit NOPASSWD-sudo (Incident 009). |
| SSH prod-vm, entw-vm (Port 22) | LAN, Tailnet; IPv4/IPv6-WAN: Phase 3 | nein (nur Schlüssel) | keiner | nicht anwendbar | schwer (vorläufig). `passwordauthentication no`. |
| k3s-API (`:6443`) und kubelet (`:10250`) | LAN, Tailnet; Firewall auch IPv6 | nicht vorhanden | nicht anwendbar | nicht anwendbar | schwer gegen anonyme Zugriffe: API und kubelet antworten anonym mit 401 (live geprüft); Kubeconfig auf dem Host weltlesbar (Incident 007). |
| Tailscale / WireGuard-Notzugang | VPN (WireGuard `443/udp`, `51888/udp` offen) | ungetestet (Tailscale-Konto) | nicht anwendbar | nicht anwendbar | mittel (vorläufig). ACL gibt sechs Geräten Vollzugriff auf den homeserver (Incident 036). |
| Router (Fritz!Box), NAS (UGOS), IoT | LAN | ungetestet | ungetestet | ungetestet | ungetestet. Nicht im Repo; Phase 3 mit Zugriffsdaten. |

---

## Methodik und Werkzeuge

| Prüfung | Werkzeug / Vorgehen | Ergebnis |
|---|---|---|
| Secrets in Arbeitsstand und Historie (791 Commits, alle Branches) | gitleaks 8.30.1, mit und ohne Repo-Allowlist | 0 Treffer mit Allowlist; 71 Rohtreffer ohne Allowlist, alle SealedSecret-Chiffretext (`Ag…`), Fehlalarme |
| Klartext-Credentials | eigene Regex-Suche über alle versionierten Dateien | keine Klartext-Credentials im Arbeitsstand; Hashes in MediaMTX (Incident 020) |
| Historische sensible Dateien | `git log -S`, Dateinamen-Suche | privater SSH-Schlüssel (Incident 001), OIDC-Secret (Incident 030) |
| Abhängigkeiten | govulncheck (Go 1.27.2), `npm audit`, trivy fs | carplay-api verwundbar (Incident 016), pacman und isc-news-bot sauber |
| Container und Kubernetes | trivy config, checkov, semgrep (`p/kubernetes`, `p/dockerfile`), 34 Charts per `helm template` gerendert und ausgewertet | Incidents 005, 006, 019, 020, 022, 023 |
| Eigener Code (Go, TypeScript, Python, Swift, Shell) | semgrep (`p/security-audit`, `p/owasp-top-ten`, `p/golang`, `p/typescript`, `p/python`), manuelle Durchsicht | Incidents 010, 011, 018, 024 bis 027 |
| CI/CD | manuelle Durchsicht aller 13 Workflows, semgrep/checkov `github_actions`, `gh api` (Repo-Einstellungen, Rulesets, lesend) | Incidents 014, 015, 033 |
| Ansible | manuelle Durchsicht, checkov `ansible` | Incidents 007 bis 009, 017, 029 |
| Hosts (homeserver, worker-1, prod-vm, entw-vm) | SSH mit vorhandenem Schlüssel, nur lesende Befehle (`sshd -T`, `ufw status`, `ss -tulpn`, `stat`, `apt list --upgradable`, SUID/World-Writable-Suche, `systemctl`, `cscli`), ssh-audit von außen | Incidents 009, 035, 038 bis 040; Bestätigung von 001, 007, 008, 010, 011 |
| Kubernetes (TECH per `kubectl`, PROD/ENTW per `k3s kubectl` auf der VM) | `get` für Nodes, Pods, RBAC, NetworkPolicies, Secrets-Typen (ohne Inhalt), ConfigMaps von ArgoCD; anonyme Aufrufe an API-Server und kubelet; ein lesender Aufruf im ntfy-Pod | Incidents 002, 006, 019, 022, 041 bis 044 |
| Tailscale | `tailscale debug netmap` auf dem homeserver (wirksamer Paketfilter), `tailscale status` | Incident 036 |
| Container-Images | trivy image (HIGH, CRITICAL, nur mit Fix) gegen die 64 im TECH-Cluster laufenden Images | Incident 045 |

Nicht prüfbar mit Repo und lokalen Mitteln: sieben Charts mit nicht heruntergeladenen Subchart-Abhängigkeiten (argo-workflows, cert-manager, minio, sealed-secrets, je ein Eintrag für TECH/PROD/ENTW) wurden nur über ihre `values.yaml` und die Trivy-Funde der Repo-Dateien bewertet.

---

## Bestätigt gut

- Keine Klartext-Secrets im Arbeitsstand, SealedSecrets durchgängig, gitleaks läuft in der CI, Token-Register mit Prüfskript.
- Workflows ohne `pull_request_target`, mit minimalen `permissions` und ohne Expression-Injection in `run:`-Blöcken.
- Eigene Dienste mit solider Eingabeprüfung: isc-news-bot (timing-sichere Auth, Größenlimits, Validierung), der öffentliche n8n-Bildpfad (Exact-Match, `^[0-9a-f]{32}$`), pacman-Leaderboard (Regex, Plausibilitätsprüfung), alamos-relay (konstante Zeit beim Token-Vergleich).
- Eigene Charts laufen als Nicht-root mit `readOnlyRootFilesystem` und `drop: ALL`; k3s mit Secrets-Verschlüsselung und Audit-Log; Forced-Command-SSH-Schlüssel für `poweroff` und n8n-Trigger mit eng geschnittenem sudo.
- Vaultwarden mit `SIGNUPS_ALLOWED: false`, Backup-Job, power-agent-Token mit 256 Bit Zufall und Dateirechten `0600`.

---

## Offen

| Punkt | Stand |
|---|---|
| Phase 3 und 3b | Übergabe an Claude Code online, Brief in [phase-3-uebergabe.md](phase-3-uebergabe.md) |
| worker-0 | ausgeschaltet, nicht geweckt. Nach dem Einschalten dieselbe Lese-Prüfung (Firewall, SSH, Updates) |
| lynis | auf den Hosts nicht installiert. Installation (`apt install lynis`) nur nach ausdrücklicher Freigabe |
| Banana Pis, Infotafel | nicht Teil der Freigabe: Prüfung von `authorized_keys` und Kiosk-Härtung steht aus (Incident 001) |
| NAS (`192.168.178.97`) | nicht Teil der Freigabe: NFS-Exports, Backup-Verschlüsselung (Incident 037), UGOS-Härtung |
| Fritz!Box | nicht Teil der Freigabe: Portfreigaben, UPnP, IPv6-Firewall (Phase 3) |
