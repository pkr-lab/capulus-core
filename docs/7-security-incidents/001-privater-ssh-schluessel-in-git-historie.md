# 001 Privater SSH-Schlüssel der Banana Pis im öffentlichen Git-Verlauf

- Severity: High
- Bereich: Repo
- Betroffen: Commit `9dea3e3` (2026-08-10): `BananaPi`, `BananaPi.pub`; entfernt in `8625d54` (2026-08-13); Repo `pkr-lab/capulus-core` (öffentlich)
- Status: Behoben am 2026-10-17 (Restpunkt: worker-0 ungeprüft, siehe Abschnitt „Behebung“)

## Beschreibung

Der Commit `9dea3e3` hat einen vollständigen OpenSSH-Private-Key (Ed25519) als Datei `BananaPi` samt `BananaPi.pub` eingecheckt. Commit `8625d54` hat beide Dateien aus dem Arbeitsstand entfernt, aus der Git-Historie sind sie dadurch nicht verschwunden. Das Repository ist öffentlich (`gh repo view`: `PUBLIC`), der Schlüssel muss deshalb als kompromittiert gelten, auch wenn er seit Mitte August nicht mehr im Branch liegt: Forks, Klone, Suchmaschinen- und Archiv-Caches halten ihn weiter vor.

Der Schlüssel hat keine Passphrase und passt zum mitgelieferten Public Key. `.gitleaksignore` führt den Fund als bekannten Altfund und unterdrückt ihn in der CI. Ein Rohscan mit den gitleaks-Standardregeln (ohne diese Ignore-Liste, Version 8.30.1) hat ihn in diesem Audit nicht gemeldet. Auf gitleaks allein ist bei dieser Art Fund deshalb kein Verlass.

Ob der Schlüssel heute noch in `authorized_keys` der Banana Pis (oder anderer Hosts) steht, ist ohne Host-Zugriff nicht prüfbar (Phase 2).

## Nachweis

```
$ git log --all --oneline -S'BEGIN OPENSSH PRIVATE KEY'
8625d54 chore: remove deprecated SSH key files for security compliance
9dea3e3 feat: update Banana Pi configuration with new IP and user details

$ git show 9dea3e3:BananaPi | head -1
-----BEGIN OPENSSH PRIVATE KEY-----

$ ssh-keygen -y -P '' -f <Kopie des Schlüssels aus 9dea3e3>
(erfolgreich: kein Passphrase-Schutz; abgeleiteter Public Key == BananaPi.pub)

$ git show 9dea3e3:BananaPi.pub | ssh-keygen -lf -
256 SHA256:G+1ezIam4dN0UiJW3CTXSUKj6L4LPrI89LZH0BFIKqw pela@192.168.178.129 (ED25519)

$ gh repo view --json visibility
{"visibility":"PUBLIC"}
```
Der Schlüsselinhalt wird hier bewusst nicht wiedergegeben.

## Phase-2-Nachweis (live, lesend)

Abgleich des Fingerprints per `ssh-keygen -lf` gegen `authorized_keys` (Stand 2026-10-16):

| Host | Ergebnis |
|---|---|
| homeserver | nicht enthalten (4 Schlüssel: homelab, semaphore@homeserver, mac, n8n-nightly-worker-trigger) |
| worker-1 | nicht enthalten (3 Schlüssel: homelab, semaphore@homeserver, cluster-power-manager@homeserver) |
| prod-vm | nicht enthalten (prod-vm-admin, ubuntu@homeserver) |
| entw-vm | nicht enthalten (prod-vm-admin) |
| worker-0 | nicht erreichbar (ausgeschaltet) |
| Banana Pis (`vereinsheim-alarmmonitor`, `infotafel`) | nicht Teil der Freigabe, **ungeprüft** |

Verschärfend: Laut Paketfilter des homeservers darf `vereinsheim-alarmmonitor` alle Ports des homeservers erreichen (Incident 036). Ein noch gültiger Schlüssel auf dem Alarmmonitor wäre damit ein Sprungbrett bis zum cluster-admin.

## Risiko / Angriffsszenario

Wer die Historie klont, kann sich an jedem System anmelden, dessen `authorized_keys` den Public Key enthält. Das sind nach Lage der Dinge die Banana-Pi-Kiosk-Geräte (Vereinsheim-Alarmmonitor), die im Tailnet hängen. Angriffsszenario: Schlüssel aus der Historie ziehen, per Tailscale/LAN auf den Pi, dort Persistenz und Sprung in das interne Netz. Wenn der Schlüssel zusätzlich für andere Hosts verwendet wurde, ist deren Zugang gleichermaßen offen.

## Empfohlene Behebung

1. Auf allen Banana Pis (und jedem anderen Host, auf dem der Schlüssel verteilt wurde) prüfen, ob der Fingerprint noch autorisiert ist:
   ```
   ssh-keygen -lf ~/.ssh/authorized_keys | grep 'G+1ezIam4dN0UiJW3CTXSUKj6L4LPrI89LZH0BFIKqw'
   ```
2. Neues Schlüsselpaar erzeugen, Public Key zuerst zusätzlich verteilen, Login testen, erst dann den alten Eintrag entfernen:
   ```
   ssh-keygen -t ed25519 -a 64 -f ~/.ssh/banana_pi_2026-10
   ```
   Der Private Key kommt in den Passwortmanager, nie ins Repo. Die Verteilung läuft über die Ansible-Rolle `banana_pi_kiosk` bzw. `semaphore_targets`.
3. Optional die Historie bereinigen (`git filter-repo --path BananaPi --path BananaPi.pub --invert-paths`, danach Force-Push). Das bricht alle Klone und Forks und ersetzt die Rotation nicht. Vorher mit dem Nutzer abstimmen.
4. Wiederholung verhindern: GitHub Push Protection und Secret Scanning aktivieren (Incident 014), `.gitignore` um Schlüsselmuster ergänzen (Incident 032).

## Rollback

Den alten Public Key bis zur erfolgreichen Verifikation des neuen Zugangs in `authorized_keys` belassen. Bei einem Lockout hilft nur physischer Zugriff bzw. ein anderer autorisierter Schlüssel (Tailscale-SSH oder Konsole am Gerät).

## Verifikation

```
ssh -i <alter-schluessel> -o BatchMode=yes -o IdentitiesOnly=yes <user>@<banana-pi> true
```
muss mit `Permission denied (publickey)` enden. Mit dem neuen Schlüssel muss der Login klappen. Anschließend `git log --all -S'BEGIN OPENSSH PRIVATE KEY'` ausführen: bei bereinigter Historie leer.

## Risiko der Behebung

Mittel: Lockout der Kiosk-Geräte, falls der neue Schlüssel nicht vor dem Entfernen des alten verteilt ist.

## Behebung (2026-10-17)

**Fix.** Die Prüfung nach Schritt 1 der Empfehlung ergab, dass der Schlüssel auf keinem erreichbaren Host autorisiert ist. Eine Rotation und ein Entfernen eines `authorized_keys`-Eintrags waren deshalb nicht nötig: Es gibt keinen Zugang, der zu schließen wäre, und kein neues Schlüsselpaar, das irgendetwas ersetzt. Die Schritte 3 und 4 der Empfehlung sind bewusst nicht Teil dieser Behebung (siehe „Restpunkte“).

| Host | Ergebnis am 2026-10-17 | Eingetragene Schlüssel (Kommentar) |
|---|---|---|
| vereinsheim-alarmmonitor (Banana Pi) | nicht autorisiert, Login mit dem alten Schlüssel abgewiesen | homelab, semaphore@homeserver, vereinsheim alarmmonitor (zweimal, Duplikat); kein `authorized_keys` für root |
| infotafel (Raspberry Pi) | nicht autorisiert, Login mit dem alten Schlüssel abgewiesen | homelab, semaphore@homeserver, peter@mac für infotafel; `authorized_keys` von root leer |
| homeserver, worker-1, prod-vm, entw-vm | nicht autorisiert (Phase 2, 2026-10-16) | siehe „Phase-2-Nachweis“ |
| worker-0 | **ungeprüft**, ausgeschaltet und bewusst nicht geweckt | |

Auf beiden Pis sind `AuthorizedKeysCommand` und `TrustedUserCAKeys` nicht gesetzt, `authorized_keys2` existiert nicht.

**Nachweis.**

```
$ git show 9dea3e3:BananaPi > <Temp-Datei, Modus 0600>
$ ssh-keygen -y -P '' -f <Temp-Datei> | ssh-keygen -lf -
256 SHA256:G+1ezIam4dN0UiJW3CTXSUKj6L4LPrI89LZH0BFIKqw pela@192.168.178.129 (ED25519)

$ ssh -i <Temp-Datei> -o BatchMode=yes -o IdentitiesOnly=yes -o PreferredAuthentications=publickey pela@<vereinsheim-alarmmonitor> true
pela@100.123.214.4: Permission denied (publickey,password).     (rc=255)

$ ssh -i <Temp-Datei> -o BatchMode=yes -o IdentitiesOnly=yes -o PreferredAuthentications=publickey pela@<infotafel> true
pela@192.168.178.98: Permission denied (publickey,password).    (rc=255)

$ shred -u <Temp-Datei>
```
Der Standardschlüssel des Admin-PCs funktioniert auf beiden Pis weiter. Gegen homeserver, worker-1, prod-vm und entw-vm wurde bewusst kein Login mit dem alten Schlüssel versucht, um CrowdSec nicht auszulösen; dort gilt der Fingerprint-Abgleich aus Phase 2.

**Geänderte Dateien.** Auf keinem Host und in keinem Cluster wurde etwas verändert. Im Repo nur Doku:

- `docs/7-security-incidents/001-privater-ssh-schluessel-in-git-historie.md` (diese Datei)
- `docs/7-security-incidents/README.md` (Status, Behebungsstand)
- `docs/7-security-incidents/009-ssh-haertung-nicht-verwaltet.md` (Nachtrag zu den Pis)
- `docs/f-cicd-automatisierung/f0070-ci-lint.md` (Stand des Altfunds in der Beschreibung der `.gitleaksignore`)

**Rollback.** Entfällt, da nichts geändert wurde. Die Doku-Änderungen lassen sich mit `git checkout -- <Datei>` zurücknehmen.

**Health-Check nach der Prüfung.** Alarmmonitor: keine fehlgeschlagenen Units, `tailscaled`, Heartbeat-Timer, WoL-Agent und `vmagent` aktiv, keine Fehler im Journal der letzten 15 Minuten, `alamos-apager.prod.homeserver` vom Pi aus erreichbar. Öffentliche Hosts (Vaultwarden, Grafana, Zammad, ntfy, Nextcloud, Wiki.js, Uptime Kuma) antworten mit 200 bzw. 302. Vorbestehende, von dieser Prüfung unabhängige Auffälligkeiten: `systemd-journal-upload` ausgefallen auf homeserver und infotafel (siehe 039), `openipmi` und `smartmontools` auf der infotafel ausgefallen, `node_exporter` auf dem Alarmmonitor inaktiv, mehrere Pods im TECH-Cluster in `Error`, `CrashLoopBackOff` oder `Pending` (`github-release-watcher`, `logging-victoria-logs-collector`, `ollama`).

**Restpunkte.**

- worker-0: Fingerprint-Abgleich nachholen, sobald der Host ohnehin läuft (`ssh-keygen -lf ~/.ssh/authorized_keys | grep 'G+1ezIam4dN0UiJW3CTXSUKj6L4LPrI89LZH0BFIKqw'`). Der Schlüssel war ein Pi-Schlüssel, eine Verteilung auf worker-0 ist unwahrscheinlich, aber nicht belegt.
- Der Schlüssel bleibt im öffentlichen Git-Verlauf und in `.gitleaksignore`. Er ist damit weiter als kompromittiert zu behandeln, hat aber keinen Zugang mehr. Eine Bereinigung der Historie (`git filter-repo` plus Force-Push auf den geschützten `main`) wurde nicht durchgeführt: Sie bricht alle Klone und Forks und ersetzt die Prüfung nicht. Sie kann später separat entschieden werden.
- Wiederholung verhindern: GitHub Push Protection und Secret Scanning (Incident 014), Schlüsselmuster in `.gitignore` (Incident 032).
- Die Pis erlauben Passwort-Login (Alarmmonitor zusätzlich Root-Login), siehe Nachtrag in 009.
