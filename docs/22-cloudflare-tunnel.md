# Cloudflare Tunnel — Externe Erreichbarkeit ohne VPN

Dieses Dokument beschreibt, wie ausgewählte Dienste aus `argocd/apps/`
über [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
öffentlich im Internet erreichbar gemacht werden — **ohne** Portfreigabe am
Router, ohne öffentliche IP und ohne dass du für jeden Zugriff erst
Tailscale verbinden musst.

> **Deploy-/Rollout-Schritte** (Day-2-Betrieb, neuen Dienst freigeben,
> Troubleshooting) stehen separat in
> [docs/23-cloudflare-deploy.md](23-cloudflare-deploy.md).

---

## Inhaltsverzeichnis

1. [Warum Cloudflare Tunnel?](#warum-cloudflare-tunnel)
2. [Voraussetzungen](#voraussetzungen)
3. [Schritt 1 — Domain zu Cloudflare hinzufügen (Netcup-spezifisch)](#schritt-1--domain-zu-cloudflare-hinzufügen-netcup-spezifisch)
4. [Schritt 2 — Tunnel erstellen](#schritt-2--tunnel-erstellen)
5. [Schritt 3 — Credentials versiegeln](#schritt-3--credentials-versiegeln)
6. [Schritt 4 — DNS-Routing: Wildcard statt Einzel-Records](#schritt-4--dns-routing-wildcard-statt-einzel-records)
7. [Schritt 5 — values.yaml befüllen](#schritt-5--valuesyaml-befüllen)
8. [Zusätzliche Absicherung: Cloudflare Access](#zusätzliche-absicherung-cloudflare-access)
9. [Welche Dienste eignen sich zur Freigabe?](#welche-dienste-eignen-sich-zur-freigabe)
10. [Sicherheitsprinzipien](#sicherheitsprinzipien)
11. [Troubleshooting](#troubleshooting)

---

## Warum Cloudflare Tunnel?

Der Home-Server sitzt hinter der Fritz!Box, hat keine öffentliche IP und
soll auch keine bekommen. Bisher ist der einzige Weg von außen Tailscale
(siehe [docs/06-tailscale.md](06-tailscale.md)) — super für dich selbst,
aber unpraktisch, wenn z. B. ein DLRG-Kamerad im Wachdienst schnell im Wiki
nachschauen will und weder Tailscale installiert noch einen Account hat.

```
┌──────────────┐        ausgehende Verbindung        ┌───────────────────┐
│  Home-Server │ ───────────────────────────────────▶│  Cloudflare Edge  │
│  (cloudflared)│      (TLS, kein offener Port nötig) │  (Reverse Proxy)  │
└──────────────┘                                      └─────────┬─────────┘
                                                                  │
                                                        https://dienst.domain.de
                                                                  │
                                                                  ▼
                                                         Beliebiger Browser
                                                     (kein VPN, kein Client nötig)
```

- **Kein Port-Forwarding.** `cloudflared` baut die Verbindung aktiv nach
  außen auf (wie ein Client, der eine Webseite lädt). Es muss am Router
  nichts freigegeben werden, und die UFW-Firewall bleibt unverändert.
- **Keine öffentliche IP nötig.** Funktioniert auch hinter CGNAT / DS-Lite.
- **TLS ist bereits erledigt.** Cloudflare terminiert HTTPS an der Edge,
  du musst dich nicht um Zertifikate für öffentliche Hostnamen kümmern.
- **DDoS-Schutz und WAF** von Cloudflare liegen automatisch vor jedem
  getunnelten Dienst.
- **Granular.** Es wird nur freigegeben, was du explizit in der
  Ingress-Liste einträgst — alles andere bleibt ausschließlich über LAN
  oder Tailscale erreichbar (siehe [Sicherheitsprinzipien](#sicherheitsprinzipien)).

Tailscale bleibt für alles mit Admin-Charakter (ArgoCD, Semaphore,
Headlamp, kubectl, SSH) der richtige Weg — Cloudflare Tunnel ergänzt das
nur für die Dienste, bei denen "irgendwer ohne VPN-Client" tatsächlich
Zugriff braucht.

---

## Voraussetzungen

- Eine **eigene Domain**, die auf Cloudflare verwaltet wird (Cloudflare
  Free-Plan reicht vollständig aus). In diesem Setup liegt die Domain bei
  **Netcup** — sie muss nicht zu Cloudflare transferiert werden, es reicht,
  die Nameserver umzustellen (siehe Schritt 1). Der Registrar bleibt
  Netcup, nur die DNS-Verwaltung wandert zu Cloudflare.
- Ein kostenloser [Cloudflare-Account](https://dash.cloudflare.com/sign-up).
- `cloudflared` CLI lokal auf deiner Workstation:

  ```bash
  # macOS
  brew install cloudflared

  # Linux (Debian/Ubuntu)
  curl -L --output cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i cloudflared.deb
  ```

- `kubeseal` CLI lokal installiert (bereits Voraussetzung für
  [docs/13-sso-authentik.md](13-sso-authentik.md) / [docs/17-zammad.md](17-zammad.md)).
- `kubectl` mit dem Cluster verbunden (für den DNS-Routing-Schritt reicht
  aber die Cloudflare-Anmeldung, `kubectl` wird nur für kubeseal gebraucht).

---

## Schritt 1 — Domain zu Cloudflare hinzufügen (Netcup-spezifisch)

### 1.1 — Bestehende DNS-Records sichern

**Wichtig, bevor du irgendetwas umstellst:** Sobald die Nameserver auf
Cloudflare zeigen, verwaltet **ausschließlich Cloudflare** die DNS-Zone —
alle bisher bei Netcup gepflegten Records (insbesondere `MX`-Einträge,
falls über die Domain E-Mail läuft, sowie bestehende `A`/`CNAME`/`TXT`
für z. B. SPF/DKIM) müssen in Cloudflare nachgezogen werden, sonst gehen
sie beim Umstellen "verloren" (sie existieren bei Netcup weiter, werden
aber nicht mehr abgefragt).

```bash
# Aktuellen Zustand vor der Umstellung dokumentieren
dig +short MX deine-domain.de
dig +short TXT deine-domain.de
dig +short A deine-domain.de
```

Ausgabe notieren — dient als Checkliste für Schritt 1.3.

### 1.2 — Site in Cloudflare anlegen

1. [Cloudflare-Dashboard](https://dash.cloudflare.com) → **Add a Site**.
2. Domain eingeben (genau wie bei Netcup registriert, ohne `www.`),
   **Free Plan** wählen.
3. Cloudflare scannt automatisch die bestehende DNS-Zone bei Netcup und
   schlägt gefundene Records zur Übernahme vor — das deckt in der Regel
   den Großteil ab, aber **gegen die Notizen aus 1.1 gegenprüfen**,
   bevor du weitermachst (der automatische Scan findet nicht immer
   jeden Record, z. B. manche `TXT`-Einträge).

### 1.3 — Nameserver bei Netcup umstellen

1. Cloudflare zeigt jetzt zwei Nameserver an, z. B.:
   ```
   bob.ns.cloudflare.com
   flora.ns.cloudflare.com
   ```
2. Im [Netcup CCP](https://www.customercontrolpanel.de) einloggen →
   **Domains** → betroffene Domain auswählen → **Nameserver ändern**.
3. Die beiden bei Netcup voreingestellten Nameserver
   (`ns1.netcup.net` / `ns2.netcup.net` / `ns3.netcup.net`) durch die
   beiden Cloudflare-Nameserver ersetzen, speichern.
4. Warten, bis Cloudflare die Umstellung erkennt — im Cloudflare-Dashboard
   erscheint dann **Active** statt **Pending Nameserver Update**. Bei
   Netcup ist das meist innerhalb von 1–4 Stunden propagiert, DNS-TTLs
   können es in Einzelfällen bis zu 24 h dauern lassen.

```bash
# Propagation prüfen — sollte irgendwann Cloudflare-Nameserver zeigen
dig +short NS deine-domain.de
```

---

## Schritt 2 — Tunnel erstellen

```bash
# Einmalig: Browser-Login, autorisiert die lokale cloudflared-CLI
cloudflared tunnel login

# Tunnel anlegen — Name frei wählbar, hier "homeserver"
cloudflared tunnel create homeserver
```

Die Ausgabe enthält:

- Die **Tunnel-ID** (UUID, z. B. `a1b2c3d4-...`).
- Den Pfad zur erzeugten Credentials-Datei, z. B.
  `~/.cloudflared/a1b2c3d4-....json`.

Beide Werte werden in den nächsten Schritten gebraucht. Die
Credentials-Datei ist das Äquivalent eines privaten Schlüssels für den
Tunnel — **niemals im Klartext committen**.

---

## Schritt 3 — Credentials versiegeln

Analog zum bestehenden SealedSecrets-Workflow
([docs/13-sso-authentik.md](13-sso-authentik.md#schritt-1--secrets-versiegeln)):

```bash
kubeseal --raw \
  --namespace cloudflared \
  --name cloudflared-credentials \
  --controller-namespace sealed-secrets \
  --controller-name sealed-secrets-controller \
  --from-file=/pfad/zu/~/.cloudflared/<TUNNEL-ID>.json
```

Den ausgegebenen Ciphertext in
`argocd/apps/cloudflared/values.yaml` unter
`tunnel.encryptedCredentialsJson` eintragen.

> Alternativ per Web-UI: <http://kubeseal-webgui.homeserver>, Namespace
> `cloudflared`, Secret-Name `cloudflared-credentials`, Key
> `credentials.json`, Value = Inhalt der `.json`-Datei.

---

## Schritt 4 — DNS-Routing: Wildcard statt Einzel-Records

Zwei Optionen, wie öffentliche Hostnamen auf den Tunnel zeigen. Wichtig,
zum Verständnis: das ist **reines DNS-Routing zum Tunnel** — welcher
interne k8s-Service hinter welchem Hostnamen hängt, entscheidet weiterhin
ausschließlich `tunnel.ingress.rules` in `values.yaml` (Schritt 5). Eine
Wildcard-DNS-Route macht also **nicht** automatisch neue Dienste
erreichbar, sie erspart dir nur den DNS-Schritt bei jedem neuen Dienst.

### Empfohlen: eine Wildcard-Route für die ganze Subdomain-Ebene

Ein einziger CNAME für `*.deine-domain.de` deckt jeden aktuellen und
zukünftigen `<name>.deine-domain.de`-Hostnamen ab — neue Dienste brauchen
danach **nur noch** einen Eintrag in `values.yaml` (kein DNS-Schritt
mehr, kein erneutes `cloudflared tunnel route dns`):

```bash
cloudflared tunnel route dns homeserver "*.deine-domain.de"
```

Legt einen `CNAME` `*` → `<tunnel-id>.cfargotunnel.com` an
(**Proxy-Status: Proxied/orange**, Pflicht). Hostnamen, die *nicht* in
`tunnel.ingress.rules` stehen, lösen zwar auf, liefern aber wegen
`defaultService: "http_status:404"` einen 404 — es wird dadurch nichts
zusätzlich exponiert.

> Falls die Domain schon einen `*`-Record für etwas anderes nutzt (z. B.
> Catch-all-E-Mail bei Netcup), kollidiert das — dann stattdessen die
> Einzel-Record-Variante unten verwenden, oder eine dedizierte
> Subdomain-Ebene wie `*.ext.deine-domain.de` als Wildcard-Ziel wählen.

### Alternative: expliziter Record pro Hostname

Etwas mehr Aufwand pro neuem Dienst, dafür ist in der Cloudflare-DNS-Zone
auf einen Blick sichtbar, welche Hostnamen tatsächlich aktiv geroutet
werden:

```bash
cloudflared tunnel route dns homeserver wiki.deine-domain.de
cloudflared tunnel route dns homeserver ntfy.deine-domain.de
cloudflared tunnel route dns homeserver support.deine-domain.de
```

Bei dieser Variante muss der DNS-Schritt bei jedem neuen freigegebenen
Dienst wiederholt werden (siehe
[docs/23 → Neuen Dienst freigeben](23-cloudflare-deploy.md#neuen-dienst-freigeben)).

Beide Varianten lassen sich auch manuell im Dashboard unter
**DNS → Records** anlegen/prüfen.

---

## Schritt 5 — values.yaml befüllen

`argocd/apps/cloudflared/values.yaml` öffnen und ausfüllen:

```yaml
tunnel:
  name: homeserver
  id: "a1b2c3d4-...."               # aus Schritt 2
  credentialsSecretName: cloudflared-credentials
  encryptedCredentialsJson: "AgB...=="   # aus Schritt 3

  ingress:
    rules:
      - hostname: wiki.deine-domain.de
        service: http://wikijs-wikijs.wikijs.svc.cluster.local:80
      - hostname: ntfy.deine-domain.de
        service: http://ntfy.ntfy.svc.cluster.local:80
      - hostname: support.deine-domain.de
        service: http://zammad-zammad-nginx.zammad.svc.cluster.local:80
    defaultService: "http_status:404"
```

Den internen Service-Namen je Dienst mit `kubectl -n <namespace> get svc`
prüfen — bei Sub-Charts (z. B. Zammad, Wiki.js) heißt der Service oft
`<release>-<chart>-<komponente>`, nicht einfach der App-Name.

> Mit der Wildcard-DNS-Route aus Schritt 4 ist das ab jetzt der **einzige**
> Schritt, um einen weiteren Dienst freizugeben — einfach eine weitere
> `hostname:`/`service:`-Zeile ergänzen, committen, pushen. Kein erneutes
> `cloudflared tunnel route dns` nötig.

Danach committen und pushen (siehe
[docs/23-cloudflare-deploy.md](23-cloudflare-deploy.md) für den vollen
Rollout- und Verifikations-Ablauf).

---

## Zusätzliche Absicherung: Cloudflare Access

Ein Cloudflare Tunnel macht einen Dienst öffentlich erreichbar — er
ersetzt aber keine Authentifizierung. Zwei Optionen, oft kombiniert:

**Option A — Dienst hat bereits Authentik davor** (z. B. via OIDC oder
Traefik-ForwardAuth, siehe [docs/13-sso-authentik.md](13-sso-authentik.md)):
Cloudflare Tunnel liefert nur den Transport, Authentik bleibt die
Zugriffskontrolle. Für interne Admin-artige Dienste reicht das **nicht**
als alleiniger Schutz für eine öffentliche Freigabe (siehe nächster
Abschnitt, welche Dienste besser gar nicht exponiert werden).

**Option B — Cloudflare Access davorschalten** (Zero Trust, im Free-Plan
für bis zu 50 Nutzer kostenlos):

1. [Zero Trust Dashboard](https://one.dash.cloudflare.com) → **Access →
   Applications → Add an application → Self-hosted**.
2. Domain/Hostname eintragen (z. B. `support.deine-domain.de`).
3. Policy definieren, z. B. "Allow" für eine Liste von E-Mail-Adressen
   (One-Time-PIN per Mail, kein Passwort/Client nötig) oder eine
   E-Mail-Domain (`*@dlrg-andernach.de`).
4. Speichern — Cloudflare zeigt jetzt vor dem eigentlichen Dienst eine
   Login-Seite; erst nach erfolgreicher Policy-Prüfung leitet Cloudflare
   zum Tunnel-Ziel weiter.

Für Dienste mit echten externen Nutzern (z. B. Zammad-Ticket-Erstellung
durch DLRG-Mitglieder ohne Cluster-Zugriff) ist Option B die richtige
Wahl. Für Dienste, die nur du selbst von unterwegs brauchst (z. B.
Grafana), reicht die Kombination aus bestehendem Authentik-Login **plus**
einer Access-Policy auf deine eigene E-Mail-Adresse.

---

## Welche Dienste eignen sich zur Freigabe?

| Dienst | Empfehlung | Begründung |
|---|---|---|
| **Wiki.js** | Freigeben | SOPs, Alarm-/Ausrückeordnung, Checklisten — genau die Inhalte, die im Wachdienst *unterwegs*, ohne VPN gebraucht werden. Reiner Lesezugriff für die meisten Nutzer, geringes Risiko. Mit Cloudflare Access (Option B) auf DLRG-Mitglieder einschränken. |
| **ntfy** | Freigeben | Push-Benachrichtigungen (z. B. Unwetterwarnung, Alarmmonitor offline) müssen genau dann ankommen, wenn das Handy *nicht* im Heimnetz/Tailnet hängt. Ohne externe Erreichbarkeit verpuffen Alerts im Ernstfall. |
| **Zammad** | Freigeben (mit Access-Policy) | Sinnvoll, wenn Tickets/Support-Anfragen auch von Leuten ohne VPN-Zugang reinkommen sollen. Cloudflare Access oder mindestens ein Rate-Limit vorschalten, da das Formular öffentlich erreichbar ist. |
| **Grafana** | Optional | Praktisch, um Pegel-/Wetter-Dashboards unterwegs zu checken. Nur mit Authentik-OIDC **und** Cloudflare-Access-Policy auf den eigenen Account freigeben — sonst sind Cluster-/Infra-Metriken öffentlich einsehbar. |
| **ArgoCD** | Nicht freigeben | Voller GitOps-Controller-Zugriff auf den Cluster. Bleibt Tailscale-only. |
| **Semaphore** | Nicht freigeben | Kann Ansible-Playbooks mit Root-Rechten auf beiden Servern ausführen. Bleibt Tailscale-only. |
| **Headlamp** | Nicht freigeben | Kubernetes-Admin-Dashboard, voller Cluster-Zugriff. Bleibt Tailscale-only. |
| **MinIO Console / kubeseal-webgui** | Nicht freigeben | Artifact-Store bzw. Secret-Verschlüsselungs-UI — reine Admin-Werkzeuge ohne externen Bedarf. |
| **Argo Workflows** | Nicht freigeben | Interne CI/CD-Pipeline, kein externer Nutzerkreis. |
| **ArgoCD/k3s-API/SSH** | Nicht freigeben | Infrastruktur-Ports gehören grundsätzlich nicht ins öffentliche Internet, auch nicht per Tunnel. |

Faustregel: **Alles mit Admin-/Infrastruktur-Charakter bleibt
Tailscale-only. Alles mit einem echten externen Nutzerkreis (Familie,
Vereinsmitglieder, Kunden) ist ein Kandidat für den Tunnel** — idealerweise
mit Cloudflare Access oder Authentik davor.

---

## Sicherheitsprinzipien

- **UFW-Firewall bleibt unverändert.** `cloudflared` braucht keinen
  eingehenden Port — es öffnet nur eine ausgehende Verbindung. Die
  bestehende Firewall-Tabelle in [README.md](../README.md#networking--security)
  bleibt exakt so, wie sie ist.
- **Opt-in pro Dienst.** Es wird nichts automatisch öffentlich — nur
  Hostnamen, die explizit in `tunnel.ingress.rules` stehen, sind über
  Cloudflare erreichbar. Alles andere bleibt ausschließlich unter
  `*.homeserver` (LAN/Tailnet).
- **Secrets bleiben verschlüsselt in Git**, wie bei jedem anderen Dienst
  in diesem Repo (SealedSecrets, siehe
  [docs/13-sso-authentik.md](13-sso-authentik.md)).
- **Least Privilege beim Access:** wo möglich Cloudflare Access oder
  Authentik vorschalten, statt einen Dienst komplett offen ins Internet
  zu hängen.

---

## Troubleshooting

**Tunnel-Status prüfen (lokal, vor dem Deployment):**

```bash
cloudflared tunnel info homeserver
cloudflared tunnel list
```

**Pod läuft nicht / CrashLoopBackOff:**

```bash
kubectl -n cloudflared get pods
kubectl -n cloudflared logs deploy/cloudflared
```

Häufigste Ursache: `encryptedCredentialsJson` falsch versiegelt (falscher
Namespace/Name beim `kubeseal`-Aufruf) oder `tunnel.id` stimmt nicht mit
der ID in der `credentials.json` überein.

**502/503 vom öffentlichen Hostnamen:**

Meist ein falsches `service:`-Ziel in `tunnel.ingress.rules` — Service-Name
und Port mit `kubectl -n <namespace> get svc` gegenprüfen.

**DNS löst nicht auf:**

```bash
dig wiki.deine-domain.de
# Sollte auf eine Cloudflare-IP (Proxied) zeigen, nicht auf die Heim-IP.

# Bei Wildcard-Setup zusätzlich den Record selbst prüfen:
dig +short CNAME wiki.deine-domain.de
# Sollte über den *-Record auf <tunnel-id>.cfargotunnel.com auflösen.
```

**Nameserver zeigen noch auf Netcup (nach Schritt 1):**

```bash
dig +short NS deine-domain.de
```

Solange hier `ns*.netcup.net` erscheint statt der Cloudflare-Nameserver,
ist die Umstellung im Netcup CCP entweder noch nicht gespeichert oder
noch nicht propagiert (siehe docs/22, Schritt 1.3).

Weitere Rollout- und Betriebsschritte:
**[docs/23-cloudflare-deploy.md](23-cloudflare-deploy.md)**.
