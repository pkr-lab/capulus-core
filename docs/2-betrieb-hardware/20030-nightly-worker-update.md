# Nightly Worker Update: automatisches apt-Update für worker-0/worker-1

worker-0 und worker-1 sind reine k3s-Compute-Nodes ohne die volle
[`common`-Rolle](../../ansible/roles/common) des Homeservers — sie bekommen
dadurch nie ein OS-Update, zumal sie die meiste Zeit per
[Cluster Power Manager](20020-cluster-power-manager.md) ausgeschaltet sind.
`nightly_worker_wake` schließt diese Lücke: jede Nacht um 01:00 Uhr Berlin
Zeit löst ein n8n-Workflow (Schedule-Trigger) das Wecken aus, beide Worker
werden per Wake-on-LAN geweckt, per Semaphore `apt update && apt
dist-upgrade` gefahren (inkl. automatischem Reboot, falls ein
Kernel-/libc-Update das verlangt), und danach bis spätestens 01:30 Uhr
wieder heruntergefahren — hartes Zeitbudget von maximal 25 Minuten ab dem
ersten Wake. Am Ende jedes Laufs geht IMMER ein Bericht (was wurde
geupdated, wo gab es Fehler, wurde rebootet) als Zammad-Ticket über n8n
raus, siehe [Bericht (Zammad-Ticket via n8n)](#bericht-zammad-ticket-via-n8n)
unten.

Das **lastbasierte** Zu-/Abschalten von worker-0/worker-1 tagsüber
(CPU/RAM-Watchdog, unabhängig von der Uhrzeit) ist NICHT Teil dieses
Workflows und bleibt bewusst reines Ansible/systemd auf dem Homeserver —
siehe [Cluster Power Manager](20020-cluster-power-manager.md). Nur der
**zeitgesteuerte** nächtliche Update-Zyklus wird von n8n angestoßen.

---

## Architektur

```
┌── n8n ("Nightly Worker Wake Trigger", Schedule-Trigger 01:00 Uhr) ──┐
│  SSH-Node -> homeserver, forced-command-Key (siehe unten)           │
└──────────────────────────────┬───────────────────────────────────────┘
                                │ SSH (forced: systemctl start ...)
                                ▼
┌─────────────────────── homeserver ──────────────────────────────────────────────────┐
│                                                                                       │
│  nightly-worker-wake.service (oneshot, per SSH-Forced-Command gestartet)            │
│  ├─ 1. cluster-power-manager.service stoppen (Kollisionsschutz, siehe unten)         │
│  ├─ 2. wakeonlan an worker-0 + worker-1, auf kubectl-Ready warten, uncordon          │
│  ├─ 3. Login bei Semaphore (Admin-Passwort aus /etc/semaphore-secrets)              │
│  ├─ 4. Template "Deploy worker-0" / "Deploy worker-1" per REST-API triggern         │
│  │     → führt worker-0.yml/worker-1.yml aus, inkl. worker_apt_update (cordon+     │
│  │       drain + Reboot bei reboot-required, siehe unten)                           │
│  ├─ 5. Task-Status pollen, bis fertig ODER max. 25 Minuten seit dem ersten Wake      │
│  │     (danach: Task-Stop-Request + kurze Gnadenfrist)                              │
│  ├─ 6. kubectl cordon+drain, SSH-Poweroff (derselbe Key wie cluster_power_manager)   │
│  ├─ 7. cluster-power-manager.service wieder starten                                 │
│  └─ 8. Bericht (JSON) an n8n-Webhook -- läuft IMMER, auch bei Fehlern/Abbruch        │
│        (zentral über einen EXIT-Trap, siehe unten)                                  │
└───────────────────────────────────────────────────────────────────────────────────────┘
              │ Magic Packet (UDP)  │ Semaphore-REST-API  │ SSH (forced: poweroff)  │ Webhook (JSON)
              ▼                      ▼                     ▼                         ▼
┌─────────────────────┐   ┌───────────────────────┐  ┌─────────────────────┐  ┌───────────────────┐
│ worker-0 / worker-1  │   │ Semaphore (im Cluster) │  │ worker-0 / worker-1  │  │ n8n -> Zammad      │
│ wake_on_lan-Rolle     │◀─│ Projekt "worker-0"/    │  │ cluster_power_       │  │ (Ticket pro Nacht) │
│                       │SSH│ "worker-1", Template   │  │ manager_target-Rolle │  └───────────────────┘
│                       │(voller│ "Deploy worker-*"  │  │ (poweroff-only Key)  │
│                       │Zugriff)│ führt worker_apt_ │  └─────────────────────┘
└─────────────────────┘   │ update + k3s_agent + Watchdogs └──────────────────┘
```

**Warum triggert n8n statt eines systemd-Timers?** Der 01:00-Uhr-Zeitpunkt
lag früher als `OnCalendar`-Ausdruck direkt im systemd-Timer der Rolle.
Jetzt gibt der n8n-Workflow
[`nightly-worker-wake-trigger.json`](../../argocd/apps/workloads/n8n/workflows/nightly-worker-wake-trigger.json)
den Zeitpunkt vor und startet den Zyklus per SSH. `nightly-worker-wake.sh`
selbst, das Zeitbudget, der Shutdown-Pfad und der Bericht bleiben dabei
komplett unverändert — nur der Auslöser wandert von einem lokalen
systemd-Timer zu einem extern (n8n) gesteuerten Trigger. **Das eigentliche
Wake-on-LAN bleibt bewusst auf dem homeserver**, nicht in n8n: WoL-Magic-
Packets sind Broadcast-Frames im lokalen Netzsegment, der n8n-Pod läuft
aber im k3s-Overlay-Netz ohne `hostNetwork` und hätte keinen zuverlässigen
Weg, worker-0/worker-1 direkt zu wecken.

Der SSH-Zugang von n8n zum homeserver ist über einen dedizierten Key
abgesichert, der per **forced command** (siehe `authorized_keys`) exakt
auf `sudo systemctl start nightly-worker-wake.service` beschränkt ist —
identisches Muster wie der poweroff-only-Key von
[`cluster_power_manager_target`](../../ansible/roles/cluster_power_manager_target)
(dort: Homeserver → Worker, hier: n8n → Homeserver). Selbst wenn der
private Schlüssel abfließen sollte, kann er ausschließlich diesen einen
Service starten — kein interaktives Shell-Login, kein Port-/Agent-
Forwarding. Details zur Einrichtung siehe
[Bericht (Zammad-Ticket via n8n)](#bericht-zammad-ticket-via-n8n) unten,
Abschnitt "Einmalige Einrichtung — Trigger".

**Warum ein `EXIT`-Trap für Shutdown/Bericht statt Aufrufen am Skriptende?**
Bricht das Skript unerwartet ab (z.B. Semaphore-API mitten im Lauf nicht
erreichbar), würde ein normaler "letzte Zeilen des Skripts"-Ablauf
übersprungen — ein geweckter Worker bliebe unbemerkt bis zum nächsten
manuellen Eingriff an. `cleanup_and_report()` läuft deshalb über
`trap ... EXIT` bei **jedem** Skriptende (normaler Durchlauf, frühes
`exit 0`, oder Abbruch durch `set -e`): fährt alle geweckten Worker
herunter, reaktiviert `cluster-power-manager.service` und schickt den
Bericht — mit einem generischen "Skript brach ab"-Hinweis, falls der
Abbruch unerwartet war.

**Warum über Semaphore statt eines eigenen Update-SSH-Keys?** Semaphore
hat über [`semaphore_targets`](../../ansible/roles/semaphore_targets) bereits
vollen, Vault-fähigen SSH-Zugriff auf beide Worker und führt bereits
`worker-0.yml`/`worker-1.yml` aus (siehe [../b-kubernetes-gitops/b0030-semaphore.md](../b-kubernetes-gitops/b0030-semaphore.md)).
`nightly_worker_wake` triggert nur ein bestehendes Template zur richtigen
Zeit, statt einen zweiten, separat gepflegten Zugangsweg mit eigenem
Schlüsselmaterial aufzubauen. Für den Shutdown-Pfad gilt weiterhin das
Gegenteil: dort bleibt bewusst der auf `sudo poweroff` beschränkte Key aus
`cluster_power_manager` im Einsatz, siehe
[20020-cluster-power-manager.md](20020-cluster-power-manager.md).

**Warum `cluster-power-manager.service` während des Fensters stoppen?**
Der lastbasierte Watchdog würde einen Worker sonst mit eigener Logik
(CPU/RAM niedrig + `MIN_UPTIME_SECONDS` erreicht) parallel herunterfahren
können — im ungünstigsten Fall mitten in einem laufenden
`apt dist-upgrade`, was `dpkg` in einem kaputten Zwischenzustand
zurücklassen kann. `nightly-worker-wake.sh` stoppt den Dienst deshalb zu
Beginn und startet ihn am Ende wieder.

**Automatischer Reboot bei `reboot-required`:** Kernel-/libc-Updates
verlangen gelegentlich einen Neustart, damit sie tatsächlich greifen.
`worker_apt_update` prüft nach dem `dist-upgrade` `/var/run/reboot-required`
und rebootet bei Bedarf selbstständig — **ohne** manuelles Eingreifen:

1. `kubectl cordon` + `kubectl drain` (delegiert auf `homeserver`, gleiche
   Flags wie beim finalen Shutdown) — evakuiert eventuell laufende Pods
   sauber, statt sie beim harten Neustart abzureißen.
2. `ansible.builtin.reboot` auf dem Worker selbst — wartet zuverlässig
   (Boot-ID-Vergleich, nicht nur "SSH antwortet wieder"), bis der Node
   tatsächlich neu gebootet und erreichbar ist.
3. Uncordon danach übernimmt die ohnehin schon bestehende "Uncordon nach
   Provisioning"-Play am Ende von `worker-0.yml`/`worker-1.yml` — kein
   separater Schritt nötig.

Läuft komplett innerhalb desselben Semaphore-Tasks, den
`nightly_worker_wake` sowieso schon abwartet — kein eigener SSH-Key, keine
Änderung am Orchestrator-Skript. Der Bericht (siehe unten) markiert einen
rebooteten Worker mit `"rebooted": true`.

---

## Beteiligte Rollen

| Rolle | Läuft auf | Zweck |
|---|---|---|
| [`worker_apt_update`](../../ansible/roles/worker_apt_update) | worker-0, worker-1 | `apt update && apt dist-upgrade`; bei `/var/run/reboot-required` automatisch cordon+drain (delegiert auf homeserver) + Reboot |
| [`nightly_worker_wake`](../../ansible/roles/nightly_worker_wake) | homeserver | Skript + SSH-Forced-Command-Key für den n8n-Trigger: wecken, Semaphore-Template triggern, Zeitbudget überwachen, herunterfahren, Bericht an n8n |

`worker_apt_update` ist der erste Schritt in `worker-0.yml`/`worker-1.yml`
und läuft damit bei **jedem** Lauf dieser Playbooks — auch bei einem
manuellen `make worker-0`/`make worker-1` oder `make worker-apt-update`.

Dazu kommen zwei n8n-Workflows (kein Ansible, müssen einmalig manuell in
n8n importiert werden):

- [`nightly-worker-wake-trigger.json`](../../argocd/apps/workloads/n8n/workflows/nightly-worker-wake-trigger.json)
  — Schedule-Trigger 01:00 Uhr, löst den Zyklus per SSH aus (siehe
  [Architektur](#architektur) oben und [Bericht (Zammad-Ticket via n8n)](#bericht-zammad-ticket-via-n8n)
  unten, Abschnitt "Einmalige Einrichtung — Trigger").
- [`nightly-worker-update-to-zammad.json`](../../argocd/apps/workloads/n8n/workflows/nightly-worker-update-to-zammad.json)
  — Webhook, baut aus dem Bericht das Zammad-Ticket, siehe
  [Bericht (Zammad-Ticket via n8n)](#bericht-zammad-ticket-via-n8n).

---

## Zeitbudget

| Variable | Default | Bedeutung |
|---|---|---|
| — | `01:00 Uhr, Europe/Berlin` | Zeitpunkt kommt jetzt aus dem Schedule-Trigger von [`nightly-worker-wake-trigger.json`](../../argocd/apps/workloads/n8n/workflows/nightly-worker-wake-trigger.json), nicht mehr aus einer Ansible-Variable — dort anpassen |
| `nightly_worker_wake_max_runtime_seconds` | 1500 (25 Min.) | Hartes Limit ab dem ersten Wake — danach Task-Stop + Shutdown, egal ob das Update (inkl. eines eventuellen Reboots) fertig ist. Passt unter das 01:00–01:30-Uhr-Fenster |
| `nightly_worker_wake_ready_timeout_seconds` | 180 | Wie lange nach dem Magic Packet auf `kubectl get node ... Ready` gewartet wird |
| `nightly_worker_wake_stop_grace_seconds` | 30 | Gnadenfrist nach einem Semaphore-Task-Stop-Request, bevor trotzdem heruntergefahren wird |
| `nightly_worker_wake_poll_seconds` | 15 | Poll-Intervall beim Warten auf den Semaphore-Task |

Es gibt **keine** erzwungene Mindestlaufzeit — ein Worker, dessen Update
schneller fertig ist, wird sofort wieder heruntergefahren statt aus
Prinzip bis zu einer Mindestdauer zu warten. In der Praxis dauert ein
`apt update && dist-upgrade` auf diesen Nodes üblicherweise 5–15 Minuten,
ein zusätzlicher Reboot (falls nötig) weitere 30–90 Sekunden; die
25-Minuten-Grenze ist ein Sicherheitsnetz, kein Zielwert. Alle Werte
lassen sich in `group_vars/all.yml` überschreiben (identisches Muster wie
bei [`cluster_power_manager`](20020-cluster-power-manager.md)).

---

## Bericht (Zammad-Ticket via n8n)

`nightly-worker-wake.sh` schickt am Ende **jedes** Laufs ein JSON an
`nightly_worker_wake_n8n_webhook_url`
(Default `http://n8n.prod.homeserver/webhook/nightly-worker-update`) —
egal ob alles glatt lief, ein Worker nicht aufgewacht ist, ein Update
fehlschlug, das Zeitbudget erreicht wurde, oder das Skript selbst
unerwartet abbrach. Der n8n-Workflow
[`nightly-worker-update-to-zammad.json`](../../argocd/apps/workloads/n8n/workflows/nightly-worker-update-to-zammad.json)
baut daraus **ein Zammad-Ticket pro Nacht** in der Gruppe
`Support::Administration`.

Payload-Format (vereinfacht):

```json
{
  "started_at": "2026-08-19T01:00:03+00:00",
  "finished_at": "2026-08-19T01:11:42+00:00",
  "elapsed_seconds": 699,
  "note": "",
  "dry_run": false,
  "workers": [
    {
      "name": "worker-0",
      "status": "success",
      "reason": "",
      "changed": true,
      "play_recap": "worker-0 : ok=41 changed=3 unreachable=0 failed=0 skipped=2 rescued=0 ignored=0",
      "rebooted": true
    },
    {
      "name": "worker-1",
      "status": "not_ready",
      "reason": "Nicht innerhalb von 180s nach Wake-on-LAN erreichbar geworden",
      "changed": false,
      "play_recap": "",
      "rebooted": false
    }
  ]
}
```

`status` je Worker: `success` / `error` / `stopped` (Zeitbudget erreicht)
/ `not_ready` (nicht aufgewacht) / `no_template` (Semaphore-Projekt/
Template fehlt) / `pending` (Skript brach vorher ab). `play_recap` ist die
rohe Ansible-`PLAY RECAP`-Zeile, per Semaphore-API aus dem Task-Log
gezogen — daran lässt sich auf einen Blick ablesen, ob überhaupt etwas
geändert wurde (`changed=0` ⇒ nichts zu tun). `rebooted: true` heißt: ein
Kernel-/libc-Update verlangte einen Neustart, `worker_apt_update` hat ihn
automatisch durchgeführt (siehe [Architektur](#architektur) oben) — kein
Handlungsbedarf, nur zur Information im Ticket.

**Einmalige Einrichtung — Trigger (`nightly-worker-wake-trigger.json`):**

1. `make nightly-worker-wake` (oder `make install`) laufen lassen — die
   Rolle erzeugt dabei einmalig das SSH-Schlüsselpaar unter
   `/etc/nightly-worker-wake/n8n_trigger_ed25519` auf dem homeserver und
   autorisiert den Public Key (forced command, siehe
   [Architektur](#architektur) oben).
2. Privaten Schlüssel einmalig auslesen:
   ```bash
   ssh ubuntu@192.168.178.94 sudo cat /etc/nightly-worker-wake/n8n_trigger_ed25519
   ```
   Inhalt **nicht** ins Repo committen — nur zum Anlegen der n8n-Credential
   im nächsten Schritt verwenden.
3. In n8n: *Workflows* → *Import from File* →
   `argocd/apps/workloads/n8n/workflows/nightly-worker-wake-trigger.json`
4. Node „Worker-Update ausloesen (SSH, forced command)“ → neue SSH-
   Credential (Private Key) anlegen: Host `192.168.178.94`, Port `22`,
   Username `ubuntu` (Default von `nightly_worker_wake_n8n_trigger_ssh_user`),
   Private Key = Inhalt aus Schritt 2.
5. Workflow **aktivieren** (Import allein reicht nicht).

Der eingetragene Befehl im SSH-Node ist informativ — durchgesetzt wird
ausschließlich der per `authorized_keys` hinterlegte forced command
(`sudo systemctl start nightly-worker-wake.service`); ein anderer Befehl
im Node würde ignoriert bzw. durch den forced command überschrieben.

**Einmalige Einrichtung — Bericht (`nightly-worker-update-to-zammad.json`):**

1. In n8n: *Workflows* → *Import from File* →
   `argocd/apps/workloads/n8n/workflows/nightly-worker-update-to-zammad.json`
2. Node „Zammad-Ticket erstellen“ → Credential zuweisen (bestehende
   „Zammad Token Auth (Rotation-Reminder)“ wiederverwenden, siehe
   [../d-sicherheit/d0060-secrets-rotation.md](../d-sicherheit/d0060-secrets-rotation.md), oder neu anlegen:
   Base URL `https://zammad.homeserver`, Access Token mit Berechtigung
   `ticket.agent`)
3. Workflow **aktivieren** (Import allein reicht nicht)
4. `nightly_worker_wake_n8n_webhook_url` gegen die tatsächliche n8n-Ingress-
   Adresse prüfen (Default passt zu `n8n.prod.homeserver`, siehe
   [../3-apps-workloads/30070-n8n.md](../3-apps-workloads/30070-n8n.md))

Ist der Webhook nicht erreichbar, bricht der nächtliche Zyklus **nicht**
ab — nur eine Journal-Warnung (`n8n-Webhook ... nicht erreichbar`), Worker
werden trotzdem korrekt heruntergefahren. Die ntfy-Push-Meldungen
(Start/Ende/Fehler) laufen unabhängig davon weiter.

---

## Deployment

```bash
make install              # site.yml: cluster_power_manager + nightly_worker_wake
make worker-0 worker-1    # worker-0.yml/worker-1.yml: jetzt inkl. worker_apt_update
```

Nur die Rolle auf dem Homeserver neu ausrollen (z.B. nach Änderung des
Zeitbudgets):

```bash
make nightly-worker-wake
```

Update manuell anstoßen, ohne auf 01:00 Uhr zu warten:

```bash
make worker-apt-update     # setzt voraus, dass beide Worker bereits wach sind
```

---

## Testen ohne echten Wake/Shutdown

```bash
# Auf homeserver:
sudo systemctl edit --runtime nightly-worker-wake.service
# In der sich öffnenden Datei:
[Service]
Environment=DRY_RUN=1
# Speichern, dann manuell auslösen (nicht auf 01:00 Uhr warten):
sudo systemctl start nightly-worker-wake.service
sudo journalctl -u nightly-worker-wake -f
```

Mit `DRY_RUN=1` protokolliert das Skript jeden Schritt, sendet aber kein
`wakeonlan`, triggert keinen echten Semaphore-Task und führt kein
`cordon`/`drain`/`poweroff` aus. Der `systemctl edit --runtime`-Drop-in
verschwindet beim nächsten Boot automatisch wieder.

Den n8n-Trigger selbst testen, ohne auf 01:00 Uhr zu warten: im
importierten Workflow [`nightly-worker-wake-trigger.json`](../../argocd/apps/workloads/n8n/workflows/nightly-worker-wake-trigger.json)
den SSH-Node manuell ausführen ("Execute step") — das löst denselben
forced command aus wie der nächtliche Schedule-Trigger.

---

## Fehlerbehebung

**Nächtlicher Zyklus läuft gar nicht erst an (kein Journal-Eintrag um 01:00 Uhr):**

Der Trigger kommt jetzt von n8n, nicht mehr von einem lokalen systemd-
Timer — zuerst dort prüfen:

```bash
# n8n: Workflow "Nightly Worker Wake Trigger" -> Executions -> letzte
# Ausführung ansehen (Fehler am SSH-Node?)
```

Häufigste Ursachen: Workflow nicht aktiviert (Import allein reicht
nicht, siehe [Bericht (Zammad-Ticket via n8n)](#bericht-zammad-ticket-via-n8n)
weiter unten, Abschnitt "Einmalige Einrichtung — Trigger"), SSH-Credential
zeigt auf einen veralteten privaten Schlüssel (z.B. nach einem Neu-
Provisionieren des homeserver, das den Key unter
`/etc/nightly-worker-wake/n8n_trigger_ed25519` neu erzeugt hätte —
passiert normalerweise NICHT, da `ssh-keygen` idempotent mit `creates:`
läuft, siehe `ansible/roles/nightly_worker_wake/tasks/main.yml`), oder
der sudoers-Eintrag fehlt (`nightly_worker_wake_enabled: false` gesetzt
gewesen?). Manuell nachvollziehen:

```bash
ssh -i <n8n-private-key> ubuntu@192.168.178.94 "irgendein-befehl"
# Sollte trotzdem nightly-worker-wake.service starten (forced command)
# und NICHT den übergebenen Befehl ausführen -- eine Fehlermeldung wie
# "sudo: a password is required" deutet auf einen fehlenden/falschen
# Eintrag in /etc/sudoers.d/nightly-worker-wake-n8n-trigger hin.
```

**Semaphore-Login schlägt fehl (`WARNUNG: Semaphore-Login fehlgeschlagen`):**

Worker werden geweckt und sofort wieder heruntergefahren, OHNE Update.
Prüfen:

```bash
cat /etc/semaphore-secrets/admin_password   # noch aktuell?
curl -i http://semaphore-api.tech.homeserver/api/ping
```

Meist rotiertes Admin-Passwort in der Semaphore-UI (siehe
[../b-kubernetes-gitops/b0030-semaphore.md](../b-kubernetes-gitops/b0030-semaphore.md)) oder Semaphore-Pod noch nicht bereit.

**Kein Semaphore-Projekt/Template gefunden:**

```
WARNUNG: kein Semaphore-Projekt 'worker-0' gefunden -- überspringe Update
```

`make semaphore-bootstrap` erneut laufen lassen — legt Projekte/Templates
idempotent an bzw. aktualisiert sie.

**Update-Task läuft beim Zeitlimit noch:**

```
WARNUNG: Zeitbudget erreicht, folgende Updates laufen noch: worker-0 -- breche ab
```

Der Task wird per Stop-Request beendet, der Worker danach trotzdem
heruntergefahren. Im schlimmsten Fall bleibt `dpkg` in einem
Zwischenzustand — beim nächsten Wake mit
`ssh ubuntu@<ip> sudo dpkg --configure -a` nachziehen. Falls das
regelmäßig passiert: `nightly_worker_wake_max_runtime_seconds` erhöhen.

**Reboot nach Kernel-/libc-Update:**

Läuft automatisch (siehe [Architektur](#architektur)) — kein manuelles
Eingreifen nötig. Falls der Reboot selbst hängt oder zu lange dauert
(`ansible.builtin.reboot` erreicht `worker_apt_update_reboot_timeout_seconds`,
Default 300s), schlägt der Semaphore-Task mit `status: error` fehl; der
Worker wird trotzdem am Ende des Zyklus heruntergefahren (Sicherheitsnetz
im `EXIT`-Trap), und das Zammad-Ticket zeigt den Fehler. Task-Log prüfen:

```bash
# Task-ID aus dem Ticket bzw. journalctl -u nightly-worker-wake
curl -s -b <cookie-jar> \
  http://semaphore-api.tech.homeserver/api/project/<id>/tasks/<task-id>/output \
  | jq -r '.[].output'
```

Reboot manuell nachholen (z.B. wenn der Timeout regelmäßig reißt und man
vor einer Ursachenklärung erstmal selbst eingreifen will):

```bash
ssh ubuntu@192.168.178.95 sudo reboot   # worker-0
```

**Kein Zammad-Ticket trotz gelaufenem Update:**

```bash
journalctl -u nightly-worker-wake | grep n8n-Webhook
```

Zeigt `WARNUNG: n8n-Webhook ... nicht erreichbar` → Workflow in n8n
importiert UND aktiviert? (`active: false` ist der Zustand direkt nach dem
Import.) Webhook-URL testen:

```bash
curl -i -X POST http://n8n.prod.homeserver/webhook/nightly-worker-update \
  -H 'Content-Type: application/json' \
  -d '{"started_at":"test","finished_at":"test","elapsed_seconds":0,"note":"manueller Test","dry_run":true,"workers":[]}'
```

Kommt der Webhook an, aber es entsteht kein Ticket → Credential-Zuweisung
im Node „Zammad-Ticket erstellen“ prüfen (siehe
[Bericht (Zammad-Ticket via n8n)](#bericht-zammad-ticket-via-n8n)).

---

## Relevante Links

- [Cluster Power Manager (lastbasiertes WoL-Zu-/Abschalten)](20020-cluster-power-manager.md)
- [Semaphore-UI](../b-kubernetes-gitops/b0030-semaphore.md)
- [k3s-Referenz](../b-kubernetes-gitops/b0000-k3s.md)
