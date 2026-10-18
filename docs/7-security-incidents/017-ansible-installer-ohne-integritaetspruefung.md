# 017 Ansible lädt Installer ohne Integritätsprüfung und führt sie als root aus (k3s, Helm von `main`, CrowdSec, Cloud-Image, vmutils)

- Severity: Medium
- Bereich: Repo
- Betroffen: `capulus-ansible/roles/k3s/tasks/main.yml:59,180`, `capulus-ansible/roles/k3s_agent/tasks/main.yml:139`, `capulus-ansible/roles/crowdsec/tasks/main.yml:7`, `capulus-ansible/roles/vmagent/tasks/main.yml:40`, `capulus-ansible/roles/libvirt_host/tasks/main.yml:213`
- Status: Behoben am 2026-10-17 (im Code; wirkt erst beim nächsten Lauf der Rollen, Check-Lauf gegen die Hosts steht aus)

## Beschreibung

Mehrere Rollen laden ein Skript oder Binärpaket per `get_url` ohne `checksum:` und starten es mit root-Rechten. Am deutlichsten: `get-helm-3` wird vom Branch `main` des Helm-Repos geladen (`raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3`) und mit `DESIRED_VERSION` ausgeführt; `get.k3s.io` und `install.crowdsec.net` sind dynamisch ausgelieferte Skripte (`force: true` bei k3s: bei jedem Lauf neu). Auch das Ubuntu-Cloud-Image, der vmutils-Tarball und der Tailscale-GPG-Schlüssel werden ohne Prüfsumme bzw. Fingerprint übernommen. Die Übertragung läuft per HTTPS, die Integrität hängt also nur am jeweiligen Webserver bzw. GitHub-Konto.

## Nachweis

```
$ grep -rn -B1 -A3 'get_url' capulus-ansible/roles | grep -E 'url:|checksum'
capulus-ansible/roles/k3s/tasks/main.yml:60:    url: https://get.k3s.io
capulus-ansible/roles/k3s/tasks/main.yml:181:    url: https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3
capulus-ansible/roles/crowdsec/tasks/main.yml:8:    url: https://install.crowdsec.net
capulus-ansible/roles/vmagent/tasks/main.yml:41:    url: "{{ vmagent_download_url }}"
capulus-ansible/roles/libvirt_host/tasks/main.yml:214:    url: "{{ libvirt_host_base_image_url }}"
(kein `checksum:` in irgendeinem der Aufrufe)
```

## Risiko / Angriffsszenario

Ein Kompromiss der Auslieferung (Webserver, Repo-Konto, DNS/CA-Missbrauch auf dem Pfad) führt zu Codeausführung als root auf dem Control-Plane- und den Worker-Hosts, damit zu cluster-admin und Zugriff auf alle Secrets.

## Empfohlene Behebung

1. Helm-Installer auf ein Tag pinnen (`…/helm/v3.21.0/scripts/get-helm-3`) oder das Release-Tarball laden und `checksum: sha256:<hash>` prüfen.
2. k3s: Installer aus dem festen Release-Tag des `k3s-io/k3s`-Repos beziehen (`…/k3s-io/k3s/<tag>/install.sh`) und gegen `checksum:` prüfen; `INSTALL_K3S_VERSION` bleibt gesetzt.
3. CrowdSec über das APT-Repository mit gepinntem Schlüssel-Fingerprint installieren statt über das Skript.
4. Für Cloud-Image und vmutils `checksum: "sha256:<URL der SHA256SUMS>"` bzw. die Prüfsumme der Release-Seite angeben.
5. Tailscale-Schlüssel: `gpg --show-keys`-Fingerprint gegen den veröffentlichten Wert prüfen.

## Rollback

Vorherige Task-Fassung wiederherstellen (Git).

## Verifikation

```
grep -rn -A6 'ansible.builtin.get_url' capulus-ansible/roles | grep -c 'checksum:'
ansible-playbook --check --diff capulus-ansible/site.yml
```
Jeder `get_url` mit externer Quelle trägt `checksum:`; der Check-Lauf läuft ohne Fehler.

## Risiko der Behebung

Niedrig: betrifft nur künftige Läufe; bestehende Installationen bleiben unberührt.

## Behebung (2026-10-17)

**Fix.**

- **k3s und k3s_agent (Punkt 2):** `get_url` lädt den `install.sh` von einem festen Commit von `k3s-io/k3s` (`2977c525…`, der letzte Commit an dieser Datei, Stand 03.09.2026) mit `checksum: sha256:e5cc3b3d…`. Die Rohdatei dieses Commits hat denselben SHA-256 wie das, was `get.k3s.io` heute ausliefert, das Verhalten bleibt also gleich. Das k3s-Binary folgt weiter dem Kanal `stable`, `INSTALL_K3S_VERSION` bleibt gesetzt, und der Installer prüft das Binary selbst gegen die Prüfsumme des Releases. Variablen `k3s_installer_url` und `k3s_installer_sha256` in `roles/k3s/defaults/main.yml` und `roles/k3s_agent/defaults/main.yml` (neu angelegt).
- **Helm (Punkt 1):** Statt `get-helm-3` von `main` lädt die Rolle `k3s` den Tarball `get.helm.sh/helm-<k3s_helm_release>-linux-<arch>.tar.gz` mit `checksum: sha256:<…sha256sum>`, entpackt nur `helm` nach `/usr/local/bin` und installiert nur, wenn die installierte Version von `k3s_helm_release` (`v3.22.1`) abweicht. Ein Renovate-Regex-Manager öffnet den PR für neue Helm-3-Versionen. Die Prüfsumme kommt live aus der Datei neben dem Tarball (schützt vor Beschädigung und Vertauschung, nicht vor einem manipulierten `get.helm.sh`; bewusste Abwägung gegen einen festen Hash, den Renovate nicht pflegen kann).
- **CrowdSec (Punkt 3):** Statt `install.crowdsec.net` lädt die Rolle den Schlüssel von `packagecloud.io/crowdsec/crowdsec/gpgkey`, legt ihn als `/etc/apt/keyrings/crowdsec_crowdsec-archive-keyring.gpg` ab, prüft seinen Fingerprint (`crowdsec_repo_key_fingerprint: 6A89E3C2303A901A889971D3376ED5326E93CD0C`) und schreibt die Repository-Datei selbst (byte-identisch zu der, die das Skript angelegt hatte).
- **vmagent und Cloud-Image (Punkt 4):** `vmagent_sha256` je Architektur (`arm`: `b87fdf5b…`) und `libvirt_host_base_image_sha256` (`88006518…`); die Image-URL zeigt jetzt auf das datierte Verzeichnis `release-20260927` statt auf das wandernde `release`.
- **Tailscale (Punkt 5):** Die Rolle prüft bei jedem Lauf den Fingerprint des Schlüsselbunds gegen `tailscale_signing_key_fingerprint` (`2596A99EAAB33821893C0A79458CA832957F5868`) und bricht bei Abweichung ab.
- **Nachbesserung im Check-Modus (ebenfalls 2026-10-17):** Der erste `--check`-Lauf gegen den Homeserver scheiterte in der CrowdSec-Rolle („object of type 'dict' has no attribute 'path'“), weil Ansible `tempfile` und `command` im Check-Modus überspringt und meine Tests nur im Normalmodus liefen. Behoben in CrowdSec, Tailscale und Helm (`check_mode: false` für die rein lesenden Schritte, `unarchive` nicht im Check-Modus). Der zweite Check-Lauf zeigte denselben Fehler in einem bestehenden Task der Rolle `tailscale` (Auth-Key-Block, weil `tailscale status --json` im Check-Modus übersprungen wurde); dort sowie in `k3s`, `k3s_agent` und `crowdsec` sind die rein lesenden Schritte jetzt ebenfalls `check_mode: false`. Danach lokal in allen Kombinationen geprüft: Check-Modus und Normalmodus, Schlüssel vorhanden und fehlend, richtiger und falscher Fingerprint, Helm aktuell, veraltet und fehlend.
- **Grenze der Fingerprint-Prüfung:** Die Fingerprints sind Trust-on-first-use. Gepinnt ist der Schlüssel, der am 2026-10-17 auf dem Homeserver installiert war; eine unabhängige Veröffentlichung der Fingerprints durch Tailscale oder CrowdSec habe ich nicht gefunden. Die frisch geladenen Schlüssel waren byte-identisch mit den installierten.

**Nachweis** (lokal, ohne Zugriff auf die Hosts, die Rollenläufe gegen die Hosts brauchen das Vault-Passwort):

| Test | Ergebnis |
|---|---|
| `get_url` k3s-Installer gegen die echte URL mit dem Hash | ok (38 693 Byte), falscher Hash: `did not match`, kein Rest im Zielordner |
| `get_url` vmutils-Tarball (118 MB) mit dem Hash | ok, um ein Zeichen geänderter Hash: abgelehnt |
| Helm-Tasks in einem Testverzeichnis | Lauf 1 installiert `v3.22.1`, Lauf 2 überspringt alles (`changed=0`), Lauf 3 mit `v3.22.0` installiert um, abweichende Prüfsumme wird abgelehnt |
| Tailscale-Fingerprint-Tasks gegen die echte Schlüsseldatei | richtiger Fingerprint: ok, falscher: `Fingerprint weicht ab` |
| CrowdSec-Tasks in einem Testverzeichnis | Neuinstallation: Keyring byte-identisch zu dem auf dem Homeserver (`24a43f11…`), zweiter Lauf `changed=0`, falscher Fingerprint: Abbruch, temporäres GnuPG-Verzeichnis jeweils entfernt |
| `.list`-Datei der Rolle gegen die auf dem Homeserver | byte-identisch (260 Byte) |
| Cloud-Image: Hash gegen `release-20260927/SHA256SUMS` | 1 Treffer |
| `ansible-playbook --syntax-check` für `site`, `worker-0`, `worker-1`, `entw`, `prod`, `banana-pi-kiosks` | alle ok |
| `get_url` ohne `checksum:` in `roles/*/tasks` | nur die zwei Schlüssel-Downloads (CrowdSec, Tailscale), deren Fingerprint die Rolle danach prüft |
| `grep` nach `get.k3s.io`, `get-helm-3`, `install.crowdsec.net` in `ansible/`, `.github/`, `scripts/` | keine Treffer |

**Test gegen die Hosts** (2026-10-18, `ansible-playbook --check --diff`, ändert nichts; dazu lesende Befehle über SSH):

| Host / Rolle | Ergebnis |
|---|---|
| homeserver (`k3s`, `crowdsec`, `tailscale`) | `ok=62, changed=2, failed=0`. CrowdSec- und Tailscale-Fingerprint bestehen, die CrowdSec-Repo-Datei ist unverändert, Helm `v3.22.1` ist installiert und wird übersprungen. Die zwei „changed“ sind erwartet (k3s-Installer mit `force: true`; Tailscale-Schlüssel-Download, den `get_url` im Check-Modus ohne Prüfsumme immer als geändert meldet). |
| prod-vm, entw-vm (`k3s`) | je `failed=0`; Helm `v3.22.0` wird auf `v3.22.1` angehoben (`Download Helm release` meldet die Änderung) |
| worker-0 (`k3s-agent`, `tailscale`) | `ok=44, changed=4, failed=0` |
| worker-1 (`k3s-agent`, `tailscale`, `libvirt-host`) | `k3s_agent` und `tailscale` wie worker-0. `libvirt_host` bricht im Check-Modus bei `Warnen, wenn die Disk einer bestehenden VM am Basis-Image haengt` ab (`from_json` auf einem übersprungenen `command`, kein Teil von 017). |
| vereinsheim-alarmmonitor (`vmagent`, `tailscale`) | `ok=30, changed=4, failed=0`. `vmutils-Release herunterladen` ist `ok`, also entspricht die Prüfsumme `b87fdf5b…` dem auf dem Pi liegenden Tarball (`get_url` meldet bei vorhandener Datei mit passender Prüfsumme „file already exists“). |
| Vom homeserver aus | Installer von GitHub: SHA-256 `e5cc3b3d…` stimmt. Helm-Tarball von `get.helm.sh`: `896cf636…` gleich der Prüfsummendatei. Tailscale-Fingerprint `2596A99E…`, CrowdSec-Fingerprint `6A89E3C2…`. Es entsteht kein `~/.gnupg`. |

Nicht getestet: ein echter Lauf (kein `--check`) der drei Rollen, die Tests des Installers bis zum Ende (`install.sh` selbst), `infotafel` (nicht Teil des Laufs) und das Cloud-Image (wird nur bei fehlendem Image geladen).

**Geänderte Dateien.**

- `capulus-ansible/roles/k3s/` (`tasks/main.yml`, neu `defaults/main.yml`), `capulus-ansible/roles/k3s_agent/` (`tasks/main.yml`, neu `defaults/main.yml`)
- `capulus-ansible/roles/crowdsec/` (`tasks/main.yml`, `defaults/main.yml`), `capulus-ansible/roles/tailscale/` (`tasks/main.yml`, `defaults/main.yml`)
- `capulus-ansible/roles/vmagent/` (`tasks/main.yml`, `defaults/main.yml`), `capulus-ansible/roles/libvirt_host/` (`tasks/main.yml`, `defaults/main.yml`)
- `renovate.json` (Regex-Manager für `k3s_helm_release` und Regel `v3.*`)
- Doku: `docs/6-hintergruende/60020-ansible-rollen.md` (Abschnitt „Installer und Prüfsummen“), `docs/a-betriebssystem/a0030-installation.md`, `docs/d-sicherheit/d0020-crowdsec.md`, `docs/f-cicd-automatisierung/f0020-renovate.md`

**Rollback.** PR revertieren. Die Rollen laden danach wieder die Skripte ohne Prüfsumme. Auf bereits laufenden Hosts ändert sich durch den Revert nichts.

**Offen.**

- **Echter Lauf der Rollen** steht aus. Er würde wegen `auto_upgrade: true` (nicht Teil von 017) auch Tailscale-Pakete auf mehreren Hosts anheben (die Check-Läufe zeigen `Install (or upgrade) tailscale package` als geändert) und k3s dem Kanal `stable` folgen lassen. Der Betreiber entscheidet, wann.
- **`libvirt_host` auf worker-1** zeigt im Check-Lauf offenen Drift (Netplan-Datei `99-libvirt-bridge.yaml` mit `ra-overrides`, Entfernen von `90-dns-fallback.yaml`, `Netplan anwenden`). Nicht 017. Vor einem Lauf mit dem Tag `libvirt-host` die Diffs prüfen, denn `Netplan anwenden` kann die Verbindung kurz trennen.
- **Check-Lauf gegen die Hosts** (erledigt, siehe oben; ursprünglicher Befehl): `ansible-playbook -i capulus-ansible/inventory/hosts.yml capulus-ansible/site.yml --check --diff --vault-password-file ~/.vault_pass --tags k3s,crowdsec,tailscale` und entsprechend für `worker-0.yml`/`worker-1.yml` (k3s_agent, libvirt_host) und `banana-pi-kiosks.yml` (vmagent), bevor der nächste reguläre Lauf kommt. Erwartet: keine Änderung außer dem Helm-Update auf `v3.22.1` von prod-vm und entw-vm (derzeit `v3.22.0`).
- **`helm_version` in `capulus-ansible/group_vars/all.yml`** hat jetzt keine Wirkung mehr; die Zeile kann entfallen (Vault-Datei, nicht von mir angefasst).
- **Helm 3 hat ein Ende:** Renovate bleibt auf `v3.*`. Eine Umstellung auf Helm 4 ist ein eigener Schritt.
- `ansible.builtin.apt_repository` ist veraltet (in ansible-core 2.25 entfernt), Umstellung auf `deb822_repository` ist ein eigener Schritt.

