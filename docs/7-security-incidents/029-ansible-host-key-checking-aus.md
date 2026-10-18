# 029 Ansible: `host_key_checking = False`, Fact-Cache in `/tmp`, `validate_certs: false` im Vaultwarden-Restore

- Severity: Low
- Bereich: Repo
- Betroffen: `capulus-ansible/ansible.cfg:5,16`, `capulus-ansible/roles/vaultwarden_restore/tasks/main.yml:63`
- Status: Behoben am 2026-10-18 (im Code, gestaged; gilt ab dem nächsten Ansible-Lauf)

## Beschreibung

`ansible.cfg` schaltet die SSH-Host-Key-Prüfung ab (Man-in-the-Middle beim Verbindungsaufbau zu allen Hosts mit `become`). Der Fact-Cache liegt unter `/tmp/ansible-facts` (je nach `umask` für andere lokale Benutzer lesbar). Der Vaultwarden-Restore prüft das Zertifikat der Health-URL nicht (`validate_certs: false`). checkov meldet zusätzlich 30 `uri`-Aufrufe mit `http://`.

## Nachweis

```
$ sed -n '5p;16p' capulus-ansible/ansible.cfg
host_key_checking = False
fact_caching_connection = /tmp/ansible-facts
$ sed -n 63p capulus-ansible/roles/vaultwarden_restore/tasks/main.yml
    validate_certs: false
```

## Risiko / Angriffsszenario

Ein MITM im LAN kann sich gegenüber dem Ansible-Controller als Zielhost ausgeben und dabei Secrets aus dem Lauf (Vault-Variablen, Tokens) abgreifen. Der Cache verrät Hostfakten an lokale Benutzer des Controllers.

## Empfohlene Behebung

1. `host_key_checking = True` setzen, bekannte Hosts einmalig mit `ssh-keyscan` in `known_hosts` eintragen.
2. `fact_caching_connection = ~/.cache/ansible-facts` mit `0700`.
3. `validate_certs: true` und die interne CA über `SSL_CERT_FILE` bzw. `ca_path` bereitstellen.

## Rollback

Werte in `ansible.cfg` zurücksetzen.

## Verifikation

```
ansible all -m ping
stat -c '%a' ~/.cache/ansible-facts
```
Erster Lauf nach `known_hosts`-Pflege ohne Fingerprint-Rückfragen; Rechte `700`.

## Risiko der Behebung

Niedrig: Beim ersten Lauf nach der Änderung müssen die Hostschlüssel bestätigt werden.

## Behebung (2026-10-18)

**Fix.**

- `capulus-ansible/ansible.cfg`: `host_key_checking = True`, `ssh_args` ergänzt um `-o StrictHostKeyChecking=accept-new`. Unbekannte Hosts werden beim ersten Kontakt aufgenommen (wichtig für Semaphore und frische Umgebungen ohne `known_hosts`), geänderte Schlüssel brechen die Verbindung ab. Die Empfehlung `ssh-keyscan` entfällt damit; ein vorheriges Eintragen der Schlüssel wäre sicherer als Aufnahme beim ersten Kontakt, für den Heimbetrieb ist TOFU vertretbar.
- `fact_caching_connection = ~/.cache/ansible-facts` statt `/tmp/ansible-facts`, Verzeichnis mit `0700`.
- `vaultwarden_restore`: `validate_certs: true`. Der Homeserver vertraut der Root-CA im System-Trust-Store.

**Nachweis.**

| Test | Ergebnis |
|---|---|
| `ansible homeserver -m ping` mit der neuen Konfiguration | `pong` |
| `ansible all -m ping` | erreichbar mit `pong`: homeserver, prod-vm, entw-vm, infotafel, vereinsheim-alarmmonitor (keine Host-Key-Fehler, `known_hosts` des Controllers passt); fehlgeschlagen nur wie bisher: worker-0/-1 (ausgeschaltet, Vault-Passwort wird hier nicht übergeben), ugreen-nas (Port 22 aus), alert-caller-vm (Platzhalter-Adresse) |
| `stat -c '%a' ~/.cache/ansible-facts` | `700` |
| `ansible-playbook --syntax-check` (vaultwarden-restore, banana-pi-kiosks) | ok |
| `curl https://vault.tech.homeserver/alive` auf dem Homeserver ohne `-k` | `200`, `ssl_verify_result=0` |

**Geänderte Dateien.**

- `capulus-ansible/ansible.cfg`, `capulus-ansible/roles/vaultwarden_restore/tasks/main.yml`
- Doku: `docs/6-hintergruende/60010-ansible-hosts-und-playbooks.md`

**Rollback.** `git revert` oder in `ansible.cfg` `host_key_checking = False` zurücksetzen.

**Offen.**

- Nach einem Neuaufbau eines Hosts bricht Ansible mit `REMOTE HOST IDENTIFICATION HAS CHANGED` ab: `ssh-keygen -R <ip>` und neu verbinden (so gewollt).
- Der Semaphore-Pod hat einen eigenen Home und eigene Ansible-Umgebung; ob dessen Läufe die `ansible.cfg` aus dem Repo nutzen, hängt vom Arbeitsverzeichnis des Templates ab. Nach dem Merge den nächsten Semaphore-Lauf (zum Beispiel „Deploy worker-*“) beobachten.
- checkov-Hinweis auf 30 `uri`-Aufrufe mit `http://` ist nicht angefasst (interne Cluster-Dienste ohne TLS).
