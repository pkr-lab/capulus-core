# Glance — Dashboard für alle Home-Server-Dienste

[Glance](https://github.com/glanceapp/glance) ist eine schlanke, self-hosted
Startseite: ein einziger Blick auf den Status aller Dienste im Cluster, plus
Suchleiste, Uhr und Quick-Links. Läuft als ArgoCD-verwaltete App
(`argocd/apps/glance/`), komplett zustandslos — die gesamte
Dashboard-Konfiguration (Seiten, Widgets, verlinkte Dienste) liegt als
statisches YAML in `argocd/apps/glance/templates/configmap.yaml` und damit
vollständig in Git, kein Setup-Schritt nach dem ersten Sync nötig.

---

## Architektur

```
glance.homeserver  →  Traefik  →  glance (Port 8080)
                                       └── ConfigMap: glance.yml (ro, /app/config)
```

Kein PVC — Glance lädt Status-Checks bei jedem Seitenaufruf live nach und
hält sie nur im Arbeitsspeicher zwischengecacht (`cache: 1m` je Widget in
der Config), nichts wird auf Disk persistiert.

Die Monitor-Widgets prüfen die verlinkten `*.homeserver`-Dienste per HTTP
aus dem Pod heraus. Das funktioniert, weil CoreDNS im Cluster
`*.homeserver`-Anfragen an den Host-`dnsmasq` weiterleitet (siehe
`argocd/apps/coredns-custom/` und
[`09-dns-architecture.md`](09-dns-architecture.md)) — ohne diesen Forward
würden alle Monitor-Einträge als "down" angezeigt, obwohl die Dienste
laufen.

---

## Erstdeployment

Kein manueller Schritt nötig — ArgoCD erkennt `argocd/apps/glance/`
automatisch (Directory-Generator im
`root-applicationset.yaml`), erstellt die `Application` `glance` im
gleichnamigen Namespace und synct sie. Danach ist das Dashboard direkt
unter **http://glance.homeserver** erreichbar.

Verifizieren:

```bash
SRV='ssh -i ~/.ssh/id_ed25519 ubuntu@homeserver'
$SRV 'sudo kubectl -n glance get pods,svc,ingress,configmap'
```

---

## Dashboard anpassen

Alle Seiten, Spalten, Widgets und verlinkten Dienste stehen im
`glance.yml`-Block in
[`argocd/apps/glance/templates/configmap.yaml`](../argocd/apps/glance/templates/configmap.yaml).
Aktuell drei Widget-Gruppen:

| Gruppe | Enthält |
|---|---|
| Infrastruktur | ArgoCD, Headlamp, Semaphore, Authentik, Grafana, Pi-hole, kubeseal-webgui, Argo Workflows, MinIO |
| Apps & Produktivität | Nextcloud, Immich, Vaultwarden, Paperless-ngx, Mealie, Grocy, n8n, Wiki.js, Zammad |
| Benachrichtigung & Sonstiges | Gotify, ntfy, Uptime Kuma, MediaMTX (Stream), Alarmmonitor |

Neuen Dienst hinzufügen: einen Eintrag unter `sites:` der passenden
`monitor`-Gruppe ergänzen (`title` + `url`), committen, pushen — ArgoCD
rollt die geänderte ConfigMap aus und `deployment.yaml` triggert per
`checksum/config`-Annotation automatisch einen Pod-Neustart, damit Glance
die neue Config lädt.

Vollständige Widget-Referenz (weitere Typen wie `rss`, `weather`,
`releases`, `docker`): [glanceapp/glance – Configuration
Docs](https://github.com/glanceapp/glance/blob/main/docs/configuration.md).

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
| `glance.homeserver` löst nicht auf | Wildcard `*.homeserver` sollte ohne manuellen Eintrag funktionieren (siehe [`09-dns-architecture.md`](09-dns-architecture.md)); falls nicht, `make dnsmasq` erneut ausrollen |
| Pod `CrashLoopBackOff` nach Config-Änderung | `glance.yml` in `templates/configmap.yaml` ist ungültiges YAML oder verstößt gegen das Glance-Schema — `kubectl -n glance logs deploy/glance` zeigt die genaue Parse-Fehlermeldung |
| Änderung an `configmap.yaml` kommt nicht an | Pod läuft weiter mit alter Config im Speicher — sollte durch die `checksum/config`-Annotation automatisch neu gestartet werden; falls nicht, manuell: `kubectl -n glance rollout restart deployment/glance` |
