# ALAMOS-Webhook-Relay (öffentlicher Proxy vor n8n)

> **Cluster:** TECH · Ordner `argocd/apps/tech/alamos-relay/` · URL `https://alamos-relay-prod.pke-lab.de` (extern), `alamos-relay.prod.homeserver` (intern). `kubectl`-Befehle in diesem Doc gelten für den TECH-Cluster ([Zugriff je Cluster](../a-betriebssystem/a0010-overview.md#kubectl-zugriff-je-cluster)).

Kleiner, einzweckiger Proxy: nimmt den ALAMOS-Einsatzalarm-Webhook
öffentlich unter einem geheimen Pfad entgegen und reicht ihn
Server-zu-Server an den internen n8n-Webhook weiter (siehe
[300h0-alamos-einsatz-zammad.md](300h0-alamos-einsatz-zammad.md)). **n8n
selbst bleibt dabei komplett unerreichbar aus dem Internet** — genau die
Entscheidung, die für `n8n.prod.homeserver` schon einmal bewusst getroffen
wurde ([c0030](../c-netzwerk-dns/c0030-port-uebersicht.md): n8n ist aus dem Cloudflare-Tunnel entfernt).

## Warum dieser Umweg nötig ist

Der direkte Weg — ALAMOS ruft `n8n.prod.homeserver` selbst auf — hat aus
zwei möglichen Gründen nicht funktioniert (siehe
[300h0, Architektur](300h0-alamos-einsatz-zammad.md#architektur)):

1. **Private Network Access (PNA):** Feuert der Webhook aus dem
   Kiosk-Chromium-Tab (AMweb-Seiteneinstellung-Variante), blockt der
   Browser standardmäßig JS-Requests von einer öffentlichen Origin
   (`amweb.alamos.cloud`) zu einer privaten Ziel-IP — und
   `n8n.prod.homeserver` löst intern auf eine private IP auf.
2. **"Allgemeine Webhooks" feuert serverseitig direkt von Alamos' Cloud** —
   dann braucht es unabhängig von PNA ohnehin eine öffentlich erreichbare
   Ziel-URL.

Beide Fälle laufen auf dasselbe Ziel hinaus: eine öffentlich erreichbare
Adresse, hinter der **nicht** n8n selbst hängt. `alamos-relay` ist genau
diese Adresse — sie löst öffentlich auf einer Cloudflare-IP auf, PNA greift
also nicht mehr, unabhängig davon, welche der beiden Alamos-Webhook-Varianten
tatsächlich genutzt wird.

## Architektur

```
ALAMOS AMweb (Cloud, Browser-Tab ODER Alamos-Server)
   │  Webhook GET/POST, an eine öffentliche, unlistbare URL
   ▼
https://alamos-relay-prod.pke-lab.de/relay/<TOKEN>
   │  Cloudflare Tunnel (Wildcard-Regel *.pke-lab.de → Traefik,
   │  siehe docs/c-netzwerk-dns/c0040-domain-tiers.md)
   ▼
Pod im eigenen Namespace "alamos-relay"
   │  - Pfad muss exakt "/relay/<TOKEN>" sein (hmac.compare_digest,
   │    konstante Laufzeit) — jede andere Pfad/Methode-Kombination
   │    bekommt dieselbe 404-Antwort, keine Unterscheidbarkeit
   │  - NetworkPolicy erlaubt Egress NUR zu n8n:5678 (+ DNS) — selbst bei
   │    Kompromittierung kein Zugriff auf irgendwas anderes im Cluster
   ▼
http://n8n.n8n.svc.cluster.local/webhook/alamos-einsatz
   (Server-zu-Server-Call innerhalb des Clusters — kein Browser, kein PNA)
   ▼
bestehender n8n-Workflow alamos-einsatz-to-zammad.json (unverändert)
```

Die Antwort von n8n (Status + Body) wird 1:1 an ALAMOS zurückgegeben, damit
sich für Alamos nichts an der Rückmeldung ändert.

## Warum ein eigener Namespace statt eines Pfads direkt an n8n

Cloudflare Tunnel könnte theoretisch auch einen Pfad direkt zu n8n
durchreichen, ohne einen eigenen Proxy zu bauen. Bewusst **nicht** so
gelöst: n8n läuft im selben Prozess wie alle anderen Workflows (Zammad-
Tickets, GitHub-Release-Watcher, xibosignage) — ein Flood/Exploit gegen
einen öffentlich erreichbaren Pfad könnte potenziell den ganzen n8n-Prozess
treffen, nicht nur diesen einen Workflow. `alamos-relay` kennt dagegen
keine Credentials, keine Zammad-Tokens, keine Workflows — es gibt dort
nichts zu stehlen, und die NetworkPolicy verhindert jede Seitwärtsbewegung
selbst im Worst Case.

## Cluster-Komponente: Helm Chart `alamos-relay`

Liegt unter `argocd/apps/tech/alamos-relay/`, wird wie jede andere App
automatisch von ArgoCD erkannt und ausgerollt (siehe
[docs/b-kubernetes-gitops/b0010-argocd.md](../b-kubernetes-gitops/b0010-argocd.md)) — keine manuelle
Registrierung im ArgoCD-Sinn nötig. **Aber:** die NetworkPolicy-Verfeinerung
(Egress-Deny + n8n-Ausnahme) läuft über Ansible, nicht über den Chart
selbst — siehe [Rollout](#rollout-nach-dem-ersten-push) unten.

Wichtigste `values.yaml`-Knobs:

| Key | Bedeutung |
|---|---|
| `n8nTargetUrl` | Internes n8n-Webhook-Ziel, an das weitergereicht wird (Default: `http://n8n.n8n.svc.cluster.local/webhook/alamos-einsatz`) |
| `n8nNamespace` / `n8nTargetPort` | Für die NetworkPolicy-Egress-Ausnahme — muss zu n8ns tatsächlichem Namespace/`targetPort` passen |
| `secrets.encryptedToken` | SealedSecret mit dem geheimen Pfad-Token (Key `token`) |
| `ingress.hosts` | Interner Host (`alamos-relay.prod.homeserver`) + externer Host (`alamos-relay-prod.pke-lab.de`, per Cloudflare-Tunnel-Wildcard erreichbar) |

Tech-Stack identisch zu [alamos-apager](30010-alamos-apager.md): reines
Python-Stdlib (`http.server`), kein externer Build, `python:3.14-alpine`
als Base-Image.

### Token erzeugen/rotieren

```bash
openssl rand -hex 24 | tr -d '\n' | kubeseal --raw \
  --namespace alamos-relay \
  --name alamos-relay-secrets \
  --controller-namespace sealed-secrets \
  --controller-name sealed-secrets-controller \
  --from-file=/dev/stdin
```

Ausgabe in `argocd/apps/tech/alamos-relay/values.yaml` unter
`secrets.encryptedToken` eintragen, committen, pushen. Das Klartext-Token
selbst **nicht** committen — es steht ausschließlich in der Alamos-
Webhook-Konfiguration (siehe [Einrichtung](#einrichtung) unten) und lokal
beim Erzeugen.

**Rotation:** einfach den Befehl erneut ausführen (neues Token), den neuen
Wert committen/pushen **und** die neue vollständige URL in der
Alamos-Webhook-Konfiguration nachtragen — bis dahin bekommt Alamos vom
Relay nur noch 404 (siehe [Fehlerbehebung](#fehlerbehebung)).

## Rollout (nach dem ersten Push)

1. `git add`/`commit`/`push` — ArgoCD legt den Namespace `alamos-relay`
   an und rollt den Chart aus (Pod, Service, Ingress, SealedSecret, eigene
   Egress-NetworkPolicies).
2. **Zusätzlich nötig, weil neue Namespaces/Cross-Namespace-Ausnahmen nicht
   rein über ArgoCD laufen** (siehe
   [docs/d-sicherheit/d0030-network-policies.md](../d-sicherheit/d0030-network-policies.md)):
   ```bash
   make argocd
   ```
   Das setzt das `security-tier`-Label auf dem neuen Namespace, wendet die
   ansible-verwaltete `tier-default-ingress`-Policy darauf an (erlaubt
   Traefik/kube-system + cloudflared, damit der Pod überhaupt erreichbar
   ist) und ergänzt in n8ns eigener Policy die Ausnahme für Ingress aus
   `alamos-relay` (`argocd_network_policy_extra_ingress` →
   `n8n: [alamos-relay]`). **Ohne diesen Schritt bleibt der Forward an n8n
   von der eigenen `networkpolicy-allow-egress-n8n`-Regel des Relays zwar
   erlaubt, aber n8n selbst weist die eingehende Verbindung weiterhin ab**
   (verfeinerte Policy lässt nur den eigenen Namespace + kube-system +
   monitoring + cloudflared rein).
3. Validieren:
   ```bash
   kubectl -n alamos-relay get pods
   kubectl get networkpolicy -n alamos-relay
   curl -s -o /dev/null -w "%{http_code}\n" https://alamos-relay-prod.pke-lab.de/relay/falsches-token   # erwartet: 404
   ```

## Einrichtung

1. [Token erzeugen](#token-erzeugenrotieren), Chart ausrollen, siehe oben.
2. Öffentliche Ziel-URL zusammensetzen:
   `https://alamos-relay-prod.pke-lab.de/relay/<TOKEN>`.
3. Diese URL in der **AMweb-Seiteneinstellung**-Webhook-Konfiguration im
   Alamos-Account eintragen (nicht "Allgemeine Webhooks" — Begründung dazu
   unverändert in [300h0, Architektur](300h0-alamos-einsatz-zammad.md#architektur)).
   Der n8n-seitige Workflow (`alamos-einsatz-to-zammad.json`) braucht dafür
   **keine** Änderung — er lauscht weiterhin auf
   `http://n8n.prod.homeserver/webhook/alamos-einsatz`, nur der Aufrufer
   hat sich geändert (Relay statt Alamos direkt).
4. Testauslösung wie in
   [300h0, Einrichtung Schritt 7](300h0-alamos-einsatz-zammad.md#einrichtung).

## Fehlerbehebung

| Symptom | Check |
|---|---|
| Relay antwortet mit `404` auf die volle URL inkl. Token | Token in `values.yaml`/Alamos-Konfiguration identisch? Nach Rotation beide Stellen aktualisiert? Wurde beim Versiegeln ein Zeilenumbruch mitversiegelt? Der Pfadvergleich ist exakt, ein mitversiegeltes `\n` macht den Pfad dauerhaft unmatchbar (Befehl oben mit `tr -d '\n'`, siehe [60030](../6-hintergruende/60030-argocd-und-bootstrap.md#sealedsecrets-fallstricke-beim-versiegeln)) |
| Relay antwortet `502 upstream unavailable` | `kubectl -n alamos-relay logs deploy/alamos-relay` — meist NetworkPolicy-Problem (Schritt 2 aus [Rollout](#rollout-nach-dem-ersten-push) vergessen) oder n8n-Workflow nicht aktiv |
| `alamos-relay-prod.pke-lab.de` löst nicht auf / liefert 404 von Cloudflare | Cloudflare-Tunnel-Wildcard-DNS prüfen (siehe [e0000-cloudflare-tunnel.md](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md)) — `dig +short alamos-relay-prod.pke-lab.de` |
| Forward kommt bei n8n nie an, Relay selbst loggt aber `200`-Antworten von n8n nicht | `kubectl -n n8n logs deploy/n8n` — Workflow überhaupt aktiv? Gleiche Checks wie in [300h0, Fehlerbehebung](300h0-alamos-einsatz-zammad.md#fehlerbehebung) |
| Relay-Pod crasht mit "RELAY_TOKEN und N8N_TARGET_URL muessen gesetzt sein" | SealedSecret nicht entschlüsselt/nicht gefunden — `kubectl -n alamos-relay get secret alamos-relay-secrets` |

## Relevante Links

- [docs/3-apps-workloads/300h0-alamos-einsatz-zammad.md](300h0-alamos-einsatz-zammad.md) — n8n-Workflow, der das Relay als Ziel bekommt
- [docs/3-apps-workloads/30010-alamos-apager.md](30010-alamos-apager.md) — gleicher Tech-Stack-Ansatz (Python-Stdlib-HTTP-Server)
- [docs/d-sicherheit/d0030-network-policies.md](../d-sicherheit/d0030-network-policies.md) — Cluster-NetworkPolicy-Modell, das dieser Chart mit eigenen Egress-Regeln ergänzt
- [docs/c-netzwerk-dns/c0040-domain-tiers.md](../c-netzwerk-dns/c0040-domain-tiers.md) — Namenskonvention `<app>-<tier>.pke-lab.de`
- [docs/e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md](../e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md) — wie der externe Host überhaupt erreichbar wird
