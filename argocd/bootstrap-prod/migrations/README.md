# App-Umzug mit Daten nach PROD (Phase 3.3, Batch 4)

Manuell anzuwendende Hilfsmanifeste, **nicht** von ArgoCD gelesen (weder das
Manifest- noch das Charts-Set schauen in diesen Ordner).

Grundsatz: **Kopie, waehrend TECH weiterlaeuft.** TECH-Daten werden nur
gelesen, das alte NFS-Verzeichnis (StorageClass `nas`, `reclaimPolicy: Retain`)
bleibt unangetastet und ist der Rueckfall. Nie TECH und PROD gleichzeitig auf
dieselben Daten schreiben lassen.

## Weitere Apps

Je App ein eigener Kopier-Job in diesem Ordner (`<app>-data-copy-job.yaml`), gleicher
Ablauf wie bei mealie (unten). Bisher: `mealie-data-copy-job.yaml` (umgezogen),
`paperless-ngx-data-copy-job.yaml` (4 Volumes, umgezogen),
`wikijs-postgres-copy-job.yaml` (Postgres-Datenverzeichnis, eigener uid/Modus 0700). Push 1 = TECH und PROD auf
`replicaCount: 0`, Endkopie, Push 2 = PROD auf `1` plus Hosts in `dnsmasq_prod_vm_hosts`.

## mealie (Vorlage fuer weitere `nas`-Apps)

Alte Daten: `192.168.178.97:/volume1/k8s-storage/mealie-mealie-data-pvc-<uid>`
(`kubectl get pv <pv> -o jsonpath='{.spec.nfs.path}'`), SQLite + Secret-Dateien,
ca. 43 MB.

### Authentik-SSO: fuer den Umzug ZURUECKGESTELLT

Fuer den ersten Umzug (mealie) ist die Authentik-Middleware in PROD **ausgebaut**
(Annotation aus `argocd/apps/prod/mealie/values.yaml` entfernt, Manifeste geparkt
in `migrations/sso-outpost/`). Folge: nur Mealies eigene Anmeldung schuetzt die
App, die Zugriffsbeschraenkung ueber die Authentik-Policy (`admins` /
`mealie-user`) entfaellt. **Der oeffentliche Host** `mealie-prod.pke-lab.de` erst
dann auf den PROD-Tunnel legen, wenn du das akzeptierst oder SSO wieder steht;
bis dahin bleibt er auf TECH (waehrend TECH-mealie gestoppt ist, ist er nicht
erreichbar).

Der Abschnitt darunter beschreibt das Wiedereinschalten (Remote-Outpost in PROD).

### Voraussetzung fuer Apps hinter Authentik-SSO: Remote-Outpost in PROD

Die ForwardAuth-Middleware in PROD ruft einen Authentik-Proxy-Outpost **in PROD**
auf (`argocd/apps/prod/authentik/outpost.yaml`). Der meldet sich mit einem Token
bei Authentik in TECH an. Einmalig einzurichten:

1. Authentik-Admin (TECH) -> **Applications -> Outposts -> Create**: Name `prod`,
   Typ **Proxy**, Integration **keine** (manuell). Unter *Applications* die
   betroffenen Anwendungen auswaehlen (`Mealie`, `Mealie (extern)`; spaeter
   `uptime-kuma`). Speichern.
2. In der Outpost-Liste beim Eintrag `prod` **View Deployment Info** -> den Wert
   `AUTHENTIK_TOKEN` kopieren (nicht ins Repo, nicht in den Chat).
3. Token fuer PROD versiegeln (Zertifikat: siehe `scripts/reseal-for-prod.sh`,
   Kopf) - die Eingabe wird nicht angezeigt und nicht in der History abgelegt:
   ```bash
   read -rs TOKEN
   kubectl create secret generic authentik-outpost-token --namespace authentik \
     --from-literal=token="$TOKEN" --dry-run=client -o yaml \
     | kubeseal --cert ~/prod-sealed-secrets.pem --format yaml \
     > argocd/apps/prod/authentik/outpost-token-sealedsecret.yaml
   unset TOKEN
   ```
4. Datei committen/pushen. Danach: `kubectl -n authentik get pods` (PROD) zeigt den
   Outpost `1/1 Running`, in Authentik erscheint `prod` als verbunden (gruener Punkt).

### A. Vorbereitung (TECH laeuft unveraendert weiter)

1. Committen/pushen, dann `kubectl apply -f argocd/bootstrap-prod/appproject.yaml`
   und beide ApplicationSets refreshen. Es entstehen `prod-authentik`
   (ForwardAuth-Middleware zu Authentik in TECH) und `prod-mealie` mit
   `replicaCount: 0` (das PVC `mealie-data` wird in PROD angelegt, kein Pod).
2. Pruefen (PROD): `kubectl -n authentik get middleware,secret`,
   `kubectl -n mealie get pvc`.
3. Probekopie (TECH laeuft, die DB kann dabei inkonsistent sein, es geht nur
   um den Test des Kopierwegs): Job anwenden, Logs lesen, Job loeschen.

4. Generalprobe: `replicaCount: 1` in `argocd/apps/prod/mealie/values.yaml`
   pushen. PROD-mealie laeuft auf der Probekopie, TECH und DNS bleiben
   unveraendert (kein Nutzer merkt etwas). Testen ueber `--resolve`:
   `curl -skI --resolve mealie-native.prod.homeserver:443:192.168.178.99 https://mealie-native.prod.homeserver`
   (muss antworten) und `--resolve mealie.prod.homeserver:...` (muss ebenfalls
   `200` liefern, ohne SSO; mit eingebautem SSO waere es `302` nach Authentik).
   Danach vor der Endkopie wieder `replicaCount: 0` pushen.

### B. Umschalten (kurze Pause fuer die Nutzer)

5. TECH-mealie stoppen **per Git**: `replicaCount: 0` in
   `argocd/apps/workloads/mealie/values.yaml`, pushen (ein `kubectl scale`
   wuerde von selfHeal zurueckgesetzt). Warten bis der Pod weg ist.
6. Endkopie (PROD-mealie muss dabei auf 0 stehen): Job erneut anwenden (leert das Ziel und kopiert neu). In den
   Logs muss `mealie.db` stehen; danach Job loeschen.
7. PROD starten: `replicaCount: 1` in `argocd/apps/prod/mealie/values.yaml`,
   pushen. Test ohne SSO ueber den Bypass-Host:
   `curl -skI --resolve mealie-native.prod.homeserver:443:192.168.178.99 https://mealie-native.prod.homeserver`
   und `--resolve mealie.prod.homeserver:...` muss ebenfalls `200` liefern
   (ohne SSO; mit wieder eingebautem SSO waere es `302` nach Authentik).
8. DNS intern: `mealie.prod.homeserver` und `mealie-native.prod.homeserver` in
   `dnsmasq_prod_vm_hosts` (ansible/group_vars/all.yml), `make dnsmasq`.
9. Oeffentlich (nur der eine Host der App): `cloudflared tunnel route dns
   homeserver-prod <oeffentlicher-host>`. NIE einen anderen Host als den der
   gerade umgezogenen App eintragen.

### C. Rueckweg

DNS-Eintraege (Schritte 9 und 8) zuruecknehmen (Cloudflare-Dashboard bzw.
`dnsmasq_prod_vm_hosts` + `make dnsmasq`), in TECH `replicaCount: 1`. Aenderungen,
die seit dem Umschalten in PROD entstanden sind, fehlen dann in TECH.

### D. Aufraeumen (erst nach einigen Tagen Betrieb)

TECH-Ordner `argocd/apps/workloads/mealie/` entfernen. Die alten PVs bleiben
wegen `Retain` erhalten; das NAS-Verzeichnis erst spaeter von Hand loeschen.
