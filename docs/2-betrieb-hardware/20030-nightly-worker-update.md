# Nightly Worker Update: automatisches apt-Update für worker-0/worker-1

worker-0 und worker-1 sind reine k3s-Compute-Nodes ohne die volle
[`common`-Rolle](../../ansible/roles/common) des Homeservers — sie bekommen
dadurch nie ein OS-Update, zumal sie die meiste Zeit per
[Cluster Power Manager](20020-cluster-power-manager.md) ausgeschaltet sind.
`nightly_worker_wake` schließt diese Lücke: jede Nacht um 01:00 Uhr
werden beide Worker per Wake-on-LAN geweckt, per Semaphore
`apt update && apt dist-upgrade` gefahren (inkl. automatischem Reboot,
falls ein Kernel-/libc-Update das verlangt), und danach wieder
heruntergefahren — mit einem harten Zeitbudget von maximal 25 Minuten.
Am Ende jedes Laufs geht IMMER ein Bericht (was wurde geupdated, wo gab
es Fehler, wurde rebootet) als Zammad-Ticket über n8n raus, siehe
[Bericht (Zammad-Ticket via n8n)](#bericht-zammad-ticket-via-n8n) unten.

---

## Architektur

```
┌─────────────────────── homeserver (01:00 Uhr, systemd-Timer) ──────────────────────┐
│                                                                                       │
│  nightly-worker-wake.service (oneshot)                                              │
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
zurücklassen kann. Der Timer stoppt den Dienst deshalb zu Beginn und
startet ihn am Ende wieder.

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
| [`nightly_worker_wake`](../../ansible/roles/nightly_worker_wake) | homeserver | systemd-Timer + Skript: wecken, Semaphore-Template triggern, Zeitbudget überwachen, herunterfahren, Bericht an n8n |

`worker_apt_update` ist der erste Schritt in `worker-0.yml`/`worker-1.yml`
und läuft damit bei **jedem** Lauf dieser Playbooks — auch bei einem
manuellen `make worker-0`/`make worker-1` oder `make worker-apt-update`.

Dazu kommt der n8n-Workflow
[`nightly-worker-update-to-zammad.json`](../../argocd/apps/workloads/n8n/workflows/nightly-worker-update-to-zammad.json)
(kein Ansible, muss einmalig manuell in n8n importiert werden) — siehe
[Bericht (Zammad-Ticket via n8n)](#bericht-zammad-ticket-via-n8n).

---

## Zeitbudget

| Variable | Default | Bedeutung |
|---|---|---|
| `nightly_worker_wake_oncalendar` | `*-*-* 01:00:00 <timezone>` | systemd-`OnCalendar`-Ausdruck |
| `nightly_worker_wake_max_runtime_seconds` | 1500 (25 Min.) | Hartes Limit ab dem ersten Wake — danach Task-Stop + Shutdown, egal ob das Update (inkl. eines eventuellen Reboots) fertig ist |
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

**Einmalige Einrichtung:**

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

Zeitpunkt/Timer prüfen:

```bash
systemctl list-timers nightly-worker-wake.timer
```

---

## Fehlerbehebung

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
