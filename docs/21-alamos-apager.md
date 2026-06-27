# Alarmmonitor-Kiosks (ALAMOS AMweb) – DLRG OG Andernach

Zentral verwaltete Raspberry-Pi-Alarmmonitore: jeder Pi zeigt im
Kiosk-Browser die ALAMOS-AMweb-Seite (Cloud-Dienst der Alamos GmbH, eigener
Account bereits vorhanden) für seinen Standort. Der Pi selbst bleibt
absichtlich dumm und austauschbar — welche Station welche AMweb-URL bekommt,
ob ein Standort ausgefallen ist und alles Alerting läuft zentral im
k3s-Cluster.

## Inhaltsverzeichnis

1. [Übersicht & Architektur](#übersicht--architektur)
2. [Cluster-Komponente: Helm Chart `alamos-apager`](#cluster-komponente-helm-chart-alamos-apager)
3. [Neuen Standort hinzufügen](#neuen-standort-hinzufügen)
4. [Pi-Provisionierung (Ansible)](#pi-provisionierung-ansible)
5. [Monitoring & Alerting](#monitoring--alerting)
6. [Fehlerbehebung](#fehlerbehebung)

---

## Übersicht & Architektur

```
Pi (Chromium --kiosk) ──▶ http://alamos-apager.homeserver/start?station=X
                              │  (Traefik Ingress, *.homeserver Wildcard-DNS)
                              ▼
                     alamos-apager Pod (k3s, Namespace alamos-apager)
                         ├─ liest Secret-Volume /etc/alamos-apager/stations/X
                         │     → 302 Redirect zur echten AMweb-URL
                         ├─ GET /heartbeat?station=X   (Pi-Timer, alle 60s)
                         └─ Background-Thread: Station überfällig (kein
                            Heartbeat seit heartbeatTimeoutSeconds)
                                  → ntfy-Push "Alarmmonitor X offline"
```

Kein Secret/Token verlässt jemals den Cluster Richtung Pi — der Pi kennt nur
seinen eigenen Stationsnamen, die echte AMweb-URL bleibt serverseitig
(gleiches Prinzip wie bei `windeployment`s `/api/notify-zammad`, siehe
[docs/17-windows-deployment.md](17-windows-deployment.md)).

## Cluster-Komponente: Helm Chart `alamos-apager`

Liegt unter `argocd/apps/alamos-apager/`, wird wie jede andere App in
`argocd/apps/*` automatisch von ArgoCD erkannt und ausgerollt (siehe
[docs/05-argocd.md](05-argocd.md)) — keine manuelle Registrierung nötig.

Wichtigste `values.yaml`-Knobs:

| Key | Bedeutung |
|---|---|
| `ntfy.url` / `ntfy.topic` | Wohin der Ausfall-Alarm gepusht wird (Default: bestehende ntfy-Instanz, Topic `Alarmmonitor`) |
| `stationsSecretName` | Name des SealedSecret mit den Standort→AMweb-URL-Paaren (Default `alamos-apager-stations`) |
| `heartbeatTimeoutSeconds` | Ab wann ein Standort als "down" gilt (Default 300s — deutlich über dem Pi-Heartbeat-Intervall) |
| `ingress.host` | `alamos-apager.homeserver` (Wildcard-DNS, keine manuelle dnsmasq-Änderung nötig) |

Die App selbst kennt **keine echten AMweb-URLs** — die liegen ausschließlich
im SealedSecret (siehe nächster Abschnitt). Ohne dieses Secret startet der
Pod, aber `/start?station=...` antwortet mit `404`.

## Neuen Standort hinzufügen

1. Echte ALAMOS-AMweb-URL für den Standort aus dem Alamos-Account
   heraussuchen (Display-/Monitor-Link, ggf. mit Zugangs-Token in der URL).
2. SealedSecret erzeugen/aktualisieren (ein Key pro Standort, Key-Name =
   Stationsname):

   ```bash
   kubectl create secret generic alamos-apager-stations \
     --namespace alamos-apager --dry-run=client -o json \
     --from-literal=geraetehaus="https://amweb.alamos.cloud/...echte-url..." \
     --from-literal=zentrale="https://amweb.alamos.cloud/...echte-url..." \
     | kubeseal --controller-namespace sealed-secrets \
         --controller-name sealed-secrets-controller -o yaml \
     > argocd/apps/alamos-apager/sealedsecret-stations.yaml
   git add argocd/apps/alamos-apager/sealedsecret-stations.yaml
   git commit -m "feat(alamos-apager): add station <name>"
   git push
   ```

   **Wichtig:** Der Befehl muss **alle** Standorte auf einmal enthalten —
   jeder `kubeseal`-Lauf ersetzt das komplette Secret. Bestehende Keys also
   immer mit angeben, nicht nur den neuen.
3. ArgoCD synct das Secret innerhalb von ~3 Minuten.
4. Pi gemäß [Pi-Provisionierung](#pi-provisionierung-ansible) mit
   `alamos_kiosk_station: <name>` (identischer Name wie der Secret-Key)
   einrichten.

## Pi-Provisionierung (Ansible)

**Voraussetzung:** Raspberry Pi OS (Desktop) bereits geflasht, Autologin für
den Kiosk-User im Raspberry Pi Imager aktiviert ("Enable autologin"). Das
richtet diese Rolle nicht zusätzlich ein — reines Imaging, kein
Konfigurationsmanagement-Thema.

1. Host in `ansible/inventory/hosts.yml` unter `raspberry_pis` eintragen:

   ```yaml
   raspberry_pis:
     hosts:
       geraetehaus:
         ansible_host: 192.168.178.110
         ansible_user: pi
         alamos_kiosk_station: geraetehaus
   ```

2. Denselben Host auch unter `semaphore_targets` eintragen, dann:

   ```bash
   make semaphore-targets   # pusht den Semaphore-SSH-Key auf den Pi
   make alarm-kiosks        # oder: Semaphore-UI → "Deploy Alarmmonitor Kiosks" → Run
   ```

   Dry-Run vorher: `make alarm-kiosks-check`.

Die Rolle `ansible/roles/alamos_kiosk` installiert Chromium im Kiosk-Modus
(`alamos-kiosk.service`, läuft in der grafischen Session des Pi-Users) sowie
einen `alamos-heartbeat.timer` (Default alle 60s, siehe
`alamos_kiosk_heartbeat_interval`). Zusätzlich laufen `thermal_watchdog` und
`resource_watchdog` mit (gleiches Bundling wie bei `worker-0`, siehe
`ansible/homeserver2.yml`) — unbeaufsichtigte Geräte sollen sich bei
Überhitzung/Überlast selbst schützen.

Das Semaphore-Projekt **"alarm-kiosks"** ist nach `make semaphore-bootstrap`
automatisch in der UI verfügbar (siehe
[docs/08-semaphore.md](08-semaphore.md)) — **bewusst ohne** automatischen
Schedule, anders als `home-server`/`worker-0`: ein Re-Run soll hier nur per
Knopfdruck laufen.

## Monitoring & Alerting

- Verpasst ein Pi `heartbeatTimeoutSeconds` lang seinen Heartbeat, pusht
  `alamos-apager` einen ntfy-Alarm ("🚨 Alarmmonitor X offline") an das
  konfigurierte Topic.
- Kommt der Heartbeat zurück, wird automatisch ein Resolve-Push ("✅
  Alarmmonitor X wieder online") gesendet.
- Bewusst **kein** Zammad-Ticket pro Ausfall (anders als `windeployment`) —
  ein kurzer Pi-Reboot soll nicht jedes Mal ein Ticket erzeugen. Bei
  wiederkehrenden Ausfällen liegt die Nachverfolgung beim Betrachten der
  ntfy-Historie.

## Fehlerbehebung

| Symptom | Check |
|---|---|
| Pi zeigt 404 statt AMweb-Seite | `kubectl -n alamos-apager get secret alamos-apager-stations -o jsonpath='{.data}'` — fehlt der Stationsname als Key? |
| `alamos-apager.homeserver` löst nicht auf | Wildcard-DNS prüfen: `nslookup alamos-apager.homeserver` (siehe [docs/09-dns-architecture.md](09-dns-architecture.md)) |
| Kein ntfy-Alarm bei Ausfall | `kubectl -n alamos-apager logs deploy/alamos-apager` — `NTFY_URL`/`NTFY_TOPIC` korrekt? ntfy-Topic im Client abonniert? |
| Chromium startet nicht / schwarzer Bildschirm | Autologin auf dem Pi aktiv? `systemctl status alamos-kiosk` auf dem Pi |
| `Permission denied (publickey)` bei `make alarm-kiosks` | `make semaphore-targets` lief nicht für den neuen Pi (siehe [docs/08-semaphore.md](08-semaphore.md)) |
| Ansible-Fehler "alamos_kiosk_station ist nicht gesetzt" | Host-Var in `ansible/inventory/hosts.yml` fehlt — siehe [Pi-Provisionierung](#pi-provisionierung-ansible) |
