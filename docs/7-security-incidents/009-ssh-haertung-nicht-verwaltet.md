# 009 SSH-Härtung wird nicht per Ansible verwaltet, Port 22 ist in der Firewall für alle Quellen offen

- Severity: Medium
- Bereich: Repo
- Betroffen: `capulus-ansible/roles/common/tasks/main.yml:157-162`, kein Task für `sshd_config` in `capulus-ansible/roles/*`, betrifft worker0, worker1 und weitere Hosts
- Status: Behoben am 2026-10-17 (alle sieben Hosts; Restpunkte: Ansible-Abgleich, Dienstweg im Journal belegen)

## Beschreibung

Im Repo gibt es keine Verwaltung von `/etc/ssh/sshd_config` oder Drop-ins (`PermitRootLogin`, `PasswordAuthentication`, `MaxAuthTries`, `AllowUsers`). Die Rolle `common` öffnet Port 22 ohne Quellbeschränkung. Der tatsächliche Zustand hängt damit von den Ubuntu-/cloud-init-Defaults der einzelnen Hosts ab. Bei Ubuntu ist Root-Login per Passwort aus, Passwort-Authentifizierung für normale Benutzer aber standardmäßig an, sofern cloud-init sie nicht abschaltet. CrowdSec (SSH-Bouncer) mildert Brute-Force, ersetzt die Härtung nicht.

Die Verifikation der effektiven Konfiguration steht für Phase 2 aus (`sshd -T`, `ssh-audit`).

## Nachweis

```
$ grep -rn -i -E 'PermitRootLogin|PasswordAuthentication|sshd_config|AllowUsers|MaxAuthTries' ansible
(keine Treffer)

$ sed -n 157,162p capulus-ansible/roles/common/tasks/main.yml
- name: Allow SSH (port 22) before any other firewall changes
  community.general.ufw:
    rule: allow
    port: "22"
    proto: tcp
```

## Phase-2-Nachweis (live, lesend)

Live-Stand `sshd -T` (identisch auf homeserver und worker-1):

```
permitrootlogin prohibit-password
passwordauthentication yes        (Quelle: /etc/ssh/sshd_config.d/50-cloud-init.conf)
maxauthtries 6        logingracetime 120        x11forwarding yes
allowagentforwarding yes        allowtcpforwarding yes
macs ... hmac-sha1-etm@openssh.com ... umac-64@openssh.com ... hmac-sha1
```
`ubuntu` hat auf beiden Hosts einen Passwort-Hash und `NOPASSWD:ALL` in sudoers: Ein erratenes SSH-Passwort ist direkt root. CrowdSec (SSH-Schutz) läuft nur auf dem homeserver, **nicht** auf worker-1. prod-vm und entw-vm haben dagegen `passwordauthentication no`.

`ssh-audit` (von außen, gegen `192.168.178.94` und `.96`): `[fail]` für `hmac-sha1`, `hmac-sha1-etm@openssh.com`, `ecdh-sha2-nistp*` und `ecdsa-sha2-nistp256`; `[warn]` für 64-Bit-Tags (`umac-64*`) und Encrypt-and-MAC-Modi. Die Kex-Liste enthält zugleich die Post-Quanten-Verfahren `mlkem768x25519-sha256` und `sntrup761x25519-sha512`.

### Nachtrag Banana Pi und Infotafel (2026-10-17, lesend)

`sshd -T` auf den beiden Kiosk-Pis (bei der Arbeit an Incident 001):

| Host | permitrootlogin | passwordauthentication | pubkeyauthentication | sudo für `pela` |
|---|---|---|---|---|
| vereinsheim-alarmmonitor | `yes` | `yes` | `yes` | ohne Passwort (`sudo -n` funktioniert) |
| infotafel | `without-password` | `yes` | `yes` | ohne Passwort (`sudo -n` funktioniert) |

Der Alarmmonitor erlaubt damit Root-Login per Passwort aus jedem Netz, das Port 22 erreicht. Er ist per Tailscale an den homeserver angebunden (Incident 036). Die Ansible-Rolle `banana_pi_kiosk` verwaltet `sshd` nicht. Eine Härtung dieser beiden Geräte gehört in den Umfang der Behebung von 009.

## Risiko / Angriffsszenario

Ist Passwort-Login aktiv, sind Brute-Force und Credential-Stuffing aus jedem Netz möglich, das Port 22 erreicht (LAN, Tailnet, bei Portweiterleitung das Internet). Schwache Algorithmen bleiben auf dem Stand der Distribution.

## Empfohlene Behebung

Ansible-Task mit Drop-in und Syntaxprüfung vor dem Reload:
```yaml
- name: sshd-Härtung ablegen
  ansible.builtin.copy:
    dest: /etc/ssh/sshd_config.d/99-hardening.conf
    owner: root
    group: root
    mode: "0644"
    content: |
      PermitRootLogin no
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      PubkeyAuthentication yes
      MaxAuthTries 3
      LoginGraceTime 20
      X11Forwarding no
      AllowAgentForwarding no
      AllowTcpForwarding no
  notify: sshd prüfen und neu laden
```
Handler: `sshd -t`, danach `systemctl reload ssh`. Zusätzlich `ufw limit 22/tcp` bzw. die Quellen auf LAN/Tailnet beschränken (siehe Incident 008).

## Rollback

Drop-in `/etc/ssh/sshd_config.d/99-hardening.conf` löschen und `systemctl reload ssh`. Bei Lockout: Konsole bzw. zweite offene Session.

## Verifikation

```
sudo sshd -T | grep -E 'permitrootlogin|passwordauthentication|maxauthtries'
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no <user>@<host>
ssh-audit <host>
```
Erwartung: `no`/`no`/`3`; Passwort-Login endet mit `Permission denied (publickey)`.

## Risiko der Behebung

Hoch: Fehlerhafte `sshd`-Einstellungen sperren den Zugang aus. Immer zweite SSH-Session offen halten, `sshd -t` vor dem Reload, nach dem Reload mit neuer Session testen.

## Behebung (2026-10-17)

**Fix.** Neue Rolle `ssh_hardening` (Tag `ssh-hardening`, `make ssh-hardening`, auch in den Kiosk-Playbooks) legt `/etc/ssh/sshd_config.d/00-hardening.conf` ab, prüft mit `sshd -t` und `sshd -T` und lädt `ssh` per `reload`. Auf allen sieben Hosts (homeserver, worker-0, worker-1, prod-vm, entw-vm sowie die Kiosk-Pis vereinsheim-alarmmonitor und infotafel) gilt jetzt `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`, `MaxAuthTries 4`, `LoginGraceTime 20`, `X11Forwarding no`, `AllowAgentForwarding no` und `AllowTcpForwarding no`. Live wurde das Drop-in von Hand mit denselben Werten angelegt, der Ansible-Lauf (`make ssh-hardening`) steht noch aus und braucht das Vault-Passwort.

Abweichungen von der Beschreibung:

- **Dateiname `00-hardening.conf` statt `99-hardening.conf`.** `sshd` nimmt den ersten Wert, `50-cloud-init.conf` setzt `PasswordAuthentication yes`. Ein `99-…`-Drop-in hätte die Einstellung nie überschrieben. Die Rolle bricht ab, wenn die wirksamen Werte (`sshd -T`) nicht stimmen.
- **`MaxAuthTries 4` statt 3**, weil ein Agent mit mehreren Schlüsseln plus Standard-Identitäten schon drei Fehlversuche erzeugen kann.
- **Nicht umgesetzt:** `ufw limit 22/tcp` (kann Ansible-Läufe und Semaphore ausbremsen, der homeserver hat CrowdSec) und neue Listen für MACs und Schlüsselaustausch (`ssh-audit`-Befunde bleiben).

**Vorab belegt.** In 30 Tagen waren alle SSH-Anmeldungen auf allen Hosts Schlüssel-Logins, bis auf eine einmalige Passwort-Anmeldung am 2026-09-21 auf worker-0 vom homeserver aus. Fehlgeschlagene Passwortversuche gab es 0. Auf keinem Host liegt ein `root`-Schlüssel. Die Vault-Dateien enthalten nur sudo-Passwörter. Weiterleitungen (`-L`, `-D`, `ProxyJump`, `qemu+ssh`) kommen weder im Repo noch in der SSH-Konfiguration des Betreibers vor.

**Nachweis** (je Host, nach dem Reload, in neuen Verbindungen):

| Test | entw-vm | prod-vm | worker-1 | worker-0 | homeserver |
|---|---|---|---|---|---|
| Schlüssel-Login und `sudo` | ok | ok | ok | ok | ok (LAN und Tailscale) |
| Passwort-Login | `Permission denied (publickey)` | dto. | dto. | dto. | dto. |
| `root`-Login | abgewiesen | abgewiesen | abgewiesen | abgewiesen | abgewiesen |
| Weiterleitung `-L` benutzt | verboten | | | | verboten |
| Bestätigung durch den Betreiber im zweiten Terminal | ja | ja | nicht einzeln (nach Neustart durch mich geprüft) | dto. | ja |

Kiosk-Pis (später am selben Tag, jeweils mit Backup und Rollback-Timer):

| Test | infotafel | vereinsheim-alarmmonitor |
|---|---|---|
| Schlüssel-Login und `sudo` | ok | ok (über Tailscale) |
| Passwort-Login | `Permission denied (publickey)` | `Permission denied (publickey)` |
| `root`-Login | abgewiesen | abgewiesen (stand zuvor auf `PermitRootLogin yes`) |
| Dienste | `tailscaled` aktiv | `tailscaled`, Heartbeat-Timer, WoL-Agent, `vmagent` aktiv, Chromium läuft |
| Bestätigung durch den Betreiber im zweiten Terminal | ja | ja |

Danach: Cluster, ArgoCD und die öffentlichen Hosts unverändert, `sshd -T` zeigt auf allen Hosts die neuen Werte, im SSH-Journal 0 Fehlerzeilen.

**Zwischenfall bei der Umsetzung.** Zum Test des Dienstwegs habe ich den Schlüssel des `cluster-power-manager` vom homeserver zu den Workern aufgerufen. Er ist per `command=` fest auf `sudo poweroff` gesetzt, ein Testbefehl wird ignoriert. Worker-0 und worker-1 wurden dadurch um etwa 15:51 UTC heruntergefahren und liefen nach rund 30 Sekunden von selbst wieder an (wer sie geweckt hat, ist nicht geklärt, `cluster-power-manager` hat dazu nichts protokolliert). Die ENTW-VM auf worker-1 war kurz weg und lief danach wieder, auf den Workern liefen keine Workloads. Die Härtung, UFW und `k3s-agent` waren nach dem Neustart unverändert. Die Warnung steht in `docs/2-betrieb-hardware/20020-cluster-power-manager.md`, ich hatte sie vor dem Test nicht gelesen. Der Dienstweg wurde danach nur noch über das Journal belegt.

**Geänderte Dateien.**

- `capulus-ansible/roles/ssh_hardening/` (neu: `defaults/main.yml`, `tasks/main.yml`, `templates/00-hardening.conf.j2`)
- `capulus-ansible/site.yml`, `prod.yml`, `entw.yml`, `worker-0.yml`, `worker-1.yml`, `Makefile`
- Doku: `docs/6-hintergruende/60020-ansible-rollen.md` (Abschnitt `ssh_hardening`), `docs/a-betriebssystem/a0020-prerequisites.md`

**Rollback.** Je Host `sudo rm /etc/ssh/sshd_config.d/00-hardening.conf && sudo systemctl reload ssh`. Bei Lockout: Konsole bzw. eine zweite offene Sitzung. Im Repo die Rolle aus den Playbooks nehmen. Die Sicherungskopien von `/etc/ssh` (`/root/ssh-backup-20261017-*`, sieben Stück) wurden nach der Bestätigung gelöscht, sie enthielten auch die privaten Host-Schlüssel.

**Offen.**

- `make ssh-hardening` ausführen, damit Ansible und Hosts übereinstimmen (der Betreiber hat den Lauf für die Server gestartet, die Kiosk-Pis kommen mit dem aktualisierten Makefile dazu).
- Dienstweg (Semaphore und n8n zu den Hosts, `cluster-power-manager` zu den Workern) bei einem natürlichen Lauf im Journal bestätigen („Accepted publickey“).
- `ufw limit 22/tcp`, Algorithmenlisten (`ssh-audit`-Befunde), IPv6-Freigabe von Port 22 (Incident 008, Phase 3).
