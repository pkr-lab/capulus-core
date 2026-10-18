# Offene Punkte (To-do)

Stand: 2026-10-18. Sammelstelle für alles, was nach der Behebung der Incidents 001 bis 017 noch bei dir liegt. Details und Begründungen stehen jeweils im Abschnitt „Offen“ der Incident-Datei. Diese Datei bleibt wie die Incident-Dokus lokal und wird nicht gepusht.

Legende: `[ ]` offen, `[x]` erledigt.

---

## Außerhalb der Incidents (aus dem Test von 017)

- [ ] **worker-1, Rolle `libvirt_host`: Drift prüfen und abarbeiten.** Der Check-Lauf zeigt 15 offene Änderungen: `99-libvirt-bridge.yaml` mit `ra-overrides`, Entfernen von `90-dns-fallback.yaml`, `Netplan anwenden`. Erst die Diffs lesen (`ansible-playbook … ansible/worker-1.yml --check --diff --tags libvirt-host`), dann mit Rollback-Timer anwenden, weil `Netplan anwenden` die Verbindung kurz trennen kann.
- [ ] **`libvirt_host` im Check-Modus lauffähig machen.** Der Task `Warnen, wenn die Disk einer bestehenden VM am Basis-Image haengt` bricht im Check-Lauf mit `from_json` ab (übersprungener `command`). Gleiche Fehlerklasse wie in `tailscale`, `k3s` und `crowdsec` (siehe [60020](../6-hintergruende/60020-ansible-rollen.md), Abschnitt „Installer und Prüfsummen“).
- [ ] **Check-Modus der übrigen Rollen prüfen.** Nur `k3s`, `k3s_agent`, `crowdsec`, `tailscale`, `vmagent` und die Lesezugriffe von `libvirt_host` wurden gegen die Hosts im Check-Modus geprüft.

---

## 012 n8n

- [ ] `make nightly-worker-wake` ausführen (Skript mit `https://`-URL und Header-Datei), danach prüfen, dass der nächtliche Bericht ein Zammad-Ticket erzeugt.
- [ ] Im Browser prüfen, dass der Cookie `n8n-auth` das Flag `Secure` trägt.
- [ ] `/webhook/isc-news` ist ohne Authentifizierung (Aufrufer ist eine externe Website). Lösung klären: Absender prüfen oder kleiner Relay mit Pfad-Token wie bei alamos-relay.
- [ ] n8n meldet nach dem Neustart wiederholt „Database ping failed“ (SQLite auf dem NAS-Volume). Ursache untersuchen.
- [ ] Positivtest der Webhooks `banana-pi-down` und `nightly-worker-update` kommt vom ersten echten Alertmanager-Aufruf bzw. Nachtlauf (nicht selbst auslösen, es entstehen echte Zammad-Tickets mit Mail).

## 013 ArgoCD

- [ ] `argocd login argocd.tech.homeserver --grpc-web` und `argocd login argocd.dev.homeserver --grpc-web` sind eingerichtet; alte Kontexte `192.168.178.94:30080` und `homeserver:30080` mit `argocd context --delete` entfernen.
- [ ] ENTW-Zertifikat für `argocd.dev.homeserver` läuft am **2027-10-17** ab. Erneuern nach [d0040](../d-sicherheit/d0040-internal-tls.md#zertifikat-für-argocd-auf-der-entw-vm), Termin eintragen.

## 014 GitHub-Sicherheitsfunktionen

- [ ] Push-Protection-Test: Wegwerf-Branch mit einer Datei, die ein gültig aufgebautes GitHub-Token-Muster enthält, pushen. Der Push muss abgelehnt werden. Branch danach löschen.
- [ ] Workflow `Security issues` wieder einschalten (`gh workflow enable security-issues.yml`), wenn öffentliche Issues zu Abhängigkeitslücken gewollt sind.
- [ ] Secret-Scanning-Funde gelegentlich prüfen: `gh api 'repos/pkr-lab/capulus-core/secret-scanning/alerts?state=open'` (enthält Klartextwerte, nicht ausgeben).

## 015 Actions und Tailscale in der CI

- [ ] Federated Identity im Tailscale-Admin-Panel anlegen (*Settings → Trust credentials → OpenID Connect*, Issuer GitHub, Subject `repo:pkr-lab/capulus-core:ref:refs/heads/main`, Scope `auth_keys` Write, Tag `tag:ci`), dann `gh secret set TS_OAUTH_CLIENT_ID` und `gh secret set TS_AUDIENCE`.
- [ ] *Tailscale Runner PoC* ausführen (muss `OK` melden), danach *Promote chain* mit `plan_only`, dann wieder aktivieren (derzeit manuell deaktiviert).
- [ ] Alte OAuth-Clients in *Trust credentials* prüfen und widerrufen.
- [ ] `tailscale-poc.yml` löschen, sobald die Promotion-Kette läuft (inklusive Verweise in `f00a0` und `600a0`).
- [ ] Optional: eigener OAuth-Client mit nur `devices:core:read` für die Schlüsselprüfung von worker-0 in `token-watch.yml` (läuft derzeit still ohne diese Prüfung).

## 017 Ansible-Installer

- [ ] Echter Lauf der Rollen (nicht `--check`) planen, Host für Host. Er hebt wegen `auto_upgrade: true` auch Tailscale-Pakete an und lässt k3s dem Kanal `stable` folgen.
- [ ] Optional: Zeile `helm_version` in `ansible/group_vars/all.yml` entfernen (hat keine Wirkung mehr, Vault-Datei).
- [ ] Pins bei Bedarf erneuern (k3s-Installer, vmagent-Tarball, Cloud-Image, Fingerprints): Befehle in [60020](../6-hintergruende/60020-ansible-rollen.md).
- [ ] `ansible.builtin.apt_repository` auf `deb822_repository` umstellen (in ansible-core 2.25 entfernt).
- [ ] `infotafel` im Check-Lauf von `vmagent` mitprüfen (war nicht Teil des Laufs).

---

## Frühere Incidents (Stand laut Behebungsstand im README, bitte gegenprüfen)

- [ ] **008:** `make common` ausführen, damit die gestagte Ansible-Fassung der UFW-Regeln auf allen Hosts ankommt.
- [ ] **010:** Telefon-Alarm Stufe 2 (`enforce`), Rollenlauf auf dem Pi (Vault-Variable `vault_alert_caller_token`) und echter Testanruf.
- [ ] **006:** Egress-Default-Deny für PROD und TECH (belegte Zielliste fehlt).
- [ ] **002:** Restpunkt worker-1 (Token-Verteilung per Ansible).
- [ ] **001:** Restpunkt worker-0 (Autorisierung des alten Schlüssels prüfen).
- [ ] **005:** zurückgestellt (Wildcard-Tunnel, Maßnahmen stehen in der Incident-Datei).
- [ ] **018 und 011-Nachtrag:** Die iOS-App erreicht `carplay-api` womöglich nicht mehr (HTTP leitet auf HTTPS um).
- [ ] **046:** wird bewusst zuletzt bearbeitet.
