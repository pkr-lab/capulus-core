# App-Umzug mit Daten nach PROD (Phase 3.3, Batch 4)

Manuell anzuwendende Hilfsmanifeste, **nicht** von ArgoCD gelesen (weder das
Manifest- noch das Charts-Set schauen in diesen Ordner).

Grundsatz: **Kopie, waehrend TECH weiterlaeuft.** TECH-Daten werden nur
gelesen, das alte NFS-Verzeichnis (StorageClass `nas`, `reclaimPolicy: Retain`)
bleibt unangetastet und ist der Rueckfall. Nie TECH und PROD gleichzeitig auf
dieselben Daten schreiben lassen.

## mealie (Vorlage fuer weitere `nas`-Apps)

Alte Daten: `192.168.178.97:/volume1/k8s-storage/mealie-mealie-data-pvc-<uid>`
(`kubectl get pv <pv> -o jsonpath='{.spec.nfs.path}'`), SQLite + Secret-Dateien,
ca. 43 MB.

### A. Vorbereitung (TECH laeuft unveraendert weiter)

1. Committen/pushen, dann `kubectl apply -f argocd/bootstrap-prod/appproject.yaml`
   und beide ApplicationSets refreshen. Es entstehen `prod-authentik`
   (ForwardAuth-Middleware zu Authentik in TECH) und `prod-mealie` mit
   `replicaCount: 0` (das PVC `mealie-data` wird in PROD angelegt, kein Pod).
2. Pruefen (PROD): `kubectl -n authentik get middleware,secret`,
   `kubectl -n mealie get pvc`.
3. Probekopie (TECH laeuft, die DB kann dabei inkonsistent sein, es geht nur
   um den Test des Kopierwegs): Job anwenden, Logs lesen, Job loeschen.

### B. Umschalten (kurze Pause fuer die Nutzer)

4. TECH-mealie stoppen **per Git**: `replicaCount: 0` in
   `argocd/apps/workloads/mealie/values.yaml`, pushen (ein `kubectl scale`
   wuerde von selfHeal zurueckgesetzt). Warten bis der Pod weg ist.
5. Endkopie: Job erneut anwenden (leert das Ziel und kopiert neu). In den
   Logs muss `mealie.db` stehen; danach Job loeschen.
6. PROD starten: `replicaCount: 1` in `argocd/apps/prod/mealie/values.yaml`,
   pushen. Test ohne SSO ueber den Bypass-Host:
   `curl -skI --resolve mealie-native.prod.homeserver:443:192.168.178.99 https://mealie-native.prod.homeserver`
   und mit SSO: `--resolve mealie.prod.homeserver:...` muss auf Authentik
   umleiten (`302`, `Location: https://authentik.tech.homeserver/...`).
7. DNS intern: `mealie.prod.homeserver` und `mealie-native.prod.homeserver` in
   `dnsmasq_prod_vm_hosts` (ansible/group_vars/all.yml), `make dnsmasq`.
8. Oeffentlich (nur der eine Host der App): `cloudflared tunnel route dns
   homeserver-prod <oeffentlicher-host>`. NIE einen anderen Host als den der
   gerade umgezogenen App eintragen.

### C. Rueckweg

DNS-Eintraege (Schritte 8 und 7) zuruecknehmen (Cloudflare-Dashboard bzw.
`dnsmasq_prod_vm_hosts` + `make dnsmasq`), in TECH `replicaCount: 1`. Aenderungen,
die seit dem Umschalten in PROD entstanden sind, fehlen dann in TECH.

### D. Aufraeumen (erst nach einigen Tagen Betrieb)

TECH-Ordner `argocd/apps/workloads/mealie/` entfernen. Die alten PVs bleiben
wegen `Retain` erhalten; das NAS-Verzeichnis erst spaeter von Hand loeschen.
