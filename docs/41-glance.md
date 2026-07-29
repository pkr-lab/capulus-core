# Glance — Dashboard für alle Home-Server-Dienste

[Glance](https://github.com/glanceapp/glance) ist eine schlanke, self-hosted
Startseite: Wetter, Tankpreise, Server-Auslastung und der Status aller
ArgoCD-Apps auf einen Blick. Läuft als ArgoCD-verwaltete App
(`argocd/apps/glance/`), komplett zustandslos — die gesamte
Dashboard-Konfiguration (Seiten, Widgets, verlinkte Dienste) liegt als
statisches YAML in `argocd/apps/glance/templates/configmap.yaml` und damit
vollständig in Git.

---

## Layout

```
┌───────────────────────────┬───────────────────────────┬──────────────────┐
│ Wetter — Morgen            │ Wetter — Heute             │ Tankpreise        │
│ (Open-Meteo, custom-api)   │ (natives weather-Widget)   │ (Tankerkönig-API) │
├───────────────────────────┼───────────────────────────┤                   │
│ Infrastruktur              │ Apps & Produktivität       │                   │
│ (ArgoCD, Headlamp, Grafana,│ (Nextcloud, Immich, Mealie,│ Server-Status     │
│  Pi-hole, ...)             │  Wiki.js, Zammad, ...)     │ (94–97, VM-Query) │
│                             │ Benachrichtigung & Sonstiges                  │
│                             │ (Gotify, ntfy, Uptime Kuma, ...)              │
└───────────────────────────┴───────────────────────────┴──────────────────┘
```

> **Warum nicht echt spaltenübergreifend?** Glance kennt keine Widgets, die
> über mehrere Spalten reichen (`docs`: "You cannot span a widget across
> multiple columns"). Um den App-Status trotzdem optisch über die linke UND
> mittlere Spalte zu ziehen, sind links und mittig beides `full`-Spalten mit
> je einem Monitor-Widget direkt unter dem jeweiligen Wetter-Widget — in der
> Breite nicht ganz identisch mit einem echten Merge, aber der nächste
> erreichbare Kompromiss innerhalb von Glances Spaltenmodell.

---

## Architektur

```
glance.homeserver → Traefik → glance (Port 8080)
                                  ├── ConfigMap: glance.yml (ro, /app/config)
                                  └── Secret (aus SealedSecret): Tankerkönig-API-Key → Env TANKERKOENIG_API_KEY
```

Kein PVC — alle Widgets laden live nach und cachen nur im Arbeitsspeicher
(`cache: ...` je Widget), nichts wird auf Disk persistiert.

| Widget | Datenquelle | Cache |
|---|---|---|
| Wetter — Morgen | `api.open-meteo.com` (kostenlos, kein Key) — Tagesprognose, Index 1 (morgen) | 3h |
| Wetter — Heute | `api.open-meteo.com` — natives Glance-Widget, aktuell + stündlich | automatisch |
| Infrastruktur / Apps & Produktivität / Benachrichtigung | HTTP-Erreichbarkeitscheck gegen die `*.homeserver`-Dienste, aus dem Pod heraus | 1m |
| Tankpreise | `creativecommons.tankerkoenig.de/json/prices.php` — MTS-K-Pflichtmeldedaten (dieselben Preise wie auf clever-tanken.de) für 3 fest hinterlegte Tankstellen | 15m |
| Server-Status | VictoriaMetrics-Query-API im `monitoring`-Namespace (bestehender Stack, `node_exporter`-Metriken) — CPU-/RAM-Auslastung für homeserver/worker-0/worker-1/ugreen-nas | 1m |

Die Monitor- und Server-Status-Widgets prüfen Dienste per HTTP/PromQL **aus
dem Pod heraus**. Das funktioniert, weil CoreDNS im Cluster
`*.homeserver`-Anfragen an den Host-`dnsmasq` weiterleitet (siehe
`argocd/apps/coredns-custom/` und
[`09-dns-architecture.md`](09-dns-architecture.md)) und weil
`monitoring.svc.cluster.local` innerhalb des Clusters immer auflösbar ist.

---

## Erstdeployment

1. ArgoCD erkennt `argocd/apps/glance/` automatisch (Directory-Generator im
   `root-applicationset.yaml`), erstellt die `Application` `glance` und
   synct sie — kein manueller Schritt nötig. Dashboard danach unter
   **http://glance.homeserver**.
2. **Ohne echten Tankerkönig-API-Key bleibt der Pod in
   `CreateContainerConfigError` hängen** (siehe unten) —
   `encryptedApiKey` ist als Platzhalter hinterlegt, den der
   sealed-secrets-Controller nicht entschlüsseln kann, wodurch das Secret
   fehlt, auf das `TANKERKOENIG_API_KEY` als Pflicht-Env im Deployment
   verweist. Entweder Schritt "Tankerkönig-API-Key einrichten" abschließen,
   oder `secrets.tankerkoenig.enabled: false` setzen, um ohne
   Tankpreise-Widget zu starten (der `apikey`-Parameter wird dann
   automatisch weggelassen statt auf eine nicht existierende Env-Var zu
   verweisen — Letzteres würde Glance selbst am Start hindern).

Verifizieren:

```bash
SRV='ssh -i ~/.ssh/id_ed25519 ubuntu@homeserver'
$SRV 'sudo kubectl -n glance get pods,svc,ingress,configmap,sealedsecret'
```

### Tankerkönig-API-Key einrichten

Kostenlos registrieren unter
<https://creativecommons.tankerkoenig.de> (nur E-Mail nötig, keine
Kreditkarte). Der Key liefert die amtlichen MTS-K-Pflichtmeldedaten aller
deutschen Tankstellen — dieselbe Datenquelle, die auch clever-tanken.de
anzeigt.

```bash
echo -n "DEIN_TANKERKOENIG_API_KEY" \
  | kubeseal --raw \
      --namespace glance \
      --name glance-tankerkoenig-api-key \
      --from-file=/dev/stdin
```

Ciphertext in `argocd/apps/glance/values.yaml` eintragen:

```yaml
secrets:
  tankerkoenig:
    encryptedApiKey: "AgB...langes-base64..."     # ← aus obigem Befehl
```

Committen + pushen. ArgoCD rollt die neue SealedSecret aus, der Pod bekommt
den Key als `TANKERKOENIG_API_KEY`-Env-Var (siehe `deployment.yaml`) und
`glance.yml` referenziert ihn per `${TANKERKOENIG_API_KEY}` als
Query-Parameter (Glances eigene Env-Var-Substitution, kein SealedSecret-
Klartext im ConfigMap).

---

## Dashboard anpassen

Alle Seiten, Spalten, Widgets und verlinkten Dienste stehen in
[`argocd/apps/glance/templates/configmap.yaml`](../argocd/apps/glance/templates/configmap.yaml).

### Monitor-Gruppen (Apps-Status)

| Gruppe | Enthält | Spalte |
|---|---|---|
| Infrastruktur | ArgoCD, Headlamp, Semaphore, Authentik, Grafana, Pi-hole, kubeseal-webgui, Argo Workflows, MinIO | links |
| Apps & Produktivität | Nextcloud, Immich, Vaultwarden, Paperless-ngx, Mealie, Grocy, n8n, Wiki.js, Zammad | mitte |
| Benachrichtigung & Sonstiges | Gotify, ntfy, Uptime Kuma, MediaMTX (Stream), Alarmmonitor | mitte |

Neuen Dienst hinzufügen: Eintrag unter `sites:` der passenden `monitor`-Gruppe
ergänzen (`title` + `url`), committen, pushen.

### Tankstellen ändern

Die drei Tankstellen-IDs sind fest in
[`templates/_helpers.tpl`](../argocd/apps/glance/templates/_helpers.tpl)
(Define `glance.fuelPricesTemplate`) und als `parameters.ids` in
`configmap.yaml` hinterlegt (Tankerkönig-UUIDs, keine Adressen). Neue
Stations-ID finden:

```bash
curl -s "https://creativecommons.tankerkoenig.de/json/list.php?lat=<LAT>&lng=<LON>&rad=2&sort=dist&type=all&apikey=00000000-0000-0000-0000-000000000002" | jq
```

(Der Demo-Key `00000000-...-000000000002` liefert echte Stationsdaten, aber
**keine echten Preise** — nur zum Suchen der `id` verwenden, nicht produktiv.)
Danach `id` sowohl in `_helpers.tpl` (Template-Block) als auch in
`configmap.yaml` (`parameters.ids`) ersetzen.

### Wetter-Standort ändern

`argocd/apps/glance/values.yaml` → `weather.location` (für das native
Heute-Widget, Freitext-Ort) und `weather.latitude`/`weather.longitude` (für
das custom Morgen-Widget). Default ist Andernach, nahe den drei Tankstellen.

### Server-Status erweitern/ändern

PromQL-Queries und die Liste der Nodes (homeserver/worker-0/worker-1/
ugreen-nas) stehen im Define `glance.serverStatusTemplate` in `_helpers.tpl`
sowie in den `parameters.query`-Werten in `configmap.yaml`. Die Werte sind
absichtlich hart hinterlegt statt aus `values.yaml` generiert — siehe
Kommentar in `_helpers.tpl`, warum Helm- und Glance-Template-Syntax
(`{{ }}`) sich hier nicht mischen lassen.

Vollständige Widget-Referenz: [glanceapp/glance – Configuration
Docs](https://github.com/glanceapp/glance/blob/main/docs/configuration.md)
und [Custom-API-Funktionsreferenz](https://github.com/glanceapp/glance/blob/main/docs/custom-api.md).

---

## Warum kein öffentlicher Zugriff

`glance` ist bewusst **nicht** in `argocd/apps/cloudflared/values.yaml`
eingetragen und damit nur intern über `*.homeserver` erreichbar (LAN +
Tailnet). Das Dashboard verlinkt direkt auf sicherheitskritische
Admin-Oberflächen (ArgoCD, Headlamp, Pi-hole, kubeseal-webgui) — ein
öffentlicher Tunnel dafür würde die Angriffsfläche unnötig vergrößern, ohne
echten Zusatznutzen (unterwegs bleibt Tailscale der reguläre Zugriffsweg,
siehe [`06-tailscale.md`](06-tailscale.md)).

---

## Troubleshooting

| Symptom | Hinweis |
|---|---|
| Monitor-Eintrag zeigt "down", Dienst läuft aber | CoreDNS-Forward für `*.homeserver` prüfen: `kubectl -n glance exec deploy/glance -- wget -qO- http://pihole.homeserver` (oder ein anderer laufender Dienst). Schlägt das fehl, `argocd/apps/coredns-custom/configmap.yaml` und den `coredns`-Pod in `kube-system` prüfen |
| Pod hängt in `CreateContainerConfigError`, Event `Failed to unseal: illegal base64 data` | `encryptedApiKey` in `values.yaml` ist noch der Platzhalter `REPLACE_ME_WITH_KUBESEAL_OUTPUT` — Schritt "Tankerkönig-API-Key einrichten" oben abschließen, oder übergangsweise `secrets.tankerkoenig.enabled: false` setzen |
| Tankpreise-Widget leer / Fehler (Pod läuft aber) | Key ist gesetzt, aber ungültig/abgelaufen — Fehlertext direkt im Widget bzw. `kubectl -n glance logs deploy/glance` prüfen (401 = ungültiger Key, 429 = Rate-Limit) |
| Server-Status-Widget zeigt Fehler `context deadline exceeded` | VictoriaMetrics-Service-Name hat sich geändert (z. B. nach Helm-Chart-Upgrade des `monitoring`-Charts) — `kubectl -n monitoring get svc \| grep vmsingle` und `monitoring.vmQueryUrl` in `values.yaml` anpassen |
| `glance.homeserver` löst nicht auf | Wildcard `*.homeserver` sollte ohne manuellen Eintrag funktionieren (siehe [`09-dns-architecture.md`](09-dns-architecture.md)); falls nicht, `make dnsmasq` erneut ausrollen |
| Pod `CrashLoopBackOff` nach Config-Änderung | `glance.yml` in `templates/configmap.yaml` ist ungültiges YAML oder verstößt gegen das Glance-Schema — `kubectl -n glance logs deploy/glance` zeigt die genaue Parse-Fehlermeldung |
| Änderung an `configmap.yaml`/`_helpers.tpl` kommt nicht an | Sollte durch die `checksum/config`-Annotation in `deployment.yaml` automatisch einen Pod-Neustart auslösen; falls nicht, manuell: `kubectl -n glance rollout restart deployment/glance` |
