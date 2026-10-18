# 006 Keine NetworkPolicies im PROD- und ENTW-Cluster, im TECH-Cluster nur Ingress-Regeln

- Severity: Medium
- Bereich: Repo
- Betroffen: `argocd/apps/prod/*`, `argocd/apps/entw/*`, `ansible/roles/argocd/templates/bootstrap-networkpolicies.yaml.j2`
- Status: Teilweise behoben am 2026-10-17 (Stufe 1: Ingress in PROD umgesetzt; offen: Egress in PROD und TECH)

## Beschreibung

Die Default-Deny-Policies werden von der Ansible-Rolle `argocd` nur auf den TECH-Hub (und drei Namespaces im ENTW-Cluster) angewendet. Die Doku stellt fest, dass PROD-Apps ihre Policies „bei Bedarf“ selbst mitbringen. Im Repo bringt keine PROD-App eine mit: `grep -rl 'kind: NetworkPolicy' argocd/apps/prod argocd/apps/entw` liefert nichts. Im PROD-Cluster liegen die Datenbanken und Nutzerdaten von Nextcloud, Immich, Paperless-ngx, Wiki.js und Xibo.

Im TECH-Cluster beschränkt die Rolle nur den Ingress (`policyTypes: [Ingress]`). Egress ist für fast alle Namespaces unbeschränkt (Ausnahmen: alamos-relay, isc-news-bot, ollama, zammad-postgresql).

## Nachweis

```
$ grep -rl 'kind: NetworkPolicy' argocd/apps/prod argocd/apps/entw argocd/bootstrap-prod
(keine Treffer)

$ helm template … (gerendert) | NetworkPolicy je App
prod-immich  np=0   prod-nextcloud  np=0   prod-paperless-ngx  np=0
prod-wikijs  np=0   prod-xibosignage np=0  prod-cloudflared    np=0
tech: nur alamos-relay(3), isc-news-bot(4), ollama(2), zammad(1) mit Egress-Regeln

$ sed -n 1,12p ansible/roles/argocd/templates/bootstrap-networkpolicies.yaml.j2   (nur policyTypes: Ingress)
```

## Phase-2-Nachweis (live, lesend)

Live-Stand der Cluster (`kubectl get netpol -A`, `kubectl get ns --show-labels`):

| Cluster | Pods | Namespaces | NetworkPolicies | Pod-Security-Labels |
|---|---|---|---|---|
| TECH | 109 | 37 | in 31 Namespaces je 1 bis 6, alle nur Ingress (Ausnahmen mit Egress: alamos-relay, isc-news-bot, ollama, zammad) | 0 |
| PROD (`prod-vm`) | 47 | 20 | **0** | 0 |
| ENTW (`entw-vm`) | 17 | 8 | 9 | 0 |

PROD enthält Nextcloud, Immich, Paperless-ngx, Wiki.js und Xibo; dort kann jeder Pod jeden anderen Pod und das LAN ungehindert erreichen.

## Risiko / Angriffsszenario

Ein kompromittierter Pod in PROD (z. B. über eine Nextcloud-/Immich-Schwachstelle) erreicht alle anderen Pods und Datenbanken im Cluster sowie das gesamte LAN ungehindert. Fehlendes Egress-Filtering erlaubt Datenabfluss, Reverse-Shells und das Erreichen interner Dienste (power-agent, ArgoCD-NodePort, NAS, Router).

## Empfohlene Behebung

1. Je PROD-Namespace ein Default-Deny für Ingress und Egress plus explizite Freigaben anlegen (Traefik in `kube-system`, `cloudflared`, DNS, Datenbank im selben Namespace, benötigte Ziele). Muster:
   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: default-deny
     namespace: nextcloud
   spec:
     podSelector: {}
     policyTypes: [Ingress, Egress]
   ---
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: allow-ingress-traefik
     namespace: nextcloud
   spec:
     podSelector: {}
     policyTypes: [Ingress]
     ingress:
       - from:
           - namespaceSelector:
               matchLabels:
                 kubernetes.io/metadata.name: kube-system
   ```
2. Egress-Freigaben für DNS (kube-dns, UDP/TCP 53), Datenbank und Internet (nur wo nötig, z. B. HTTPS) ergänzen.
3. Namespace für Namespace ausrollen, nach jedem Schritt externen Zugriff über den Tunnel und internen Zugriff prüfen, ein Namespace pro Release.
4. Für TECH die Rolle um Egress-Default-Deny für sensible Namespaces (n8n, vaultwarden, zammad, semaphore) erweitern.

## Rollback

Policy-Dateien entfernen und synchronisieren (Default ist wieder „alles offen“). Bei einem Ausfall zuerst die `default-deny`-Datei des betroffenen Namespaces löschen.

## Verifikation

```
kubectl get networkpolicy -A | grep -E 'nextcloud|immich|paperless|wikijs|xibosignage'
kubectl -n nextcloud run np-test --rm -it --restart=Never --image=busybox:1.37 -- wget -T3 -qO- http://immich-server.immich.svc.cluster.local:2283
```
Der Test-Pod darf den fremden Namespace nicht mehr erreichen (Timeout); die App muss über `https://nextcloud-prod.pke-lab.de` weiter funktionieren.

## Risiko der Behebung

Hoch: Eine fehlerhafte Policy trennt Traefik/cloudflared von den Apps. Beim Rollout 2026-08-13 ist genau das schon einmal passiert (`docs/d-sicherheit/d0030-network-policies.md`, Cloudflare-Tunnel-Ausfall).

## Behebung (2026-10-17, Stufe 1)

**Fix** (zwei PRs, Batch A #455, Batch B #457): Punkte 1 und 3 der Empfehlung, beschränkt auf Ingress. Jeder PROD-App-Chart bringt die Policy `default-ingress` mit (`templates/networkpolicy.yaml`, Schalter `networkPolicy.enabled`). Sie erlaubt Ingress auf alle Pods des Namespaces nur aus dem eigenen Namespace, aus `kube-system` (Traefik) und aus `networkPolicy.extraIngressNamespaces` (wikijs: `wiki-docs-sync`). Anders als im Muster der Beschreibung fehlt eine Freigabe für `cloudflared`: Der PROD-Tunnel ruft nur Traefik auf. Das ist belegt (Tunnel-Konfiguration, keine direkten Service-Aufrufe im Repo) und wurde nach jedem Batch über die Tunnel-Hosts getestet.

Aktiv in: wikijs, wiki-docs-sync, xibosignage (Batch A) sowie paperless-ngx, immich, nextcloud (Batch B). Bewusst ohne Policy bleiben `kube-system`, `cert-manager` (der API-Server ruft den Webhook auf), `sealed-secrets`, `cloudflared`, `nas-storage`, `immich-storage` und die Leer-Namespaces (`mealie`, `tinyteller`, `demo-app`, `example-whoami`, siehe Incident 042).

**Nachweis** (Test-Pods mit `nc -z -w 4` auf `prod-vm`, nach dem Sync):

| Verbindung | Ergebnis |
|---|---|
| fremder Namespace → `wikijs-postgresql:5432`, `xibosignage-mysql:3306`, `wikijs:80` | gesperrt |
| fremder Namespace → `immich-postgresql:5432`, `immich-redis:6379`, `nextcloud-postgresql:5432`, `nextcloud-redis:6379`, `nextcloud:80` | gesperrt |
| `nextcloud` → `immich-postgresql`, `wikijs` → `paperless-ngx:80` (quer zwischen Apps) | gesperrt |
| eigener Namespace → eigene Datenbank, Redis und Machine-Learning-Dienst | offen |
| `wiki-docs-sync` → `wikijs:80` (erlaubter Cross-Namespace-Weg) | offen |
| `kube-system` → `wikijs`, `nextcloud`, `immich-server`, `paperless-ngx` (Traefik-Weg) | offen |

Vorher und nachher gemessen: `wiki-prod` 200, `xibo-prod` 302, `immich-prod` 200, `nextcloud-prod` 302, interne `*.prod.homeserver`-Hosts 200/302, `nextcloud /status.php` 200, `immich /api/server/ping` 200. Alle Pods blieben ohne neuen Neustart `Running`, die App-Logs und der cloudflared-Log in PROD enthielten keine Verbindungsfehler. Funktionstests mit Dateien (Upload in Nextcloud, Foto in Immich, Dokument in Paperless) hat der Betreiber nicht bestätigt, sie stehen aus.

**Geänderte Dateien.**

- `argocd/apps/prod/{wikijs,wiki-docs-sync,xibosignage,paperless-ngx,immich,nextcloud}/templates/networkpolicy.yaml` (neu) und `values.yaml` (Block `networkPolicy`)
- Doku: `docs/d-sicherheit/d0030-network-policies.md`, `docs/6-hintergruende/60050-helm-charts-prod.md`

**Rollback.** Im betroffenen Chart `networkPolicy.enabled: false`, PR, Merge. Von Hand löschen hilft nicht, die PROD-Apps laufen mit `selfHeal`. Notfalls in ArgoCD den Auto-Sync der betroffenen `prod-<app>` pausieren und `default-ingress` im Namespace löschen.

**Offen.**

- **Egress in PROD (Punkte 2 und 4 teilweise):** Ein kompromittierter Pod erreicht weiter das LAN (NAS, Router, power-agent, ArgoCD-NodePort) und das Internet. Eine belegte Zielliste je App fehlt, `/proc/net/nf_conntrack` gibt es auf der `prod-vm` nicht. Vorschlag: DNS, eigener Namespace und Internet erlauben, private Bereiche sperren, ein Namespace pro Release.
- **TECH-Egress-Deny** für n8n, vaultwarden, zammad und semaphore (Punkt 4 der Beschreibung): nicht begonnen.
- **ENTW** (9 Policies) wurde nicht verändert, es ist die absichtlich verwundbare Trainingsumgebung.
- **Verfeinerung:** Der Extra-Ingress für `wiki-docs-sync` gilt für alle Pods im Namespace `wikijs`, also auch für die Datenbank. Eine Einschränkung per `podSelector` auf den App-Pod wäre enger.
- Der Job `wiki-docs-sync` lief schon vor der Änderung nicht (9 Pods in `Error`), der Weg wiki-docs-sync → wikijs wurde daher nur per Verbindungstest, nicht per echtem Lauf geprüft.
