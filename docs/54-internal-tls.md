# 54 — Internes TLS für `*.homeserver` (Security-Härtung Phase 5)

Detail-Doku zu Phase 5 aus [docs/51-security-hardening-roadmap.md](51-security-hardening-roadmap.md).

**Status (16.08.2026): Umstellung auf cert-manager.** Der ursprüngliche
Ansatz (manuell per `openssl` signierte Leaf-Zertifikate, als SealedSecret
committet — siehe [Vorheriger Ansatz](#vorheriger-ansatz-manuelles-opensslmkcert)
unten) ist abgelöst durch [cert-manager](https://cert-manager.io), das
Zertifikate automatisch aus derselben Homeserver-Root-CA signiert und vor
Ablauf selbstständig erneuert.

**Konkreter Auslöser der Umstellung:** Die Domain-Tier-Migration
([docs/56-domain-tiers.md](56-domain-tiers.md), `<app>.homeserver` →
`<app>.tech.homeserver`/`<app>.prod.homeserver`) hat die SAN-Liste des
damals committeten Zertifikats stillschweigend veralten lassen — das
Zertifikat trug noch die alten, untierten Hostnamen. Jeder neue
tier-behaftete Host bekam seither einen Zertifikats-Hostname-Mismatch, und
weil der CA-Private-Key bewusst nie im Repo lag, ließ sich das nicht per
Commit reparieren (siehe docs/56, Abschnitt "Offener Punkt", jetzt
aufgelöst). Das war der praktische Bruchpunkt, der die Automatisierung
nötig gemacht hat.

---

## Ziel

Alle `*.homeserver`-Adressen liefen bisher über Klartext-`http://` intern
im LAN (Traefik hatte kein TLS-Zertifikat für diese Zone — nur der externe
Pfad über den Cloudflare-Tunnel, `*.pke-lab.de`, ist bereits TLS-terminiert
bei Cloudflare). Diese Phase schließt die Lücke für den lokalen Pfad —
jetzt mit automatischer Ausstellung/Erneuerung statt eines manuellen,
CA-Key-abhängigen Ablaufs.

---

## Design-Entscheidungen

### cert-manager statt weiterhin manuellem openssl

Der ursprüngliche Grund gegen einen laufenden CA-Server (siehe
[Vorheriger Ansatz](#vorheriger-ansatz-manuelles-opensslmkcert)) war die
zusätzliche dauerhaft laufende Komponente für einen selten wechselnden
Bedarf. Das hat sich als falsche Abwägung erwiesen, sobald sich die
SAN-Liste (Domain-Tier-Migration) tatsächlich geändert hat: ohne
laufenden Signier-Dienst bedeutet jede SAN-Änderung wieder denselben
manuellen, CA-Key-abhängigen Ablauf — genau das Risiko, das gerade
eingetreten ist. cert-manager übernimmt Signieren + Erneuern vollständig
und ist als reiner Kubernetes-Controller (kein separater ACME-Server wie
`step-ca`) die kleinstmögliche Automatisierung für genau dieses Problem.

### Bestehende CA weiterverwenden statt neuer Self-Signed-Root

cert-managers Standardweg für eine private CA ist ein `SelfSigned`-
Bootstrap-`ClusterIssuer`, der eine komplett neue Root-CA erzeugt. Bewusst
NICHT so umgesetzt — das hätte auf jedem Client-Gerät einen erneuten
Trust-Store-Rollout nötig gemacht (siehe [Client-Geräte](#client-geräte-vertrauensspeicher)
unten, der aufwendigste Teil des ursprünglichen Rollouts). Stattdessen
signiert ein `ClusterIssuer` vom Typ `CA` mit der **bestehenden**
Homeserver-Root-CA (`rootCA.pem`/`rootCA-key.pem`, bisher nur lokal für
den manuellen `openssl x509 -req -CA ...`-Schritt genutzt) — exakt
dieselbe CA bleibt gültig, das bereits auf allen Geräten installierte
[docs/assets/homeserver-root-ca.pem](assets/homeserver-root-ca.pem)
musste **nicht** ersetzt werden.

### CA-Private-Key: einmaliger manueller Import, kein SealedSecret

Der CA-Private-Key muss jetzt zwingend im Cluster liegen, sonst kann
cert-manager nicht selbstständig signieren — das ist der ganze Sinn dieser
Migration. Trotzdem bewusst **kein** SealedSecret dafür im Repo, aus
demselben Grund wie beim vorherigen Ansatz: der CA-Key ist höherwertiger
als ein normales App-Secret (er signiert praktisch beliebig viele
Leaf-Zertifikate), ein Repo-Leak der sealed-secrets-Controller-Keys soll
ihn nicht mit offenlegen. Import bleibt deshalb ein einmaliger manueller
`kubectl create secret`-Schritt außerhalb von GitOps (siehe
[Rollout](#rollout) unten) — das Secret existiert nur im Cluster, nie im
Repo, nicht mal versiegelt.

### Kein Wildcard — weiterhin explizite SAN-Liste

Unverändert gegenüber dem vorherigen Ansatz: `*.homeserver` scheitert
strukturell an `X509_check_host` (OpenSSL, von curl/den meisten
TLS-Stacks genutzt), das Wildcards unter einem Suffix mit nur **einem**
DNS-Label ablehnt — dieselbe Schutzregel, die ein `*.com`-Zertifikat
verhindert. Das ist eine Eigenschaft von `.homeserver` als Zone, keine
Tool-Einschränkung — auch cert-manager kann daran nichts ändern. Die
[`Certificate`-Ressource](../argocd/apps/platform/cert-manager/templates/certificate-homeserver-wildcard.yaml)
trägt deshalb weiterhin eine explizite, jetzt tier-behaftete `dnsNames`-
Liste. Ein neuer `*.homeserver`-Host braucht weiterhin einen Eintrag dort
+ Commit — was sich geändert hat, ist nur, dass danach niemand mehr
`openssl`/`kubeseal` von Hand ausführen muss: cert-manager erneuert das
Zertifikat automatisch, sobald der geänderte Manifest gesynct ist.

### Zertifikat

- **Subject Alternative Names:** alle aktuellen `*.homeserver`-Hosts
  (tier-behaftet, `<app>.tech.homeserver`/`<app>.prod.homeserver`) plus
  der nackte Apex `homeserver` — siehe
  [certificate-homeserver-wildcard.yaml](../argocd/apps/platform/cert-manager/templates/certificate-homeserver-wildcard.yaml).
- **Gültigkeit:** 90 Tage (`duration: 2160h`), automatische Erneuerung 30
  Tage vor Ablauf (`renewBefore: 720h`) — bewusst kurz, weil das jetzt
  nichts mehr kostet (keine ACME-Rate-Limits wie bei einer öffentlichen
  CA, keine manuelle Arbeit): häufige Rotation ist bei einer internen CA
  reiner Sicherheitsgewinn ohne Nachteil.

### Ablage im Cluster: TLSStore statt pro-App-Ingress

Unverändert: ein einziges `TLSStore`-Objekt namens `default`
([argocd/apps/platform/traefik-config/tlsstore.yaml](../argocd/apps/platform/traefik-config/tlsstore.yaml))
verweist auf das von cert-manager verwaltete Secret — `default` ist dabei
kein Freitext, sondern der von Traefik selbst reservierte Name, der
automatisch für jeden Router greift, der nicht explizit ein anderes
TLSStore referenziert.

### cert-manager-Namespace: Infrastruktur, kein App-Tier

`cert-manager` läuft in einem eigenen Namespace, ist aber bewusst **nicht**
Teil von `argocd_platform_apps`
([ansible/roles/argocd/defaults/main.yml](../ansible/roles/argocd/defaults/main.yml))
— genau wie `kube-system` und `argocd` selbst ist das Cluster-
Infrastruktur, kein App mit eigenem Nutzerkreis/Tier. Die Namespace-
Berechtigung steht deshalb als zusätzlicher, fest kodierter Eintrag in der
`platform`-AppProject-Destination-Liste
([ansible/roles/argocd/templates/bootstrap-appprojects.yaml.j2](../ansible/roles/argocd/templates/bootstrap-appprojects.yaml.j2)),
analog zum bestehenden `kube-system`-Eintrag — sonst bekäme der
Namespace ein `tier-default-ingress`-NetworkPolicy und ein
`security-tier`-Label, die für Cluster-Infrastruktur nicht sinnvoll sind
(siehe [docs/52-network-policies.md](52-network-policies.md)).

---

## Rollout

**1. Committen + pushen** (macht der Nutzer selbst) — sobald
`argocd/apps/platform/cert-manager/`,
`argocd/apps/platform/traefik-config/tlsstore.yaml` und
`ansible/roles/argocd/templates/bootstrap-appprojects.yaml.j2` +
`argocd/bootstrap/projects.yaml` im Repo sind, holt sich ArgoCD die
Änderung automatisch (`automated: {prune: true, selfHeal: true}`, kein
manueller Sync-Trigger nötig). cert-manager selbst (Controller + CRDs +
`ClusterIssuer` + `Certificate`) synct in einem Zug — der `ClusterIssuer`
bleibt bis Schritt 2 `NotReady` (fehlendes Secret), das lässt den Sync
nicht fehlschlagen, nur das `Certificate` bleibt so lange `Pending`.

**2. CA-Keypair einmalig ins Cluster importieren** (nicht Teil von
GitOps, siehe [Design-Entscheidungen](#ca-private-key-einmaliger-manueller-import-kein-sealedsecret)
oben — CA-Key aus dem Passwort-Manager zurückspielen, falls nicht mehr am
Rechner, der ihn generiert hat):

```bash
kubectl create secret tls homeserver-ca-keypair \
  --cert=rootCA.pem --key=rootCA-key.pem \
  --namespace=cert-manager
```

**3. Sync + Zertifikat-Status verifizieren:**

```bash
kubectl get application cert-manager -n argocd \
  -o custom-columns='NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status'
kubectl get clusterissuer homeserver-ca-issuer -o wide
kubectl -n kube-system get certificate homeserver-wildcard-tls
# READY sollte "True" zeigen, sobald Schritt 2 erledigt ist
kubectl -n kube-system get secret homeserver-wildcard-tls
```

**4. HTTPS lokal testen** (von einem Gerät, auf dem die CA schon
installiert ist — siehe [Client-Geräte](#client-geräte-vertrauensspeicher) unten):

```bash
curl -v https://whoami.prod.homeserver/ 2>&1 | grep -E "issuer|subject|SSL certificate verify"
```

Erwartung: `issuer: O=Homeserver Internal CA, CN=Homeserver Root CA`
(dieselbe CA wie vorher), **kein**
`SSL certificate problem: unable to get local issuer certificate` (das
würde bedeuten, die CA ist auf diesem Gerät nicht vertraut — Schritt für
dieses Gerät nachholen, siehe unten). **Nicht** nur `kubectl get secret`
prüfen — das zeigt nur, dass irgendein Zertifikat da ist, nicht, dass die
SAN-Liste zum tatsächlichen Host passt.

---

## Client-Geräte (Vertrauensspeicher)

Da dieselbe CA weiterverwendet wird (siehe Design-Entscheidungen oben),
ändert sich hier **nichts** gegenüber dem bisherigen Stand — Geräte, auf
denen die CA schon installiert ist, brauchen keinen erneuten Rollout.
Für alle anderen Geräte gilt weiterhin, pro Gerät manuell, kein
Ansible/Automatisierung möglich (unterschiedliche OS-Mechanismen, teils
kein Remote-Zugriff auf private Geräte):

**Linux:**

```bash
sudo apt-get install -y mkcert libnss3-tools   # falls noch nicht installiert
mkcert -install
```

Installiert automatisch in den System-Trust-Store **und** in Firefox/
Chrome (NSS-Datenbank, dafür `libnss3-tools`).

**Weitere Linux-Rechner** (ohne mkcert/CA-Private-Key dort): CA-Zertifikat
kopieren und manuell registrieren, statt mkcert erneut zu installieren
(braucht nur die public `.pem`, keinen Private Key):

```bash
sudo cp docs/assets/homeserver-root-ca.pem /usr/local/share/ca-certificates/homeserver-root-ca.crt
sudo update-ca-certificates
# Für Firefox/Chrome zusätzlich (NSS-Datenbank):
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "homeserver-root-ca" -i docs/assets/homeserver-root-ca.pem
```

**Windows:** `docs/assets/homeserver-root-ca.pem` doppelklicken →
"Zertifikat installieren" → **Lokaler Computer** → "Alle Zertifikate in
folgendem Speicher speichern" → **Vertrauenswürdige Stammzertifizierungsstellen**.
Firefox verwendet einen eigenen Speicher (`about:preferences#privacy` →
Zertifikate → Zertifikate anzeigen → Zertifizierungsstellen → Importieren).

**macOS:** `docs/assets/homeserver-root-ca.pem` in Schlüsselbundverwaltung
importieren (System-Schlüsselbund) → Zertifikat öffnen → "Vertrauen" →
"Bei Verwendung dieses Zertifikats" auf **Immer vertrauen** setzen.

**iOS:** Datei per AirDrop/Mail an das Gerät schicken → öffnen → Profil
installieren (Einstellungen → Profil geladen) → **zusätzlich**
Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen →
das Root-Zertifikat manuell aktivieren (iOS installiert es sonst nur,
vertraut ihm aber nicht automatisch für TLS).

**Android:** Datei aufs Gerät kopieren → Einstellungen → Sicherheit →
Verschlüsselung & Anmeldedaten → Zertifikat installieren → CA-Zertifikat.
Ab Android 7 gelten benutzerinstallierte CAs nicht automatisch für alle
Apps (nur für den Browser/System-WebView) — für Apps mit eigenem
Netzwerk-Stack ggf. nicht wirksam, hier aber nicht relevant (nur
Browser-Zugriff auf `*.homeserver`).

---

## Neuen Host hinzufügen / Zertifikat erneuern

**Neuer Host:** Eintrag in `dnsNames` in
[certificate-homeserver-wildcard.yaml](../argocd/apps/platform/cert-manager/templates/certificate-homeserver-wildcard.yaml)
ergänzen, committen, pushen — cert-manager erstellt automatisch ein neues
Zertifikat mit der erweiterten SAN-Liste, kein `openssl`/`kubeseal` mehr
nötig.

**Reguläre Erneuerung:** komplett automatisch (siehe
[Zertifikat](#zertifikat) oben, `renewBefore: 720h`) — nichts zu tun.

**CA läuft aus (alle 10 Jahre) oder CA-Key kompromittiert:** einziger
noch verbliebener manueller Fall — neue Root-CA per `openssl` erzeugen
(gleiches Verfahren wie beim ursprünglichen Rollout), `rootCA.pem` in
[docs/assets/homeserver-root-ca.pem](assets/homeserver-root-ca.pem)
ersetzen + committen, `homeserver-ca-keypair`-Secret im Cluster mit dem
neuen Keypair überschreiben (Schritt 2 aus [Rollout](#rollout) erneut),
und — anders als bei einer normalen Zertifikats-Erneuerung — **auf jedem
Client-Gerät erneut installieren** (siehe
[Client-Geräte](#client-geräte-vertrauensspeicher)), weil sich die CA
selbst ändert.

---

## Aufräumen

- [ ] CA-Private-Key (lokale Kopie, z. B.
      `~/.local/share/mkcert/rootCA-key.pem`) bleibt zusätzlich im
      Passwort-Manager gesichert — geht sowohl die lokale Kopie als auch
      das `homeserver-ca-keypair`-Secret im Cluster verloren, muss bei der
      nächsten Änderung eine komplett neue CA generiert und auf **allen**
      Geräten neu installiert werden.

---

## Vorheriger Ansatz: manuelles openssl/mkcert

Bis 16.08.2026 wurde jedes Leaf-Zertifikat manuell per `openssl x509 -req
-CA rootCA.pem -CAkey rootCA-key.pem ...` signiert und als SealedSecret
committet, mit der SAN-Liste per Hand aus `kubectl get ingress -A`
gezogen. Grund für die Ablösung: siehe Status-Absatz ganz oben. Root-CA-
Erzeugung (`openssl req -x509 ...` mit neutralem Subject statt `mkcert`s
`OU=user@host`, wegen des öffentlichen Repos) und die Argumentation dafür
sind unverändert gültig — nur der Leaf-Signier-Schritt ist jetzt
automatisiert, siehe [Design-Entscheidungen](#design-entscheidungen) oben.
